# cx-label-desktop-github: label Desktop GitHub requests for Vector Local (#142 takeover)

Branch `cx-label-desktop-github`, from Codex's draft PR #142 (`label-desktop-github`). The draft had been idle for more than a day, so this v2 run took it over to finish it so it lands in main before the redesign starts. No feature flag changes and no public claims. `VECTOR_EVERYWHERE_ENABLED` stays off, and the desktop still declines laptop jobs under Vector Local. Each entry names the change, the test that fails without it, and the mutation check.

## 2026-11-26, takeover state and merge with main

**State found.** The PR was one commit (`938c2de9`) and its work was complete. The PR body listed nothing as unfinished. Every CI job in the PR head's verify, typecheck and everywhere runs was cancelled after waiting about six hours for a runner, with no steps run, so those runs gave no signal either way. The jobs that did run on the head passed: typecheck (desktop), engine and core, the air gap, the 30-minute Vector Local desktop packet capture, the website build and the VectorScope jobs.

**Merge.** `origin/main` (`b57b8d53`) was merged in (no rebase), with no conflicts.

**Stacking.** The branch contains no other open PR's commits. #150 (`verify-github-thread`) contains this PR's commit, so this PR merges first. Its code and test changes are kept exactly as Codex wrote them, so #150 merges main cleanly after it.

## 2026-11-26, Desktop GitHub requests ignored Vector Local's `github` allowance

**Bug.** `githubFetch` (desktop `src/main/github-api.ts`) sent each REST and GraphQL request with a plain `fetch`. The Pull Requests panel, VectorScope, the CI view and Vector everywhere's GitHub reads all go through it. No Vector Local decision was made for these requests. In the desktop, the process backstop refused them as `unlabelled` while Vector Local was on, even when the user had allowed the `github` source. Anywhere without the backstop, a request Vector Local should refuse was sent. The `github` registry entry (core `local-mode/sources.ts`) already listed `github-api.ts` as one of its call sites.

**Fix.** `githubFetch` sends through `Egress.fetch("github", ...)`, so each request is decided and logged as the `github` integration source. A refused request throws `GithubRequestError` with Vector Local's own refusal text and status 0, and nothing is sent. Before, the panel showed "Couldn't reach GitHub". With Vector Local off, or with `github` allowed, behaviour is unchanged: same headers, the same 30-second timeout and the same error mapping.

**Test.** desktop `src/main/github-api.test.ts`, "the Desktop GitHub client honors its named Vector Local allowance". With Vector Local on and nothing allowed, `githubJson` rejects with "Vector Local blocked" and the fake `fetch` gets no request. With `github` allowed, the one request reaches the fake with the bearer token, and the last network log event is `github` / `integration` / `allow`.

**Red before.** With `github-api.ts` reverted to `origin/main`, the case fails (10 pass, 1 fail: expected a rejection, but the promise resolved because the request reached the fake). Restored, 11 pass.

**Mutation checks.**
- With the `EgressBlocked` mapping removed from the `catch`, the case fails (10 pass, 1 fail). It got "Couldn't reach GitHub. Check your internet connection and try again." instead of "Vector Local blocked".
- With the request labelled `gitlab` instead of `github`, the case fails (10 pass, 1 fail). The named `github` allowance no longer lets the request through.

## 2026-11-26, lead ruling: the `github` guard in `localAllows` stays

The deviations log's open item ("EV-21, labelled GitHub calls") said the change that labels these calls should also remove the `github` guard in `localAllows` (desktop `everywhere-runner.ts`). It should also put R2's success case back under Vector Local and revise the everywhere source's `note`. This PR labels the calls but keeps the guard. Only the guard's comment and R2's test name change, to give the reason that still applies.

**Why.** `everywhere-wiring.ts` still passes push-path stand-ins: `privateRepository` answers false and `openPr` is undefined. #150 keeps publication closed too. Without the guard, a job taken under Vector Local with all three sources allowed would be claimed, run and spend its budget, then end held at the push gate. Review round one added the guard to stop exactly that. Keeping the guard is the safest option that still fully closes the labelling. Nothing a user sees changes: under Vector Local, every laptop job is still declined `local-mode` before any claim.

**Handed on.** The change that wires the production GitHub push ports (repository visibility and the draft pull request) will:
- remove the guard and its comment;
- put R2's success case back under Vector Local;
- revise the everywhere source's `note` in `sources.ts` to name the job's `github` requests;
- ask the owner whether the app's `KEPT_OFF` line for the source goes.

The `note` stays as it is for now because no production job makes a GitHub API call yet. It describes only what HEAD does.

**Stale wording left for follow-up.** Other open PRs touch these files, so this PR does not edit them. Each now needs to say "until the production GitHub push ports are wired" instead of "until the GitHub calls are labelled":
- schema `src/everywhere.ts`, the `localMode` doc comment (#118, #123, #140, #150, #157);
- web `src/drafts/docs/everywhere.astro`, the header comment (#123, #157);
- `vector-everywhere-deviations.md`, the "EV-21, labelled GitHub calls" open item (#118, #140);
- `vector-everywhere-spec.md`, the §3.5 EV-15 note (#117, #123, #150, #157);
- `vector-everywhere-handoff.md`, the "Vector Local and laptop jobs after EV-15" bullet (#116, #117, #121, #123, #138, #150, #157).

## Tests run

Each file was run alone from `packages/desktop` with `--timeout 30000`, after the merge with main. They cover the PR's two test files and every desktop module that imports `github-api.ts` or `localAllows`:

| File | Result |
| --- | --- |
| `src/main/github-api.test.ts` | 11 pass |
| `src/main/everywhere-runner.test.ts` | 62 pass |
| `src/main/everywhere-wiring.test.ts` | 31 pass |
| `src/main/github-pr.test.ts` (loopback GitHub fake) | 31 pass |
| `src/main/ci-watch.test.ts` | 16 pass |
| `src/main/everywhere-github.test.ts` | 6 pass |
| `src/main/everywhere-pr.test.ts` | 2 pass |
| `src/main/github-agents.test.ts` | 23 pass |
| `src/main/github-agents-brain.test.ts` | 17 pass |
| `src/main/ops.test.ts` | 8 pass |

`bun typecheck` in `packages/desktop` passed. All the tests use fakes and loopback servers, and none needs Valkey or platform-only tooling. In CI on a pull request, the everywhere lane (`vector-everywhere.yml`, "Vector everywhere tests") runs the desktop's `everywhere-*.test.ts` files, and a change to `github-api.ts` starts that lane. The other desktop files, `github-api.test.ts` among them, run in CI only in the desktop release workflow's `bun run test`. test.yml's `unit` jobs run only the desktop's computer-use files, because turbo has no desktop test task.
