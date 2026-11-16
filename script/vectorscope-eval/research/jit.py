# Session origin: round-two scratchpad scripts/jit.py, 2026-11-06. Changes: argparse.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, sys, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT commit-level models: per-project rates, single-feature AUC, time-split logistic models, effort recall, bands and cross-project transfer.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
path = ap.parse_args().data
rows = list(csv.DictReader(open(path)))
F = ["la","ld","nf","nd","ns","ent","ndev","age","nuc","aexp","arexp","asexp","fix"]
proj = np.array([r["project"] for r in rows]); year = np.array([int(r["year"]) for r in rows])
y = np.array([r["buggy"]=="True" for r in rows]).astype(float)
X = np.array([[float(r[f]=="True") if f=="fix" else float(r[f]) for f in F] for r in rows])
X = np.nan_to_num(X)
keep = proj != "apache/hadoop"; rows=[r for r,k in zip(rows,keep) if k]; proj=proj[keep]; year=year[keep]; y=y[keep]; X=X[keep]
print("n", len(y), "base", y.mean().round(3), "years", year.min(), year.max())
for p in sorted(set(proj)):
    m = proj==p; print(f"  {p:28s} n={m.sum():6d} buggy={y[m].mean():.3f}")
def auc(s, t):
    o = np.argsort(s, kind="mergesort"); r = np.empty(len(s)); r[o] = np.arange(1, len(s)+1)
    # average ties
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=r); r = (sums/cnt)[inv]
    npos = t.sum(); nneg = len(t)-npos
    return (r[t==1].sum() - npos*(npos+1)/2)/(npos*nneg)
print("single-feature AUC (all data):")
for i,f in enumerate(F): print(f"  {f:6s} {auc(X[:,i], y):.3f}")
def prep(X):
    Z = X.copy(); Z[:, :12] = np.log1p(np.clip(Z[:, :12], 0, None)); return Z
def fit(X, y, l2=1e-3, it=300):
    mu = X.mean(0); sd = X.std(0)+1e-9; Z = (X-mu)/sd; Z = np.c_[np.ones(len(Z)), Z]
    w = np.zeros(Z.shape[1])
    pw = (1-y.mean())/y.mean(); sw = np.where(y==1, pw, 1.0)  # class-balance weights
    for _ in range(it):
        p = 1/(1+np.exp(-Z@w)); g = Z.T@((p-y)*sw)/len(y) + l2*np.r_[0,w[1:]]
        H = (Z*(p*(1-p)*sw)[:,None]).T@Z/len(y) + l2*np.eye(len(w)); w -= np.linalg.solve(H, g)
    return mu, sd, w
def score(model, X):
    mu, sd, w = model; Z = np.c_[np.ones(len(X)), (X-mu)/sd]; return Z@w
def effort_recall(s, t, loc, frac=0.2):
    o = np.argsort(-s/np.maximum(loc,1)); c = np.cumsum(loc[o]); k = c <= frac*loc.sum()
    return t[o][k].sum()/t.sum()
def effort_recall_raw(s, t, loc, frac=0.2):
    o = np.argsort(-s); c = np.cumsum(loc[o]); k = c <= frac*loc.sum(); return t[o][k].sum()/t.sum()
tr = year <= 2016; te = year >= 2017
P = prep(X); loc = X[:,0]+X[:,1]
print("time split: train<=2016 n=%d base=%.3f, test>=2017 n=%d base=%.3f" % (tr.sum(), y[tr].mean(), te.sum(), y[te].mean()))
m = fit(P[tr], y[tr]); s = score(m, P[te])
print("  LR(14 Kamei-ish) AUC %.3f" % auc(s, y[te]))
print("  la only AUC %.3f" % auc(X[te,0], y[te]))
print("  coefficients on standardized log features:")
for f, wv in zip(F, m[2][1:]): print(f"    {f:6s} {wv:+.3f}")
# subset available to VectorScope without history: la, ld, nf, nd, ent
idx_nohist = [0,1,2,3,5]; idx_hist = [0,1,2,3,5,7,8,6,12]
for name, idx in [("diff-only(la,ld,nf,nd,ent)", idx_nohist), ("diff+history(age,nuc,ndev,fix)", idx_hist), ("diff+history+exp", list(range(13)))]:
    mm = fit(P[tr][:,idx], y[tr]); ss = score(mm, P[te][:,idx])
    print(f"  {name:36s} AUC {auc(ss, y[te]):.3f}  recall@20%LOC(density) {effort_recall(1/(1+np.exp(-ss)), y[te], loc[te]):.3f}  recall@20%LOC(raw) {effort_recall_raw(ss, y[te], loc[te]):.3f}")
print("  LApredict-style effort: rank by 1/la  recall@20%%LOC %.3f" % effort_recall_raw(-X[te,0], y[te], loc[te]))
print("  random recall@20%LOC ~0.20")
# bands: Mozilla-style relative to base rate on the test set using train-calibrated cutpoints (percentiles of train scores)
mm = fit(P[tr][:,idx_hist], y[tr]); str_ = score(mm, P[tr][:,idx_hist]); ste = score(mm, P[te][:,idx_hist])
for lo, hi in [(50, 90), (40, 80), (60, 95)]:
    a, b = np.percentile(str_, [lo, hi])
    band = np.where(ste < a, 0, np.where(ste < b, 1, 2))
    out = []
    for k in range(3):
        mk = band==k; out.append(f"{['low','med','high'][k]}: share={mk.mean():.2f} buggy={y[te][mk].mean():.3f} lift={y[te][mk].mean()/y[te].mean():.2f} recall={y[te][mk].sum()/y[te].sum():.2f} locshare={loc[te][mk].sum()/loc[te].sum():.2f}")
    print(f"  bands train pct {lo}/{hi}:", " | ".join(out))
# cross-project: leave-one-project-out with diff+history features, test on that project's >=2017 data
print("cross-project (LOPO) vs within-project (time split), diff+history features:")
res = []
for p in sorted(set(proj)):
    tp = (proj==p)&te
    if tp.sum() < 200 or y[tp].sum() < 20: continue
    wp = (proj==p)&tr
    cp = (proj!=p)
    a_cross = auc(score(fit(P[cp][:,idx_hist], y[cp]), P[tp][:,idx_hist]), y[tp])
    a_within = auc(score(fit(P[wp][:,idx_hist], y[wp]), P[tp][:,idx_hist]), y[tp]) if wp.sum() > 200 and y[wp].sum() > 20 else float('nan')
    a_la = auc(X[tp,0], y[tp])
    res.append((a_cross, a_within, a_la)); print(f"  {p:28s} test n={tp.sum():5d} cross {a_cross:.3f} within {a_within:.3f} la-only {a_la:.3f}")
r = np.array(res); print("  mean cross %.3f within %.3f la-only %.3f" % (np.nanmean(r[:,0]), np.nanmean(r[:,1]), np.nanmean(r[:,2])))
