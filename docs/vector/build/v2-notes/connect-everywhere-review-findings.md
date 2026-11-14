# Review findings from the stopped connect/everywhere lane (2026-11-14)

These reviews read build-connect and vector-everywhere (both inside build-complete) against v2. Confirm each against build-complete before fixing; some may already be fixed there.


## review:everywhere:fit

Findings for `git diff origin/v2...origin/vector-everywhere` (head 890bb072b; merge base 0dcbb8e2d = v2~1), reviewed for fit with v2. Review was read-only. I found 6 problems: 1 medium and 5 low. None blocks a dormant Stage A merge.

1. MEDIUM. `.github/workflows/vector-everywhere.yml:13-16, 60, 103` and `packages/web/test/everywhere-lane.test.ts:152-155, 324-358`
   - Problem: the lane only knows the `vector-everywhere` and `main` branches. Its push trigger, its scope job (`[ "$REF" = refs/heads/main ]`) and its per-run concurrency group (`refs/heads/main`) all leave out `v2`. Several checks run only in this lane:
     - `packages/web` has no test script, and `test.yml:143` says turbo skips it. So the roughly 45 `packages/web/test/everywhere-*.test.ts` files (the whole server side) never run in the general checks.
     - The `api/**` typecheck against the root tsconfig.
     - The real-Redis (Valkey) cases.
   - Failing scenario: Stage A merges into v2. A later PR into v2 changes something the everywhere code imports that is not on the lane's path list. Example: `api/_lib/codium-keys.ts`, which `codium-switches.ts:3` imports. Neither that PR nor the push to v2 runs the lane, so the break only shows up when v2 goes to main.
   - Fix:
     - Add `v2` to `push.branches`.
     - Make the scope job path-filter `refs/heads/v2` the way it does main.
     - Give v2 the per-run concurrency group that main has.
     - Update the lane test's expectations to match.
     - Add `api/_lib/codium-keys.ts` and `integrations/linear/**` to the paths.
     - `vector-codium.yml` is also branch-only, so use the same approach for every lane.

2. LOW. `packages/engine/test/local-mode/local-run.test.ts:1353`
   - Problem: this is Stage A's only edit to an existing file. It carries the same fixture fix as process-finish d2156cb2d, build-integrate and vector-at-mention, but with a different one-line comment.
   - Checked with merge-tree:
     - Clean against current v2, because v2 does not have #26 yet.
     - Content conflict on this one comment against `origin/process-finish`, `origin/build-integrate` and `origin/vector-at-mention`.
   - It also breaks `vector-everywhere-spec.md:686`, which says Stage A has "New files only, no shared-file edits" and that "Other branches never conflict with it". The deviations log does not record this edit.
   - Failing scenario: process-finish merges into v2 first (step 1), then everywhere gets a content conflict.
   - Fix: replace the one-line comment with process-finish's two-line comment (its lines 1356-1357) so both hunks are byte-identical and merge cleanly in any order. Alternatively, once #26 is on v2, merge v2 and take v2's side so the branch no longer touches the file.

3. LOW. The docs do not match the code.
   - `docs/vector/build/vector-everywhere-handoff.md:107` says `decodeJobRecord` "keeps unknown fields". The code refuses any unknown field (`api/_lib/everywhere/jobs.ts:289`). `deviations.md:123` is correct.
   - `handoff.md:77` says `oauth-finish` answers 501 for Slack and Linear until their exchanges exist. They exist now (`api/_lib/everywhere/oauth-exchanges.ts`, `account-api.ts:327`). The comment at `account-api.ts:51` is just as out of date.
   - `handoff.md:7` points to the `/workspace/vector-build-everywhere` worktree and the `build-everywhere` branch. Neither is on origin.
   - `spec.md:3` still says only VE-00 to VE-05 are built.
   - `handoff.md:100, 130-131` and `spec.md:686, 803` still describe landing on main, and the handoff forbids opening PRs. The target is now v2, with draft PRs opened by the orchestrator.
   - `spec.md:879` contains a local path on the owner's machine (`/Users/<owner>/.cache/vector-connect/...`).
   - Fix: refresh the handoff status and rules for v2, fix the two statements above (unknown fields, 501), and update the spec status line. Replace the local path with `origin/connected-workspace:docs/vector/build/connected-workspace-spec.md`.

4. LOW. Hooks that depend on codium are not wired: `api/_lib/everywhere/erase.ts:263` and `api/everywhere/sweep.ts`.
   - Problem: `EVERYWHERE_ERASE_PART` matches the shapes of codium's `ErasePart` and `EraseContext` (codium branch, `api/_lib/codium-erase.ts:77-89`). But nothing calls `registerErasePart` (codium `codium-erase.ts:254`, which reaches v2 first), and `vercel.json` has no cron for `/api/everywhere/sweep`. These are tracked as R-C9 and R-C11.
   - Failing scenario: a preview with `VECTOR_EVERYWHERE_ENABLED=true` creates installs, links and sealed tokens. Account deletion then scans only the Codium key root, so `vector:everywhere:*` records survive. Separately, a laptop that dies mid-job gets no `lost` reply until some later call triggers the lazy sweep.
   - Fix: once codium and everywhere are both on v2, add the registration import in `codium-erase.ts` and a `* * * * *` cron entry, before any deployment with the flag on. Add both to finish-plan item 38.

5. LOW. `packages/engine/test/everywhere/unattended-session.test.ts:9` imports `../../../desktop/src/main/everywhere-engine`.
   - Problem: no engine test on v2 imports desktop source, and engine does not depend on desktop. Engine's typecheck now checks a desktop file under engine's compiler settings, and turbo's engine inputs do not include it.
   - Failing scenario: a desktop-only edit to `everywhere-engine.ts` that breaks engine types is missed whenever turbo's engine typecheck is served from cache.
   - Fix: move the loopback client into `@vectordevai/core/everywhere`, which both packages can import, or document the cross-package test in the deviations log.

6. LOW / nit. `packages/desktop/src/main/everywhere-awake.ts:2` adds a second owner of `prevent-app-suspension`.
   - Problem: desktop already has one in `packages/desktop/src/main/index.ts:570-583` (`startKeepAwake` / `setDesktopWorkBlocker`).
   - Failing scenario: none today, since it is not wired. Once VE-21 wires it, two independent blockers could hold or release the machine's sleep state.
   - Fix: when wiring VE-21, route it through the shared blocker.

Checked and fine:
- **Clean merges:** merge-tree with the branch is clean against v2, release-coordination, codium, cloud-workspaces, hands, build-scope-joined and build-connect.
- **Additive only:** 163 files are new and 1 is modified. No changes to the SDK, openapi, `bun.lock` or `vercel.json`.
- **Off by default:** with `VECTOR_EVERYWHERE_ENABLED` unset, every route answers 404, 501 or `stop`. Desktop and core modules are not wired. Manifests carry placeholder ids only.
- **Matches upstream code:**
  - The `codium-switches` API and the desktop `github-api` helper are identical on every upstream branch.
  - The `api/**` imports are relative or `jose`, which is a root dependency.
  - The `vector:codium` key-spelling rule in `test/codium-mode.test.ts:633` is not tripped.
  - The Valkey digest matches the other lanes.
- **No collisions:** none on `vector:everywhere`, `vej_`, `vef1.` or `vector.unattended`.
- **Forbidden content:** no forbidden project name or owner email in the diff.

## review:everywhere:correctness-security

Seven findings, none critical, from the correctness-security review of `origin/v2...origin/vector-everywhere` at 890bb072b. Three are Medium and four are Low. Nothing found lets untrusted text become the task, skips signature or replay checks, leaks a secret, or runs while the feature flag is off. The Medium items are about the feature failing safe but not working, or reporting the wrong result.

**1. Medium – the runner turns down valid projects as "not mapped" (Windows clones and common tools)**
- Where: `packages/desktop/src/main/everywhere-git.ts:10` (`SAFE_CONFIG`), used by `mapped()` at :126, declined at `everywhere-runner.ts:135-137`.
- Problem: the list of allowed local git settings is missing harmless keys that git and common tools write by default:
  - `core.symlinks` (Git for Windows writes `false` when symlinks are not enabled, which is the default)
  - `remote.<n>.gh-resolved` (written by `gh`)
  - `branch.<b>.vscode-merge-base` and `branch.<b>.rebase` (written by VS Code)
  - `pull.rebase`, `maintenance.*`, `submodule.<n>.url|active`, and the partial-clone keys `remote.<n>.promisor`, `remote.<n>.partialclonefilter`, `extensions.partialclone`
- Failing scenario: on a default Windows clone, `.git/config` has `symlinks = false`. `safeRepositoryConfig` returns false, `mapped()` returns false, and every job is declined `not-mapped`. The user is told the repository is not mapped when it is. The same happens on macOS or Linux after `gh repo set-default` or a VS Code branch create.
- Fix:
  - Allow these keys, but only the inert ones. Keep refusing `submodule.*.update`, `filter.*`, `include*`, `url.*`, `http.*`, `credential.*`, `core.editor`/pager/askpass, and `gpg.*`.
  - Give unsafe config its own decline code or log line, so the user knows why.
  - Add a test with a stock Windows `.git/config`.

**2. Medium – Linear and Jira treat a numeric rate-limit score as a fault and go dark for up to 24 hours**
- Where: `api/_lib/everywhere/linear/adapter.ts:86-89` and `api/_lib/everywhere/jira/client.ts:17-19`.
- Problem: commit 15e92e6ac fixed this for Slack only. Real Redis can return `ZSCORE` as a number (the hosted run proved it), but these two readers accept only a digit string.
- Failing scenario:
  - Linear writes the cooldown whenever an `x-ratelimit-*-remaining` header is `"0"`, even on a successful response (`linear/client.ts:54-59`), and on `RATELIMITED` errors (:66-67).
  - Jira writes it on any 429 (`jira/client.ts:27-30`).
  - After that, every Linear call throws `LinearFailure` and every Jira call throws `JiraFailure`, even once Retry-After has passed. The key's expiry is 24 hours and is pushed out again on every write.
- Fix: parse with `storeInteger` and refuse negatives, as `slack/cooldown.ts` now does. Add number, string and malformed cases for both platforms.

**3. Medium – after a successful push, a failed settle is reported as "nothing published"**
- Where: `packages/desktop/src/main/everywhere-runner.ts:262-276`; git gets `controller.signal` at :134; the timer aborts at the deadline at :186.
- Problem:
  - When the `changes` settle at :264 throws, the catch block still has `outcome = "failed"`. It settles again as `failed` with "The unattended job ended without publishing changes." and no branch or PR link. A 503 `EVERYWHERE_BUSY` (`jobs-api.ts:229`, which asks for a retry in 2 s) or a timeout is enough to trigger this.
  - Also, the deadline timer can abort a `git push` that is already running (the git process is killed through the signal), after the server may already have accepted it.
- Failing scenario: a branch is pushed and a draft PR is open, but the Slack, Linear or Jira reply says no changes were published. If the second settle succeeds, the job record has no link to the PR.
- Fix:
  - Once the push has started, retry the identical `changes` settle with bounded backoff. The server already answers a repeat settle on the same lease the same way as the first.
  - Never send a non-`changes` outcome after a push.
  - Don't pass the deadline signal to push, or treat an aborted push as "uncertain" rather than "failed".

**4. Medium – a Linear token refresh can permanently break the installation**
- Where: `api/_lib/everywhere/linear/credentials.ts:71-88`.
- Problem: the new credential pair is saved only after the follow-up `viewer` check succeeds. Linear refresh tokens rotate, as the branch itself assumes, so using one invalidates it.
- Failing scenario: the initial activity runs with an 8 s deadline (`linear/adapter.ts:161`). If the refresh takes most of that, the `viewer` call hits `remaining <= 0` (`linear/client.ts:40`), or times out, or returns 5xx or `RATELIMITED`. The new pair is thrown away and the stored refresh token is already used. Every later call then fails with "Reconnect Linear" until someone reconnects by hand.
- Fix: save the new pair right after the token exchange, guarded on `current.raw`. Then run the `viewer` check. Only a definite mismatch should close the install; a temporary failure keeps the new pair.

**5. Low – a failed ledger release in `finally` leaks the job slot**
- Where: `everywhere-runner.ts:281-282`.
- Problem: `await deps.ledger.release(jid)` has no guard. If it throws, `active.delete(jid)` is skipped, `offer()` rejects, and the ledger row keeps holding the job slot until `recover()` runs at restart.
- Failing scenario: on Windows, `rename` in `ledgerFile.write` can fail with EPERM while antivirus holds the file. With `atOnce = 1`, every later offer is declined `busy` until Vector restarts.
- Fix: run `active.delete` first, then release with a retry, wrapped in try/catch.

**6. Low – one large engine event makes a finished job fail**
- Where: `packages/desktop/src/main/everywhere-engine.ts:89-90`.
- Problem: the 1 MB cap is checked on the whole pending buffer before it is split into events. A single legitimate tool event can be over 1 MB: edit and write parts carry the patch twice (`metadata.diff` and `metadata.filediff.patch`, `packages/engine/src/tool/edit.ts:176-205` on v2).
- Failing scenario: the agent writes or rewrites a file of roughly 500 KB or more. The stream throws, the work is already done, and the job settles `failed`.
- Fix: split events first, cap each event separately, and skip (rather than fail on) oversized events of types the runner ignores.

**7. Low – GitHub status lock is never released (not wired yet)**
- Where: `api/_lib/everywhere/github/status.ts:23`.
- Problem: `jobStatusLock` is set new-only with a 30 s expiry and is never deleted. Slack's version releases its lock (`slack/adapter.ts:88-97`).
- Failing scenario: progress posts within 30 s of the previous one are silently dropped. A final post within 30 s throws and waits for the 60 s outbox retry.
- Fix: use a random token and release it with `swapValue` in `finally`.

**8. Low – GitHub `issues` triggers are almost always seen as edited (not wired yet, Phase 4)**
- Where: `packages/desktop/src/main/everywhere-github.ts:39-41`; `bodySha256` is optional at `api/_lib/everywhere/github/adapter.ts:75-80`.
- Problem: an issue's `updated_at` changes on any comment, label or assignment.
- Failing scenario: without `bodySha256`, every issue-body trigger that anyone has touched is declined `trigger-changed`.
- Fix: require `bodySha256` for `event === "issues"` at handoff, or compare only the body hash.

**Test gap (already known):** there are still no runner cases for server `stop`, `lost`, 404 and 409 on report, heartbeat failure up to the 5-minute lease, or question rejection. While reading those paths I found no extra bug in them; findings 3 and 5 should get tests in the same batch.

The local-run.test.ts conflict was not part of this review step.

## review:connect:fit

**Fit review: `build-connect` (a8234d9ac) against `origin/v2` (54fa0f8c7) and the branches that merge before it**

The review was read-only, using fetch, log, show, diff and merge-tree only. Two things moved while I was reviewing:
- **v2 already holds three merges:** `process-finish`, `release-coordination` and `codium`.
- **The build agent is still pushing:** `build-connect` gained a8234d9ac at 02:52 UTC on 11-14, after the plan was written. At that commit, typecheck 43549516689 passed, test 43549509307 was cancelled, and Verify has not run.

Ten findings, most severe first:

1. **High: two separate ways to start a VectorScope review once scope and connect are both on v2**
   - Files:
     - `packages/engine/src/server/routes/instance/httpapi/groups/connect.ts:44,51`
     - `packages/engine/src/connect/directory-request.ts:207`
     - `packages/engine/src/connect/git.ts:37`
     - On `build-scope-joined`: `groups/review.ts:52`, `core/src/review/request-store.ts` and `engine/src/review/git.ts:160`
   - Problem: `build-scope-joined` (step 7) already ships its own owner-only route that starts a review of a conversation, `POST /experimental/session/:id/review` with list, get and stop. Behind it sit a database ledger for request keys (`ReviewRequestTable`) and its own translator from Git commands to safe reads (`ReviewGit`). Connect has a second copy of each:
     - two start routes, `POST /experimental/session/:id/connect` and `/experimental/connect/review`;
     - a file ledger under `storage/connect-directory-requests`;
     - its own command translator, `ConnectGit.query`;
     - a second desktop start screen.
   - Q6 said connect keeps its own route "until VectorScope's VS-10 decides". That has now happened.
   - Failing scenario: after both merge, the owner starts a review from the VectorScope panel and another through connect on the same session. There are two independent run ledgers, and cancelling on one screen does not stop the other. Separately, when scope's collector issues a Git command that connect's list does not know, every connect review refuses ("cannot be inspected safely") while scope's own reviews succeed.
   - Fix:
     - Get the Q6 decision before the connect PR.
     - Route connect's adapter through scope's review service (`options.context` plus `ReviewGit.within`) and delete `ConnectGit`'s translator.
     - Either make connect's owner routes call `ReviewOwner` or remove them.
     - Replace spec §6's "the swap on our side is one file (CW-20)" (`connected-workspace-spec.md:395`) with the real file list.

2. **Medium: two typecheck breaks that merge-tree reports as clean merges**
   - Workflow stages, on v2 now:
     - Files: `packages/engine/src/orchestration/runs.ts:270` (this line came in with codium).
     - Problem: the line reads `entry.stage.verify`. Connect widens `entry.stage` so it can also be a connect stage, which has no `verify` field (`core/src/orchestration/spec.ts:160`).
     - Failing scenario: merging v2 into the connect branch fails engine typecheck with TS2339 in `runs.ts`.
     - Fix: narrow with `"prompt" in entry.stage` (or `WorkflowPlan.isAgent`) inside that `.map`.
   - MCP test stub, once @vector (step 4) is on v2:
     - Files: `packages/engine/src/mcp/index.ts:253`; on `build-integrate` and `build-native-shell`: `packages/engine/test/tool/registry-actions.test.ts:259`.
     - Problem: connect makes `snapshot` a required member of the MCP service. That new test file builds a stand-in MCP service without it. Engine typecheck covers tests, since there is no `include` in `packages/engine/tsconfig.json`.
     - Failing scenario: engine typecheck fails on that file after the merge.
     - Fix: add `snapshot: () => Effect.succeed({})` to that stub when merging, or make `snapshot` optional.

3. **Medium: connect carries an older copy of the safe Git reader that scope keeps hardening**
   - Files: `packages/core/src/read-only-git.ts:1` and `packages/core/test/read-only-git.test.ts`.
   - Problem: both come from the same commit (2a603eb48 here, 616dca162 on scope; same patch-id). Scope has five later hardening commits:
     - d470df71c: bounded object parsing
     - 38f9cf149: graph verification
     - 7cc8cac56: single-threaded grep
     - 35cd3665e: directory identity
     - a48363934: `isOpen` view lifetime
   - Failing scenario: both files hit add/add conflicts (1079 vs 1733 lines). Taking connect's side, or merging by hand, silently drops scope's security fixes, and the old 571-line test replaces scope's.
   - Fix: take scope's versions of both files whole. `ConnectGit.use` already passes the result of `metadataHead` into `open`, so `commonIdentity` binds automatically. Re-run `test/connect/git.test.ts`.

4. **Medium: connected reviews refuse on macOS and Windows, but VectorScope shows as "ready"**
   - Files: `packages/core/src/read-only-git.ts:498,699`, `packages/engine/src/connect/git.ts` (`use`), `packages/engine/src/connect/adapters/vectorscope.ts:314`.
   - Problem: `metadataHead` and `open` require Linux. `describe()` never checks the platform and reports `state: "ready"`.
   - Failing scenario: on the owner's Mac with the flag on, the build agent is offered `connect`, the Connected tools list shows VectorScope as ready, and every review refuses with "This review's Git reads cannot be inspected safely". Also, a server hosted by Bun refuses `vector connected review` (`handlers/connect.ts`).
   - Docs gap: spec §4.1 (`connected-workspace-spec.md:215`) promises the desktop sidecar. The handoff only says "unsupported-platform qualification" is open.
   - Fix: return `unavailable` with a plain reason off Linux. State in the handoff and spec that reviews work on Linux only until there are private-Git adapters for macOS and Windows, and note the Bun listener limit.

5. **Medium: changes to shared core code that the flag does not cover and the docs do not mention**
   - InstanceStore:
     - Files: `packages/engine/src/project/instance-store.ts:30,69,246`, `effect/instance-registry.ts` (a8234d9ac).
     - Problem: rewrites load, reload and dispose for every instance (`withFresh`, `unconfirmed`, `uncachedDisposals`). It is not in the handoff or the deviations log, and has no green full test.
     - Failing scenario: any regression in the new dispose and reload loops hits every session with connect off, unverified.
   - Config scope:
     - Files: `packages/engine/src/config/config.ts:1909` and `config/paths.ts:13` (167dfa110).
     - Problem: every instance's config load now resolves real paths with `Effect.promise`. A `realpath` or `stat` failure, or a directory outside its worktree, becomes a crash rather than an error the caller can handle. Not recorded in the deviations log.
   - Fix: get a green full `test` at the head. Record both changes as general fixes, or split them into their own PR into v2. Use `Effect.tryPromise` with a typed error for `canonicalScope`.

6. **Medium: textual conflicts at current heads, and generated files to rebuild**
   - Against v2 (from codium), 3 files:
     - `packages/engine/src/task/notify.ts`: semantic. Codium's "hosted" note kind and its delivery receipts have to sit alongside connect's "connect" note kind and its repair hand-off.
     - `httpapi/server.ts` and `packages/app/e2e/tsconfig.json`: mechanical.
   - Against `hands`, 9 files:
     - `permission/index.ts`: keep both hands' `approved()` and connect's `canAllow()`. They read the same set of approved rules, so `canAllow` could be built on `approved`.
     - `tool/registry.ts`: keep hands' computer filter and connect's offer rule.
     - `smoke-node-bundle.ts`: hands adds 694 lines; re-add `--connect-only`.
     - `subagent-config.test.ts`: the key list becomes the released keys plus `computer` plus `connect`.
     - `event-manifest.test.ts`: the event count becomes 102.
     - `dialog-settings-v2.tsx`, plus the two SDK `types.gen.ts` files and `openapi.json`.
   - Against `build-scope-joined`, 12 files:
     - `read-only-git` and its test (finding 3);
     - the capabilities lists in groups and handlers `experimental.ts` and `engine-capabilities.ts`: keep `connections` beside the `vectorscope*` flags;
     - `server.ts` layers, `httpapi-exercise/index.ts`;
     - the `submit.test.ts` and `bootstrap.test.ts` fixtures;
     - the generated SDK files.
   - Fix: after scope and hands are in, rebuild in one pass `openapi.json`, both `gen/types.gen.ts` and `sdk.gen.ts`, `packages/web/public/config.json`, `packages/web/public/workflow.json` (`schema-file.test` checks it) and the CLI help snapshot. Never edit them by hand.

7. **Low: connect's own CI lanes are tied to the branch name, and diagnostic scaffolding would land on v2**
   - Files: `.github/workflows/connect-app-validation.yml:2-5`, `.github/workflows/connect-guest-diagnostics.yml`, `packages/engine/test/diagnostics/auth-guest-preload.ts`.
   - Problem: both workflows run only on push to `build-connect`. They have no `workflow_dispatch` and no `pull_request` trigger. The guest diagnostics lane and its preload file are a one-off probe for a symptom that was never explained. Spec §7.1 says "It changes no workflow file" (`connected-workspace-spec.md:420`).
   - Failing scenario: on a repair branch such as `v2-connect`, or on v2 itself, neither lane runs and neither can be dispatched. The app regression specs still run in `test.yml`'s e2e job, so the app lane only duplicates that.
   - Fix: drop the diagnostics workflow and preload before the PR. Drop the app lane, or retarget it to `workflow_dispatch` plus a `pull_request` paths filter. Update the spec line.

8. **Low: connect is still visible with the flag off**
   - Files:
     - `packages/engine/src/index.ts:153`: `vector connected` appears in top-level help and always fails with "Connected tools are off in this build".
     - `packages/engine/src/agent/agent.ts:548`: `connect_fix` is still listed by `vector agent list`, and a `task: {connect_fix: deny}` rule is added to every agent. This is the open CW-08 gap.
     - `packages/engine/src/orchestration/guide.txt:11`: this model-facing workflow guide describes connected stages, `vectorscope` and `connect_model` to every model. That breaks spec §8: "All model-facing behaviour sits behind `VECTOR_EXPERIMENTAL_CONNECT`".
     - `packages/web/public/config.json` (`ConnectReviewConfig`): the public schema advertises `after_run: "repair"` and `max_rounds`, which are held (A13). `workflow.json` advertises the connect stage. Both go public at the v2-to-main ship.
   - Fix:
     - Register `connect_fix` only when the flag is on (add `RuntimeFlags.node` to `agent.ts`'s deps).
     - Hide the `connected` command when the flag is off.
     - Append the guide paragraph only when the flag is on.
     - Mark repair "not available yet" in the schema, or keep it out of the enum until A13 is decided.

9. **Low: held automatic repair could switch on silently**
   - Files: `packages/engine/src/task/notify.ts:323,849,876`.
   - Problem: repair is held only because the code checks whether SpendGuard happens to have a `tightenLease` method. No branch defines one, and the docs do not mention the check.
   - Failing scenario: the tokenomics owner adds a method by that name to the protected `spend-guard.ts`. Automatic repair then turns on for users with the flag on and `after_run: "repair"`, without the A13 decision.
   - Fix: add an explicit `REPAIR_AVAILABLE = false` gate in `canReply` and in the after-run path, plus a deviations entry that names it.

10. **Low: handoff and spec do not match the code**
    - The handoff (line 8) says the current source is 6070835df. The head is a8234d9ac, and that commit is not documented.
    - Two of the three CW-08 gaps are already closed (handoff lines 160-161; finish plan item 34 and the task text still list them):
      - `vector run` waiting: `cli/cmd/run.ts:1200` and `run/background-wait.ts`, done in 33c8cf309.
      - Revert stopping the review: `session/revert.ts:191`, done in 33c8cf309.
      - Both have tests: `background-wait.test.ts` (3 cases) and `revert-compact.test.ts`. Only the `connect_fix` listing (line 164) is still open.
    - The spec and handoff still say connect lands on `main` and mention 1.99.113. Under `v2-integration.md`, the target is `v2` and the version becomes 2.0.0.
    - Fix: update the handoff checkpoint and the CW-08 status, and replace the `main` and 1.99.113 wording.

## review:connect:correctness-security

Reviewed `origin/v2...origin/build-connect` at `a8234d9ac` through the correctness-security lens. 11 findings, highest severity first. One process note: `a8234d9ac` (the exclusive task-review instance ownership commit, pushed 11-14 02:52 by "Vector Build Agent") has no completed test run. `test` 43549509307 was cancelled, and only typecheck and app-validation passed. The existing CI receipts are for `6070835df`.

**1. HIGH — Secret files in the change set reach the review model without the ask the requester's read rules require**
- Where: `packages/core/src/connect/policy.ts:670-694` (`readPatterns` drops `if (denied) return` at :690); `packages/engine/src/connect/hub.ts:1059-1086` (`checkReads`, called at :928 and :1009); diff source is `packages/engine/src/cli/cmd/review.ts:983-995`, reached through `adapters/vectorscope.ts:471`.
- Problem: `readPatterns` leaves out every pattern that VectorScope's review rules deny (`*.env`, `*.env.*`, `*.pem`, `*.key`, `.ssh/*`, `.aws/*`), on the theory that the reviewer cannot read those files. That deny only covers the reviewer's read tool. The review collector puts the full text of untracked files (`git diff --no-index /dev/null <file>`) and tracked changes straight into the prompt. `core/review/ignore.ts` does not skip `.env`, `.pem` or `.key`.
- Failing scenario: an untracked, non-ignored `.env` or `server.key`, or a modified tracked `.env.development`. `connect: allow` is the default, so with a local or unpriced user model there is no prompt at all. With `after_run: report` it happens automatically. The file contents go to the review provider. The build agent's own rules (`*.env: ask`, `*.pem: ask`, `*.key: ask`) would have asked first. This breaks invariant "a member never reads what its requester could not".
- Fix: check every path in the target's changed set (`scope.changed`, untracked files and rename old paths included) against the requester's rules with `evaluate("read", path, rules)`, without the review-deny exemption. Refuse, or drop those files from the diff, before `working` and before `executeLocalReview`.

**2. HIGH (does it work) — Every connect review and fix is refused on macOS and Windows, but the registry says VectorScope is "ready"**
- Where: `packages/core/src/read-only-git.ts:498` and `:699` (`process.platform === "linux"`); `packages/engine/src/connect/git.ts:321`; `adapters/vectorscope.ts:302-321` (`describe` never touches ConnectGit) and `:324`.
- Problem: `handle` always runs inside `ConnectGit.use`, which calls `ReadOnlyGit.metadataHead`. That throws on any non-Linux platform, so the run is refused with "This review's Git reads cannot be inspected safely".
- Failing scenario: the owner's Mac. `/vectorscope`, the tool, owner routes and after-run all refuse. After-run writes a refused row on every idle. The members list and TUI still show "ready". The same refusal hits Linux projects opened through a symlinked path, because `git.ts:319` requires `realpath(directory) === path.resolve(directory)`.
- Fix: have `describe()` report `unavailable` with a reason when the private-Git port is unsupported. Treat cross-platform ReadOnlyGit as a blocker for CW-25 (default on) and record it in the deviations log.

**3. MEDIUM-HIGH (does it work) — `target: branch` is refused unless `base` is a full 40-hex SHA**
- Where: `packages/engine/src/connect/git.ts:281` (`defaultBranch: fail`); `packages/core/src/read-only-git.ts:841-847` (`revision()` accepts only `HEAD` or a 40-hex SHA); `adapters/vectorscope.ts:1023-1037` (`mergeBase`).
- Failing scenario: `connect {action: review, target: branch}`, `/vectorscope branch main`, or `vector connected review --base main`. `commitOf("main")` maps to `resolve` and throws Unavailable; no base goes to `defaultBranch` and dies. The run is refused. The app's directory review also fails for an abbreviated or uppercase `baseCommit`, which `agent-dashboard-model.ts:63` accepts as 7-64 hex.
- Fix: resolve named refs inside the private view, for example by copying `refs/` and `packed-refs` and allowing a validated ref name, or resolve the base to a SHA before entering ConnectGit. Implement `defaultBranch` there too.

**4. MEDIUM (process lifecycle, new in `a8234d9ac`) — A failed fresh-instance cleanup poisons that directory and stops `disposeAll` partway**
- Where: `packages/engine/src/project/instance-store.ts:381-385`. Consequences at :167, :210, :250, :284 and :300-312.
- Problem: if `disposeInstanceConfirmed` rejects, `owner.released` is completed with a die and the `fresh`/`cache` entries are never removed.
- Failing scenario:
  - Every later `load`, `reload`, `dispose` or `disposeDirectory` for that task directory dies.
  - `disposeAllOnce` dies at `Deferred.await(owner.released)`, so the remaining cached instances are never disposed. Their MCP, LSP and shell processes stay alive.
  - TUI `shutdown()` rejects before `server.stop(true)`.
- Fix: on cleanup failure, add the directory to `unconfirmed` (so `withFresh` keeps refusing), delete it from `fresh`, and complete `released` with something callers tolerate. Catch failures per owner in `disposeAllOnce` so the other instances still get disposed.

**5. MEDIUM — Background reviews are cancelled by ordinary git use in the checkout, and every check is expensive**
- Where: `packages/core/src/read-only-git.ts:831-840` (`unchanged` compares a digest of the original index), `:202-204` (10 s SIGKILL), `:821-830` (private index rebuilt without stat data), `:298-345` (object copy); `packages/engine/src/connect/git.ts:254-269`; `adapters/vectorscope.ts:342-346` and `:423-424`.
- Failing scenario: the tool output tells the agent to keep working during a background review. The agent runs plain `git status` (Vector's shell does not set `GIT_OPTIONAL_LOCKS=0`) or `git add`. That rewrites `.git/index`, the next helper prompt's `check()` fails, and the review is refused.
- Cost of each `check()`: the rebuilt private index has no stat data and is never written back, so every `status` re-hashes the whole worktree. Medium-sized repos can hit the 10 s kill.
- Cost of each `open`: it copies up to 1 GiB of objects into `os.tmpdir()`, often RAM-backed, and nothing cleans that up after a crash.
- Fix: compare HEAD plus the index tree OID (from `git write-tree` on a private copy) instead of raw index bytes. Persist a refreshed private index between checks. Clean up stale `vector-readonly-git-*` directories at startup.

**6. MEDIUM — A directory-review request key can be left `pending` forever, and the app has no way out**
- Where: `packages/engine/src/connect/owner.ts:392-455`; `packages/engine/src/connect/directory-request.ts:322`; `packages/app/src/features/connect/directory-review-controller.ts:162-220`.
- Problem: anything that fails or is interrupted between `reserve` and `bind` (lines 392 to 448) leaves the key `pending`. That includes the HTTP fiber being interrupted when the response is lost, which is exactly the case this ledger exists to recover. Other triggers are `fenceIsolation`/`issue` errors, `unrecorded` refusals, a failed durable-job write, or an engine restart.
- Failing scenario: the app keeps the key in `sessionStorage` and only offers "Retry review start". Every retry returns `pending`, so directory reviews for that workspace are blocked until the app restarts.
- Also: the ledger is never pruned. After 4,096 reviews in one directory (or 65,536 overall, `:333-339`), every new directory review is refused for good.
- Fix: bind or release the reservation in an `ensuring`/`onExit` path, and reconcile a `pending` key that has no live claim or job as consumed-and-refused. Add retention pruning.

**7. LOW-MEDIUM — The `connect_write` merge approval shows no diff**
- Where: `packages/tui/src/routes/session/permission.tsx:455-470` shows only the description; `packages/app/src/pages/session/composer/session-permission-dock.tsx:81` shows the sentence only. The ask is raised at `packages/engine/src/task/isolation.ts:2366`.
- Failing scenario: merging a `connect_fix` worktree asks `connect_write` with `metadata.diff`, but the user sees only "It changes N files". The `edit` ask that follows (and carries the diff) is allowed by the build agent's defaults, so it never appears. The user approves model-written changes, built from findings an attacker can influence, without seeing them.
- Fix: render `metadata.diff` for `connect_write` in both UIs, as `EditBody` does for `edit`.

**8. LOW — CW-08 gap still open: `connect_fix` is listed with the flag off**
- Where: `packages/engine/src/agent/agent.ts:548-557` and `:842-858`.
- Problem: the agent is registered unconditionally. `vector agent list` and `GET /agent` show it while `VECTOR_EXPERIMENTAL_CONNECT` is off.
- Fix: register it only when `RuntimeFlags.experimentalConnect` is on (add `RuntimeFlags.node` to the deps). The other two CW-08 gaps (`vector run` waiting via `trackConnect`, revert cancelling `connect` jobs) are addressed in source.

**9. LOW — `vector run --attach` never stops background reviews**
- Where: `packages/engine/src/cli/cmd/run.ts:1095-1107`, plus the Ctrl+C path through `stopSession`/`task.stop`.
- Problem: on wait timeout or Ctrl+C, `cr_` IDs are filtered out with the comment "the run's exit ends the review". That is only true for an in-process server.
- Failing scenario: with `--attach`, the review keeps running on the server after the CLI exits, spending up to its cap.
- Fix: call `client.connect.cancel` for each tracked `cr_` ID when not in-process.

**10. LOW (documented A3 leftover, still open) — Session-level ask rules do not reach the fix child**
- Where: `packages/engine/src/agent/agent.ts:842-858` builds `requester` from `agents.build.permission`; `tool/task.ts` `deriveSubagentSessionPermission` passes only denies.
- Failing scenario: a conversation with a session rule `read: {"secrets/*": "ask"}`. A `fix` in worktree mode reads those files in the child without asking. The hub's `checkReads` runs only for reviews.
- Fix: pass the requester session's ask rules into `fixAgentRules`, or run `checkReads` with the merged rules over the fix child's worktree before launching it.

**11. LOW — Changes outside the flag that affect every user**
- Where: `packages/engine/src/config/config.ts:1909`; `packages/engine/src/project/instance-store.ts` (whole rewrite).
- Problem: `loadInstanceState` now always runs `ConfigPaths.canonicalScope`, wrapped in `Effect.promise`, so any rejection is a defect.
- Failing scenario: if the instance directory was deleted, or is reached through a link that resolves outside its worktree, config loading dies for the whole instance, whether or not the flag is on. The instance-store rewrite also changes `load`/`dispose`/`disposeAll`/`loaded` for all callers, and its only test run was cancelled.
- Fix: gate both behind the flag, or fail softly to the previous behaviour. Re-run full `test` on the head.

Files read are under `docs/vector/build/v2-notes/bc` (a `git show` export of `origin/build-connect`).