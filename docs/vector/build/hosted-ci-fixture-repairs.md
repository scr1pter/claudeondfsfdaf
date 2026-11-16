# Hosted CI follow-up: copy and Ship Desk fixture

Read against `f830e3fdf707b722aa190206994337cecec0f01d` and hosted CI job [132557474935](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024064/job/132557474935). These changes repair three failures; the separate historical plan-name documentation repair belongs to the coordinator.

- The English wording guard found three Everywhere refusal messages calling Vector's folder a project. They now say workspace folder; refusal conditions and Git safety checks are unchanged.
- The no-top-ups guard found three ambiguous or historical phrases in the owner setup prompt. The text now identifies OpenRouter's automatic funding and legacy prices explicitly. No scanner exception, legal policy, payment instruction or product offer changed.
- Ship Desk's test file attempted to register a synthetic `vrt_` verifier over the integrated production verifier and failed before running any case. It now passes an independent registry through the handler's optional internal argument, using the existing caller-verification seam. Ordinary calls retain the real registry. A new regression checks that the same synthetic caller is refused through the default handler, that production registration cannot be replaced, and that explicit fixture composition alone permits it. Existing identity, ticket, repository, billing, privacy and erasure assertions remain.

## Executed checks

Windows, Bun 1.3.14; frozen installation with lifecycle scripts disabled, no lockfile change. One coordinated Bun process ran the three named files from `test/`:

`bun --no-env-file test --timeout 30000 ./no-project-wording.test.ts ./no-topups.test.ts ./ship-desk.test.ts`

Exit 0: **32 passed, 393 assertions, one explicitly skipped CI-only Valkey case**, 23.29 seconds. The new default-registry refusal and duplicate-registration regression passed. The existing wording/top-ups guards were not weakened.

From `packages/engine`, `bun run typecheck --project ../../tsconfig.json` exited 0 with no diagnostics. This checks the hosted API source, including the optional registry parameter. `git diff --check` passed. No local server, paid provider, native/browser input, external service or real owner credential was used. The live Valkey case and integrated exact-head CI still require hosted qualification.
