# Codium and multiagent integration

The owner resumed the remaining handoff on 31 October 2026. This feature-branch
merge combines `self-evolving` at `b5af4269` with Codium A22 at `4fde1a49`.
Main already entered self-evolving at `78526052`. This does not publish either
feature or enable model routes.

The merge preserves the workflow/fork retry selection and adds Codium's review
purpose beside it. Session imports, billing flags, usage mappings and the
database migration tests retain both branches' changes. Codium's task result
wording moves into the current `TaskNotify.render` implementation; the older
helpers in `tool/task.ts` remain removed. Codium-only and mixed results keep
their distinct usage labels without restoring removed notification code.

The core migration generator rebuilt the combined snapshot, schema and registry.
Its newly emitted SQL for Codium's two columns matched the already committed
`20261031070337_session_codium_steps` migration exactly; only the newly generated
duplicate was removed, and the generator then rebuilt the registry. The original
background-job, audience and Codium migrations are all retained. The legacy SDK
and current client were regenerated from the combined source.

## Validation

Focused static integration review found no additional A22 blocker. Focused checks
on the combined source passed: three Codium task-result cases, all 16 notification
pipeline cases, and all 20 database migration cases (including migration-generator
parity). Core and engine package typechecks passed. The first task-test invocation
could not bind its loopback test proxy under the restricted network sandbox; the
same checks passed with loopback networking available. Full native CI remains required
on the combined branch; the prior self-evolving run timed out in one Windows
shard despite continuing to pass tests.

## Obligations for subsequent packages

- The A23 delegated-counter obligation is completed below. Future workflow budget
  restoration must preserve this split instead of seeding the unknown-step limit
  with inclusive session counters.
- B03 owns the learned-skill helper's Codium consent, role-based model selection
  and `purpose: "brain"`. Current helper behavior is not proof of Track B
  acceptance; the corresponding perks remain unlisted.
- A23–A26 still own the remaining guard and display changes documented by A22.
  The intermediate accounting state is not a release candidate.

The reviewed integration scope covers conflict resolutions and the shared
session/task contracts. It is not a replacement for the remaining financial,
security, browser, native-platform or owner acceptance gates.

## A23 and workflow schema integration

The A23 merge combines Codium `7a7c664d` with the workflow schema checkpoint
`9ae43953`. It retains both the delegated ledger and A23's separate Codium
counter. The delegated seed, snapshot and saved child scope carry `codiumSteps`;
older child records without the optional field still decode. Durable request
seeding subtracts Codium from the session's inclusive unpriced counters and
aggregates it separately, retaining the existing parent/descendant deduplication
and documented restart behavior for total steps.

Focused integration checks passed: 70 core spend-guard tests, 26 task-limit tests,
12 lifecycle decoder tests, 25 desktop usage-check-in tests and 16 session usage
tests. These include 445 deduplicated Codium steps across nested and workflow
sessions, and restart admission with 80 Codium steps plus 0, 39 or 40 unknown
steps under a 40-unknown-step limit. Existing ledger seeds cannot overwrite live
spend. Codium and learned-skill metadata both remain excluded from usage check-ins.
Independent static review found no blocking conflict in the guard, lifecycle,
session summary or check-in merge.

The first integration typecheck caught a predicate whose public optional Codium
field no longer proved the guard's required field; it now narrows the guard and
public scope types together. The test fixture's stop reason also retains its
literal type. These are type-only corrections. Core and final engine package
typechecks pass on the integrated source.

## Approved fixes integration

The feature branch also merges `approved-fixes` at `279d4292` (PR 19), preserving
its benchmark evidence and commit lineage. Standard task guidance now tracks
substantial milestones or a requested plan while retaining current delegation
and user caps. Client-assigned titles, planned 550B+ Velocity copy and typed SSE
deadline cleanup retain the reviewed behavior. The footprint harness accepts
both configuration overrides and the optional task-size/judge controls.

Independent static review found no blocking conflict. Focused combined checks
passed: 35 task-size, 3 title, 59 composer, 1 provider deadline, 1 client-named
prompt, 22 workflow compliance, 3 footprint controls, 14 landing-copy and 14
investor-page tests, plus the native Node cleanup regression. These checks do
not replace the final branch CI. The twelve Windows engine shards are retained;
manual production-navigation and offline-footprint jobs remain off by default.
PR 18's timing fixture was already patch-equivalent in this branch, so its older
branch did not need a separate merge. No main merge or release is implied.

## Native regression fixtures

Codium's reviewed `9c5bc861` test repair is also included: four HttpApi spend
snapshots now retain the separate zero-valued `codiumSteps` counter, and the
Host locally policy test permits only the four exact Codium presentation
references. Its broader account, credits, pricing and plan-gating prohibitions
remain intact. The integrated HttpApi file passes 26 tests and Host locally
passes 17 tests.

An unrelated Windows Local API case in run `41259171922` returned 400 where the
test requires 409. The same revision passed that case on Linux. The previous
assertion discarded the response body, so a probe timeout remains a hypothesis.
The test now retains its exact 409 and change assertions while reporting the
fake response, bounded fake-server paths and limited local policy state on
failure. No production probe deadline changes. This local run passed 28 of 30
cases, including that case; the two company-policy cases refused the managed
fixture because this sandbox maps `/` and `/tmp` ownership to UID 65534, outside
the trusted root/current-user owners. The production ownership check remains
unchanged.

Native acceptance is now recorded on `c7335646` in general run `41260900526`:
Linux shard 2 job `124713782988` and Windows shard 10 job `124713783056` each
ran all 30 cases in `test/server/local.test.ts` successfully, including Add
server's exact 409 assertion and both company-lock cases. The individual file
headers and passing case lines were checked in both job logs. This does not
establish the cause of the older intermittent 400, and the full run was not
green: its two unrelated release-instrumentation discovery failures are recorded
as CI9 in the parity deviations.
