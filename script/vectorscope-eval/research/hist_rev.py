# Session origin: round-two scratchpad scripts/hist_rev.py, 2026-11-06. Changes: argparse; pinned revs with check=True; --out.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, re, subprocess, bisect, numpy as np
from collections import defaultdict
ap = argparse.ArgumentParser(description="hist.py's features with a revert or back-out regex in place of the fix regex.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
ap.add_argument("repos", help="folder holding the bare clones kafka.git, groovy.git, zookeeper.git and zeppelin.git (README.md, Inputs)")
ap.add_argument("--out", required=True, help="the features CSV to write, outside the repository (for example /tmp/vector-vectorscope/research/hist_revert.csv)")
args = ap.parse_args(); here = pathlib.Path(__file__)
out_csv = runpy.run_path(str(here.with_name("outguard.py")))["outside_repo"](args.out, "--out")
APACHE_REVS = runpy.run_path(str(here.with_name("jitlib.py")))["APACHE_REVS"]
data, repos = args.data, args.repos
FIX = re.compile(r"\brevert|\bback(ed)? ?out|rollback", re.I)
rows = [r for r in csv.DictReader(open(data)) if r["project"].split("/")[1] in ("kafka","groovy","zookeeper","zeppelin")]
out = []
for name in ("kafka","groovy","zookeeper","zeppelin"):
    log = subprocess.run(["git","-C",f"{repos}/{name}.git","log",APACHE_REVS[name],"--no-renames","--name-only","--format=%x00%H%x09%at%x09%s"], stdout=subprocess.PIPE, text=True, check=True).stdout
    commits = []
    for chunk in log.split("\x00")[1:]:
        lines = chunk.strip("\n").split("\n"); h, t, s = lines[0].split("\t", 2)
        commits.append((h, int(t), bool(FIX.search(s)), [l for l in lines[1:] if l]))
    commits.sort(key=lambda c: c[1])
    ft = defaultdict(list); ff = defaultdict(list); fseq = defaultdict(list)
    for h, t, isfix, files in commits:
        for f in files:
            ft[f].append(t); fseq[f].append(isfix)
            if isfix: ff[f].append(t)
    idx = {c[0]: c for c in commits}
    found = 0
    for r in rows:
        if r["project"] != f"apache/{name}": continue
        c = idx.get(r["commit_id"]);
        if not c: continue
        found += 1; h, t, isfix, files = c; W = 90*86400
        fixd = sum(bisect.bisect_left(ff[f], t) - bisect.bisect_left(ff[f], t-W) for f in files)
        churn = sum(bisect.bisect_left(ft[f], t) - bisect.bisect_left(ft[f], t-W) for f in files)
        last5 = 0
        for f in files:
            i = bisect.bisect_left(ft[f], t); last5 += sum(fseq[f][max(0,i-5):i])
        # Google/bugspots-style decay over past fixes within 1 year
        dec = 0.0
        for f in files:
            i = bisect.bisect_left(ff[f], t); j = bisect.bisect_left(ff[f], t-365*86400)
            for tt in ff[f][j:i]:
                x = 1 - (t-tt)/(365*86400); dec += 1/(1+np.exp(-12*x+12))
        out.append([r[k] for k in ("project","year","buggy","la","ld","nf","nd","ent","fix")] + [fixd, churn, last5, dec, len(files)])
    print(name, "matched", found, "of", sum(r["project"]==f"apache/{name}" for r in rows))
w = csv.writer(open(out_csv,"w")); w.writerow(["project","year","buggy","la","ld","nf","nd","ent","fix","fixd90","churn90","fixlast5","decay","files"]); w.writerows(out)
