# Session origin: round-two scratchpad scripts/jit2.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT lift tables per feature and the hand-set points score (with churn and fix), per project.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
rows = [r for r in csv.DictReader(open(args.data)) if r["project"] != "apache/hadoop"]
g = lambda f: np.array([float(r[f]=="True") if f in ("fix","buggy") else float(r[f]) for r in rows])
proj = np.array([r["project"] for r in rows]); year = g("year"); y = g("buggy")
la, ld, nf, nd, ent, nuc, age, fix, ndev = [np.nan_to_num(g(f)) for f in ["la","ld","nf","nd","ent","nuc","age","fix","ndev"]]
base = {p: y[proj==p].mean() for p in set(proj)}; rel = np.array([base[p] for p in proj])
te = year >= 2017
def lift_table(name, v, edges):
    print(name)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = te & (v >= lo) & (v < hi)
        if m.sum() < 50: continue
        print(f"  [{lo:>6}, {hi:>6})  share={m.sum()/te.sum():.2f}  buggy={y[m].mean():.3f}  lift-vs-project-base={(y[m]/rel[m]).mean():.2f}")
inf = float("inf")
lift_table("lines added", la, [0,1,5,11,21,51,101,201,501,1001,inf])
lift_table("files", nf, [0,1,2,3,5,9,17,inf])
lift_table("dirs", nd, [0,1,2,3,5,inf])
lift_table("entropy", ent, [0,0.01,0.5,1,1.5,2,3,inf])
lift_table("nuc (unique prior changes to files)", nuc, [0,1,2,4,8,16,32,inf])
lift_table("fix (commit is a fix)", fix, [0,1,2])
lift_table("age (days since last change to files, avg)", age, [0,1,7,30,90,365,inf])
# hand-set additive points score with documented weights
L = np.log2
pts = (np.select([la<=10, la<=50, la<=200], [0,1,2], 3) + np.select([ld<=50], [0], 1)
       + np.select([nd<=1, nd<=3], [0,1], 2) + np.select([ent<1], [0], 1)
       + np.select([nuc<4, nuc<16], [0,1], 2) + fix*1)
print("points score AUC test", round(auc(pts[te], y[te]), 3))
for k in range(int(pts.max())+1):
    m = te & (pts==k)
    if m.sum(): print(f"  points={k} share={m.sum()/te.sum():.2f} buggy={y[m].mean():.3f} lift={(y[m]/rel[m]).mean():.2f}")
band = np.select([pts<=2, pts<=5], [0,1], 2)
for k in range(3):
    m = te & (band==k); print(f"  band {['low','medium','high'][k]} (pts {['0-2','3-5','6+'][k]}): share={m.sum()/te.sum():.2f} buggy={y[m].mean():.3f} lift={(y[m]/rel[m]).mean():.2f} recall={y[m].sum()/y[te].sum():.2f} locshare={(la+ld)[m].sum()/(la+ld)[te].sum():.2f}")
print("per-project AUC of fixed points score (no training):")
a=[]
for p in sorted(set(proj)):
    m = te & (proj==p)
    if y[m].sum() >= 20 and m.sum()>=200: a.append(auc(pts[m], y[m])); print(f"  {p:26s} {a[-1]:.3f}")
print("  mean", round(np.mean(a),3))
# diff-only points (no history)
pts0 = (np.select([la<=10, la<=50, la<=200], [0,1,2], 3) + np.select([ld<=50], [0], 1) + np.select([nd<=1, nd<=3], [0,1], 2) + np.select([ent<1], [0], 1))
print("diff-only points AUC test", round(auc(pts0[te], y[te]),3))
