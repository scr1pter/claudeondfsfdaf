# Contracts candidate: original Evidence Workbench sources

This publication preserves the original first-submission application bytes from
both completed contracts-evidence arms at candidate revision
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`. These are original sources, not
normalized review copies. Both arms settled without repair.

| Submission | Original archive files | Published source files | Excluded generated artifacts |
| --- | ---: | ---: | ---: |
| [Vector first](vector-first/source) | 15 | 15 | 0 |
| [Codex first](codex-first/source) | 28 | 20 | 8 |

Every archive path, including hidden paths, was inspected against the original
runner snapshot and the fixed selected-source inventory. `TASK.md`, `bun.lock`,
protected fixtures, authored tests and hidden `.gitignore` files are retained.
Codex's authored `.verification/REPORT.md`, `.verification/browser-check.cjs`, and
`.verification/restart-check.cjs` remain included even when Git ignores them.
No source bytes were edited, renamed, formatted, or normalized.

The eight Codex exclusions are generated verification artifacts: three SQLite
database/shared-memory/write-ahead-log files, two browser log files, and three
mobile observation/action/screenshot result files. Their exact relative paths,
SHA-256 hashes and byte lengths remain in [manifest.json](manifest.json); their
contents are excluded. The complete original archive digest covers both included
and excluded hashes. No generic hidden-directory, `build`, or `dist` filter is
used, and no authored verification file is excluded.

## Static verification

From this directory:

```text
python verify.py
```

After the repository owner stages every included file, including ignored
authored verification files, verify actual staged Git bytes and attributes:

```text
python verify.py --git-index
```

The static verifier checks all 35 included files, complete archive digests,
explicit eight-artifact hash/length accounting, hidden authored files, source
secret/private-user-path patterns, and effective `-text` attributes. Index mode
also checks every actual staged source blob; a missing ignored file or changed
line ending fails. Preparation does not assert that files are already staged or
committed. Neither mode starts an app, runs application tests, uses Bun, installs
dependencies, or calls a provider. Pattern scanning is bounded evidence, not a
formal secret audit.

## Gate provenance and limits

Both original first submissions passed 18 API and 8 browser checks, with exit code
0 and authored source unchanged, under task digest
`1c9887ee0aacb62830942559ac845dda8c3e5d9a5765f20a17e38b67a0e20094`.
The shared-client profile audit reported `no_clear_bypass_observed`, a bounded
observation rather than a hard execution fence or proof of adherence.

Authored test scripts and reports remain original submission evidence; their
claims do not replace independent acceptance. Source file counts or passing
synthetic checks do not establish production readiness. The separate
[result report](../../results/contracts-evidence.md) records usage-derived charges
and bounded fixed blinded review results. No overall candidate decision
is established before the third task is evaluated.
