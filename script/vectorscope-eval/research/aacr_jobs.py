# New in VS-21d: rebuilds the AACR job list the session fed to aacr2.sh (g2/aacr2s.tsv, written ad hoc from jobs.py's AACR rows).
# See README.md for its inputs, the findings it backs and how to run it.
import argparse, datetime, hashlib, json, pathlib, re, runpy, sys

# The 10 AACR-Bench repositories VOI13 classified as not permissive (moved here from the session's aacr.py). VOI13's
# licence fetch is not committed (README.md, "Gated"), so this list is its outcome, to be re-derived per PR in VS-22.
NONPERM = {"bluewave-labs/Checkmate","immich-app/immich","nextcloud/server","CherryHQ/cherry-studio","comfyanonymous/ComfyUI","mpv-player/mpv","FreeCAD/FreeCAD","elastic/elasticsearch","n8n-io/n8n","timescale/timescaledb"}


def jobs(samples):
    # One row per positive sample outside NONPERM: key, repository URL, base, head, and the --shallow-since date.
    # source_commit is the base-branch tip and target_commit the PR head (gap-2 §1.2). In round two, every fetch GitHub
    # still served found their merge base within the 120 days before the PR opened.
    # aacr2.sh reads each row back from a TSV and hands the fields to git, so a field that is not a plain GitHub repository
    # or a 40-hex SHA stops the list (exit 1) instead of shifting a column or reading as an option.
    for i, x in enumerate(samples):
        m = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)", x["githubPrUrl"])
        if not m: sys.exit(f"aacr_jobs.py: sample {i}: githubPrUrl {x['githubPrUrl']!r} is not https://github.com/OWNER/REPO/pull/N")
        if m.group(1) in NONPERM: continue
        bad = [c for c in ("source_commit", "target_commit") if not re.fullmatch(r"[0-9a-f]{40}", x[c])]
        if bad: sys.exit(f"aacr_jobs.py: sample {i} ({x['githubPrUrl']}): {' and '.join(bad)} must be a 40-hex SHA")
        key = "aacr_" + hashlib.md5(x["githubPrUrl"].encode()).hexdigest()[:10]
        since = datetime.date.fromisoformat(x["created_at"][:10]) - datetime.timedelta(days=120)
        yield key, f"https://github.com/{m.group(1)}", x["source_commit"], x["target_commit"], since.isoformat()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Writes the permissive AACR-Bench job list (one aacr2.sh call per row).")
    ap.add_argument("samples", help="dataset/positive_samples.json from alibaba/aacr-bench at ee9d7fe (README.md, Inputs)")
    ap.add_argument("--out", required=True, help="the TSV to write, outside the repository (for example /tmp/vector-vectorscope/research/aacr/jobs.tsv)")
    args = ap.parse_args()
    out = runpy.run_path(str(pathlib.Path(__file__).with_name("outguard.py")))["outside_repo"](args.out, "--out")
    rows = list(jobs(json.load(open(args.samples))))
    out.write_text("".join("\t".join(r) + "\n" for r in rows))
    print(len(rows), "jobs in", len({r[1] for r in rows}), "repositories")
