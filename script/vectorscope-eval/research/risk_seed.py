# New in VS-28c (no session original): seeds packages/core/src/review/risk.ts RISK_CUTPOINTS from numstat only.
# See README.md for its inputs, the constant it backs and how to run it. Results never land in the repository (I-13).
#
# It computes risk.ts's likelihood score per PR, so keep the two in step: log2(1 + added + deleted), plus
# 0.25 * min(max(dirs - 1, 0), 7) / 7, plus 0.25 * min(entropy, 3) / 3, where dirs counts distinct parent directories
# (the root as one) and entropy is in bits over the files with changed lines. The cutpoints are the --medium and --high
# percentiles of the scores (numpy's default linear interpolation), rounded to --decimals; a score above a cutpoint takes
# the higher band, one at it the lower. No label is read: the seed is unsupervised.
#
# "raw" reads every numstat row, lockfiles and binaries included (round two's band analysis). "filtered" first drops the
# rows risk.ts would never see, mirroring ignore.ts classifyPath under the default ignores: LOCKFILES by file name,
# DEFAULT_IGNORES, binary extensions, and binary rows ("-"). It does not mirror a repository's own ignore globs or
# .gitattributes. Keep these lists in step with ignore.ts too.
import argparse, math, os, re, sys

import numpy

LOCKFILES = {"bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "Gemfile.lock", "flake.lock", "Podfile.lock", "pubspec.lock", "mix.lock", "packages.lock.json"}
# DEFAULT_IGNORES as regexes: `**/x/**` anywhere, `x/**` at the root only, and `**/*.ext` by suffix (minimatch, dot: true).
IGNORED = re.compile(r"(^|/)(dist|\.next|coverage|node_modules|__snapshots__|__generated__)/|^(build|out|vendor)/|\.min\.js$|\.min\.css$|\.map$|\.snap$|\.pb\.go$|_pb2\.py$|(^|/)[^/]*\.generated\.[^/]*$")
BINARY = set(("png jpg jpeg gif bmp ico icns webp avif tif tiff psd heic pdf zip gz tgz bz2 xz zst 7z rar tar jar war ear "
              "exe dll so dylib a lib o obj class pyc pyo wasm bin dat node dmg iso apk aab ipa woff woff2 ttf otf eot mp3 "
              "mp4 m4a m4v mov avi mkv webm wav flac ogg sqlite sqlite3 db p12 pfx jks keystore").split())


def score(added, deleted, dirs, entropy):
    return math.log2(1 + added + deleted) + 0.25 * min(max(dirs - 1, 0), 7) / 7 + 0.25 * min(entropy, 3) / 3


def ignored(path, binary):
    name = path.rsplit("/", 1)[-1]
    dot = name.lower().rfind(".")
    return binary or name in LOCKFILES or bool(IGNORED.search(path)) or (dot > 0 and name.lower()[dot + 1:] in BINARY)


def features(path, filtered):
    # One PR's (lines, score) from its numstat: "added<TAB>deleted<TAB>path" rows, "-" for a binary file's counts.
    rows = []
    for line in open(path, encoding="utf-8", errors="replace"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3: continue
        binary = parts[0] == "-" or parts[1] == "-"
        if filtered and ignored(parts[2], binary): continue
        rows.append((0 if parts[0] == "-" else int(parts[0]), 0 if parts[1] == "-" else int(parts[1]), parts[2]))
    added = sum(r[0] for r in rows); deleted = sum(r[1] for r in rows); total = added + deleted
    entropy = -sum(((r[0] + r[1]) / total) * math.log2((r[0] + r[1]) / total) for r in rows if r[0] + r[1] > 0) if total else 0.0
    return total, score(added, deleted, len({os.path.dirname(r[2]) for r in rows}), entropy)


def report(label, prs, medium_q, high_q, decimals, at=None):
    # Prints the percentiles and their rounded cutpoints, then the band shares at `at` (default: those cutpoints).
    scores = numpy.array([s for _, s in prs]); lines = numpy.array([n for n, _ in prs])
    exact = numpy.percentile(scores, [medium_q * 100, high_q * 100])
    own = tuple(round(float(v), decimals) for v in exact)
    medium, high = at or own
    print(f"{label}: n {len(prs)}; p{medium_q * 100:g} {exact[0]:.4f}, p{high_q * 100:g} {exact[1]:.4f}; cutpoints medium {own[0]} high {own[1]}")
    print(f"  shares at medium {medium} high {high}{' (the raw cutpoints)' if at else ''}:")
    for band, keep in (("low", scores <= medium), ("medium", (scores > medium) & (scores <= high)), ("high", scores > high)):
        print(f"    {band}: {int(keep.sum())} PRs ({keep.mean():.1%}), {lines[keep].sum() / lines.sum():.1%} of changed lines")
    return own


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Seeds risk.ts RISK_CUTPOINTS from numstats of the AACR permissive PRs.")
    ap.add_argument("jobs", help="aacr_jobs.py's TSV; only its keys are read, so no non-permissive numstat is")
    ap.add_argument("numstat_dir", help="aacr2.sh's OUT_DIR/numstat (KEY.numstat per job; a job without one is skipped)")
    ap.add_argument("--medium", type=float, default=0.5, help="the medium cutpoint's percentile, as a fraction (default 0.5)")
    ap.add_argument("--high", type=float, default=0.85, help="the high cutpoint's percentile, as a fraction (default 0.85)")
    ap.add_argument("--decimals", type=int, default=2, help="decimals the cutpoints are rounded to (default 2)")
    args = ap.parse_args()
    if not 0 < args.medium < args.high < 1: ap.error("need 0 < --medium < --high < 1")
    if not 0 <= args.decimals <= 6: ap.error("--decimals must be 0 to 6")
    keys = []
    for i, line in enumerate(open(args.jobs)):
        key = line.split("\t", 1)[0]
        if not re.fullmatch(r"aacr_[0-9a-f]{10}", key): sys.exit(f"risk_seed.py: row {i + 1}: key {key!r} is not aacr_ and 10 hex digits, as aacr_jobs.py writes it")
        keys.append(key)
    found = [k for k in keys if os.path.isfile(os.path.join(args.numstat_dir, k + ".numstat"))]
    if not found: sys.exit("risk_seed.py: no numstat for any job in " + args.numstat_dir)
    print(f"jobs {len(keys)}; with a numstat {len(found)}; skipped {len(keys) - len(found)}")
    # risk.ts ships the raw cutpoints (round two's convention); the filtered scores are shown at them, and at their own.
    prs = {f: [features(os.path.join(args.numstat_dir, k + ".numstat"), f) for k in found] for f in (False, True)}
    raw = report("raw", prs[False], args.medium, args.high, args.decimals)
    report("filtered", prs[True], args.medium, args.high, args.decimals, at=raw)
    report("filtered", prs[True], args.medium, args.high, args.decimals)
    # Cross-checks against risk.test.ts: the second puts dirs and entropy past their caps.
    for added, deleted, dirs, entropy in ((100, 4, 3, 1.5), (900, 123, 12, 4.2)):
        print(f"example added {added} deleted {deleted} dirs {dirs} entropy {entropy}: {score(added, deleted, dirs, entropy):.5f}")
