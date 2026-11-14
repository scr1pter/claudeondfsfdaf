# Session origin: round-two scratchpad rpverify/sens.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy; pinned revs with check=True.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, re, subprocess, numpy as np
ap = argparse.ArgumentParser(description="Substring against word-level sensitive-path flags per commit, within size buckets and per project.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
ap.add_argument("repos", help="folder holding the bare clones kafka.git, groovy.git, zookeeper.git and zeppelin.git (README.md, Inputs)")
args = ap.parse_args()
lib = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py"))); auc = lib["auc"]; APACHE_REVS = lib["APACHE_REVS"]
data, repos = args.data, args.repos
OLD = re.compile(r"auth|security|secur|crypt|acl|permission|token|password|credential|ssl|tls|sasl|kerberos", re.I)
# path-segment / camel-word boundaries: split path into lowercase words
WORDS = {"auth","authentication","authorization","authorizer","authenticator","security","secure","crypto","crypt","encrypt","encryption","cipher","acl","acls","permission","permissions","token","tokens","password","passwords","credential","credentials","ssl","tls","sasl","kerberos","jaas","oauth","keystore","truststore","secret","secrets"}
def words(p): return {w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", p)}
rows = [r for r in csv.DictReader(open(data)) if r["project"].split("/")[1] in ("kafka","groovy","zookeeper","zeppelin")]
out=[]
for name in ("kafka","groovy","zookeeper","zeppelin"):
    log = subprocess.run(["git","-C",f"{repos}/{name}.git","log",APACHE_REVS[name],"--no-renames","--name-only","--format=%x00%H"], stdout=subprocess.PIPE, text=True, check=True).stdout
    idx={}
    for chunk in log.split("\x00")[1:]:
        lines=chunk.strip("\n").split("\n"); idx[lines[0]]=[l for l in lines[1:] if l]
    for r in rows:
        if r["project"]!=f"apache/{name}" or r["commit_id"] not in idx: continue
        f=idx[r["commit_id"]]
        out.append((name, r["buggy"]=="True", float(r["la"]), int(any(OLD.search(x) for x in f)), int(any(words(x)&WORDS for x in f))))
y=np.array([o[1] for o in out],float); la=np.array([o[2] for o in out]); old=np.array([o[3] for o in out]); new=np.array([o[4] for o in out]); proj=np.array([o[0] for o in out])
print("n",len(y),"old share",old.mean().round(3),"new share",new.mean().round(3))
print("AUC old",round(auc(old.astype(float),y),3),"AUC new",round(auc(new.astype(float),y),3))
for lo,hi in [(0,20),(20,100),(100,10**9)]:
    m=(la>=lo)&(la<hi)
    print(f" la[{lo},{hi})", " ".join(f"{n}={v}:{y[m&(a==v)].mean():.3f}(n={int((m&(a==v)).sum())})" for n,a in (("old",old),("new",new)) for v in (0,1)))
for p in sorted(set(proj)):
    m=proj==p; print(p, "new share", new[m].mean().round(3), "AUC new", round(auc(new[m].astype(float),y[m]),3), "old share", old[m].mean().round(3))
