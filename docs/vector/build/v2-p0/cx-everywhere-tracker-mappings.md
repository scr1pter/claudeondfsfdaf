# cx-everywhere-tracker-mappings: takeover of PR #123 (verified tracker repository mappings)

PR #123 (head `everywhere-tracker-mappings`) was a Codex draft, idle since 2026-11-24, so this run took it over to
finish and merge it. The feature is Codex's; this entry records what the takeover checked and changed. No flag changes, no public claims: the account routes still answer 404 while
the platform is off, and the account page is still an unrouted draft (PUB-8).

## 2026-11-26, merge main and verify the composed tree

**State taken over.** The branch carried three things: the GitHub thread link on account job rows (Codex's #108
feature commit `9a492260`), the repository adapter from #117, and the tracker mapping package itself (`2764278c`,
`6c190061`). #117 has since merged into main (`dbeb0666`), so its commits drop out of the diff. #108 is still an
open draft whose head is that same feature commit plus a main merge; its four files stay in this PR's diff, so #108
should merge first, or it closes as included once this PR lands. Codex's body listed no remaining work.

**Merge.** `origin/main` at `dbeb0666` merged into the branch with no conflicts (merge commit `b0c548c2`). The diff
against main is 12 files: the account repos route's `addRepository` PUT and the history's `threadUrl` (api
`everywhere/account-api.ts`), `addTrackerRepository` (api `everywhere/identity.ts`), the schema's `isTrackerPlace`,
the account model and view, the drafts docs page, the owner guides and the lane handoff notes, and their tests.

**What the behaviour is.** A Linear or Jira installation's connector can add one GitHub repository to a team ID or
Jira key. The server verifies it through the production repository port against the connector's own active GitHub
binding before any write. The write fences the installation snapshot, the mapping snapshot and the account's authority
together, so a concurrent edit made during verification refuses the add (409) instead of being replaced. Existing
entries and the private mark are kept; the replace and remove requests are unchanged. A GitHub job row shows a
canonical issue or pull request link only while the requester's current binding still matches the recorded handoff.

**Tests (packages/web, one file at a time, `--timeout 30000`).** `everywhere-pages.test.ts` 71 pass, 1 skip (a
real-Redis case, run by vector-everywhere.yml's Valkey job); `everywhere-docs.test.ts` 17/17; `everywhere-identity`
39 pass, 4 skip; `everywhere-authority` 20 pass, 7 skip (the skips are the same Valkey job's); `everywhere-lane` 14/14;
`everywhere-repository-port` 5/5; `everywhere-install-api` 17/17; `everywhere-link-api` 13/13;
`everywhere-slack-oauth` 5/5. Typechecks: schema `bun typecheck`, the hosted API (`bun typecheck --project
../../tsconfig.json` from packages/engine, as vector-everywhere.yml runs it) and web `bun typecheck` (0 errors).

**Red before.** With the five source files (account-api.ts, identity.ts, schema everywhere.ts, everywhere-model.ts,
EverywhereView.tsx) put back to main, `everywhere-pages.test.ts` fails three cases: "a connector can add a repository
from the tracker controls using the installed Vector session", "GitHub history links require the requester's current
repository binding" and "the history keeps jobs while discarding noncanonical or differently scoped thread links"
(68 pass, 3 fail). Restored, all pass.

**Mutation check.** `addTrackerRepository` was changed to re-read the mapping just before the write instead of
fencing the snapshot it read before verification. The tracker controls case then fails, because the concurrent edit
is overwritten instead of answering 409. Restored, it passes.

**CI on the taken-over head (`6c190061`).** Every job for the changed files passed, including Vector everywhere tests,
Hosted tests and the Website build. The red jobs touch nothing in this diff: engine (linux, shard 8/8) failed
"code review after each task > VectorScope reviews the changes and leaves one quiet note without starting a turn", an
engine timing case in `code-review-flow.test.ts`, the file Codex's open #131 stabilizes; the computer-helper jobs failed by runner timeout or never
started.

**Lead calls.** None needed. The Jira key is matched as typed (the owner guide says to use the key as Jira shows it).
Linear and Jira go-live still wait on PUB-8 and the gates the owner guides list.
