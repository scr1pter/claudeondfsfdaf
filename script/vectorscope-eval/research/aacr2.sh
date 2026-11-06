#!/bin/bash
# Session origin: round-two scratchpad g2/bin/aacr2.sh, 2026-11-06. Changes: OUT_DIR argument, absolute and outside the repository; usage guard;
# format checks on KEY, URL, BASE, HEAD and SINCE; --end-of-options before git's repository and revision arguments.
# See README.md for its inputs, the findings it backs and how to run it.
# usage: aacr2.sh OUT_DIR KEY URL BASE HEAD SINCE   (one row of aacr_jobs.py's TSV; writes OUT_DIR/numstat/KEY.numstat)
usage() { echo "usage: bash aacr2.sh OUT_DIR KEY URL BASE HEAD SINCE (OUT_DIR outside this repository, for example /tmp/vector-vectorscope/research/aacr)"; }
if [ "$1" = --help ] || [ "$1" = -h ]; then usage; exit 0; fi
[ $# -eq 6 ] || { usage >&2; exit 2; }
# KEY names a file and a folder that is removed, so it must be a job key of aacr_jobs.py and nothing else.
[[ "$2" =~ ^aacr_[0-9a-f]{10}$ ]] || { echo "aacr2.sh: KEY must be aacr_ and 10 hex digits, as aacr_jobs.py writes it" >&2; exit 2; }
# URL, BASE, HEAD and SINCE reach git, so none of them may read as an option or point anywhere but GitHub.
[[ "$3" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "aacr2.sh: URL must be https://github.com/OWNER/REPO" >&2; exit 2; }
[[ "$4" =~ ^[0-9a-f]{40}$ && "$5" =~ ^[0-9a-f]{40}$ ]] || { echo "aacr2.sh: BASE and HEAD must be 40-hex SHAs" >&2; exit 2; }
[[ "$6" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "aacr2.sh: SINCE must be YYYY-MM-DD" >&2; exit 2; }
G=$(realpath -m -- "$1") || exit 2
top=$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel 2>/dev/null) && top=$(realpath -m -- "$top")
case "$G/" in "${top:-/nonexistent}"/*) echo "aacr2.sh: OUT_DIR must be outside the repository ($top)" >&2; exit 2;; esac
mkdir -p "$G/numstat" "$G/git" || exit 1
key="$2"; url="$3"; base="$4"; head="$5"; since="$6"
out="$G/numstat/$key.numstat"; [ -s "$out" ] && exit 0
d="$G/git/$key"; rm -rf "$d"; git init -q "$d"; cd "$d" || exit 1
git remote add origin "$url"
timeout 900 git fetch -q --filter=tree:0 --shallow-since="$since" --end-of-options origin "$base" "$head" 2> "$out.err" || { cd "$G"; rm -rf "$d"; exit 1; }
mb=$(git merge-base --end-of-options "$base" "$head") || { echo NOMB >> "$out.err"; cd "$G"; rm -rf "$d"; exit 1; }
echo "$mb" > "$out.mb"
timeout 1200 git diff --no-renames --numstat --end-of-options "$mb" "$head" > "$out.tmp" 2>>"$out.err" && mv "$out.tmp" "$out"
cd "$G"; rm -rf "$d"
