# Contracts candidate: original Workflow Runner sources

This directory preserves the original synthetic application sources from both
completed contracts-workflow arms, using candidate product revision
`a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`. These are the submitted source bytes,
not normalized review copies.

| Submission | Original archive files | Published files | Excluded files | Attempts |
| --- | ---: | ---: | ---: | ---: |
| [Codex first](codex-first/source) | 19 | 19 | 0 | 1 |
| [Vector first](vector-first/source) | 15 | 15 | 0 | 1 |

Each arm completed its first attempt without repair. All settled attempts are
included. Each source file matches its original archive and contemporaneous
runner manifest byte-for-byte. `TASK.md`, `bun.lock`, protected fixtures, authored
tests, SQL, scripts, and both hidden `.gitignore` files are retained. Full hidden
path inspection found no other hidden files or generated runtime artifacts in
either archive, so nothing was excluded. No generic dot-directory, `build`, or
`dist` filter was applied. No source was renamed, formatted, or edited.

The [manifest](manifest.json) records every file's SHA-256 and byte length,
complete archive inventory digests, hidden-file inspection, source scanning, and
gate provenance. Source `.gitattributes` sets `-text` to preserve original bytes
through Git. This preparation does not assert that the files are already staged
or committed.

## Verify and reproduce

From this directory, run the static publication check:

```text
python verify.py
```

After staging all publication files, verify the actual staged Git blobs and
staged source attributes:

```text
python verify.py --git-index
```

Both modes check complete inventories, byte hashes, hidden authored files,
source secret/private-user-path patterns, and recorded acceptance metadata.
Neither launches an application, runs Bun, installs dependencies, or calls a
provider. `--git-index` compares the bytes returned by Git for every staged source
blob, so a missing ignored file or line-ending conversion fails the check. The
pattern scan is bounded evidence, not a formal secret audit.

For application experiments, copy one `source` directory into a separate writable
scratch workspace. Preserve its pinned package and lock files, and keep generated
dependencies, build output, and runtime data outside these immutable evidence
directories. Use the independent [Workflow Runner evaluator](../../workflow-runner/README.md)
for acceptance. Candidate-authored tests and README claims do not replace that
evaluator.

## Gate provenance and limits

Both arms used the reviewed keyboard-v2 task digest
`bc418928e76adaebed02f7de9339d23c881c0d10bca33adb7b4b5002b6de7547`, published
at Git `c027c80637c993fb9e873407403f2c4f6a1333c3`. Each first attempt passed
16/16 API and 8/8 browser groups with exit code 0 and authored source unchanged.
The shared-client profile audit recorded `no_clear_bypass_observed`; that bounded
observation is not a hard execution fence or proof that every bypass is impossible.

The publication author performed only static byte, inventory, attribute, and
pattern checks. Passing synthetic gates and source file counts do not establish
universal quality, production readiness, or cost savings. The separate
[task result report](../../results/contracts-workflow.md) covers bounded blinded
quality review, usage-derived charges, and the study's per-task quality criterion.
