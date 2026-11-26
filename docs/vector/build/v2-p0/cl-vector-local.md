# cl-vector-local: Vector Local loose ends

Branch `cl-vector-local`, cut from origin/main `dbeb06661` (feat(everywhere): verify repositories through sponsor bindings, #117). It closes the Vector Local loose ends for Vector v2: the meaning of an allow entry with no hosts (VL-1), the company's `local.recommend` table (VL-2), which Vector a Vector Local switch is for (VL-3), the Windows identity failure (VL-4, record only), stale comments (VL-5) and the guard's Octokit note (VL-6). No flag changes, no generated file changes (no Effect Schema annotation, HTTP schema or route is touched, so `packages/web/public/config.json`, the SDK and `packages/client` stay as they are), and no public docs page is edited.

Open-PR check (live, 2026-11-25, 42 open PRs, `gh pr diff <n> --name-only` for each): no file this branch edits is held by an open PR. `packages/engine/src/tool/shell/sandbox.ts` (#128, #161, #162, #163, #167, #170) and the `vector github` command files (#98, #106, #160) are read only. Re-checked when the drafting ended: 38 open (#100, #158, #160 and #165 had merged into main, none touching a file here), still none holding a file this branch edits, and main still has 8 GitHub client sites, each with its fetch.

Test runs: the drafting step may not run a test runner or a typechecker, so every "fails without it" and mutation line below is the check to run, with the expected result. The verifier runs each and records what it saw.

## 2026-11-25, VL-1: an allow entry with no hosts

**What it closes.** `LocalPolicy.allowEntry` (`packages/core/src/local-mode/policy.ts`) lets an entry with no `hosts` match every host for its source, and the app's Always allow always adds such an entry. But the schema comment said "without hosts the source's own registry hosts apply", the Allow dialog's "To" line and Settings → Vector Local → Allowed services showed the registry hosts as if they were the limit ("github.com, api.github.com and vectordev.ai"), and `vector local allow --host` said "only these hosts of it". The held-change text was already right ("allows github for any host").

**Lead ruling (R1-0): keep the behaviour, make every text say it exactly.** The item's rule was to restrict host-less entries to each service's own hosts only if the policy knows them. It does not. The registry's `hosts` (`packages/core/src/local-mode/sources.ts`) are the hosts a source usually reaches, written for the log and the dialog, and they are incomplete for allowable sources. Each of these works today and would break silently under a "registry hosts only" rule, with no fake-only test able to catch it (`Egress.fetch` decides every redirect hop):

- `embedding-model` lists `huggingface.co`; the download follows redirects to `*.hf.co` (`packages/core/src/brain/embed-manifest.ts`).
- `github` lists `github.com`, `api.github.com`, `vectordev.ai`; attachments redirect to `*.githubusercontent.com` (`packages/engine/src/cli/cmd/github.attachment.ts`).
- `lsp-install` lists `registry.npmjs.org`, `proxy.golang.org`, `rubygems.org`, `github.com`; `packages/engine/src/lsp/server.ts` also reaches `api.github.com`, `api.nuget.org`, `www.eclipse.org`, `download-cdn.jetbrains.com`, `api.releases.hashicorp.com` and GitHub's release-asset hosts.
- `cloud-computer` lists `vectordev.ai`; the live view loads the https viewer host its link names (`packages/app/src/features/cloud/hosted/hosted-requests.ts`, `packages/desktop/src/main/hosted-window.ts`).
- `model-catalog` lists `vectordev.ai`; `VECTOR_MODELS_URL` points it at a mirror (`packages/core/src/model-catalog.ts`).
- Sources whose host the user or company chooses (`mcp-remote`, `git-remote`, `remote-config`, `telemetry`, `crash-reports`, `local-server-check`) list none; `packages/desktop/src/main/everywhere-git.test.ts` relies on a host-less `git-remote` entry.

Narrowing after a registry audit is owner item O5. The public docs page says nothing about allow-entry hosts, so it is not edited.

**Fix.**

- `packages/app/src/features/local/local-model.ts`: new `allowHosts(entry, source)`. With entry hosts it lists them; with none it says `Any host it reaches, usually <registry hosts>`, or `The addresses set for it` when the registry lists none.
- `packages/app/src/features/local/allow-dialog.tsx`: the "To" line is `allowHosts(undefined, source.hosts)` (the dialog only adds host-less entries); the unused `list` import is dropped.
- `packages/app/src/components/settings-v2/local-model.ts`: `allowedRows` returns `hosts: allowHosts(entry.hosts, source?.hosts ?? [])`.
- `packages/app/src/components/settings-v2/local.tsx`: the Allowed services row reads "Sends … to {hosts}." mid-sentence, so it renders `lowerFirst(row.hosts)` ("to any host it reaches, usually …"); `lowerFirst` in `features/local/local-model.ts` is now exported. Lead call: a render-only grammar fix that the new copy makes visible; the row data the tests pin is unchanged.
- `packages/schema/src/local-mode.ts`: the `Allowed` comment (a plain comment, not an annotation, so nothing regenerates) says hosts limit an entry, and an entry without hosts covers every host the source's labelled requests go to.
- `packages/core/src/local-mode/policy.ts`: a doc comment on `allowEntry` says the same and why. No code change.
- `packages/engine/src/cli/cmd/local.ts`: `--host` is "only these hosts (without --host it covers every host the service reaches)". No CLI help snapshot covers `vector local`.

**Tests.**

- Fails without the fix: `packages/app/src/features/local/local-model.test.ts`, new describe "where an allowed service may go" (3 tests): entry hosts give `tools.example.org`; a host-less entry gives `Any host it reaches, usually github.com, api.github.com and vectordev.ai` (from a literal list and from the registry's `github` hosts, with `[]` as the entry); no registry hosts give `The addresses set for it`. Red-before: revert `packages/app/src/features/local/local-model.ts` (no `allowHosts`).
- Updated, same strictness: `packages/app/src/components/settings-v2/local-model.test.ts`, "allowed services > say what each sends, where, the reason, who added it and when" now expects the new `hosts` for the host-less `github` row; row 2 (`tools.example.org`) is unchanged. It pinned the misleading copy. Red-before: revert `packages/app/src/components/settings-v2/local-model.ts`.
- Ruling pin (passes before and after): `packages/core/test/local-mode/policy.test.ts`, "an allow entry without hosts opens its source for any host it reaches": a host-less `github` entry allows `https://github.example.com/api/v3` for source `github` (rule `allowed-source`) and still blocks it for `gitlab`.
- `packages/app/e2e/regression/vector-local.spec.ts`: the Allow dialog under a lock also contains "Any host it reaches" (same locator, no new wait). The existing registry-hosts substring still matches.

**Mutation check.** Make `allowHosts` return `list(source)` for a host-less entry: the new features test ("an entry with no hosts covers any host …") and the settings test fail. Restore with `git checkout`. Not run in the drafting step.

## 2026-11-25, VL-2: `local.recommend` is read

**What it closes.** `packages/core/src/v1/config/local.ts` declares `recommend` ("Managed only: replaces the bundled model recommendations"), and `LocalRecommend.table(override)` already checked a company table and fell back to the bundled one. But both callers used the bundled table: GET /local/recommend (`packages/engine/src/server/routes/instance/httpapi/handlers/local.ts`) and `vector local setup` when nothing answers (`packages/engine/src/cli/cmd/local.ts`, `noServer`). A company's table was never read.

**Lead ruling.** Wire it in (the company's table first, the bundled table as fallback); do not remove the key. It is managed-only, and the response shape (`LocalRecommendation`, `LocalSuggestion`) is unchanged, so there is no SDK, `config.json` or schema regeneration. A company table Vector cannot use is ignored with a policy warning, so the fallback is never silent. Lead calls beyond the spec, both stricter and both tested: a tier must name a model the table has as its own key (`Object.hasOwn`, so `constructor` no longer passes as it did with `in`), and each model's `memory_gb` and `context` must be finite, since the Local API answers them as `Schema.Finite` and JSON reads `1e400` as Infinity, which would otherwise make GET /local/recommend fail for every user of that company.

**Fix.**

- `packages/core/src/local-mode/recommend.ts`: new `problem(override)`. It returns undefined for undefined, null or a usable table, and otherwise one of: `it is not a recommendation table`, `no tier starts at 0 GB`, `a tier names a model the table does not have`, `a model's memory_gb or context is not a finite number`, `a model's link is not an http or https address` (the CLI prints `links[0]` as it is). `table()` uses the same check; `consistent` is folded into it.
- `packages/engine/src/config/config.ts`: imports `LocalRecommend`. `readLocalSources` adds `Ignored local.recommend in your company's policy: <reason>. Vector suggests models from its own examples.` to the warnings when the company's `recommend` is non-null and has a problem. `evaluateLocal` returns `recommend: sources.managed?.recommend`, `refreshLocal` keeps it in `localState.recommend`, and the new `localRecommend()` returns it. The module-load refresh and the watcher keep it current.
- `packages/engine/src/config/local-settings.ts`: new `recommendation(usable)`, which is `LocalRecommend.recommend({ usable, table: LocalRecommend.table(Config.localRecommend()) })`.
- GET /local/recommend and the CLI's `noServer` call `LocalSettings.recommendation(hardware.usable)`; the handler's unused `LocalRecommend` import is dropped.

**Tests.**

- Fails without the fix: `packages/engine/test/server/local.test.ts`, "model suggestions come from the company's table, and one Vector cannot use falls back with a warning". It writes `VECTOR_TEST_MANAGED_CONFIG_DIR/vector.json` with `local.recommend` set to the bundled table relabelled `Company models. Check each model's licence.` with one tier `{ id: "all", min_gb: 0, roles: { agent: "glm-4.6" } }`, then `useManagedPolicyFixture` and `Config.refreshLocal()`. GET /local/recommend answers that label, tier `all` and `roles.agent.key` `glm-4.6` (one tier from 0 GB, so the runner's memory does not matter). Rewritten with a missing agent model and refreshed, it answers the bundled label and `Config.local().warnings` contains the full `Ignored local.recommend …` line. `finally` removes the folder, restores the fixture and refreshes. Red-before: revert `packages/engine/src/config/local-settings.ts`, `packages/engine/src/config/config.ts` and `packages/engine/src/server/routes/instance/httpapi/handlers/local.ts`.
- Fails without the fix: `packages/core/test/local-mode/recommend.test.ts`, "recommendations per memory tier > says why a company table cannot be used": undefined, null, the bundled table and the company table have no problem; `42`, an 8 GB-only tier, a missing model, a `constructor` model key, an infinite `memory_gb` and a `javascript:alert(1)` link each give their reason; the link table falls back to the bundled label and the company table keeps its own. Red-before: revert `packages/core/src/local-mode/recommend.ts`. The existing "a company's table replaces the bundled one only when it is whole" stays as it is.

**Mutation checks.** (1) In `LocalSettings.recommendation` drop `table:`: the server test fails on the label. (2) Remove the link rule from the check in `recommend.ts`: the core test fails on the `javascript:` case. Restore each with `git checkout`. Not run in the drafting step.

## 2026-11-25, VL-3: the CLI and the desktop app keep separate Vector Local settings

**What it closes.** The desktop's engine reads `XDG_CONFIG_HOME=<userData>/xdg-config` (`packages/desktop/src/main/sidecar.ts`, `packages/desktop/src/main/local-policy.ts`); a terminal's `vector` reads `~/.config/vector`. The confirmed copies are one per config folder on purpose (`Config.localConfirmedFile`, `packages/engine/src/config/config.ts`). So `vector local on` never reaches the app, and the app's switch never reaches the terminal, and neither said so. Company policy and `VECTOR_LOCAL` reach both.

**Lead ruling.** Clear messages in both places, not a shared setting. A shared switch would cross two config folders and two confirmed copies that are separate by design, and a CLI "on" reaching the app would turn Vector Local on there with the app's own server list, which may be empty and would break its chats. The messages remove the surprise with no change to enforcement. The TUI is not changed: it follows whichever engine it is attached to, so a fixed sentence there could be wrong.

**Fix.**

- `packages/engine/src/cli/cmd/local.ts`: exported `SURFACE` ("This is Vector Local for Vector in a terminal. The desktop app keeps its own setting, in its Settings → Vector Local. Your company's policy applies to both."), printed last and dim by `describe()`, so `vector local status`, `on`, `off`, `web`, `allow` and `confirm` all say it. `--json` returns before `describe()`, so JSON output is unchanged.
- `packages/app/src/components/settings-v2/local-model.ts`: exported `SURFACE` ("This switch is for the desktop app. Vector in a terminal keeps its own setting: vector local on turns it on there. Your company's policy applies to both.") and `surfaceNote({ desktop, remote })`, which returns it only when `desktop && !remote`.
- `packages/app/src/components/settings-v2/local.tsx`: `SwitchCard` takes `surface` and renders it first in the card body as a `local-muted` note. The page passes `surfaceNote({ desktop: desktop.latest !== undefined, remote: reader.remote() !== undefined })`: `desktopLocal()` is undefined outside the desktop app, and `reader.remote()` is undefined for this computer's engine (`packages/app/src/features/local/use-local.ts`). A browser, or the app reading another computer's engine, shows no note.

**Tests.**

- Fails without the fix: `packages/engine/test/cli/local.test.ts`, "asks at a terminal before loosening, so without one nothing changes": after the existing `held` assertion, `expect(held.stderr).toContain(SURFACE)`, with `SURFACE` imported beside `sinceOf`. No new spawn and no timeout change. Red-before: revert `packages/engine/src/cli/cmd/local.ts` (no `SURFACE` export, no line).
- Fails without the fix: `packages/app/src/components/settings-v2/local-model.test.ts`, new describe "which Vector the switch is for": `surfaceNote({ desktop: true, remote: false })` is `SURFACE` (which names `vector local on`); `{ desktop: false, remote: false }` and `{ desktop: true, remote: true }` give undefined. Red-before: revert `packages/app/src/components/settings-v2/local-model.ts`.

**Mutation checks.** (1) Make `surfaceNote` return undefined: the app test fails. (2) Remove the `SURFACE` println from `describe()`: the CLI test fails. Restore each with `git checkout`. Not run in the drafting step.

## 2026-11-25, VL-4: the "Vector Local provider identity" Windows failure (record only)

**What it closes.** The failing case was `packages/engine/test/local-mode/local-run.test.ts`, "the provider under Vector Local > refuses a model call to a server whose identity changed since it was added, before any request". It failed on Windows shard 1/12 in main run 42515544563 (2026-11-08): `LocalProbe.verify` returned `unreachable` instead of `changed`, because the production 400 ms loopback identify deadline expired on a slow runner (`docs/vector/build/main-ci-followup.md`).

**Fix.** None here. main fixed it with `3d027edae` (2026-11-10, the fixture), `e817fe511` (2026-11-16: probe and verify default to `IDENTIFY_TIMEOUT.remote`, 3 s, for every address) and `183a402cd` (2026-11-21).

**Evidence.** It passes on main: run 45732340721 at `dbeb06661`, job 139618053114, "engine (windows, shard 10/18)", 616 ms. Of main's last 10 `test.yml` runs at planning time, 8 passed and 2 failed for unrelated reasons (45580448953: the Windows containment helper's startup; 45675088518: the computer-helper Windows build).

**Test.** No new test, because nothing changes. Nothing is loosened and no timeout is touched.

**Lead ruling.** Record only. The dated 2026-11-14 row in `docs/vector/build/v2-finish-plan.md` is a snapshot and stays as it is; this entry is the update.

## 2026-11-25, VL-5: stale comments

**What it closes.** Two comments that described the code as it was before later work landed. Comment-only, no behaviour change.

**Fix.**

- `packages/core/src/local-mode/egress-proxy.ts`, the header: "Nothing starts it yet: phase W3 starts it in desktop main …" now says desktop main's `research-proxy.ts` starts one for each research browser while it is open (`research-browser.ts`, `startResearchProxy`), points that browser's session at it with `session.setProxy` with Chromium's loopback bypass removed, and answers Electron's `login` with the secret. "Phase W3 wires this one into desktop main and writes no second proxy" is now "research-proxy.ts wires this one; there is no second proxy."
- `packages/engine/src/config/config.ts`, the `localHeldAdvice` doc comment: "The desktop app has no confirmation of its own yet" is now "The desktop app confirms it itself, from Settings → Vector Local → Review and apply".

**Tests.** Lead ruling: no new test for comments. The behaviour each corrected comment describes is already pinned: `packages/desktop/src/main/research-proxy.test.ts` (the research proxy's challenge, secret and session wiring), `packages/core/test/local-mode/egress-proxy.test.ts`, and `packages/engine/test/config/local-policy.test.ts`, "the held change says how to apply it from where this Vector runs" (the desktop advice "Review and apply"). Checks on this branch: `git grep -n "Nothing starts it yet"` and `git grep -n "no confirmation of its own yet"` both come back empty. No mutation check, since nothing executes.

**Waiting (VL-5c, W1).** `packages/engine/src/tool/shell/sandbox.ts`, the `offline()` docstring, says "on macOS and Linux it runs in the sandbox with no network but this computer's", but Linux bubblewrap's `--unshare-net` leaves no network at all (`OFFLINE_NOTICE.bubblewrap`, and the docs page already says so). The file is held by #128, #161, #162, #163, #167 and #170, and #161 edits the lines right after that docstring. When they have merged or closed, the docstring becomes: "on macOS it runs in the sandbox with no network but this computer's; on Linux, bubblewrap's --unshare-net leaves it no network at all, not even this computer's". Comment-only, pinned by the existing `OFFLINE_NOTICE` copy.

## 2026-11-25, VL-6: the guard's Octokit note under Bun

**What it closes.** `packages/core/src/local-mode/guard.ts` listed "@actions/github's Octokit (`vector github`)" among the requests the guard does not see under Bun, because the `undici` package's fetch is Bun.fetch there. The gap is already closed in code: since `e60ae35ea` (2026-10-22) every GitHub client in `vector github` is given `request.fetch: githubFetch` (`packages/engine/src/cli/cmd/github.shared.ts`, `Egress.fetch("github", …)`) or `readOnlyFetch`, which wraps it: `github.agent.ts` (`readOnlyGithub`, REST and GraphQL), `github.app.ts`, `github.handler.ts` (three clients), `github.publish.ts` and `github.review-api.ts`. `@actions/github` is imported only for `github.context` (`github.handler.ts`), and nothing calls `getOctokit`. So these requests are labelled, decided and logged. Only the comment was stale, and nothing stopped a new client from dropping the labelled fetch.

**Lead ruling.** No held file is needed: fix the comment and add a source-scan test beside the existing "never calls Bun.fetch" test. The `vector github` files (held by #98, #106 and #160) are read, never edited. None of those PRs, nor #142, adds an Octokit or GraphQL client (checked in their diffs on 2026-11-25).

**Fix.** `packages/core/src/local-mode/guard.ts`: the "Neither mode covers" bullet keeps "Vector's own code never calls Bun.fetch, which a test checks, and the guard is the first import of every entry point", says a library that sends through `undici`'s fetch is not seen under Bun, and says Vector's own GitHub clients are each given a labelled fetch (githubFetch, Egress.fetch as `github`) and @actions/github is read only for its event context, never to make a client, which a test checks.

**Test.** `packages/core/test/local-mode/guard.test.ts`, "Vector's own code > gives every GitHub client a fetch Vector Local decides". It globs `*/src/**/*.{ts,tsx}` under `packages/`, as the neighbouring test does. For each `new Octokit(` or `graphql.defaults(` it takes the argument text up to the matching `)` by depth count and requires `fetch:` in it, it forbids `getOctokit(` anywhere, and it expects at least 7 client sites (8 today) so a wrong glob cannot pass it. It passes on main: it is the guard against regression, and the mutation below is its proof.

**Mutation check.** Locally delete `request: { fetch: githubFetch }` from the client in `packages/engine/src/cli/cmd/github.app.ts` (no open PR holds that file; never committed): the test fails, naming `engine/src/cli/cmd/github.app.ts`. Restore with `git checkout -- packages/engine/src/cli/cmd/github.app.ts`. Not run in the drafting step.

## Waiting

- W1 (VL-5c): the `offline()` docstring in `packages/engine/src/tool/shell/sandbox.ts`, as above, once #128, #161, #162, #163, #167 and #170 have merged or closed.

## Owner items (not built here)

- O1: programs the agent starts (shell commands, stdio MCP servers, language servers) are not covered by the guard.
- O2: Windows has no network sandbox for shell commands.
- O3: the server adapters and error patterns were written from vendor docs, not from recordings of real servers.
- O4: packet-capture gate L2 stays pending (`docs/vector/local-packet-capture.md`).
- O5 (from VL-1): narrowing host-less allow entries to each service's own hosts, after an audit makes the registry's hosts complete (redirect, mirror and installer hosts included).
