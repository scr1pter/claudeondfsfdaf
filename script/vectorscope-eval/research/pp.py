# Session origin: round-two scratchpad rpverify/pp.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, sys, numpy as np
ap = argparse.ArgumentParser(description="ApacheJIT fixed points per project, and band rates in the training years.")
ap.add_argument("data", help="dataset/apachejit_total.csv from ApacheJIT at ddfd547 (README.md, Inputs)")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
rows = [r for r in csv.DictReader(open(args.data)) if r["project"] != "apache/hadoop"]
g = lambda f: np.nan_to_num(np.array([float(r[f]=="True") if f in ("fix","buggy") else float(r[f]) for r in rows]))
y, year, la, ld, nd, ent, nuc = [g(f) for f in ["buggy","year","la","ld","nd","ent","nuc"]]; proj = np.array([r["project"] for r in rows])
te = year >= 2017
diff = np.select([la<=10, la<=50, la<=200], [0,1,2], 3) + (ld>50) + np.select([nd<=1, nd<=3], [0,1], 2) + (ent>=1)
hist = np.select([nuc<4, nuc<16], [0,1], 2)
for nm, s in (("diff-only", diff), ("diff+churn", diff+hist)):
    a=[auc(s[te&(proj==p)], y[te&(proj==p)]) for p in sorted(set(proj)) if y[te&(proj==p)].sum()>=20 and (te&(proj==p)).sum()>=200]
    print(nm, "n proj", len(a), "mean", round(np.mean(a),3), "min", round(min(a),3), "max", round(max(a),3))
# cutpoints chosen on test? check train-period bug rates by band
tr=~te
b=np.select([diff<=3, diff<=5],[0,1],2)
for k in range(3):
    m=tr&(b==k); print("train band",k,"share",round(m.sum()/tr.sum(),2),"buggy",round(y[m].mean(),3))
print("train AUC diff-only", round(auc(diff[tr],y[tr]),3), "test base", round(y[te].mean(),3))
