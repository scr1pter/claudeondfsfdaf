# A19 core and engine clients: implementation record

This work builds on `87b1e128` (A18) in `codium-next`. Part 1 put in the client code table, headers, catalog and
status decoders, Codium Auto's pure choices, helper models, the purpose header and the real `vector login` flow. Part 2
(below the part 1 record) puts in Codium Auto per user message in the engine, the schema fields, the `review` purpose,
Auto at prepare in Core V2, Codium's default model by role, and the regenerated SDK and client. Listing Auto, locked and
manual-only entries waits for A20 (see "Moved to A20"). This is not a completeness claim: two review rounds of the
uncommitted change ran and every finding is fixed (see "Review fixes" and "Second review fixes"), but no GitHub CI run
of either part has been seen (see "Final gate"). No provider request, Stripe, OpenRouter or GitHub call, account
setting, deployment or release-catalog change was made. Every service in the tests is a loopback fake, an in-process
function or a disposable local `redis-server` 7.0.15. No `api/` file changed, so no `api/_lib/model-plan-*.ts` edit is
listed.

## What changed

| File                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/model-plan-status.ts`                            | Browser-safe additions: `AUTO_ID`, `PURPOSES`/`purpose()`, `clientHeaders()` (`X-Vector-Client`, `X-Vector-Catalog: 2`); the §4.10 code table with `gatewayFailure` (`{code, kind, action?, message, retry}`) and `failureKind`; status sends the client headers; `purchased` optional; a lenient second pass for the §4.11 fields (plan `state`, `reason`, `action`, `scheduled`, `today`, `forecastDate`, `ramp`; `listed`, `entitlements`, `meters`, `history`, `founding`, `velocity`, `labs`), each dropped alone when unknown or malformed; `describe()` and `notice()` copy without credits or top-ups (kinds unchanged). |
| `packages/core/src/model-plans.ts`                                  | Catalog sends the client headers and decodes the v2 shape: the four old fields stay strict; `lab`, `weight`, `role`, `manualOnly`, `locked`, `preview`, `auto`, `plan`, `limits`, `judges`, `review` are lenient; Auto is kept only when its three models are listed, unlocked and not manual-only. `usableModel()`. `resolveRoute` never sends `AUTO_ID` (local `CODIUM_AUTO`). `createFetch` sends the client headers and a known `X-Vector-Purpose` (else `chat`), and `finalAnswer` turns a final answer at 408/409/429/5xx into a 400 so the AI SDK never retries it. Re-exports the table from the status module.          |
| `packages/core/src/codium-auto.ts` (new)                            | Pure `resolve({catalog, tier, contextTokens})` (chat/light → floor, standard → default, thorough → ceiling; step up while the context is over 80% of the window; else the largest window) and `helper(catalog)` (floor, then default, else none). Never locked, manual-only, unlisted or Auto. Type-only import of `model-plans.ts`.                                                                                                                                                                                                                                                                                             |
| `packages/core/src/session/runner/model-plan-route.ts`              | V2 sends the client headers and `X-Vector-Purpose: chat`; final answers go through `finalAnswer`, capacity 402 → 429; errors classified by code (the old 429 → 402 shim is gone); retried answers that run out become a rate limit with no action; metadata gains `kind`.                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/src/plugin/provider/vector-plan.ts`                  | Lists `usableModel` entries only (interim, see deviations).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/oauth/loopback.ts`                               | The hardened listener (Host check, constant-time state, one code then 409, `error` refused, no-store/no-referrer/nosniff, timeout, abort) is now `listenLoopback`, shared by `authorizeLoopback` and `vector login`; behaviour unchanged for xAI and Poe.                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/engine/src/provider/error.ts`, `session/retry.ts`         | Final Codium answers carry `{codium: action, kind, code}` and are never retried; temporary ones (`RATE_LIMITED`, `BUSY`, `RENEWING`, `CONCURRENCY`, `CAPACITY`) keep their retry-after headers. `MODEL_PLAN_CONCURRENCY` does not count toward `RETRY_MAX_ATTEMPTS` (15-minute bound only).                                                                                                                                                                                                                                                                                                                                      |
| `packages/engine/src/provider/provider.ts`                          | `fromModelPlans` lists usable models only; `getSmallModel` for Codium is `CodiumAuto.helper` (none when neither floor nor default is usable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/engine/src/session/llm.ts`, `llm/request.ts`, `prompt.ts` | `purpose` on the stream input; `X-Vector-Purpose` set last, for `vector-plan` only (plugins and model headers cannot set it): `title`, `brain` (model learning), `judge` (judge agent), else `chat`. Titles and learning are skipped on a Codium conversation without a helper model.                                                                                                                                                                                                                                                                                                                                            |
| `packages/engine/src/cli/vector-account.ts`, `cmd/vector-login.ts`  | Browser PKCE login over a 127.0.0.1 loopback (`--port` optional); exchange through `Egress`; only a grant whose claims are `client: "cli"` with a `jti` (and `sub` = the user) is stored, mode 0600, never printed; `--token` stays an unmarked legacy grant with a free-models note; `tokenMarked`, `storedTokenMarked`; `vector login` with an unmarked stored token signs in again; a note when an unmarked `VECTOR_CLI_TOKEN` overrides the sign-in.                                                                                                                                                                         |
| `packages/engine/src/cli/cmd/codium.ts`, `models.ts`                | New `describe` lines; no "Buy credits"; unmarked token and `VECTOR_CLI_TOKEN` notes; command description "plan and usage"; `vector models` line without credits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/web/src/lib/desktop-sign-in.ts`                           | `purpose=cli` with a user `port` (1024–65535, only with `cli`), kept through `/login`; a discriminated request type; `cliSignInCallback` (only `http://127.0.0.1:<port>/callback?code&state`), `cliSignInCancel` (`error=access_denied`), `desktopSignInStep` (CLI asks for Approve; delete as before; desktop straight on).                                                                                                                                                                                                                                                                                                     |
| `packages/web/src/components/marketing/account/CliTokenPage.tsx`    | CLI approval card (Approve / Cancel); nothing minted before Approve; the code goes only to the loopback; "Return to your terminal"; legacy page notes copied tokens are free-models only.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Tests

Each file ran alone through `vector-serial`, `--timeout 30000`, with fresh XDG and `VECTOR_TEST_HOME` roots under
`/tmp/a19-xdg`. Results of the last run of each file:

| Package | File                                                                                                                             | Result          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| core    | `test/model-plans.test.ts` (code table, purpose pass-through, v2 decode, Auto never sent, V2 final/temporary codes, status copy) | 30 pass         |
| core    | `test/codium-auto.test.ts` (new)                                                                                                 | 4 pass          |
| core    | `test/model-plan-status-compat.test.ts` (new, H7)                                                                                | 4 pass          |
| core    | `test/model-plan-catalog.test.ts` (V2 listing)                                                                                   | 5 pass          |
| core    | `test/oauth/xai.test.ts`, `test/oauth/poe.test.ts` (shared listener)                                                             | 5 pass, 4 pass  |
| core    | `test/free-model-selection.test.ts`                                                                                              | 21 pass         |
| engine  | `test/session/retry.test.ts` (39 after the review fixes)                                                                         | 38 pass         |
| engine  | `test/session/llm-request.test.ts`                                                                                               | 13 pass         |
| engine  | `test/provider/model-plans.test.ts`                                                                                              | 12 pass         |
| engine  | `test/cli/vector-login.test.ts` (new, offline full flow; 6 after the review fixes)                                               | 5 pass          |
| web     | `test/desktop-account.test.ts`                                                                                                   | 12 pass         |
| web     | `test/model-plan-status-api.test.ts` (frozen decoders over real handler bodies)                                                  | 19 pass         |
| web     | `test/model-plan-models-api.test.ts` (client decode of the real v2 body, `AUTO_ID` = `CODIUM_AUTO_ID`)                           | 11 pass         |
| web     | `test/model-plans-api.test.ts` (real Lua, loopback `redis-server`, stopped afterwards)                                           | 75 pass         |
| web     | `test/model-plans.test.ts`, `test/model-plan-context.test.ts`                                                                    | 21 pass, 6 pass |
| app     | `codium-error.test.ts`, `settings-v2/account-model.test.ts`, `vector-account.test.ts` (`--isolate`)                              | 6, 17, 6 pass   |
| desktop | `src/main/vector-account.test.ts` (`--no-env-file`)                                                                              | 24 pass         |

The offline login test drives the real CLI code (`login` with an injected `openBrowser`), the website's request parsing,
approval step and callback, and the real `api/account/cli-code`, `cli-exchange` and `cli-verify` handlers over a fake
key-value store and identity service. It checks: nothing minted before Approve; a forged state answered 400 while the
CLI keeps waiting; the callback page never shows the code; a second callback 409; stored claims `client: "cli"` with a
`jti`, mode 0600; the grant absent from all terminal output, URLs and the page; the core client's real chat request
accepted by `requireModelPlanClient` and `requireModelPlanCaller` as kind `cli`; replay of the CLI's exact exchange
refused `DESKTOP_CODE_INVALID`; a purpose-stripped code (desktop grant) and a code bound to another challenge both
store nothing; Cancel on the page, an abort and a timeout end the wait, close the listener and store nothing; a copied
token signs in unmarked and Codium refuses it with `CODIUM_SIGN_IN_REQUIRED`.

Mutation checks (each made, seen failing, reverted): the 80% guard with `<` instead of `<=` (codium-auto test fails);
`MODEL_PLAN_CONCURRENCY` counted as an attempt (retry test fails); both CLI grant checks removed (the stripped-purpose
login test fails; either check alone still refuses it, since a desktop grant has no `jti`).

Not run locally: `packages/engine/test/session/prompt.test.ts` (starts nested Bun processes; its Codium stub now
answers the v2 catalog so its title case has a helper model) and `packages/engine/test/cli/vector-account-usage.test.ts`
(nested Bun processes; it runs `vector login --token`, which now also prints the free-models note). Both are left to the
Codium CI lane.

Typechecks (`bun typecheck` through `vector-serial`): core, engine (includes the new test's `api/` imports), app,
desktop and tui passed; web (`astro check`) 195 files, 0 errors, 0 warnings, 173 hints (A18's figures). Schema, client
and sdk were not touched in part 1, and no generator ran then; part 2 changed the schema and ran both generators.

## Not provider acceptance

`ROUTE_ACCEPTANCES` stays empty, so production `/models` lists no model and every chat route answers 503
`MODEL_PLAN_MODEL_UNAVAILABLE`. The login test is offline; it is not acceptance of `vector login` against the deployed
site, real browsers' handling of an https page navigating to `http://127.0.0.1`, or macOS/Windows `open` (A60 and CI).

## Moved to A20

Items 1, 2 and 4 of part 1's list are done in part 2. Coordinator decision, 30 Oct: the remaining listing item moves to
A20, beside the routing and swarm guards it depends on (option (a); A19 does not edit A20's files):

1. List Auto, locked and manual-only entries in the engine provider (`fromModelPlans`) and the V2 catalog
   (`vector-plan.ts`) with their `codium` metadata, once A20's pickers, routing (`task-intelligence.ts`) and swarms
   (`swarm-plan.ts`) skip locked, manual-only and Auto entries; then the `vector models` line names Codium Auto and the
   locked models from that listing (the CLI runtime cannot read the catalog service itself).

A20 status (the A20 commit, see [codium-a20-plan-ui-notes.md](codium-a20-plan-ui-notes.md)): done. The engine
provider and the V2 catalog list every entry with its metadata, after routing, swarms, pickers, restore and cycling
skip locked, manual-only and Auto entries, and `vector models` names Codium Auto and the locked models.

## Obligations for A20 and later

A20 status: the suffix stripping, the finer answers by code and suffix (no purchase for daily, run or Brain), restoring
`selected` in the app and TUI, the badges, the routing and swarm guards and the desktop's desktop-only grant check are
done in A20 ([codium-a20-plan-ui-notes.md](codium-a20-plan-ui-notes.md)). The server hardening below stays open (A16).

- `codium-error.tsx` strips only the old `" Buy credits at <url>"` suffix; the engine now ends credit answers with
  `" See plans at <url>"`, `" Update your card at <url>"` or `" Confirm your payment at <url>"`, and upgrade and plan
  answers with `" Change plan at <url>"` / `" Manage your plan at <url>"`. Until A20 the card shows that sentence beside
  its own button. Test it with real `gatewayFailure` messages.
- Use `failureKind(code)` / metadata `kind` for the finer answers (daily, run, upgrade, update, contact); the stored
  `action` stays three-valued: credits (credits, upgrade, plan), sign-in, unavailable (run, daily, contact, wait,
  update, unavailable). Daily, run and Brain limits never offer a purchase.
- Restore `selected` in the app and TUI pickers; badges for locked and preview models; routing (`task-intelligence.ts`)
  and desktop swarms must skip locked, manual-only and Auto entries before (3) lists them.
- The desktop's own sign-in exchange should refuse a grant that is not `client: "desktop"`, as the CLI now refuses one
  that is not `client: "cli"` (not checked or changed here).
- Server hardening (A16 files, not changed here): a purpose-stripped code is minted and consumed as a desktop grant,
  which the CLI refuses to keep but which stays valid until it expires. Checking the expected purpose before consuming
  the code would close that.

## Remaining gates

- Independent review: two rounds ran on the uncommitted change and all twelve findings are fixed (below); the final
  gate had no unresolved blocker or major finding. The listing above is A20's, not an A19 gap.
- `vector-codium.yml` on the pushed commit (Valkey 7.2.14, the selected Codium files including `prompt.test.ts`,
  `vector-account-usage.test.ts` and the new `test/session/codium-auto.test.ts`, the typecheck matrix, browser specs);
  `packages/client` `check:generated` on the committed tree.

## Part 2: Codium Auto per message, schema and generators

### What changed

| File                                                                                                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/session/codium-auto.ts` (new)                                                                                                       | `isAuto`, `contextTokens(visible, added)` (the newest measured request after the compaction boundary plus what came after it, never a summary's own size, floored by an estimate of the whole visible history; plus the new parts) and `notice(err)`, the session error for a model that cannot run (moved out of `getModel`).                                                                                                                                          |
| `packages/engine/src/provider/provider.ts`                                                                                                               | `Provider.codiumAuto({tier, contextTokens})`: the notice a chosen Codium model gives when Codium cannot run; else `CodiumAuto.resolve` over the account's catalog, or a Codium `unavailable` notice when the catalog has no usable Auto. `Provider.Model.codium` (`ModelPlans.listing`). `defaultModelIDs` picks Codium's `default` role, never Auto, locked or manual-only.                                                                                            |
| `packages/engine/src/session/prompt.ts`                                                                                                                  | `createUserMessage` resolves Auto once (tier: the size of the request the message opens or joins; unsized sessions: the sender's size or `standard`), stores the concrete `model` and `selected` = Auto, session stays on Auto; `currentModel` prefers `selected`; `shellImpl` and subtask parts on Auto resolve at `standard`; a command on Auto skips the early check; follow-ups inside a request copy `selected`; `purpose: "review"` for `vectorscope.*` sessions. |
| `packages/engine/src/session/compaction.ts`                                                                                                              | `create` on Auto (the summarize handler's `/compact`) resolves at `standard` over the visible history, stores `selected`, and reports a failure on the session; otherwise the model is stored as handed over (variant kept). Replay and continue messages copy `selected`.                                                                                                                                                                                              |
| `packages/engine/src/tool/plan.ts`                                                                                                                       | The build message after plan approval copies `selected`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/engine/test/fake/provider.ts`                                                                                                                  | `codiumAuto` (dies unless a test sets it).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/model-plans.ts`                                                                                                                       | `listing(model)` (lab, role, manualOnly, locked, preview, auto; never weight); `resolveRoute({auto: "default"})` sends Auto to its default model, otherwise Auto stays refused (`CODIUM_AUTO`).                                                                                                                                                                                                                                                                         |
| `packages/core/src/session/runner/model-plan-route.ts`                                                                                                   | The V2 route passes `auto: "default"`; `codiumError` keeps the gateway `code`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/core/src/plugin/provider/vector-plan.ts`                                                                                                       | Listed entries carry `codium` metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/core/src/model.ts`                                                                                                                             | Re-exports `Codium`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/schema/src/model.ts`, `v1/session.ts`, `session-message.ts`                                                                                    | `Model.Codium` and optional `ModelV2.Info.codium`; V1 `UserMessage.selected`; optional `Session.Error.Codium.code`.                                                                                                                                                                                                                                                                                                                                                     |
| `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `packages/client/src/generated/types.ts` | Regenerated with `./packages/sdk/js/script/build.ts` and `bun run generate` in `packages/client`, one at a time through `vector-serial`; not edited by hand. A second `bun run generate` left the client diff byte-identical.                                                                                                                                                                                                                                           |

### Tests

Each file ran alone through `vector-serial`, `--timeout 30000`, with fresh XDG and `VECTOR_TEST_HOME` roots under
`/tmp/a19-xdg2`. Last run of each:

| Package | File                                                                                                                                                             | Result          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| engine  | `test/session/codium-auto.test.ts` (new; in-process catalog and chat transport, no gateway process, no nested Bun; the shell case runs `echo` through `/bin/sh`) | 9 pass          |
| engine  | `test/session/compaction.test.ts`                                                                                                                                | 67 pass         |
| engine  | `test/session/llm-request.test.ts`, `test/session/revert-compact.test.ts`                                                                                        | 13 pass, 7 pass |
| engine  | `test/provider/model-plans.test.ts` (default by role, `codium` listing)                                                                                          | 12 pass         |
| core    | `test/model-plans.test.ts` (V2 Auto to its default and refused without one, stored `code`, `listing`)                                                            | 31 pass         |
| core    | `test/model-plan-catalog.test.ts` (V2 listing metadata)                                                                                                          | 5 pass          |
| core    | `test/session-runner-model.test.ts`, `test/codium-auto.test.ts`, `test/model-plan-status-compat.test.ts`                                                         | 18, 4, 4 pass   |

The new engine file checks: a thorough message runs on the ceiling and the next (no model named, standard) on the
default, both store `selected` = Auto, the session stays on Auto; a chat message whose context is over 80% of the
floor's window runs on the default, and so does the next one while that context is in the history; a two-step message
(a tool call, then text) sends both steps on the one model; `/compact` stores the resolved model with `selected` and no
request names Auto; a shell command stores a resolved model and sends nothing; a catalog without Auto fails the message
with a Codium `unavailable` notice, saves nothing, sends nothing and keeps the session on Auto; a subtask on Auto runs
its subagent on a resolved model; a `vectorscope.review` session sends `X-Vector-Purpose: review`; and the context
estimate (measured request, its tool results, later messages, a summary left out, the no-usage floor) with exact token
counts.

Mutation checks (each made, seen failing, reverted): skipping the resolution in `createUserMessage` (6 of 8 cases
fail); skipping it in `SessionCompaction.create` and in `shellImpl` (the `/compact` and shell cases fail); dropping the
whole-history floor from `contextTokens` (the step-up case and the estimate case fail). The existing
`compaction.test.ts` caught a first version of `create` that rebuilt the model without its variant; it now stores the
model as handed over.

Not run locally: `test/session/prompt.test.ts` and `test/cli/vector-account-usage.test.ts` (nested Bun processes; CI).

Typechecks (`bun typecheck` through `vector-serial`): schema, core, engine, client, server, sdk-next, app, tui,
desktop, session-ui, cli, plugin and protocol passed. Core passes only after the SDK regeneration, since the V2 plugin's
model draft type comes from the generated `ModelV2Info`. Web (`astro check`): 195 files, 0 errors, 0 warnings, 173 hints.

## Review fixes (uncommitted)

The first review of the uncommitted A19 change raised six findings. Each was checked against the code; all six were
real and are fixed. Nothing was deferred.

1. **Backoff after waiting for the account's other requests** (`packages/engine/src/session/retry.ts`). The waits did
   not count toward the attempt bound but still raised the backoff exponent, and an AI SDK error from an HTTP answer
   always has `responseHeaders`, so its backoff is not held to 30 s. Reproduced first: after 10 `MODEL_PLAN_CONCURRENCY`
   waits, a 503 `MODEL_PLAN_UPSTREAM` without a retry-after ended the run at once (`Done` 11, a 34-minute wait). Now a
   counted failure backs off from the counted failures (`meta.attempt - waits`), and a wait from its own count (its
   retry-after-ms wins). Regression test in `test/session/retry.test.ts`: 10 waits, then 503 at 2 s, a wait at its
   500 ms retry-after, the next 503 at 4 s.
2. **Login test depended on module load order** (`packages/engine/src/cli/vector-account.ts`). The site was read once
   at load, and `test/cli/usage-report.test.ts` imports the module statically, so a shared Bun process (CI shards)
   would hand the login test a CLI aimed at `https://vectordev.ai`. The CLI now reads `VECTOR_SITE_URL` on each call
   (`site()`). The test imports the CLI statically, before it sets the site, which is the shared-process state;
   reproduced first against the load-time constant: 4 of 5 tests failed, with the CLI aiming at `https://vectordev.ai`
   and the network guard blocking it. `afterAll` restores the earlier environment values instead of deleting them.
3. **Project copy name on Codium without a helper model**
   (`packages/engine/src/server/routes/instance/httpapi/handlers/project-copy.ts`). It now falls back to its random
   name, as titles and model learning skip, and sends purpose `title` (deviations updated). No handler test: the handler
   is served only inside the whole instance API with the real provider and LLM services; the guard mirrors the title
   skip, and the helper choice itself is covered by `test/provider/model-plans.test.ts`.
4. **"Try again" on `/auth/cli?purpose=cli` skipped Approve**
   (`packages/web/src/components/marketing/account/CliTokenPage.tsx`). A failure before the Approve card (for example
   `getSession()` failing) left a "Try again" that called `mint(true)`. An `approved` state is now set only by Approve or
   Continue, and "Try again" calls `mint(approved)`, so a failure before the person chose asks first. This also tightens
   the deletion flow, whose retry was `mint(true)` too; a deletion that came back with `confirmed=1` still goes straight
   on (`deletionConfirmation`). No component test: the web package has no DOM test environment and no dependency may be
   added; `desktopSignInStep` (ask before Approve, send after) is covered by `test/desktop-account.test.ts`.
5. **Browser sign-in over a copied token for another account** (`vector-account.ts` `browserLogin`). If the stored
   sign-in belongs to another account, it is signed out (team choice and checked tokens with it, as `--token` does)
   before the new grant is stored; the same account keeps them. The command's note says so. Regression test in
   `test/cli/vector-login.test.ts`; mutation check: without the sign-out the other-account case fails (`teams.json` and
   `cli-token-checked.json` kept).
6. **`--port` checked after sign-out** (`packages/engine/src/cli/cmd/vector-login.ts`). The options are now checked
   before anything stored is read or changed, and `--port` with `--token` is refused (the port applies only to the
   browser sign-in). No test: the handler exits the process, and `vector login` runs as a subprocess only in
   `test/cli/vector-account-usage.test.ts` (nested Bun processes, left to CI).

Each file ran alone through `vector-serial`, `--timeout 30000`, with fresh XDG and `VECTOR_TEST_HOME` roots under
`/tmp/a19-review-xdg`:

| Package | File                             | Result  |
| ------- | -------------------------------- | ------- |
| engine  | `test/session/retry.test.ts`     | 39 pass |
| engine  | `test/cli/vector-login.test.ts`  | 6 pass  |
| engine  | `test/cli/usage-report.test.ts`  | 7 pass  |
| web     | `test/desktop-account.test.ts`   | 12 pass |
| web     | `test/first-launch-docs.test.ts` | 4 pass  |

Typechecks (`bun typecheck` through `vector-serial`): engine passed; web (`astro check`) 195 files, 0 errors, 0
warnings. Prettier check passed on every edited file. Not run here: the whole engine suite in one process (the
load-order case is reproduced by the static import instead), `prompt.test.ts` and `vector-account-usage.test.ts`
(nested Bun; CI).

## Second review fixes (uncommitted)

The second review of the uncommitted A19 change raised six findings. Each was checked against the code; all six were
real (two were test gaps) and are fixed. Nothing was deferred or rejected.

1. **Codium switched off was retried by the AI SDK** (`packages/core/src/model-plans.ts`). `createFetch` returned its
   own refusals without `finalAnswer`, so the local 503 `CODIUM_UNAVAILABLE` (a catalog that says `enabled: false`
   under a stale listing) kept a status the AI SDK retries on titles, model learning, fast turns and project-copy names.
   Reproduced first: the extended case in `test/model-plans.test.ts` received 503. Local refusals now pass
   `finalAnswer`; the case asserts 400 with `retry: false` (and 401 for signed out). Deviations updated.
2. **A19 guards in `prompt.ts` without a test** (`packages/engine/test/session/codium-auto.test.ts`). New cases: an
   untitled Codium conversation with the model learner on sends `chat`, `title` and `brain` while Auto offers a helper
   model, and only `chat` once the catalog has no Auto; a session whose row names no model picks Auto again from the
   last message's `selected`. Mutation checks (each made, seen failing, reverted): the title guard removed (an extra
   `title`), the learning guard removed (an extra `brain`), `selected ??` removed from `currentModel` (the next message
   ran on the ceiling with no `selected`).
3. **H7 config checked only against a literal** (`packages/web/test/model-plan-status-api.test.ts`). The frozen
   1.99.111 and 1.99.112 `salesOpen` and `fetchOffers` now run over the real `/api/model-plans/config` handler's answer
   with sales open (the fixture environment plus a webhook secret and portal configuration, so
   `codiumBillingConfigProblems()` is empty) and closed. Mutation check: the handler answering `price` as a string fails
   it (handler restored; no `api/` file is changed). The core literal stays as a shape example; its comment says so.
4. **A subtask naming Auto in a free conversation** (`prompt.ts` `handleSubtask`). Auto was resolved before the
   free-selection check, so being signed out, Vector Local or a plan without Auto failed the whole loop. The free check
   now comes first, and Auto is never resolved for a free conversation. Reproduced first in a new `free` stack in the
   same test file (Vector's shared free models listed, model calls answered in-process): the loop died with "Codium Auto
   is not available on your plan right now"; now the subtask runs on the free model, with no session error and nothing
   sent to Codium.
5. **A shell command on Auto needed Codium** (`prompt.ts` `shellImpl`). Resolution is split into `pickAuto` (fails with
   the notice) and `autoModel` (also publishes it and fails the turn). The shell uses `pickAuto`; when Auto cannot pick,
   the command still runs and its message keeps Auto as its model (no `selected`). Reproduced first: with a catalog
   without Auto the shell died with the notice; now `echo hi` completes with no session error and nothing sent. The
   catalog wait the finding mentions applies only when the account has no catalog yet (`wait`), so a stale catalog does
   not delay the command; unchanged. Left as it is: a model turn that answers such a shell message directly, with no new
   user message, gets the model-not-found error for Auto (unlisted until A20) instead of resolving it; a new prompt makes
   and resolves its own message. A20, which lists Auto, should resolve Auto in the run loop for a message that kept it.
6. **`vector login` over a revoked or expired grant** (`packages/engine/src/cli/vector-account.ts`,
   `cmd/vector-login.ts`). New `confirmStoredSignIn()` asks `/api/account/cli-verify` before "Already signed in": a
   refusal signs out (team choice and checked tokens with it, as the daily check does), a note says so and the browser
   sign-in starts; an unreachable site or Vector Local keeps the sign-in. Regression test in
   `test/cli/vector-login.test.ts` over the real verify handler: a current grant stands, also through a 503; one revoked
   with the real `revokeCliToken`, and one past its ninety days, sign out. The fake store now answers revocation reads
   from what was written. Mutation check: trusting the stored mark alone, as before, fails it. The handler itself exits
   the process; `vector login` as a subprocess runs only in `vector-account-usage.test.ts` (CI).

Also found while typechecking: core `bun typecheck` failed on three `toEqual` calls in the `listing` case of
`test/model-plans.test.ts` (TS2769, `listing` claimed every field was present). `listing` now returns
`Partial<Pick<Model, ...>>`, which is what it builds; runtime unchanged.

Each file ran alone through `vector-serial`, `--timeout 30000`, with fresh XDG and `VECTOR_TEST_HOME` roots under
`/tmp/vector-codium-A19/xdg`:

| Package | File                                                                        | Result  |
| ------- | --------------------------------------------------------------------------- | ------- |
| core    | `test/model-plans.test.ts`                                                  | 31 pass |
| core    | `test/model-plan-status-compat.test.ts`, `test/model-plan-catalog.test.ts`  | 4, 5    |
| core    | `test/session-runner-model.test.ts`                                         | 18 pass |
| engine  | `test/session/codium-auto.test.ts` (13: 4 new)                              | 13 pass |
| engine  | `test/cli/vector-login.test.ts` (7: 1 new), `test/cli/usage-report.test.ts` | 7, 7    |
| engine  | `test/session/compaction.test.ts`, `test/provider/model-plans.test.ts`      | 67, 12  |
| web     | `test/model-plan-status-api.test.ts` (20: 1 new)                            | 20 pass |

Typechecks (`bun typecheck` through `vector-serial`): core and engine passed; web (`astro check`) 195 files, 0 errors, 0
warnings, 173 hints. Prettier check passed on every edited file. Not run here: `test/session/prompt.test.ts` and
`test/cli/vector-account-usage.test.ts` (nested Bun processes; CI).

## Final gate

- **Tree.** `git status` before the commit showed only the A19 source, test, fixture, generated and doc files listed
  in the tables above (41 changed, 9 new): no scratch files, logs, `node_modules` or temporary fixtures. Backups made
  during the reviews live outside the worktree (`/tmp/vector-codium-A19/`). No `api/` file, no cloud-agent file and no
  generated file edited by hand.
- **Last edit re-checked.** The last source edit was `packages/core/src/model-plans.ts` (`listing` typed as
  `Partial<Pick<...>>`, runtime unchanged). Rerun after it, through `vector-serial`, with fresh XDG and
  `VECTOR_TEST_HOME` roots under `/tmp/vector-codium-A19/`: core `test/model-plans.test.ts` 31 pass, 0 fail (309
  expects); core `bun typecheck` passed. Every other file's last pass is recorded in the sections above and none of
  them changed after it. Prettier `--check` passed on every changed hand-written file.
- **Push.** The commit is pushed through `vector-serial` to `codium-next` and `codium`; the pre-push hook typechecks
  every package one at a time. The push to `codium` starts the scoped `vector-codium.yml` workflow on its own; no
  workflow is dispatched by hand, and its result is not recorded here.
- **CI only.** `packages/engine/test/session/prompt.test.ts` and `packages/engine/test/cli/vector-account-usage.test.ts`
  (nested Bun processes), `packages/client` `check:generated` on the committed tree (a second local generator run
  changed nothing), Valkey 7.2.14 reply shapes and the browser specs.

## P3 review

The P3 phase review found that the retried codes above (`MODEL_PLAN_BUSY`, `MODEL_PLAN_CAPACITY`) and the 5xx retry of
`MODEL_PLAN_UPSTREAM` also covered answers the gateway gives after it dispatched the request, each of which A17
commits at a full reservation. The engine could resend one refused request up to ten times. The gateway now marks
those answers `dispatched: true` and `gatewayFailure` makes a marked answer final whatever its code (kind and action
`unavailable`); the unmarked codes keep their retry. Details, tests and the records changed are in
[codium-p3-repairs.md](codium-p3-repairs.md) and `codium-deviations.md` ("P3 review decisions").
