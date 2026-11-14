# Main integration — 14 November 2026

The owner asked for the surviving feature work to land in `main`. PR #33 assembles it without rewriting the feature
histories. This record concerns source integration, not release publication or permission to activate hosted services.

## Source inventory

| Workstream | Included source | Integration notes |
| --- | --- | --- |
| v2 foundation / Codium / process ownership / release coordination | `main` at `2f8802184` | Kept the staged erasure and Windows Job Object ownership contracts. |
| @Vector, connected workspace, Everywhere | `build-complete` at `00b87034f`, `v2-vector` at `5dbdcfb46`, `v2-connect` at `0c58e7f69`, `v2-everywhere` at `40e708614` | Included continuation repairs; guarded launches refuse before creating a durable background job. |
| VectorScope | `v2-scope` at `76b5619f1` and its folded branches | Renumbered Brain migrations retain aliases for databases that already applied the old IDs. Real Session ownership fixtures replace incomplete test doubles. |
| Hands | `hands` at `4eb9f52fd`, `v2-hands` at `5681ba012` | Preserved early admission and final native pre-spawn checks. Account broadcasts cannot carry Hands overlay messages. |
| Cloud workspaces | `cloud-workspaces` at `d0300404e` | Preserved pilot admission and confirmed remote erasure before account removal. |
| Agent environment | `agent-environment` at `fa938a090` | Terminal input serialization, lifecycle and notification work, browser controls and cleanup; late Hands authority checks remain before every typed byte. |
| Locks | `v2-locks` at `06814f1df` | Included cleanup error reporting and competing directory-creation repairs. |
| Native isolation | `build-native-shell` through `19aabf9ee`, stat-refresh repair `c3ce00d12` | Inactive build; owned/native combinations and fixed helper bypasses refuse before launch. |
| Owner setup / build coordination | `6f4a7c5bb`, `41dac6f72` | Retained as clearly labelled historical proposals and receipts. |

## Repairs made while joining the work

- Enforced the requester's actual read rules, including untracked files and both sides of a rename, before connected
  review consent and again before the provider starts. A later explicit allow remains an allow.
- Persisted rotated Linear credentials before viewer verification. Pending credentials cannot be used by older readers;
  definite identity mismatches remain quarantined. Account deletion and reconnect races retain compare-and-swap fences.
- Quarantined failed exclusive instance cleanup without retaining a dead owner that blocks global disposal. Ordinary
  disposal keeps its existing compatibility contract. Scope-resolution failure falls back without enabling project trust.
- Preserved the original Windows startup error across Effect boundaries and owned cancellation; the regression exercises
  a real isolated child rather than weakening a cleanup deadline.
- Fixed the combined browser fixture build to resolve Vite's configuration callback before merging its settings.
- Removed temporary compatibility/diagnostic workflows and retained permanent dispatchable validation lanes for `main`.
- Kept review leases valid across harmless Git stat-cache refreshes while comparing the actual staged entries, tree and
  HEAD/ref. A captured private index remains private; real content, mode, staged and ref changes still invalidate it.
- Kept confirmed Everywhere publication receipts stable across retry/restart. Ambiguous pushes say to check the remote,
  and bounded atomic journal writes cannot replace the last readable file with an oversized record.

## Validation ledger

These are completed checks at their recorded integration stages, not claims that every check ran on the final PR head.
The current exact-head GitHub checks remain the merge gate.

| Check | Completed result | Limits |
| --- | --- | --- |
| Workspace package types | All 27 packages across the initial integration and affected-package repairs | Recheck affected packages after new source changes. |
| Agent-environment combined types | Schema, Core, Engine, App, Desktop passed | App/desktop required removing a duplicated notification import. |
| Exclusive instance ownership regression | 13 passed, 64 assertions | Actual store, bootstrap, disposer and cancellation lifecycle; no company data. |
| Merged terminal safety regression | 16 passed, 63 assertions | 39 explicit POSIX PTY cases skipped on Windows; these require Linux CI. |
| Connected read policy / hub / qualified capability | 42 / 41 / 3 passed; 767 / 321 / 15 assertions | Genuine provider-success and secret-negative paths require Linux private-Git qualification. |
| Linear OAuth / webhook regression | 15 / 15 passed; 112 / 146 assertions | Four webhook cases explicitly require disposable Redis in CI. API typecheck passed. |
| Everywhere runner / ledger / engine regressions | 47 passed; 773 assertions | Source-level fixtures and real atomic file preservation; the production runner is still held pending VE-21 composition. |
| Native pure policy / adapter / spawner checks | 134 passed | Four explicit Windows/platform skips; Core and Engine types passed. Real-host bootstrap remains unqualified. |
| Prior integrated account erasure regression | 34 passed; 369 assertions | One explicit Valkey-dependent skip; held loopback HTTP exercises the unchanged one-second abort deadline. |
| Generated clients | Client generator and legacy SDK build passed in initial integration | Regenerate after the last public API merge; commit only actual drift. |
| First shared candidate `fbf1eb1b3` | Vercel preview build, cloud-workspace lane, public-sharing lane and standalone-installer lane passed | Browser fixture callback and task fixture owner-model failures were diagnosed and fixed afterward; this head does not qualify later changes. |

Initial full task-provider Linux CI selected no owner VectorScope model and refused before consent. The test fixture now
selects its disposable owner-global test model. No product model fallback, private-Git boundary, timeout, provider,
lineage, spend or cancellation assertion was relaxed to hide the failure.

## Qualification and owner gates

- All existing experimental flags remain off by default. Source inclusion does not list Codium perks or enable cloud
  agents, native isolation, GitHub Brain transport, Everywhere, connected workflows or cloud workspaces.
- Native isolation still needs a qualified real-host bootstrap, cleanup and adversarial matrix. The last completed
  diagnostic (`43621985900`, `f141ef16e`) passed 31 pure policy cases and metadata preflights, then refused prepare at
  bubblewrap's inaccessible host-temp destination before keeper startup; cleanup proof remained refused. It is not an
  isolation pass. No mask or cleanup policy was relaxed to make that run green.
- The legal branch contains live consent/version/page changes, despite its historical "docs-only" label. Those proposals
  are archived under `owner-actions/proposals/codium-legal` per the owner's 14 November decision; the current deployed
  terms, consent date and active policy tests are preserved. The archive is review material and is not built or published.
- Provider/payment acceptance, platform app registration, protected secrets, code signing, release publication and live
  company deployments remain separate owner-controlled gates.
- V27 encrypted session save/restore and attestation, later VectorScope executors and connected automatic repair remain
  explicit disabled follow-ups under the reviewed Tier C plan. A source merge is not evidence that those workflows run.
- `integration-runtime-boundaries.md` records the remaining production composition and credential-authority contracts.
  Connected adapters currently register VectorScope; source for Hands/GitHub does not automatically register them as
  connected members. Those registrations require their declared lifecycle, cancellation, privacy and budget contracts.
- The Signature design specification is present. The Mac redesign implementation is not represented by an unpushed local
  checkout; this integration does not claim to have imported it.

## Branch cleanup

The raw `evidence/v2-repository-audit-2026-11-14.json` and failed-job snapshot preserve the earlier 79-branch observation.
They are historical data collected before the owner's cleanup, not today's branch count or final-head qualification.

Delete a remote feature branch only after its work is included and its last SHA is recorded. A patch-equivalent or
superseded branch needs an explicit equivalence record. Keep unmerged legal/runtime proposals and active agent branches
until their disposition is recorded; branch deletion must not stand in for finishing their work.
