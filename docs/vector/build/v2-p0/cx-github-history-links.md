# cx-github-history-links: GitHub thread links on the account's job list (PR #108)

Branch `github-history-links` (PR #108), finished from the local branch `cx-github-history-links`. Codex opened the draft on 2026-11-24 and left it idle for more than a day, so this v2 run took it over on 2026-11-26 to finish it so it lands in main before the v2 redesign starts (the owner set 2027-01-01 as the deadline for the redesign and the other launch work). It covers the GitHub part of one EV-23 loose end ("no platform thread links (only the PR link)"). The feature stays dormant: the everywhere pages are unreleased drafts and `VECTOR_EVERYWHERE_ENABLED` stays off. No flag, public claim or production setting changes.

The everywhere lane's handoff and deviations files are in other open PRs, so the dated entry lives here. Once those PRs merge, add it to the handoff's "The vectordev.ai pages' loose ends (EV-23, open)", "Small ones" bullet: GitHub thread links are done; Slack, Linear and Jira links are still open.

Files: `api/_lib/everywhere/account-api.ts`, `packages/web/src/components/marketing/everywhere/everywhere-model.ts`, `packages/web/src/components/marketing/everywhere/EverywhereView.tsx` and `packages/web/test/everywhere-pages.test.ts`.

## 2026-11-26, the job list showed no link to a GitHub job's issue or pull request

**The gap.** GET `/api/everywhere/history` returned only the result's pull request link, so a GitHub job row on the account page had no way back to the issue or pull request where the person mentioned Vector. The job record has the thread's kind and number (`job.github`), but it was never returned.

**The fix (Codex's commit `9a492260`, kept as it was).**

- `account-api.ts` `history` returns a `threadUrl` only for a GitHub job that the signed-in account requested, whose handoff recorded the verified binder (`actorId` equal to the requester's GitHub id, and an `event`). The account's current binding for that repository must also match: same account, not suspended, the same positive binding generation sealed into the job's private reply, same repository name (case folded), same binder GitHub id, and the job's installation equal to `github:<binding.installationId>`. The link is built only by the schema's `githubThreadUrl` from the job's repository, kind and number, so it can never point at another host or path.
- The bindings come from `bindingsForAccount` through the existing persistent store: two store reads, and GitHub is never contacted. They are read only when the GitHub platform is on and at least one listed job could get a link. A store failure drops the links, not the list (`.catch(() => [])`).
- `everywhere-model.ts` `readJob` keeps a `threadUrl` only for a GitHub row, and only when it is exactly the canonical `https://github.com/<row repository>/(issues|pull)/<n>` link (the repository name is case folded). Any other value is dropped and the row is kept. `EverywhereView.tsx` shows it as "GitHub thread" unless it is the same link as the pull request link.

**Lead call.** Two options were possible: build links for every platform now, or link only where the server can prove the canonical link from stored authority. Ruling: the safest option that closes the GitHub part is the second one. A link is shown only when the requester and the current repository binding both match the recorded handoff. A legacy reference without author or event proof, a job the account sponsored but did not request, and a borrowed, transferred, suspended, renamed, rebound or reinstalled binding all show no link. Slack, Linear and Jira links stay unbuilt, because the job record holds no authority data that proves their canonical thread links. They remain on the EV-23 open list.

**Takeover work (2026-11-26).** Merged origin/main (`dbeb0666`, which includes #117's sponsor-binding repository checks) with no conflicts. #117 changes neither the binding record nor the history route, so the feature diff is still the same four files. CI on the draft had been cancelled before any job ran, so there was no hosted result to read.

**Tests.** `packages/web/test/everywhere-pages.test.ts`:

- "GitHub history links require the requester's current repository binding". It uses the real account routes on loopback with a fake store. Issue and pull request jobs get their canonical links, and the page renders both as "GitHub thread". The legacy reference, the sponsored-only job and another requester's job get none. No sealed reference, comment id, requester or actor id appears in the answer. The binding is then made missing, store-down, another account's, suspended, renamed, on another installation, bound by another GitHub user, and bound after the job, and each time the four rows still answer without a link. With GitHub off, the bindings are not read at all.
- "the history keeps jobs while discarding noncanonical or differently scoped thread links". The renderer keeps the rows and drops a link on a non-GitHub row, a `javascript:` link, a look-alike host, another repository, a link with a user name, query or fragment, an unsafe or zero-padded number, and a trailing newline.

**Red before, green after.** With the three source files reverted to origin/main, both cases fail (68 pass, 1 skip, 2 fail). With them restored, 70 pass and 1 skips.

**Mutation check.** With the binder check (`binding.binder.githubId !== job.requester.userId`) removed from `boundGithubThread`, the first case fails (a link is shown for the binding bound by another GitHub user; 69 pass, 1 fail). Restored, it passes. Removing the renderer's last `canonical === value` comparison changes no outcome, because the pattern above it already accepts only canonical links. It is kept as defense in depth.

**Checks (one Bun process at a time).** In packages/web: `everywhere-pages.test.ts` (70 pass, 1 skip), `everywhere-link-api.test.ts`, `everywhere-install-api.test.ts`, `everywhere-slack-oauth.test.ts`, `everywhere-docs.test.ts`, `everywhere-linear-oauth.test.ts` and `everywhere-lane.test.ts` all pass. `bun typecheck` in packages/web (astro check, 0 errors) and the hosted API check (`bun typecheck --project ../../tsconfig.json` from packages/engine) both exit 0. The skipped case is the file's "against a real Redis" block. It runs in CI in the "Vector everywhere tests" job (vector-everywhere.yml, Valkey service).
