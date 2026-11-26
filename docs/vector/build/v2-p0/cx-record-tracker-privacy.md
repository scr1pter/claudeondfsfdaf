# cx-record-tracker-privacy: dated tracker privacy marks (#157)

Branch `record-tracker-privacy` (PR #157), finished locally on `cx-record-tracker-privacy`. Codex opened the draft on 2026-11-24 and left it idle for more than a day, so this v2 run took it over to land it in main with the rest of v2. Vector Everywhere stays behind `VECTOR_EVERYWHERE_ENABLED`, which stays off. No public claims, no production configuration.

## 2026-11-26, takeover: a tracker privacy mark had no time of its own

**Bug.** A Linear team's or Jira project's repository mapping (`repo:<installation>:<place>`, api `_lib/everywhere/identity.ts`) stores the connector's `private` mark, but only one `setAt`. Every repository edit or verified tracker append rewrites `setAt`, so nothing recorded when the connector last chose the mark. Any future use of the mark in routing could not tell a mark confirmed under the current policy from an old one carried along by later edits.

**Fix (Codex's commit `3e496599`, kept as is).** `RepoMapping.privateSetAt` is an optional server time. `setMapping` sets it to the server clock only when the authenticated connector explicitly sends `private` (true or false) for a Linear or Jira place, keeps the stored one otherwise, and `addTrackerRepository` carries it through an append. Slack places never get one. Old rows decode without it and stay undated until the connector sets the mark again. The decoder accepts the field and refuses a non-time value. The account API strips it (`mappingForAccount` in api `_lib/everywhere/account-api.ts`), so the GET and PUT repository responses keep their existing shape, and a `privateSetAt` sent by a client is ignored. Tracker routing still treats every Linear team and Jira key as shared; the mark is not read for routing.

**Tests.** web `test/everywhere-identity.test.ts`: "tracker privacy marks keep their own time through repository edits and accept explicit reconfirmation" and "an old tracker mark stays undated until the connector explicitly sets it" (a non-connector's attempt leaves it undated). web `test/everywhere-pages.test.ts`: "only the server dates a tracker mark and account responses keep their existing shape" and the extra `privateSetAt` check in "a connector can add a repository from the tracker controls using the installed Vector session". The existing Slack case "only the connector sets a place's repositories" pins the exact Slack mapping with `private: true`, so it also covers "Slack is never dated".

**Red before.** With only the commit's two source files reverted (on top of today's merge of main), the two identity cases fail (39 pass, 2 fail) and the pages case fails (71 pass, 1 fail). Restored: 41 pass, 4 skip and 72 pass, 1 skip.

**Mutation checks.**
- `mappingForAccount` returning the full mapping: two pages cases fail (70 pass, 2 fail).
- `addTrackerRepository` dropping the stored time: the first identity case fails (40 pass, 1 fail).
- The Linear/Jira condition removed, so a Slack mark is dated: "only the connector sets a place's repositories" fails (40 pass, 1 fail).

**Other runs on this tree.** web `everywhere-docs` 17 pass; `everywhere-authority` 20 pass, 7 skip; `everywhere-repository-port` 5 pass; `everywhere-intake` 8 pass; `everywhere-jira-a2a` 20 pass, 3 skip; `everywhere-journey-laptop-tracker` 5 pass, 4 skip; `everywhere-erase` 11 pass; `everywhere-journey-actions` 11 pass, 2 skip; `everywhere-linear-webhook` 15 pass, 4 skip; root `test/no-personal-paths.test.ts` 1 pass. Every skip is a `VECTOR_TEST_REDIS_URL` "real Redis" block, which runs in CI's "Vector everywhere tests" job (Valkey service). Typechecks pass for the hosted API (root `tsconfig.json`), schema and web. The PR's earlier CI run was cancelled while queued, not failed.

**Lead rulings.**
- Stacking: this branch contains #108 (`9a492260`, verified GitHub job threads, an open Codex draft) and #123 (verified tracker repository mappings, an open draft that Claude Code took over on 2026-11-26; its head `6c190061` is an exact ancestor of this branch). Merging #157 lands both. Ruling: keep the stack as it is and land in order #108, #123, #157 (or #157 alone, which carries both). Do not split the stack, because #157's tests use #123's `addTrackerRepository`.
- Clearing a mark (`private: false`) is also an explicit choice, so it is dated too. That keeps "when did the connector last decide" true for both values.
- The datastore field is optional and older readers refuse unknown keys. Real tracker mark collection stays off until every deployed reader understands `privateSetAt`. Today nothing collects marks: the account page never sends `private`.

## 2026-11-26, finalize: wording only

The review found nothing to fix in code. The stacking ruling records #123's current owner. #108's later main-merge commit `2762464c` is not in this branch, which is harmless: landing #157 lands #108's change itself.

## 2026-11-26, finalize: no schedule in the entry

The second review asked to drop the intro's deadline sentence that commit `3061460de` added. This repository is public and every push to main deploys the site, so a build note must not carry the owner's private schedule or business plans, and it must not read as a public ship date. The sentence is gone; the rest of the intro (Vector Everywhere stays behind `VECTOR_EVERYWHERE_ENABLED`, which stays off) is unchanged. Docs only, no code or test change.
