# cx-verify-github-thread: authorize owner GitHub issue reads (#150 takeover)

Branch `cx-verify-github-thread`, from Codex's draft PR #150 (`verify-github-thread`). The draft had been idle for more than a day, so this v2 run took it over to finish it so it lands in main before the redesign starts. No feature flag changes and no public claims. `VECTOR_EVERYWHERE_ENABLED` stays off, so the new route answers 404 in production, and the desktop still declines laptop jobs under Vector Local. Each entry names the change, the test that fails without it, and the mutation check.

## 2026-11-26, takeover state and merge with main

**State found.** The PR's own work was complete on its head (`19160249`): the desktop GitHub thread reader, the hosted `POST /api/everywhere/jobs/github-thread` proof and the binding generation carried on GitHub handoff jobs. Every CI job on the head had been cancelled before it got a runner, so CI gave no signal either way. Nothing was left unfinished in the PR body except the Valkey case (CI only) and live timing and activation (platform qualification, which stays with the owner).

**Merge.** `origin/main` was merged in (no rebase). Main now has #117 squash-merged, which this branch carried as its original commits. One conflict, in `packages/web/test/everywhere-github-live.test.ts` imports: main uses `openSummary`, this PR adds `openReply`, `updateJobReply` and `createJobsApi`. Both sides are kept.

**Stacking.** The branch contains #118 (`everywhere-publication-ack`), #140 (`replay-held-settlements`, which includes #118) and #142 (`label-desktop-github`). All three are Codex's open drafts.

**Lead ruling.** This PR merges only after #118, #140 and #142 have merged, or together with them as their exact descendant. Their changes are not edited here.

## 2026-11-26, a laptop GitHub job could read a thread without proving the live claim, App binding and issue kind

**Bug.** Before this PR, the desktop's GitHub thread port was not wired (`githubThread` was unset), and `readEverywhereGithubThread` only took a ready credential and checked the repository id and name. Nothing tied a thread read to the current claim's lease, the App binding the handoff was created under, or the person who signed in to Vector. Also, REST `/issues/:n` also returns pull requests, so a number GitHub resolves to a PR would be read as an issue body.

**Fix.**
- Hosted (`api/_lib/everywhere/jobs-api.ts`, `adapters/cloud-agents.ts`, `github/adapter.ts`): the handoff records the App binding generation in the job's sealed reply. `githubThread` answers `{expiresAt}` only for the signed-in sponsor's own claimed laptop issue job on this device with this exact lease, inside the offer window, lease and deadline. `createGithubThreadAuthority` matches the current binding (repository id and name, account, installation, binder, generation, Codium mode). It reads the App's live repository metadata, checks the claim again, then checks the binding again. A missing proof, a replaced binding, the `stop` switch or a lapsed window answers 404. The route reads only and does not sweep.
- Desktop (`everywhere-github.ts`, `everywhere-runner.ts`, `everywhere-wiring.ts`): `readAuthorizedGithubThread` takes only the Vector GitHub sign-in and proves `/user` is the trigger's actor. It checks repository visibility against the job and proves the native issue kind with GraphQL (no body fields). Then it asks the hosted proof and checks the credential has not changed, all before the first REST thread body. Every read is bound to the runner's abort signal and the proven expiry. Publication ports stay closed (`privateRepository` false, `openPr` undefined).

**Tests.**
- web `test/everywhere-github-live.test.ts`, "a signed handoff authorizes thread reads only for the live lease and original App binding": another account, another device and another lease each get 404 before any metadata read. The live claim gets `{expiresAt}` and leaves the job unchanged. Generation 2, another installation, another binder and a suspended binding each get 404. A binding replaced during the metadata read, the `stop` switch during it, and a cleared generation each get 404.
- desktop `src/main/everywhere-github.test.ts`, the "qualified reader" cases: request order `/user`, `/repositories/101`, `/graphql`, proof, then bodies. A PR-shaped number, cancellation at the lease check, a non-owner claim, a PR claim, a CLI login, another OAuth user, a shared-visibility change, the wrong GraphQL repository or issue number, a refused proof, an OAuth switch during the proof, and an expired proof each stop before any thread body.

**Red before.** With `cloud-agents.ts`, `jobs-api.ts` and `github/adapter.ts` reverted to `origin/main`, the web file fails (0 pass, 1 fail). With `everywhere-github.ts` reverted to `origin/main`, the desktop file fails (0 pass, 1 fail). Both pass again once restored.

**Mutation checks.**
- Without the generation comparison in `createGithubThreadAuthority`, the web case fails (expected 404, received 200; 22 pass, 1 fail).
- Without the exact lease comparison in `githubThread`, it fails the same way.
- Without the GraphQL issue-kind proof on the desktop, 8 of the 19 desktop cases fail.
- Restored, the web file has 23 pass (and 1 Valkey skip), and the desktop file has 19 pass.

**Also run, one file at a time.** desktop `everywhere-runner` (70), `everywhere-ledger` (9), `github-api` (11), `everywhere-wiring` (31). web `everywhere-github` (17), `everywhere-jobs-api` (23), `everywhere-cloud-adapter` (85, 3 Valkey skips). Typecheck: desktop, web, schema, and `api/` against the root tsconfig.

**CI only.** The Valkey case "R3: R1 on Valkey" and the cloud adapter's Valkey cases need `VECTOR_TEST_REDIS_URL`. They run in the `Vector everywhere tests` job of `vector-everywhere.yml`.

**Known limit, left for platform qualification.** After the proof, the desktop refuses any expiry that is more than the 20-second offer window ahead of its own clock. If the desktop clock runs behind the server's by more than the time already spent since the offer, the read fails closed and the job does not run. This is safe, and live timing is part of the owner's platform qualification.

## 2026-11-26, review: no test held the new public route shut while the feature is off

**Gap.** The PR and this entry say `POST /api/everywhere/jobs/github-thread` answers 404 while `VECTOR_EVERYWHERE_ENABLED` is off, and every push to main deploys that route. But no test mounted `api.githubThread` with the feature off, with GitHub missing from `VECTOR_EVERYWHERE_PLATFORMS`, or with no thread authority wired. The route's code was already correct, so this entry adds tests only and changes no route code.

**Tests.** In web `test/everywhere-jobs-api.test.ts`, `mount()` now mounts `api.githubThread`. Each case sends a well-formed `{jid, lease}` with the device header and a desktop token, so only the route's first guard can refuse it.
- "while the feature is off every route answers stop, or 404 for the GitHub thread check, before any store read" (the existing feature-off case, extended). With an authority wired and GitHub listed, the check answers 404 `NOT_FOUND`, the authority is never called, and the store sees no command.
- "with the feature on but GitHub not among the platforms it answers 404 before any store read". The authority is wired and never called, and the store sees no command.
- "with no thread authority wired it answers 404 before any store read". GitHub is on and the store sees no command.
- "with GitHub on and an authority wired the same check reads the store, and an unknown job is 404". This is the control: with every guard open, the same request does reach the store, so the empty command lists in the cases above prove something. No such job exists, so it is still 404 and the authority is never called.

**Mutation checks.** Each one removes one part of the route's first guard, `if (started.off || !platformOn(started.config, "github") || !authority)`:
- Without `started.off ||`, the feature-off case fails: the route answers 500 instead of 404 (25 pass, 1 fail).
- Without `!platformOn(started.config, "github")`, the platforms case fails (25 pass, 1 fail).
- Without `|| !authority`, the no-authority case fails: the store sees the revocation, account and job reads (25 pass, 1 fail).
- Restored, the file has 26 pass (23 before, plus 3 new cases).

**Red before.** Not applicable: this entry adds only tests for code that was already correct. The three mutation checks above are the evidence that each case can fail.
