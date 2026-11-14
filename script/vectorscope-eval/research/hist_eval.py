# Session origin: round-two scratchpad scripts/hist_eval.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, numpy as np
ap = argparse.ArgumentParser(description="AUC of each history feature and of diff-only models with one added; fix density within size buckets.")
ap.add_argument("features", help="the CSV hist.py (or hist_rev.py) wrote")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
R = list(csv.DictReader(open(args.features)))
g = lambda k: np.array([float(r[k]=="True") if k in ("buggy","fix") else float(r[k]) for r in R])
y = g("buggy"); year = g("year"); proj = np.array([r["project"] for r in R])
feat = {k: np.nan_to_num(g(k)) for k in ["la","ld","nf","nd","ent","fix","fixd90","churn90","fixlast5","decay"]}
print("n", len(y), "base", y.mean().round(3))
for k, v in feat.items(): print(f"  AUC {k:9s} {auc(v, y):.3f}   nonzero share {np.mean(v>0):.2f}")
def fit(X, y, l2=1e-3, it=50):
    mu = X.mean(0); sd = X.std(0)+1e-9; Z = np.c_[np.ones(len(X)), (X-mu)/sd]; w = np.zeros(Z.shape[1])
    pw = (1-y.mean())/y.mean(); sw = np.where(y==1, pw, 1.0)
    for _ in range(it):
        p = 1/(1+np.exp(-Z@w)); gr = Z.T@((p-y)*sw)/len(y) + l2*np.r_[0,w[1:]]
        H = (Z*(p*(1-p)*sw)[:,None]).T@Z/len(y) + l2*np.eye(len(w)); w -= np.linalg.solve(H, gr)
    return lambda X: np.c_[np.ones(len(X)), (X-mu)/sd]@w, w
L = lambda ks: np.column_stack([np.log1p(feat[k]) for k in ks])
tr, te = year <= 2016, year >= 2017
print("time split test n", te.sum(), "base", y[te].mean().round(3))
sets = {"diff": ["la","ld","nf","nd","ent"], "diff+fixd90": ["la","ld","nf","nd","ent","fixd90"], "diff+churn90": ["la","ld","nf","nd","ent","churn90"],
        "diff+fixd90+churn90": ["la","ld","nf","nd","ent","fixd90","churn90"], "diff+fixlast5": ["la","ld","nf","nd","ent","fixlast5"], "diff+decay": ["la","ld","nf","nd","ent","decay"],
        "diff+fixd90+selffix": ["la","ld","nf","nd","ent","fixd90","fix"]}
for name, ks in sets.items():
    s, w = fit(L(ks)[tr], y[tr]); a = auc(s(L(ks)[te]), y[te])
    per = [auc(s(L(ks)[te & (proj==p)]), y[te & (proj==p)]) for p in sorted(set(proj)) if y[te&(proj==p)].sum()>=10]
    print(f"  {name:22s} AUC {a:.3f}  per-project {' '.join(f'{x:.3f}' for x in per)}  w={' '.join(f'{x:+.2f}' for x in w[1:])}")
# fix-density lift (normalised by la bucket to separate from size)
print("lift of fixd90 within size buckets (test):")
for lo, hi in [(0,20),(20,100),(100,10**9)]:
    m = te & (feat["la"]>=lo) & (feat["la"]<hi)
    for c, cond in [("fixd90=0", feat["fixd90"]==0), ("1-3", (feat["fixd90"]>=1)&(feat["fixd90"]<=3)), (">=4", feat["fixd90"]>=4)]:
        mm = m & cond
        if mm.sum() >= 30: print(f"  la[{lo},{hi}) {c:9s} n={mm.sum():5d} buggy={y[mm].mean():.3f}")
