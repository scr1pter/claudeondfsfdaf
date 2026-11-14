# Session origin: round-two scratchpad g2/bin/feat.py, 2026-11-06. Changes: only feats() kept (its main block read the gated job list).
# See README.md. A helper that other scripts load with runpy.run_path; it does nothing when run on its own.
import json, sys, os, math, re
LOCK = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|(^|/)(vendor|dist|node_modules)/|\.snap$|(^|/)__snapshots__/|\.(svg|png|jpg|gif|ico|pdf)$")
SENS = re.compile(r"auth|secur|crypt|acl|permission|token|password|credential|secret|oauth|session|login|ssl|tls|key", re.I)
TEST = re.compile(r"(^|/)(tests?|__tests__|spec)/|[._-](test|spec)\.\w+$|Test\w*\.\w+$|_test\.go$", re.I)
def feats(path, filt):
    rows = []
    for l in open(path):
        p = l.rstrip("\n").split("\t")
        if len(p) < 3: continue
        a = 0 if p[0] == "-" else int(p[0]); d = 0 if p[1] == "-" else int(p[1])
        if filt and LOCK.search(p[2]): continue
        rows.append((a, d, p[2]))
    la = sum(r[0] for r in rows); ld = sum(r[1] for r in rows); tot = la + ld
    nd = len({os.path.dirname(r[2]) for r in rows}); nf = len(rows)
    ent = -sum(((r[0]+r[1])/tot) * math.log2((r[0]+r[1])/tot) for r in rows if r[0]+r[1] > 0) if tot else 0.0
    sens = any(SENS.search(r[2]) for r in rows); tests = sum(1 for r in rows if TEST.search(r[2]))
    pts = (0 if la <= 10 else 1 if la <= 50 else 2 if la <= 200 else 3) + (ld > 50) + (0 if nd <= 1 else 1 if nd <= 3 else 2) + (ent >= 1)
    band = "low" if pts <= 3 else "medium" if pts <= 5 else "high"
    return dict(la=la, ld=ld, nf=nf, nd=nd, ent=round(ent, 3), sens=sens, tests=tests, pts=pts, band=band, pts_s=pts + sens,
                band_s="low" if pts + sens <= 3 else "medium" if pts + sens <= 5 else "high")
