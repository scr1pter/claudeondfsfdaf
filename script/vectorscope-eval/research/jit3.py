# Session origin: round-two scratchpad scripts/jit3.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT feature-set increments over diff-only, diff-only bands at train percentiles and project-relative cutpoints.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
rows = [r for r in csv.DictReader(open(args.data)) if r["project"] != "apache/hadoop"]
F = ["la","ld","nf","nd","ns","ent","ndev","age","nuc","aexp","arexp","asexp","fix"]
X = np.nan_to_num(np.array([[float(r[f]=="True") if f=="fix" else float(r[f]) for f in F] for r in rows]))
y = np.array([r["buggy"]=="True" for r in rows], float); year = np.array([int(r["year"]) for r in rows]); proj = np.array([r["project"] for r in rows])
P = X.copy(); P[:, :12] = np.log1p(np.clip(P[:, :12], 0, None))
def fit(X, y, l2=1e-3, it=40):
    mu = X.mean(0); sd = X.std(0)+1e-9; Z = np.c_[np.ones(len(X)), (X-mu)/sd]; w = np.zeros(Z.shape[1])
    pw = (1-y.mean())/y.mean(); sw = np.where(y==1, pw, 1.0)
    for _ in range(it):
        p = 1/(1+np.exp(-Z@w)); gr = Z.T@((p-y)*sw)/len(y) + l2*np.r_[0,w[1:]]
        H = (Z*(p*(1-p)*sw)[:,None]).T@Z/len(y) + l2*np.eye(len(w)); w -= np.linalg.solve(H, gr)
    return lambda X: np.c_[np.ones(len(X)), (X-mu)/sd]@w
tr, te = year <= 2016, year >= 2017
I = {f:i for i,f in enumerate(F)}
D = ["la","ld","nf","nd","ent"]
for name, ks in [("diff", D), ("diff+nuc", D+["nuc"]), ("diff+age", D+["age"]), ("diff+ndev", D+["ndev"]), ("diff+exp(aexp,arexp,asexp)", D+["aexp","arexp","asexp"]),
                 ("diff+nuc+age+ndev", D+["nuc","age","ndev"]), ("diff+fix", D+["fix"]), ("all13", F)]:
    c = [I[k] for k in ks]; s = fit(P[tr][:,c], y[tr])(P[te][:,c])
    print(f"  {name:28s} AUC {auc(s, y[te]):.3f}")
c = [I[k] for k in D]; f = fit(P[tr][:,c], y[tr]); s_tr = f(P[tr][:,c]); s_te = f(P[te][:,c]); loc = X[:,0]+X[:,1]
print("diff-only bands (train-percentile cutpoints), test >=2017:")
for lo, hi in [(50,90),(60,95),(70,97)]:
    a, b = np.percentile(s_tr, [lo, hi]); band = np.where(s_te<a,0,np.where(s_te<b,1,2)); out=[]
    for k in range(3):
        m = band==k; out.append(f"{['low','med','high'][k]} share={m.mean():.2f} buggy={y[te][m].mean():.2f} recall={y[te][m].sum()/y[te].sum():.2f} loc={loc[te][m].sum()/loc[te].sum():.2f}")
    print(f"  {lo}/{hi}: " + " | ".join(out))
# same by repo-relative percentiles (each project's own train distribution)
print("project-relative cutpoints 50/90 (each project's own train scores):")
bt = np.zeros(te.sum(), int); pte = proj[te]
for p in set(proj):
    mtr = tr & (proj==p)
    if mtr.sum() < 100: continue
    a, b = np.percentile(f(P[mtr][:,c]), [50, 90]); mm = pte==p; ss = s_te[mm]; bt[mm] = np.where(ss<a,0,np.where(ss<b,1,2))
for k in range(3):
    m = bt==k; print(f"  {['low','med','high'][k]} share={m.mean():.2f} buggy={y[te][m].mean():.2f} recall={y[te][m].sum()/y[te].sum():.2f} loc={loc[te][m].sum()/loc[te].sum():.2f}")
