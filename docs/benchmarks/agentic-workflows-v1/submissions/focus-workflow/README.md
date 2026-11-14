# Focus-workflow repeat: original application sources

This directory publishes the original synthetic Workflow Runner applications
from both completed focus-workflow repeat arms. The candidate product revision
was `893b9629224dc4249f08c0e18712511437a35a22`. These are the actual submitted
source archives, not the normalized copies used for blind review.

| Submission | Original archive files | Published source files | Excluded files | Attempts |
| --- | ---: | ---: | ---: | ---: |
| [Codex first](codex-first/source) | 17 | 17 | 0 | 1 |
| [Vector first](vector-first/source) | 16 | 16 | 0 | 1 |

Both arms settled with one attempt and no repairs. All attempts are included;
there is no selection of a preferred result. Every included byte matches its
original archive and the contemporaneous runner source manifest. `TASK.md`,
dependency locks, protected fixtures, authored tests, SQL migrations, and
authored browser scripts are retained. `.gitattributes` disables source
line-ending normalization. No source was renamed, formatted, or edited.

The publication rule excludes only generated runtime contents beneath the exact
top-level `.verification/` prefix, retaining their path/hash inventory if
present. Neither archive contains such files, so nothing was excluded. No
generic `build` or `dist` pruning was applied. Credentials, machine runtime
configuration, provider transcripts, logs, databases, process markers, and
screenshots are not included in this publication.

## Verify and reproduce

From this directory:

```text
python verify.py
```

This checks all source bytes, file counts, complete archive inventory digests,
and the recorded acceptance metadata without launching an app or calling a
provider. `manifest.json` records every file's SHA-256 and byte length, original
attempt identifiers, source scanning, and task/evaluator provenance.

For experiments, copy one `source` directory into a separate writable scratch
workspace. Its pinned `package.json` and `bun.lock` are included; the task uses
Bun 1.3.14 and provides typecheck, build, test, and start scripts. Keep generated
dependencies, build output, and runtime data outside these immutable evidence
directories. Use the independent [Workflow Runner evaluator](../../workflow-runner/README.md)
for acceptance. Candidate-authored tests and README statements remain original
submission content and do not replace that evaluator.

## Gate provenance and limits

Both arms used the same reviewed keyboard-v2 instrument as the corrected
development baseline. Its task digest is
`bc418928e76adaebed02f7de9339d23c881c0d10bca33adb7b4b5002b6de7547`, published
at Git `c027c80637c993fb9e873407403f2c4f6a1333c3`.
The [instrument revision history](../../workflow-runner/instrument-revisions/postlaunch-keyboard-v2/README.md)
preserves the earlier checker and explains the correction.

Each original first attempt passed 16/16 API groups and 8/8 browser groups with
exit code 0 and authored source unchanged. The publication author ran only
static byte/inventory verification: no Bun, application tests, or model calls.
File counts and passing synthetic functional checks do not establish a quality,
cost, or production-readiness conclusion. Cost and blinded quality reporting
are separate from this source evidence. The earlier original applications
remain available under [baseline submissions](../baseline/README.md).
