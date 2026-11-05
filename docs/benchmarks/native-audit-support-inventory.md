# Future native audit support inventory

This instrument correction is based on stage revision `d858eda13c25d3e889c3fa8d86bdd7f52dd9c941` and is intended for future stages. It does not rewrite or requalify either frozen R2 arm, its applications, receipts, native transcripts, or original audit verdict.

## Reproduced inventory exception

The closed Codex audit raised `StudyError: linked paths are not part of a frozen input`. A read-only reproduction used copies of all seven private transcripts and the exact frozen instrument hashes. The throw site was `paired_runner.audit_descendants` at the final `common.manifest(support)` call, followed by the common runner's `manifest`, `inside`, and `require` functions. The generic frozen-input manifest rejected a reparse entry in mutable owned `DATA_DIR`; this was not a detected forbidden native command.

The diagnostic confirmed that all original transcript, normalized audit-event, closure, witness, and result file hashes remained unchanged. Its provenance is:

| Item | SHA-256 |
| --- | --- |
| Original paired runner file | `982252d765730ceb72cf92c69625b341be1997b34d80d28fcd7fd485cecfc258` |
| Original common runner file | `79d00e7b7147da44699cc70cf9c2ab86cb4ab1b5adf41a3bfcd1b25ce57cb5d0` |
| Private read-only diagnostic report, raw bytes | `16807ba58378b91d0030d0544df03b23a49291f209dceaf29343deb37161214f` |
| Original Codex result, canonical JSON digest | `2c82451300de32172963d85a884717d6f9f6ef29555a06b73c0d41811a8e259b` |
| Same original Codex result, raw file bytes | `64ac42f805500ef6558218aadf224728d2f4d254984ec3157681946814647b83` |

Canonical JSON uses sorted keys, compact separators, and `ensure_ascii=False`. The two result hashes describe different serializations of the same unchanged result. Private reports retain the diagnostic details; no raw commands, prompts, native identities, credentials, or model reasoning are published here.

## Scoped future change

Only mutable owned support-data counting uses the new `owned_support_inventory`. The frozen-input manifest remains unchanged. The inventory counts ordinary files, directories, and reparse entries without opening file content or descending through links. Target classification reads bounded link metadata, resolves earlier link components before `..`, rejects outside hops before inspecting their targets, and handles cycles, missing targets, unknown reparse forms, unsupported Windows namespaces, inaccessible metadata, and entry/depth/hop limits as manual review.

Internal links do not duplicate target files in the count. An outside or unresolved target remains review-required. Linked roots and linked root ancestors are not traversed. Inventory uncertainty is combined with existing native, ordering, script, interactive-input, and verification flags; it cannot clear them. This is bounded posthoc observation, not a filesystem sandbox guarantee.

A metadata-only probe of the unchanged closed Codex support directory counted 205 regular files, 234 directories, and 30 reparse entries: 16 junctions and 14 symlinks, all resolving within the owned support root. No link target content was opened. That inventory result is not a corrected quality pass. The original native audit remains review-required, including its original unresolved script, native-outcome, and interactive observations.

## Pure Python validation

Two integration controls failed against the original paired-runner source with the same `StudyError`, then passed with the scoped inventory. An earlier negative-control invocation used the wrong unittest class name and was corrected; that invocation is not counted as a reproduced regression.

The final inventory control set ran **78 tests: 77 passed and one explicit platform skip** on Windows. The skipped FIFO fixture requires a POSIX FIFO API. Real Windows junction coverage passed. Controls include ordinary files, internal and external links, internal-to-external chains, dangling targets, cycles, safe relative parent paths, compound parent/link ambiguity, linked roots and ancestors, Windows rooted/drive-relative targets, unsupported device namespaces, resource bounds, no content reads, and preservation of unrelated audit flags.

The existing heavy fixture now creates its empty owned `DATA_DIR`, matching `NativeAdapter.prepare`; no assertion was removed or weakened. Independent review found no remaining inventory issue.

Run from `scripts/benchmarks/matched-headless-stage`:

```sh
python -B -m unittest test_paired_runner test_heavy_runner test_support_inventory
```

No Bun, Chrome, native runtime, provider, or paid controller was started for these controls.

## Future known-failed command normalization

A second, separate correction preserves a fully observed native Codex `CommandExecution` with status `failed`, an integer nonzero exit, a concrete command and identifier, and valid ordered timestamps. It remains a failed execution: its original status and exit value are retained in normalized execution metadata and terminal command events, and the command still passes through the existing bounded browser/script audit. Every accepted nonzero integer exit contributes to `knownFailedCommandExecutions`, including the previously accepted `completed` status with a nonzero exit.

The future post-judge verification gate uses the same explicit success criterion for both runtimes. Existing `CommandObserved` fields remain literal observations, including failed commands. Separate `CommandSucceeded` fields require completed tool state, an integer zero exit, and explicit ordered execution start/end after the judge completes. Vector shell/bash uses the real tool's `metadata.exit`; terminal uses `metadata.exitCode` and additionally requires process status `exited`. The actual terminal open/read/wait contract includes those metadata fields; usage and not-found fallbacks do not. No output prose or JSON is parsed to invent an exit. Missing exit/timing, error status, nonzero exit, and running or readiness-only terminals cannot satisfy successful verification. Raw tool output and tool APIs are unchanged.

Split terminal traces currently remain explicitly unproven because safe open/exit correlation is not implemented in this audit: an `open` with a command and running status followed by `wait` or `read` with an exit but no command is not joined. The candidate creates a fresh ascending `PtyID` for each open and the tool does not supply a requested ID; this is an audit coverage limit, not evidence of an application defect or legitimate runtime ID reuse. Such observations remain visible, but cannot qualify successful verification. Controls cover zero and nonzero later exits, mismatched IDs, adversarial reused-ID telemetry, and readiness while still running. Direct shell exits and already-exited terminal opens are separately covered; those positives do not claim coverage of split open/wait execution.

Missing exit or timing fields, noninteger or boolean exits, nonterminal statuses, reversed timestamps, missing commands/identifiers, and contradictory `failed` plus zero exit remain unknown. Invalid timestamp strings keep the existing fail-closed exception. A failed tool never synthesizes native turn completion or clears a native fatal/pending outcome.

The positive normalization control fails against the inventory-only commit for all three synthetic nonzero exit variants, then passes with this correction. Both-runtime verification controls also fail against that earlier source: Vector incorrectly accepts failed verification, while Codex omits the failed command observation. The combined pure Python suite runs **94 tests: 93 pass and the same one explicit FIFO skip**, including 16 failed-command and symmetric verification controls. These cover positive and negative exit values, malformed fields, existing completed-status behavior, failure metadata, explicit native completion/fatal states, descendant coverage, continued browser/script inspection, explicit zero-exit positives, missing exit/timing/process-state negatives, split terminal uncertainty, and the distinction between observed and successful post-judge API/CLI/SDK evidence. Independent source review found no remaining issue.

```sh
python -B -m unittest test_paired_runner test_heavy_runner test_support_inventory test_native_command_failures
```

A separate diagnostic using copied closed transcripts and the future instrument classifies the 22 previously unknown complete nonzero-exit records as known failed commands. It still returns manual review: native outcomes are not all settled, and one unavailable script observation remains. Original R2 files and their original 22 unknown observations are unchanged. This diagnostic is explicitly not requalification or a quality pass.

The unavailable script is a transient generated verification script absent from the final authored snapshot. Its logical text can be recovered from an owned native creation command. A private recovery retained 4,918 UTF-8 text bytes with digest `2a06f516bc7e1bdc7031348ecbaef1c9d78cfc917f792c5aeb65fff7008fe3b3`; that is not a proven original file-byte hash because no writer BOM or trailing newline is assumed. The original unavailable-script review flag remains. No recovered script contents or commands are published here.

Before a future paid stage, native qualification must include a safe intentional nonzero shell command to exercise the actual retained native schema. That native control has not run as part of these Python-only changes. No quality, cache, model, effort, cost, funding, or provider setting changes are included.
