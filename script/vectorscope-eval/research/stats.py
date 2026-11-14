# Session origin: round-two scratchpad g2/bin/stats.py, 2026-11-06. Unchanged apart from this header.
# See README.md. A helper that other scripts load with runpy.run_path; it does nothing when run on its own.
import numpy as np, random
def rank(x):
    x = np.asarray(x, float); o = np.argsort(x, kind="mergesort"); r = np.empty(len(x)); r[o] = np.arange(1, len(x) + 1)
    _, inv, cnt = np.unique(x, return_inverse=True, return_counts=True); s = np.bincount(inv, weights=r); return (s / cnt)[inv]
def spearmanr(x, y, n=5000):
    rx, ry = rank(x), rank(y); rho = np.corrcoef(rx, ry)[0, 1]
    rng = np.random.default_rng(3); c = sum(abs(np.corrcoef(rx, rng.permutation(ry))[0, 1]) >= abs(rho) - 1e-12 for _ in range(n))
    return round(float(rho), 3), round((c + 1) / (n + 1), 4)
