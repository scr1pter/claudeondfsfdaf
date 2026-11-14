# Vector v2: master handoff (2026-11-14)

Read this first. It is enough to pick up all the in-flight work from a fresh `git clone` of `scr1pter/claudeondfsfdaf` (public).

## The goal

1. **Finish every in-flight feature and get all of it into `main`.**
2. **Delete every branch except `main`.** Delete each one only once its work is fully in `main`, and record each deleted branch's last commit.
3. **Then** build the desktop redesign, Vector Signature (`docs/vector/design/signature/`).
4. **Then** build the new features it shows: On-call, Plan and Artifacts (plus the Simulator, commands and walkthrough).
5. **Ship as Vector v2, version 2.0.0.** There is no 1.99.113 release.

## Owner decisions in force

- **No long-lived integration branch.** Everything merges straight into `main`.
  - Every push to `main` deploys vectordev.ai (site, `api/` functions, redirects, crons) to production through Vercel.
  - New features therefore stay off by default behind their flags.
  - Check the branch's Vercel preview before each merge.
  - The temporary `v2` branch was used for the first merges. Once `main` equals `v2`, retarget any PR whose base is `v2` to `main`, then delete `v2`.
- **Merges.** The agent finishing this work may merge finished, reviewed, CI-green branches into `main` in the planned order without asking each time, and tells the owner after each merge.
  - Still ask first for: cutting or publishing a release, public or comparative claims, purchases, platform app registrations, and deleting branches that are not yet fully in `main`.
- **Ownership.** Every area is now this work's to finish, including Hands, which the owner says is done.
- **Version:** 2.0.0.
- **agent-environment** (the agent fully controls its own terminals and browser) is in v2 as a main feature.

## Rules (binding)

- **Never:**
  - force-push or use `--no-verify` (fix whatever the pre-push typecheck reports);
  - use `git stash`;
  - rebase or rewrite history that exists on origin (use merge commits).
- **Installs and turbo:**
  - Install with `bun install --ignore-scripts`.
  - Set `TURBO_CACHE_DIR` inside your own checkout before any turbo command or push.
- **Tests:** run them one file at a time from the package directory (`bun test --timeout 30000 <file>`), and typecheck per package or with `bun turbo typecheck --concurrency=2`. Full suites, browser and native lanes run only in GitHub CI. Heavy local runs crashed the owner's Vector app before.
- **Never, anywhere:**
  - read credential files;
  - put the owner's email in the repository (commit as `Vector <bot@vectordev.ai>`);
  - name the open-source project this code was forked from, in code, docs or commits.
- **Tokenomics and benchmarks:** never edit tokenomics or benchmark *files*; another agent owns them. The merged tokenomics branches were deleted with the owner's yes.
- **The owner's computer:**
  - Never start or restart the owner's Vector app.
  - Never let Hands or any test drive the owner's real screen, keyboard or browser.
- **Pushing `main`:**
  - On the owner's Mac, push `main` only from `~/.cache/vector-main` with `git push origin main-wt:main`.
  - Elsewhere, only fast-forward pushes or GitHub PR merges.
  - Never touch the owner's main checkout in the session folder.
- **Flags stay off by default:** `MODEL_PLANS_ENABLED` (Codium), `VECTOR_EXPERIMENTAL_CONNECT`, `VECTOR_EVERYWHERE_ENABLED`, `VECTOR_GITHUB_BRAIN_ENABLED`, native isolation, Hands (until onboarding), cloud workspaces.
- **Known CI flakes.** Re-run once with `gh run rerun <id> --failed`, and only when the failed job matches one of these and nothing else failed:
  - a Bun segfault on a Linux shard;
  - Windows: `local-fit`, `prompt` 3 s, `task-size` 30 s, effect-flock contention, `local.test` probe 400, `task-manage-abort` 2 s;
  - packet-capture DNS (UDP to 198.18.0.53:53) or the 55-minute setup timeout;
  - GitHub "Failed to CreateArtifact";
  - Chocolatey or ripgrep 504;
  - Vite "Outdated Optimize Dep" 504;
  - `engine review.test.ts:1050` failing because a random SHA contains "987". That is a known test bug in tokenomics territory: never edit that file.
- **CI triggers:**
  - `test.yml` and `verify.yml` run on `pull_request`.
  - `typecheck.yml` runs on PRs into `main` and `v2`.
  - On other branches, dispatch them with `gh workflow run <file> --ref <branch>`.

## Where things stand (2026-11-14, about 07:30 UTC)

**In `v2` (and going to `main`):**
- #26 process ownership (supersedes #23, closed).
- #27 release coordination.
- Codium #24 (Track A A29–A58, Track B B01–B11 source; supersedes #28, closed).
- The docs: `v2-integration.md` (merge log, plus the list of deleted branches with their SHAs), `v2-spawn-review.md`, `v2-finish-plan.md`, and this file.
- The design folder.

**Pending first step:** fast-forward `main` to `v2`.
- Check first that `v2`'s `test` run is green. Run 43567384542 failed only on a Linux Bun segfault and was re-run.
- Then retarget open PRs to `main` and delete `v2`.

**Lanes that were in progress.** Each may have pushed commits and a draft PR into `v2`. Check `gh pr list`, re-fetch, and continue from the branch head.

| Branch | What it is | Left to do |
|---|---|---|
| `v2-hands` | Hands (computer use) integration, from `hands`. Hands is done: last code commit `a0e5ce8e8` all green; unsigned package handoff `4eb9f52fd` | Merge `main` in and resolve 10 conflicts per `v2-spawn-review.md`:<br>• `task/shells.ts`: Hands' `beforeSpawn` recheck runs before #26's `background.start` writes a job row.<br>• `pages/layout.tsx`: Codium's `sendPhoneAlert` moves into Hands' `ask-notifications.ts`.<br>• Eight mechanical files.<br>Then review, CI and merge. Close #22 |
| `v2-complete` | One combined branch for @vector, VectorScope, connected workspace and Vector everywhere, built from `build-complete` (`00b87034f`) | Fold in `v2`/`main`, plus the stopped lanes `v2-vector`, `v2-scope`, `v2-connect` and `v2-everywhere` (all on origin), and the review findings for connect and everywhere.<br>Resolve process spawn per `v2-spawn-review.md`: one signaler per spawn, the owner is the outermost layer, and the Windows background path keeps the isolation floor.<br>Renumber VectorScope's Brain migrations after Codium's `20261213`/`20261214` and add an ordering test.<br>After Hands lands, merge `main` again and resolve the Hands × @vector/scope/connect conflicts.<br>Full CI, three-lens review, merge. Close #25 |
| `cloud-workspaces` (#21, base `v2`) | Persistent cloud sessions | Merge `main` in. Move `closeCloudWorkspaces` into Codium's staged `finishAccountDeletion`. Change "credits" to percentages-only copy. CI, review, merge |
| `agent-environment` | The agent's own terminals and browser (original commit `0806bafd7`) | Bug review, finish on top of `main`'s newer process and browser pieces, tests, CI, review, merge |
| `v2-codium-acceptance` | Codium B09, B10 and B11 acceptance runs | Finish, CI, merge. B08 waits until @vector is in |
| `v2-locks` | Lock follow-ups: `forceRemove` swallowed errors, twin `flock.ts` mkdir, `LockCompromisedError` message | Finish, CI, merge |

**Other branches still to resolve:**
- `build-native-shell` and `build-isolation` (@vector native isolation): merge switched off after `v2-complete`. Its real-machine qualification is a shipping gate.
- `owner-setup`, `build-coordination` and `codium-legal`: docs-only, merge them. `codium-legal` holds the legal drafts for the owner's legal read.
- `hands-diagnostics`: 10 commits not on `hands`. Check whether they are superseded, then merge or drop.
- `hands-ui-check`: contained in `hands`.
- `finish-checks` and `codium-track`: everything in them is already merged. Delete them.
- `benchmark-before`: one benchmark commit that conflicts in `test.yml`. The owner decides.
- `vectorscope`: stale and superseded by the scope fold. Delete it after `v2-complete` merges.
- Only on the owner's Mac: `r2-downloads` (parked; the owner decides) and `ci-tmp-90acb30c` (temporary; drop).
- `build-candidate`, `build-complete`, `build-integrate`, `build-github-ui`, `vector-at-mention`, `build-scope*`, `build-connect`, `connected-workspace`, `vector-everywhere` and `build-everywhere`: all fold into `v2-complete`. Check that `build-everywhere`'s extra runner tests are included.

## After those merges

1. **Codium:**
   - B08: job dispatch screen, live run reader, Redis/Lua upload hardening, Brain-history encryption.
   - The A59 joint check with @vector.
2. **@vector:** V27 runtime (save and restore, runner attestation, desktop Brain transport, preview and import) and V30 acceptance. V31 comes after A49.
3. **VectorScope:**
   - The VS-12 executor, VS-14, 15, 18, 19 and 26.
   - Wiring of VS-23/24/25/27/28/34/42/43/44, with defaults unchanged.
   - VS-05 and VS-13, plus the GitHub and Codium halves.
4. **Connected workspace:** CW-20 to CW-25. Turning it on by default is the owner's Q1.
5. **Vector everywhere:** Phase 3 (laptop route), Phase 4 (Actions fallback) and Phase S (settings, site pages, docs).
6. Regenerate the SDK, openapi and help snapshots once, and fix the fallout.
7. **Version 2.0.0 everywhere:**
   - desktop and CLI;
   - `MIN_AGENTS_CLI` and `MODEL_PLANS_MIN_CLIENT`;
   - the 44+ files that mention 1.99.113;
   - the live site's "Coming in desktop 1.99.113";
   - the release docs and policy names.
8. Full CI green on `main`, plus a check of the production site.
9. **Delete every remaining branch except `main`.** Verify each first with `git rev-list --count main..<b>` or `git cherry`, and record its last commit in `v2-integration.md`. Close leftover PRs.

## Owner-only items

These block shipping, not merging.

- **Hands:**
  - Apple Developer ID and Azure Trusted Signing.
  - Device checks: a clean Mac, Windows 11, and reset on macOS 14, 15, 26 and 27.
  - Legal, name and icon.
  - Decisions O1–O5.
- **Codium A60:**
  - The legal read.
  - Stripe, an OpenRouter account and terms, Cloudflare.
  - Signing and HMAC keys, VAPID, vault salt, R2, `remote.vectordev.ai`, Supabase SQL, the Vercel spend webhook.
  - The go-live switches, and the open questions in spec section 8.3.
- **@vector:**
  - Register the GitHub App (not named "vector").
  - Set `VECTOR_RUN_TOKEN_SECRET` and `VECTOR_RUN_ARTIFACT_SECRET`.
  - A live OIDC check and acceptance on a private repository.
- **Vector everywhere:** Slack, Linear and Jira apps; the data key and the offer signing keys; privacy text.
- **VectorScope:** an evaluation key with a $50 limit, a pilot, and publishing the CLI to npm.
- **Cloud workspaces:** the hosting list and the billing decision.
- **Connected workspace:** Q1, and the held-back capabilities.
- **GitHub:** the `codium-test`, `hosted-production` and `vectorscope-eval` environments, plus branch protection on `main`.
- **Release:**
  - Release-candidate checks RC-01 to RC-12 on Mac and Windows.
  - The default-behavior sign-offs and privacy wording.
  - Whether helpers get terminal access, and whether settings import works in non-git folders.
  - Vector Labs on the pricing page, which the current tests forbid.
  - The two Codium sentences on `docs/tokenomics.astro`.
- **Outside:**
  - Security reviews of Remote, the hosted computer and the revert-PR path.
  - A trademark search for "Vector Hands".

## Key documents

- `docs/vector/build/v2-finish-plan.md`: the full assessment, conflicts and merge simulation, and owner decisions A0–A21. It was written before the owner's later answers, which this file supersedes.
- `docs/vector/build/v2-spawn-review.md`: how process spawn, ownership and isolation must combine.
- `docs/vector/build/v2-integration.md`: the merge log and the list of deleted branches with their SHAs.
- **Per-area specs and handoffs:**
  - `codium-build-spec.md` and `codium-track-b-checkpoint.md`;
  - `vector-at-mention-spec.md` and its progress notes;
  - `vectorscope-remaining.md`;
  - `connected-workspace-handoff.md` and `vector-everywhere-handoff.md`;
  - the hands docs on `hands`.
- `docs/vector/design/signature/`: the redesign. Its README links the live canvas.

## How to work

- **One lane per area, each on its own branch.** For each lane: build, then review from two or three angles (correctness and security, data, fit), repair, get CI green, check the Vercel preview, then merge.
- **Re-fetch before every push.** If someone else's commits appeared, merge them in; never overwrite them.
- **Too many lanes at once** fill GitHub's runner queue and hit the shared API rate limit, so poll gently.
