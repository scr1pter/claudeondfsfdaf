# Original Workflow Runner baseline submissions

These are the original synthetic application sources produced by the first paid
Workflow Runner pair and Vector's repair. They are copied byte-for-byte from the
actual attempt archives, including `TASK.md`, dependency locks, protected
fixtures, authored tests, and authored verification scripts. They are not the
renamed or normalized copies prepared for blind review.

| Submission | Original archive files | Published source files | Excluded generated files |
| --- | ---: | ---: | ---: |
| [Codex first](codex-first/source) | 235 | 17 | 218 |
| [Vector first](vector-first/source) | 14 | 14 | 0 |
| [Vector repair](vector-repair/source) | 15 | 15 | 0 |

The Codex archive's extra files are under the exact top-level `.verification/`
prefix. Inspection found generated test/browser databases, process markers,
screenshots, and runtime reports. Those contents are omitted. The manifest
retains every excluded path, byte length, and SHA-256 hash so the complete
235-file archive inventory remains accountable. Authored tests and verification
scripts outside that prefix are included. No generic `build` or `dist` rule was
used to discard source, and none of the included files were reformatted.

`manifest.json` records exact file hashes, aggregate inventories, original
attempt identifiers, task/evaluator revisions, the publication scan, and the
corrected independent outcomes. `.gitattributes` disables line-ending
normalization only for the copied source trees, preserving their original
bytes. Raw provider transcripts, credentials, machine runtime configuration,
databases, markers, logs, and screenshots are not published here.

## Verify and reproduce

From this directory, verify the source bytes and inventory without running the
applications or contacting a provider:

```text
python verify.py
```

For application experiments, copy one `source` directory into a separate
writable scratch workspace. Its pinned `package.json` and `bun.lock` are
included. The task uses Bun 1.3.14. The package provides `typecheck`, `build`,
`test`, and `start` scripts. Keep generated dependencies, build output, and
runtime data in that scratch workspace; the published evidence directories
should remain unchanged.

Functional acceptance uses the independent [Workflow Runner evaluator](../../workflow-runner/README.md),
with explicit local tool paths and disposable synthetic data. Application-authored
test scripts and their README claims are historical submission content; they do
not replace the independent gate. This publication step ran only static byte
and inventory verification, without Bun, application tests, or model calls.

## Evaluation provenance

The original task digest was
`722a00ba024522e2e88aee585f778dad206b115a30a8d1caded38681cf7cd761`, frozen at
Git `44f93362a683d39198ead037beb639abc828fb63`. The postlaunch
[keyboard-v2 instrument correction](../../workflow-runner/instrument-revisions/postlaunch-keyboard-v2/README.md)
is explicit and preserves the original instrument bytes. Its task digest is
`bc418928e76adaebed02f7de9339d23c881c0d10bca33adb7b4b5002b6de7547`, published
at Git `c027c80637c993fb9e873407403f2c4f6a1333c3`.

The study owner reevaluated all three unchanged original archives under the
same corrected instrument. Each passed 16/16 API groups and 8/8 browser groups,
with exit code 0 and source integrity unchanged. The published source subset
was not rerun by the publication author. File counts describe provenance, not
quality or cost. Original outcomes and every repair charge remain retained;
this source publication makes no savings, quality, or production-readiness
claim.
