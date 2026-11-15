# Vector Hands: current state

A plain summary on 15 November 2026, at `hands-finish` after HF-3. The evidence ledger is [hands-progress.md](./hands-progress.md); where this page and the ledger differ, the ledger wins. Hands is unreleased and unversioned. Nothing here is release, signing or device approval. Counts such as 30/0/1 are passed/failed/skipped.

## What is done

- All 73 source work packages are implemented ([current checkpoint](./hands-progress.md#current-continuation-automated-ci-and-unsigned-packages-passed-owner-device-and-release-gates-remain)).
- The `hands` branch (tip `4eb9f52f`) is joined into PR #33 (`release-finish`). PR #33 is not merged into `main` yet.
- The owner-approved W9 redesign, one-time calibration plus a listener heartbeat, is implemented ([W9 proposal](./hands-deviations.md#w9-proposal-for-owner-review--real-calibration-and-a-separate-listener-heartbeat)).
- HF-1 merged the native-stop-fix Windows diagnostics on `hands-finish`, not yet in PR #33, and kept helper `1.0.15` ([HF-1](./hands-progress.md#hf-1--native-stop-fix-merged-at-helper-1015-15-november-2026)).
- HF-2 added the MCP and PTY isolation-order tests. It found that an isolation refusal inside MCP's `localTransport` already ends as a failed status, because `MCP.create`'s `Effect.catchCause` (`packages/engine/src/mcp/index.ts:553-559`) turns it into `{ status: "failed" }`, so no code change was needed ([HF-2](./hands-progress.md#hf-2--mcp-and-pty-isolation-order-tests-15-november-2026)).

## Last fully passing automated evidence (a0e5ce8e)

- Full PR CI [run 43560683817](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43560683817) at `a0e5ce8e`: 27 successful jobs, 11 skipped, none failed. Windows core 30/0/1, isolated 37/0/11.
- The unsigned artifacts-only [preview 43560764334](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43560764334) at the same source: 31 successful jobs, 3 skipped, none failed. The final Windows x64 and native ARM64 verifiers, both Mac helper verifiers and the Linux package checks passed. Windows was unsigned, Mac ad-hoc, and nothing was published.
- `packages/desktop/native` and `computer-helper.yml` are identical at `a0e5ce8e`, `f830e3fd`, `0ee486e3` and `cf2373c4`; the only desktop script change among them is the test file `computer-workflow.test.ts`, between `a0e5ce8e` and `f830e3fd`. `hands-finish` adds Windows-only native diagnostics plus the unused `test.yml` Mac measurement route (HF-1) and tests (HF-2), none of which has run in CI yet.

## PR #33 computer-helper observations

The isolated step continues on error when `privileged-required` is false, as in PR runs (`computer-helper.yml:718`), so its failed rows do not fail the job. In all three runs mac-build passed and mac-test and windows-arm64-test were skipped. Each whole run concluded failure. In run 43631024090 the Hands windows-build job `132558654772` also failed, at its staged Stop step; every other failed job in the three runs is outside the computer-helper workflow.

| Run, head                                                                                       | windows-build job | Core   | Isolated                                                                                               | Staged Stop                                             | Job     |
| ----------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------- |
| [43631024090](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024090), `f830e3fd` | `132558654772`    | 30/0/1 | 36/2/10: aggregate and `apps-running-target` (`native_operation_failed`)                               | failed: `stop-root-retired` / `core_failure:no_ui_tree` | failure |
| [43636452606](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43636452606), `0ee486e3` | `132574657019`    | 30/0/1 | 36/2/10: the same two rows                                                                             | passed                                                  | success |
| [43656696007](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43656696007), `cf2373c4` | `132636926176`    | 30/0/1 | 35/3/10: aggregate, `capture-color-patch` and `capture-affinity-exclusion` (`native_operation_failed`) | passed                                                  | success |

`apps-running-target` passed at `a0e5ce8e` and was not among the failed or skipped rows at `cf2373c4`. The native source did not change across these runs, yet the failed rows and the Stop result differed. No cause is established.

## Side branches

- `hands-diagnostics` (`ead16339`) was ancestry-merged by `eddd80dc`, a no-content merge. The [disposition audit](./hands-diagnostics-disposition.md) found nothing missing.
- `native-stop-fix` (`a0fbfa3b`) was merged by HF-1 (`6179bd42`), with `identity.json` restored to `1.0.15` (`acd0c9bb`), so no measured macOS input changed.

## Open engineering items

- Windows staged Stop failed at `f830e3fd` and passed at `0ee486e3` and `cf2373c4` on identical native source; no cause is established.
- Windows x64 isolated rows: `apps-running-target` at `f830e3fd` and `0ee486e3`; the capture color patch and affinity exclusion at `cf2373c4`.
- ARM64 at `503418a1` (job `132576158733`): privileged 34/4/10, the aggregate row plus `apps-running-target`, `capture-affinity-exclusion` and `input-listener-health` ([diagnostic note](./hands-uia-timeout-diagnostic.md)).
- HF-4 Windows native rows: x64 and ARM64 at `hands-finish`, through `test.yml` with `computer_helper=true` and `computer_helper_target=windows`.
- HF-2's MCP `refused` branch on the Windows engine shards: a separate default-input `test.yml` dispatch on `hands-finish`, or the lane PR's run. A `computer_helper` dispatch skips the engine shards (`test.yml:747` and `:799`).
- Mac lock confirmation at the merged source, in the lane's final full `test.yml`.
- Packaging at the merged source: the artifacts-only preview accepts only `refs/heads/hands` (`vector-desktop-release.yml:74`; see [release artifacts](./hands-release-artifacts.md)).
- Direct `computer-helper.yml` dispatch returned HTTP 404 on 14 and 15 November 2026, while the file was not on `main`; the lane uses `test.yml`.

## Owner gates

These are in the [owner checklist](../owner-actions/hands-release.md). No lane does or decides them.

- Production signing: Apple Developer ID and notarization, Azure Trusted Signing, `VECTOR_WINDOWS_PUBLISHER_NAME` and `VECTOR_COMPUTER_HELPER_PUBLISHER_SUBJECT` ([signing configuration](./hands-release-artifacts.md#signing-configuration)).
- The [Clean Mac checklist](../owner-actions/hands-release.md#clean-mac-checklist). Reset (`VECTOR_COMPUTER_RESET_VERIFIED=1`) only after recorded helper-only results on macOS 14, 15, 26 and 27, and the Apple persistent-content-capture entitlement question.
- The [Windows 11 checklist](../owner-actions/hands-release.md#windows-11-checklist), including an ARM64 device run.
- Legal text, the name, helper icon and System Settings names, the trademark search, and the final docs and release notes.
- Owner decisions O1, O3, O4 and O5 ([build spec section 1.9](./hands-build-spec.md#19-owner-decisions-and-manual-checks-for-this-section)).
- Which ref may run the artifacts-only preview once `hands` is retired.
- Codium gateway image acceptance ([provider and publication gates](../owner-actions/hands-release.md#provider-and-publication-gates)).
- The release version, tag, installers, update feeds and `publishedDesktopVersion`.
- Any change to the macOS helper bytes, which needs a new Mac measurement.
