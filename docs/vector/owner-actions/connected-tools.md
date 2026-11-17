# Connected tools: owner decisions and steps

This is a checklist, not authorization to turn Connect on, publish a page, add a docs-nav entry, release, or widen any held capability. Connected tools ship dormant behind `VECTOR_EXPERIMENTAL_CONNECT`, which is off unless set. The readiness checklist, the draft docs page text, the docs-nav line and the two flag lines are in [connected-workspace-release.md](../build/connected-workspace-release.md); the contract is [connected-workspace-spec.md](../build/connected-workspace-spec.md) (§9 CW-22 and CW-25, §12 Q1 and Q6); every decision the build made is in [connected-workspace-deviations.md](../build/connected-workspace-deviations.md). Each section below says what exists, the options, what the connect-finish lane prepared, and what follows a yes or a no. None of these is decided here.

## 1. Q1: default-on, and which release shows Connected tools

- **What exists.** While the flag is off, the connected-tools surfaces are hidden or refuse. The desktop Connected tools card, the Tasks pane rows and the directory review read the `connections` capability (app `components/settings-v2/subagents.tsx`:511, `features/background-tasks/background-tasks-pane.tsx`:577, `features/connect/directory-review.tsx`:21 and :288), as does the terminal's "Connected tools" command (tui `routes/session/index.tsx`:489). The `connect` tool and `/vectorscope` are registered only with the flag on (engine `tool/registry.ts`:443, `command/index.ts`:104). `vector connected` drops its help line (`cli/cmd/connected.ts`:66), and the server refuses what it asks. CN-20 pins the engine flag's default, the `connections` capability, the connect list and run routes, and the owner's gate on every read and action, in engine `test/effect/runtime-flags.test.ts`, `test/server/httpapi-connect.test.ts` and `test/connect/owner.test.ts`. Those tests do not pin the client surfaces or the tool and command registration; each reads the same capability or flag in its own code.
- **Options.** Turn it on by default in a named release; keep it opt-in through `VECTOR_EXPERIMENTAL_CONNECT=true`; or keep it dormant.
- **Preconditions.** The release checklist's blockers B1 to B8 (§1.1), each cleared or explicitly accepted. B1 (reviews are Linux-only), B4 (repair held, and the app's repair option that only reports) and B8 (Hands and @vector rows, and the two flag readers' disagreement) need a decision of their own.
- **On yes.** One owner commit changes the two lines in the release checklist §4, under its requirements (the same answer from both readers for every value in its matrix, and the default-off pins updated in the same commit). Then remove the PUB-2 version sentence and regenerate `config.json`, publish the page and nav (§4 below), write the release notes, and run the full CI.
- **On no.** Nothing changes: Connect stays dormant, and the lane's tests keep it so.

## 2. Q6: who owns the review start routes and the request ledger

- **What exists.** Connect has `POST /experimental/session/:sessionID/connect`, `POST /experimental/connect/review` and its own file ledger (`packages/engine/src/connect/directory-request.ts`). VectorScope has its own owner-only `POST /experimental/session/:sessionID/review` and `ReviewRequestTable` (core `review/request-store.ts`). Connect's reviews already run through VectorScope's review service (CW-20).
- **Options.** (a) Keep connect's routes and ledger as they are. (b) Make connect's routes thin aliases of VectorScope's route and move the ledger onto `ReviewRequestTable`. (c) Delete connect's routes.
- **What any change touches.** (b) and (c) change the public API: the SDK is regenerated (`bun run generate` in `packages/client`, and `./packages/sdk/js/script/build.ts`), and the desktop's Remote allowlist (CN-17, `packages/desktop/src/main/remote-routes.ts`), the workspace supervisor's allowlist (CN-19, `packages/cloud-workspaces/src/protocol.ts`), the app's and the phone's clients and the CLI move with them.
- **On (a).** Nothing changes. **On (b) or (c).** A later package carries it out, after VectorScope's owner agrees on the route and ledger shape.

## 3. CW-22 `task`: may the local agent hand a fix to @vector on GitHub?

- **What exists.** The @vector on GitHub row is list-only (CN-13, `packages/engine/src/connect/adapters/github-agent.ts`): its installed state and CLI pin come from the repository's workflow file, and it has no actions.
- **The question.** May the local agent post a `/vector` request to hand a fix to @vector on GitHub, asking you every time?
- **On yes.** A later package adds an always-asked `task` action to `github-agent.ts`, with its own tests. **On no.** The row stays list-only.
- Whether `connect` is withheld on GitHub Actions (`GithubAgents.withheldOnActions`) is @vector's owner's decision, not this one.

## 4. Publishing the docs page

- **What exists.** The draft text is in the release checklist §2, and the exact page path, header and docs-nav entry are in its §3. Nothing is in `packages/web`.
- **Steps, only with the release that turns Connect on.** Review the draft text against the build that ships; choose the release label; add the page and its docs-nav entry in the same commit (the layout refuses a page with no nav entry), with a `packages/web/test/docs-connected-tools.test.ts` on the `docs-hands.test.ts` model; add the owner add-ons for anything else shipping in that release. An unreleased page can wait as an unrouted draft in `packages/web/src/drafts/docs/`, as Hands' does.
- The page makes no quality or comparative claim and carries no price, legal, privacy or consent text.

## 5. Hosted computer: may a hand-off send code or a screen to Vector's cloud?

- **What exists.** The `cloud` effect and the always-asked `connect_cloud` consent, which names the destination on every hand-off (CN-14). No member declares a `cloud` action, so nothing uses them. The hosted-computer adapter (`connect/adapters/hosted-computer.ts`) and its reserved slot are Codium's (spec §6). See [hosted-computer.md](./hosted-computer.md).
- **The question.** Whether any connected hand-off may send code or a screen to a Vector cloud service and spend money there.
- **Before a yes takes effect.** CN-14's four hard preconditions for the first member that declares `cloud` (deviations "CW-23a: the cloud effect and connect_cloud always-ask (CN-14)"): an app and terminal presentation of `connect_cloud`; a `Connect.SendsTo` form for that service; the old-client approval gap closed or the client floor raised; and a decision on whether Vector Local gates the cloud action.
- **On no.** `connect_cloud` stays unused.

## 6. Vector Remote's outside security review

- **What exists.** While the engine reports connected tools on, a paired phone may list the members, list and read a conversation's runs, cancel a run, and start one VectorScope review after a passkey check bound to that conversation, folder and target (CN-17); the phone pages show the cards, runs and questions (CN-18). Both were tested only against the in-memory relay and the soft passkey. See [remote.md](./remote.md).
- **The step.** The outside security review's scope includes these connect routes in `packages/desktop/src/main/remote-routes.ts` (the member and run lists, the run read, cancel and the passkey-checked review start) and the CN-18 phone pages. It comes before `VECTOR_REMOTE_ENABLED` is turned on and before Remote is listed anywhere.

## 7. Connect inside a cloud workspace

- **The question, before the cloud-workspaces pilot turns on.** With the supervisor's marker set and Vector Local on, the list reads members "off" that connect never stops. Choose one: restrict the workspace place to the members connect itself admits, or make Vector Local enforce inside containers (deviations "CW-24a: the engine reports a cloud-workspace place from the runtime marker (CN-15)", Held). The same entry lists the "this computer" and "local" wording that must change inside a container.
- The release checklist §1.2 has the other pilot items (D34, the run read, the clone depth and the 20-second window).

## Not decided here

- Automatic repair (A13) and `task_manage` resume of a stopped fix child: the tokenomics owner's, in protected files.
- Connected workflow stages and automatic swarm review: they need protected budget authority.
- The run read's optional `sessionID` on the workspace supervisor and the D34 confirmation: the lead's, at PR review (deviations, CN-19).
