# Session origin: round-two scratchpad scripts/pts.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT diff-only points (0-7) and diff+churn points (0-9): per-point rates, bands and band agreement.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
rows = [r for r in csv.DictReader(open(args.data)) if r["project"] != "apache/hadoop"]
g = lambda f: np.nan_to_num(np.array([float(r[f]=="True") if f in ("fix","buggy") else float(r[f]) for r in rows]))
y, year, la, ld, nd, ent, nuc = [g(f) for f in ["buggy","year","la","ld","nd","ent","nuc"]]; proj = np.array([r["project"] for r in rows])
te = year >= 2017; loc = la+ld
diff = np.select([la<=10, la<=50, la<=200], [0,1,2], 3) + (ld>50) + np.select([nd<=1, nd<=3], [0,1], 2) + (ent>=1)
hist = np.select([nuc<4, nuc<16], [0,1], 2)
for name, s, cuts in [("diff-only points (0-7)", diff, (2,4)), ("diff-only points (0-7)", diff, (3,5)), ("diff+churn points (0-9)", diff+hist, (4,7))]:
    print(name, "AUC", round(auc(s[te], y[te]),3), "cuts low<=%d med<=%d" % cuts)
    for k in range(int(s.max())+1):
        m = te&(s==k); print(f"   pts={k} share={m.sum()/te.sum():.2f} buggy={y[m].mean():.3f}")
    b = np.select([s<=cuts[0], s<=cuts[1]], [0,1], 2)
    for k in range(3):
        m = te&(b==k); print(f"   {['low','medium','high'][k]:6s} share={m.sum()/te.sum():.2f} buggy={y[m].mean():.3f} recall={y[m].sum()/y[te].sum():.2f} loc={loc[m].sum()/loc[te].sum():.2f}")
    # band agreement between surfaces: diff-only vs diff+churn
b1 = np.select([diff<=3, diff<=5],[0,1],2); b2 = np.select([diff+hist<=4, diff+hist<=7],[0,1],2)
print("band agreement diff-only(3/5) vs diff+churn(4/7):", round(np.mean(b1[te]==b2[te]),3), " |diff|>1:", round(np.mean(abs(b1[te]-b2[te])>1),3))
