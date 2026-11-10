# P2 integration review repairs

These repairs follow clean main integration commit `9ccc9372` (Codium `615855fb` plus exact approved main `dfc98974`). The canonical and next worktrees remain frozen while the parent coordinator reviews and publishes the integration tree. No live provider call, setup application, deployment, sales change or account setting was performed.

## Payment-method portal flow

The contract's explicit `payment_method_update` flow was missing from the billing route and account helper. It now opens that Stripe portal flow with the account's own customer and the existing no-change configuration. Only cancellation performs the paid-subscription lookup and releases a scheduled downgrade. Card updates therefore work for an existing customer with no active subscription or a past-due plan, while sales and Codium are off and provider management is unavailable. The completion redirect uses the existing account `model_plan=updated` return recognized by the desktop billing window. The request contains no subscription field for a card update.

The actual HTTP regression exercises both a desktop token with no subscription and a browser session with a past-due subscription. It verifies the exact portal form and preservation of the saved downgrade. It failed against the prior source with HTTP 400 before the repair. Existing legacy change-flow refusals and cancellation behavior remain covered by the complete HTTP file.

## Owner sales readiness

The owner dashboard's effective sales summary now calls the same `requireModelPlans` configuration guard used by checkout. It no longer treats a present Stripe key and four price IDs as full service readiness. Its generic configuration reason exposes no missing secret or raw exception. Stripe owner diagnostics are still read independently when their own credentials are usable.

The new regression starts with complete configuration and a fresh open funding reading, confirms sales ready, then removes `OPENROUTER_MANAGEMENT_KEY`. The old source still reported sales open; the repaired source reports configuration incomplete while retaining the known subscription count. The owner fixture explicitly supplies the previously omitted webhook and portal settings so this failure is isolated to the management key.

## Historical Stripe identities and the name guard

A14's CI [run 40798014006](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40798014006) failed the repository plan-name scan in [job 123199080856](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40798014006/job/123199080856). Its four matches were the exact historical product comparisons and fixtures required to migrate old monthly products and archive owned one-time prices safely. The ownership checks and their readable strings are preserved.

The guard now has four explicit exact-file/exact-trimmed-line historical exceptions, each with a migration or fixture reason and each required to occur exactly once. Regression cases still reject numbered names in current product creation, modified lines in the permitted files and the same historical lines in any other path. No setup file or current offer is broadly exempted. The complete guard and setup migration tests pass after the repair.

## Validation

Files ran individually through `vector-serial` from package directories with thirty-second per-test timeouts, local fake provider/auth services and an ephemeral localhost Valkey. The server is stopped at the end of the validation batch.

- `packages/web/test/model-plans-api.test.ts`: **44 passing**.
- `test/codium-owner.test.ts`: **35 passing**, including its real-Valkey atomic intent case.
- `test/codium-plan-names.test.ts`: **6 passing**, including the complete repository scan and exact exception checks.
- `packages/web/test/model-plan-setup.test.ts`: **31 passing** against the in-memory Stripe setup fake.
- API typecheck from `packages/engine`: `bun typecheck --project ../../tsconfig.json` passed.
- Web Astro check passed across 187 files with zero errors, zero warnings and 101 informational hints.

Total: **116 passing tests across four files**. Both behavioral regressions failed against unchanged source first. The first broader owner run then exposed a test assertion that compared a one-row array to the full four-tier projection; it was narrowed to the intended plan row and the complete file passed. Independent targeted review closed with no confirmed blocker in the portal, dashboard or historical-name exception changes. Parent-coordinated full pre-push checks, push and phase CI remain pending.
