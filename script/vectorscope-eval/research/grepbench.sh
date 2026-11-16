#!/bin/bash
# Session origin: round-two scratchpad g1/scripts/grepbench.sh, 2026-11-06. Changes: temporary file under SCRATCH_DIR (was /tmp/gb.out); usage guard;
# -e before each name in the per-name loop, as the combined row already had, so a NAME starting with - is a pattern, not an option.
# See README.md for its inputs, the findings it backs and how to run it.
# usage: grepbench.sh SCRATCH_DIR repo name...
usage() { echo "usage: bash grepbench.sh SCRATCH_DIR REPO NAME... (SCRATCH_DIR outside this repository, for example /tmp/vector-vectorscope/research)"; }
if [ "$1" = --help ] || [ "$1" = -h ]; then usage; exit 0; fi
[ $# -ge 3 ] || { usage >&2; exit 2; }
scratch=$(realpath -m -- "$1") || exit 2
top=$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel 2>/dev/null) && top=$(realpath -m -- "$top")
case "$scratch/" in "${top:-/nonexistent}"/*) echo "grepbench.sh: SCRATCH_DIR must be outside the repository ($top)" >&2; exit 2;; esac
mkdir -p "$scratch" && gb=$(mktemp "$scratch/gb.XXXXXX") || exit 1
trap 'rm -f "$gb"' EXIT
repo=$2; shift 2
cd "$repo" || exit 1
t() { local s=$(date +%s%N); "$@" > "$gb" 2>/dev/null; local e=$(date +%s%N); echo $(( (e-s)/1000000 )); }
med() { printf "%s\n" "$@" | sort -n | sed -n 2p; }
for n in "$@"; do
  a=(); b=()
  for i in 1 2 3; do a+=($(t git grep -l -w -F -e "$n" HEAD)); done
  c=$(wc -l < "$gb")
  for i in 1 2 3; do b+=($(t git grep -l -w -F -e "$n")); done
  echo "$(basename $repo) name=$n files=$c treeish_ms=$(med ${a[@]}) worktree_ms=$(med ${b[@]})"
done
args=(); for n in "$@"; do args+=(-e "$n"); done
a=(); for i in 1 2 3; do a+=($(t git grep -l -w -F "${args[@]}" HEAD)); done
echo "$(basename $repo) combined(${#@} names) files=$(wc -l < "$gb") treeish_ms=$(med ${a[@]})"
