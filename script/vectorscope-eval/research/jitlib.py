# Session origin: round-two scratchpad scripts/jitlib.py (rpverify/jitlib.py is byte-identical), 2026-11-06; APACHE_REVS added.
# See README.md. A helper that other scripts load with runpy.run_path; it does nothing when run on its own.
def auc(s, t):
    import numpy as np
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    o = np.argsort(s, kind="mergesort"); r = np.empty(len(s)); r[o] = np.arange(1, len(s)+1)
    sums = np.bincount(inv, weights=r); r = (sums/cnt)[inv]
    npos = t.sum(); nneg = len(t)-npos
    return (r[t==1].sum() - npos*(npos+1)/2)/(npos*nneg)

# The heads of the round-two bare --filter=blob:none clones of the four Apache repositories (README.md, "Inputs").
# The history scripts walk these commits instead of HEAD, so a clone that lacks one fails instead of matching nothing.
APACHE_REVS = {
    "kafka": "11e9247aca883c49f1b225000c1148a188c98269",
    "groovy": "826394513c2ba1723248a04aca337ccf426cca25",
    "zookeeper": "87e85f28e72384c9e5a1cf089b6e21b2533970c7",
    "zeppelin": "0acbdf9630276d66cbcf1dae97cd50cef9b70646",
}
