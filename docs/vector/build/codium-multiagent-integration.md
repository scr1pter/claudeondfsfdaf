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
