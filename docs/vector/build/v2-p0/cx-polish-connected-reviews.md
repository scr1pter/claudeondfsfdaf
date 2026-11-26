# cx-polish-connected-reviews: accurate review readiness and finished titles (PR #162 takeover)

Branch `cx-polish-connected-reviews`, cut from origin/polish-connected-reviews `f897d970b` (Codex's draft PR #162). This v2 run took the PR over on 2026-11-26 because the draft had been idle for more than a day, and every open engineering item has to land in main before the redesign starts (the owner's 2027-01-01 date covers the redesign, go-to-market, Stripe, signing and the rest of the launch work). Nothing here turns on: connected reviews stay behind `VECTOR_EXPERIMENTAL_CONNECT`, which stays off. No public claims.

## 2026-11-26, takeover: merge main and verify

**What the PR does (Codex's code, verified here).**

1. **A finished background review kept the title "VectorScope review: in the background"** (connected-workspace-release.md, CW-08 "Left open" (3)). `ConnectFrame.titleOf` (moved from `tool/connect.ts` to `core/src/connect/frame.ts`, which the tool now re-exports) gives the terminal title. When a background run ends, `connect/hub.ts` passes it to `patchPart` in `tool/subagent-lifecycle.ts`, which writes it to a completed tool part under the same part lock as the run metadata. The part's original output and the note delivery are unchanged. Cards stored before this change are not rewritten.
2. **A folder outside Git listed VectorScope as ready and asked for consent before failing** (`connect/git.ts`, `connect/adapters/vectorscope.ts`). `ConnectGit.nonRepository` matches only the exact context project discovery builds for a non-Git folder: the selected instance's own directory, worktree `/`, the global project ID and no VCS. For that context the adapter lists VectorScope as `unavailable` with "Open a Git repository to use connected reviews.", and `ConnectGit.use` refuses a review with the same reason before any consent prompt. An empty Git checkout (global project ID, VCS `git`) stays ready. A folder reached through a link keeps the existing refusal.
3. **The native Node owner smoke used a plain folder** (`script/smoke-connect-node.ts`, `script/smoke-node-bundle.ts`, new `script/smoke-connect-fixture.ts`). After fix 2, that folder gets the early non-Git refusal instead of the consent prompt the smoke waits for. The smoke now creates a separate clean committed Git fixture (an empty template, a scrubbed Git environment and no remote) for approval, concurrent-start, peer-disconnect and directory lifecycle checks. It keeps the plain folder as a control and checks that this folder is refused before consent.

**Codex's state.** The PR body reported the work done: 119 focused tests passed, and the Core and Engine typechecks were clean. It left the packaged Node bundle smoke to hosted CI. Every hosted job on the last head was cancelled after about 51 minutes, before any test ran, so there was no failing test to fix.

**This run.** Merged origin/main `dbeb06661` (69 commits, no conflicts; never rebased). Main had changed none of this PR's Connect, VectorScope, smoke or generated files since the branch point. No source change was needed.

**Stacking.** The branch also carries:

- the first six commits of open PR #128 (`scope-authorization-followups`, `234ced66a`..`96b3a68bb`). #128 has since added four more commits, so its head is no longer an ancestor of this branch.
- the commit from PR #159 (`ceeddfc01`, refusing hand-offs to list-only members before any work starts). #159 was closed without merging, so that change lands here instead.

Merge this PR after #128, or together with it. Open PRs #163, #167 and #170 already contain this PR's title commit (`4c7c43489`), and #161 contains the #128 base. Each of those resolves against this PR when it lands.

## 2026-11-26, before marking ready: merge main again

Merged `origin/polish-connected-reviews` (no new commits; the head was still `f897d970b`) and `origin/main` `b57b8d53a` (10 commits: Codium estimates, playbook validation, race model labs, brain command allowlist). No conflicts and no shared files with this branch. None of main's changed files is in the review pipeline's source list, so the digest stays `219a1a25bf3251df`.

Re-run after this merge, one file at a time: core review/model-evidence 37 pass, brain/brain 59 pass, brain/knowledge-recall 11 pass, permission 29 pass; engine connect/background 12 pass, 4 skip. `bun typecheck` is clean for core, schema and engine. No source change; the review returned no must-fix items.

## Tests

The non-Git behaviour, and the native bundle smoke that depends on it, can only be checked in CI (see "CI-only coverage").

The background title cases run locally.

- engine `test/connect/background.test.ts`, "cancelled after its caller left, it reports once as cancelled; the caller stopping first leaves no note". It expects the stored part to be `completed` with the title "VectorScope review cancelled" and its original output.
- engine `test/connect/background.test.ts`, "a review with background returns at once with its run id; a fix cannot run in the background". It expects the title "VectorScope review: findings", with the tool's output, the extra metadata and the original timing unchanged.

**Runs** (one file at a time, `bun test <file> --timeout 30000` from the package directory, after the merge):

- engine connect: background 12 pass, 4 skip. vectorscope 37 pass, 7 skip. git 13 skip. node-smoke-fixture 3 pass. owner 8, hands 11, github-agent 12, fix 13 pass. hub 55 pass, 1 fail (see below).
- engine others: acp/permission 15, cli/run/footer.view 28, cli/run/permission.shared 12, permission/next 97, server/httpapi-connect 13 and server/httpapi-v2-permission-plugins 2 pass. everywhere/offline-shell 13 pass, 5 skip. everywhere/unattended-seccomp 3 pass, 2 skip. everywhere/unattended-session 6 pass, 1 skip.
- core: review/model-evidence 37, brain/brain 59, brain/knowledge-recall 11 and permission 29 pass.
- app: session-permission-dock 20 and phone/remote/model 34 pass. desktop: remote-routes 35 pass. tui: connect-presentation 8 pass. cloud-workspaces: protocol 8 pass. web: cloud-workspaces-client 23 and everywhere-lane 14 pass.
- The one hub failure is environmental: "missing snapshot capability lists configuration without probing MCP" configures local MCP servers that run `node`, and this machine has no `node` on PATH. With a `node` shim on PATH it passes. This branch changes no MCP, config or member-listing code.
- The VectorScope evidence check (core `test/review/model-evidence.test.ts`) still passes at revision 5 with source digest `219a1a25bf3251df`, so the merge did not change the review pipeline sources.

**Red before.** The title fix's source files are `connect/hub.ts`, `tool/connect.ts` and `tool/subagent-lifecycle.ts` (engine) and `connect/frame.ts` (core).

- Reverted to the stacked base (`ceeddfc01`, which holds only this PR's layer): both title cases fail, with the stored title still "VectorScope review: in the background" (10 pass, 2 fail).
- Reverted to `origin/main`: the same two cases fail (10 pass, 2 fail).
- Restored: 12 pass. The worktree matched HEAD after each restore.

**Mutation.** Turning off the title write in `patchPart` (`if (false && state.status === "completed" ...)`) fails both title cases (10 pass, 2 fail). Restored.

**CI-only coverage.**

- Every case in `test/connect/git.test.ts` runs on Linux only, and so do the new cases in `test/connect/vectorscope.test.ts` ("a non-Git folder lists VectorScope unavailable and refuses a review before consent", "an empty Git checkout can still be ready under the global project ID"). Connected reviews inspect Git reads only on Linux. Enabled on macOS for a local check, both cases stop at "Connected VectorScope reviews currently require Linux", so this run could not prove them red here. CI runs them in the test.yml job "engine (linux, shard N/8)".
- The native Node bundle smoke (`smoke-node-bundle.ts` with the new Git fixture) runs in "desktop engine bundle (node)", in test.yml and vector-at-mention.yml.
- The Linux-only cases in background, offline-shell, unattended-seccomp and unattended-session also run in the Linux engine shards. The three everywhere files also run in vector-everywhere.yml, job "Vector everywhere tests", which has Linux bubblewrap.

**Typechecks** (`bun typecheck`, one package at a time): core, engine, schema, protocol, server, client, sdk/js, tui, cloud-workspaces, app, desktop and web (astro check, 0 errors) are all clean. The client's `bun run check:generated` regenerated `src/generated` and `src/generated-effect` with no diff.

## Lead rulings

- Codex's placement of the non-Git check stays as it is: one exact-context predicate, used by the adapter for the member list and by `ConnectGit.use` for the refusal. It is the narrowest option that closes the item. It changes nothing for empty Git checkouts or linked folders, and the generic hand-off path keeps its existing tests.
- The red-before proof uses both the stacked base and `origin/main`, because the branch also carries #128 and #159. Reverting to the stacked base isolates this PR's own change.
- `REVIEW_PIPELINE_REVISION` stays at 5 and only the pinned source digest (`REVIEW_PIPELINE_SOURCES`) changes. The pipeline sources changed, but what a review finds or posts did not: the title fix only renames a finished background card, and the non-Git check refuses a review that could never have run. A bump would stop every certificate made before it from applying, with no change in review output to justify that.

## Left for others

- `connected-workspace-release.md` still lists "The read-deny alias gap" as open. This branch carries #128's alias fix (`234ced66a`). #128 owns that item and its docs, so this run did not edit the line. Update it when #128 lands.
