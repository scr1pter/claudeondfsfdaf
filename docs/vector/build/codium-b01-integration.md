# Codium and multiagent integration

Started November 9, 2026, on `codium-finish`, from Codium `d795403b2da17009075e646c0b2049d2d575716a` and main `0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c`.

This joins the existing A00–A50 source with the merged multiagent, research and tokenomics work. It does not activate services, qualify provider routes, publish legal drafts, or release a desktop or CLI. Track B remains unfinished until its own packages and acceptance checks pass.

## Merge decisions

Eight files needed resolution:

- Settings General retains Codium's Second opinion controls and main's follow-up/Stop controls.
- Memory's tab type and search registry retain Skills and Workflow insights alongside the desktop-only Backup tab. Both sets of CSS rules remain, with separate closing braces.
- The settings store retains Second opinion, notification quiet hours, follow-up mode and Stop scope, including each default, decoder and setter.
- The memory API handler retains Vault's project service and backup/restore endpoints alongside learned skills, workflow insights and research export. Generated clients are regenerated from the combined server contract rather than edited.
- The task tool keeps main's per-brief `SubagentModel.choose`, preflight, admission, isolation and file claims. A35's internally selected Second opinion judge is passed as a pinned agent model to that resolver only for the trusted judge launch; configured judge models and free routes still win. B05 must replace this compatibility handoff with the explicit per-brief allowed-model path before Track B is complete.
- The prompt cancellation fixture keeps main's bounded Windows timeout and Codium's independent test additions.

The six B01 label-plan files and `createUserMessage` were compared with main. Main already contains A00–A28's partitioned accounting, provenance, workflow output guards and the Codium Auto `selected` identity. The merge keeps those changes and adds later Codium behavior around them. No copied plan patch is applied over the newer implementations.

The automatic merge of sanitized export needed one additional correction: main preserves archive privacy and guest markers by spreading the archive, while Codium P4 requires omission of ancillary title/memory receipts. The combined sanitizer now removes `ancillaryUsage` from an output copy while retaining those markers. Raw archive bytes and receipt storage remain unchanged. The P4 regression checks omitted receipts alongside retained privacy and guest markers and an unchanged source archive.

Independent review found that the new Vault CLI mutations could bypass main's owner-only memory policy. Backup, restore and forget now refuse an agent-marked process before account transport and again inside each handler before project, key or backup access. Status and versions remain read-only. Desktop-sealed key guidance now points to Settings → Memory → Backup. Real CLI argument tests cover installed and source entrypoints, read-only access, owner access and direct handler defense, including an empty marker.

## Validation

Normal SDK generation (including its emit) and typed-client generation passed with no output drift. Independent source review passed after the Vault correction. Focused engine checks passed: sanitized export (13), Second opinion (8), per-brief model selection (26), real CLI command gate (8), and Vault CLI (2). The Second opinion fixture now provides main's TaskNotify, TaskLimits and FreeModelGuests services, so its judge integration cases exercise the combined task tool.

App merge checks passed: Memory tab model (18), Backup model (6), settings registry (18), Second opinion model (3), and settings store (6). Core Brain export (10) and spend guard (80) passed. In total, the 12 focused files passed 198 cases on November 10, 2026, one file at a time with fresh data/config/cache/state directories.

The first engine test attempt could not start the test network guard's loopback server inside the command sandbox; it ran no tests. The same commands with loopback permission passed, with the network guard still enabled. `git diff --check` passed for the integration edits; archived benchmark snapshots brought from main retain their existing whitespace. Remote CI and the mandatory push hook remain pending; this is not an overall acceptance claim.

The full handoff authorizes A51–A58 inactive hosted-service source. The canceled GitHub cloud development-session request remains canceled; no sandbox purchase, provider deployment, account configuration or live service call is part of this source integration. Hands remains owned by its separate lane; hosted adapters must consume its committed action contract.
