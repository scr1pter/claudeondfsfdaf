# Session origin: round-two scratchpad scripts/hist_eval2.py, 2026-11-06. Changes: argparse; jitlib.py loaded with runpy.
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, csv, pathlib, runpy, numpy as np
ap = argparse.ArgumentParser(description="Bug rates by source/test mix and sensitive paths within size buckets.")
ap.add_argument("features", help="the CSV hist2.py wrote")
args = ap.parse_args()
auc = runpy.run_path(str(pathlib.Path(__file__).with_name("jitlib.py")))["auc"]
R = list(csv.DictReader(open(args.features)))
g = lambda k: np.array([float(r[k]=="True") if k in ("buggy","fix") else float(r[k]) for r in R])
y = g("buggy"); year = g("year"); te = year >= 2017; tr = ~te
files = g("files"); tests = g("tests"); sens = g("sens"); docs=g("docs"); la = g("la")
src = files - tests - docs
cat = np.select([src==0, tests==0], ["no-src(tests/docs only)", "src, no tests"], "src+tests")
print("share sensitive", sens.mean().round(3))
for lo, hi in [(0,20),(20,100),(100,10**9)]:
    m = (la>=lo)&(la<hi)
    for c in ["no-src(tests/docs only)","src, no tests","src+tests"]:
        mm = m&(cat==c)
        if mm.sum()>=30: print(f"  la[{lo},{hi}) {c:24s} n={mm.sum():5d} buggy={y[mm].mean():.3f}")
    for v in [0,1]:
        mm = m&(sens==v)
        if mm.sum()>=30: print(f"  la[{lo},{hi}) sensitive={v} n={mm.sum():5d} buggy={y[mm].mean():.3f}")
print("AUC tests-touched", round(auc(tests>0, y),3), "AUC sensitive", round(auc(sens, y),3), "AUC no-src", round(auc((src==0).astype(float), y),3))
