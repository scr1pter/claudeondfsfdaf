# Session origin: round-two scratchpad g2/bin/aacr.py, 2026-11-06. Changes: argparse; runpy helpers; reads only the permissive job list.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, json, sys, re, ast, hashlib, collections, os, pathlib, runpy
import numpy as np
ap = argparse.ArgumentParser(description="AACR-Bench permissive subset: VS-28's diff-only band against golden comments per PR.")
ap.add_argument("samples", help="dataset/positive_samples.json from alibaba/aacr-bench at ee9d7fe (README.md, Inputs)")
ap.add_argument("jobs", help="the TSV aacr_jobs.py wrote; only the PRs it lists are read")
ap.add_argument("numstat_dir", help="the numstat folder aacr2.sh wrote (OUT_DIR/numstat)")
ap.add_argument("--defect", action="store_true", help="count only golden comments in the Code Defect category")
args = ap.parse_args(); DEFECT = args.defect; here = pathlib.Path(__file__)
spearmanr = runpy.run_path(str(here.with_name("stats.py")))["spearmanr"]
feats = runpy.run_path(str(here.with_name("feat.py")))["feats"]
# Only the PRs the job list names, which is the permissive subset. The session read every numstat it had, then split
# "all" from "permissive" with a per-repository list (now aacr_jobs.NONPERM); its "all" rows are gated (README.md).
listed = {l.split("\t")[0] for l in open(args.jobs) if l.strip()}
items = []; check = []
for x in json.load(open(args.samples)):
    k = "aacr_" + hashlib.md5(x["githubPrUrl"].encode()).hexdigest()[:10]; f = f"{args.numstat_dir}/{k}.numstat"
    if k not in listed or not os.path.exists(f): continue
    r = feats(f, False); repo = "/".join(x["githubPrUrl"].split("/")[3:5])
    cm = x["comments"] if isinstance(x["comments"], list) else ast.literal_eval(x["comments"])
    cm = [c for c in cm if c.get("category") == "Code Defect"] if DEFECT else cm
    check.append((x["change_line_count"], r["la"] + r["ld"]))
    items.append(dict(repo=repo, band=r["band"], pts=r["pts"], size=r["la"] + r["ld"], n=len(cm), ai=sum(1 for c in cm if c.get("is_ai_comment")), r=r, keys=list(cm[0].keys()) if cm else []))
ratio = [b / a for a, b in check if a]
print("validation: n", len(check), "exact", sum(1 for a, b in check if a == b), "within 10%", sum(1 for a, b in check if a and abs(b - a) <= 0.1 * a), "median ratio", np.median(ratio))
print("comment keys", collections.Counter(k for i in items for k in i["keys"]))
for nm, sub in (("permissive", items),):
    print(f"== AACR {nm} n={len(sub)} repos={len({i['repo'] for i in sub})} bands={dict(collections.Counter(i['band'] for i in sub))}")
    for b in ("low", "medium", "high"):
        s = [i for i in sub if i["band"] == b]
        if s: print(f"  {b}: n={len(s)} golden/PR={np.mean([i['n'] for i in s]):.2f} median={np.median([i['n'] for i in s]):.1f} ai-origin share={sum(i['ai'] for i in s)/max(1,sum(i['n'] for i in s)):.2f} median size={np.median([i['size'] for i in s]):.0f} golden/kLOC={1000*sum(i['n'] for i in s)/max(1,sum(i['size'] for i in s)):.2f}")
    print("  spearman pts~golden", spearmanr([i["pts"] for i in sub], [i["n"] for i in sub]), "size~golden", spearmanr([i["size"] for i in sub], [i["n"] for i in sub]))
    sz = np.array([i["size"] for i in sub]); q = np.quantile(sz, [1/3, 2/3])
    for lo, hi, t in ((-1, q[0], "small"), (q[0], q[1], "mid"), (q[1], 1e12, "large")):
        s = [i for i in sub if lo < i["size"] <= hi]
        if len(s) > 8: print(f"   within {t} tercile n={len(s)} spearman pts~golden {spearmanr([i['pts'] for i in s],[i['n'] for i in s])}")
