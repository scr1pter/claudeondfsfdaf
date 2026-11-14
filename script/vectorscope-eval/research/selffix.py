# Session origin: round-two scratchpad rpverify/selffix.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy; pinned revs with check=True.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, re, subprocess, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT's fix column against a fix regex on the commit subject (the RP15 refutation).")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
ap.add_argument("repos", help="folder holding the bare clones kafka.git, groovy.git, zookeeper.git and zeppelin.git (README.md, Inputs)")
args = ap.parse_args()
lib = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py"))); auc = lib["auc"]; APACHE_REVS = lib["APACHE_REVS"]
data, repos = args.data, args.repos
FIX = re.compile(r"\b(fix(e[sd])?|bug|revert|hotfix)\b", re.I)
rows = [r for r in csv.DictReader(open(data)) if r["project"].split("/")[1] in ("kafka","groovy","zookeeper","zeppelin")]
out=[]
for name in ("kafka","groovy","zookeeper","zeppelin"):
    log = subprocess.run(["git","-C",f"{repos}/{name}.git","log",APACHE_REVS[name],"--format=%x00%H%x09%s"], stdout=subprocess.PIPE, text=True, check=True).stdout
    subj = dict(l.strip("\n").split("\t",1) for l in log.split("\x00")[1:] if "\t" in l)
    for r in rows:
        if r["project"]==f"apache/{name}" and r["commit_id"] in subj:
            out.append(dict(r, rx=bool(FIX.search(subj[r["commit_id"]]))))
g=lambda k: np.array([float(o[k]=="True") if k in ("buggy","fix") else float(o[k]) for o in out])
y=g("buggy"); fx=g("fix"); rx=np.array([o["rx"] for o in out],float); yr=g("year")
print("n",len(y))
for nm,v in (("jit fix col",fx),("subject regex",rx)):
    print(nm,"share",v.mean().round(3),"P(b|1)",y[v==1].mean().round(3),"P(b|0)",y[v==0].mean().round(3),"AUC",round(auc(v,y),3))
print("crosstab (fixcol, regex) -> n, buggy rate")
for a in (0,1):
    for b in (0,1):
        m=(fx==a)&(rx==b); print(" ",a,b,int(m.sum()), y[m].mean().round(3) if m.sum() else None)
def fit(X, y, l2=1e-3, it=50):
    mu = X.mean(0); sd = X.std(0)+1e-9; Z = np.c_[np.ones(len(X)), (X-mu)/sd]; w = np.zeros(Z.shape[1])
    pw = (1-y.mean())/y.mean(); sw = np.where(y==1, pw, 1.0)
    for _ in range(it):
        p = 1/(1+np.exp(-Z@w)); gr = Z.T@((p-y)*sw)/len(y) + l2*np.r_[0,w[1:]]
        H = (Z*(p*(1-p)*sw)[:,None]).T@Z/len(y) + l2*np.eye(len(w)); w -= np.linalg.solve(H, gr)
    return lambda X: np.c_[np.ones(len(X)), (X-mu)/sd]@w
D=np.column_stack([np.log1p(np.nan_to_num(g(k))) for k in ["la","ld","nf","nd","ent"]])
tr,te=yr<=2016,yr>=2017
for nm,X in (("diff",D),("diff+fixcol",np.c_[D,fx]),("diff+subject-regex",np.c_[D,rx])):
    print(nm,"AUC",round(auc(fit(X[tr],y[tr])(X[te]),y[te]),3))
