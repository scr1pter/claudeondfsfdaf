# P6 phase review repairs (A37 to A43)

These repairs answer the P6 phase review ("services and remote") on `codium-wt`. Each finding was checked against the
code first, and all four were confirmed. Each repair has a regression test that fails against the previous source. The
owner's pending decisions are unchanged: Vector Labs on the pricing page, the Oct 30 model lineup and the investors
page claims. No service, account, deployment or provider was called, nothing was pushed, and no cloud-agent file was
touched. Contract readings are in `codium-deviations.md` ("P6 review decisions").

## A38/A41 phone alerts

**Settings promised alerts never show code or prompts.** Confirmed. `alertTitle("Finished", session.title)`,
`alertTitle("Needs you", sessionTitle)` and the Run Guard alert all carry the session's name. A new session's name is
the first line of its first message (cut to 50 characters, `provisionalOf` in the engine's `session/prompt.ts`) until
the model's title replaces it, and for a greeting or a failed title request it stays. The alert is still sealed end to
end (P7), but the promise was false. **Repair:** `PHONE_ALERT_CONTENT` in `settings-v2/notifications-model.ts` says
"Alerts show a short title, such as the session's name, sealed so only your paired phones can read it.", and
Settings → Notifications uses it. The phone's Alerts page said "never your code" in two states and now says the title
is such as the session's name. Regression (`packages/app/src/context/phone-alerts.test.ts`): an alert title carries
what was typed, the shared wording names the session's name, and neither page's source promises that code or prompts
stay out.

## A39 relay

**Erase wiped the revocation time and the used ticket ids.** Confirmed. `erase()` ran `deleteAll()` and the schema
again, so a ticket issued in the five minutes before the erasure passed `standing()` afterwards, even one already used.
It wrote `meta.account` (before the standing check), the plan and its device row, and started meters again. A computer
admitted that way could stay up to a day. **Repair:** `erase()` keeps the unexpired `seen` rows (random ids) and writes
`revoked_before` = the erasure time plus the 60 s ticket skew, so a ticket from an issuer whose clock runs a little ahead
is also refused. `connect()` writes the account handle only once a ticket passes the standing check. Regression
(`packages/relay/test/relay.test.ts`): after an erase the object holds only `revoked_before` and the used ids, and the
closes that arrive later add nothing. A used ticket gets 401, while an unused ticket and one issued 30 s ahead are
closed `REMOTE_REVOKED`. No device row, account handle or meter comes back. A ticket issued after the skew connects as
any first device does. The CI smoke (`e2e/relay-smoke.ts`) now also opens a ticket minted before the erase and expects
`REMOTE_REVOKED`.

## A39/A40 tickets

**Tickets carried a server-only limit.** Confirmed. `ticketClaims` put `REMOTE_LIMITS.viewerHours[plan]` into the
claims, and any client can decode a ticket's middle segment. §4.2 keeps viewer-hours on the server, and they are not in
ENTITLEMENTS. **Repair:** the claim is now `rank` (ENTITLEMENTS rank, 1 to 4, public). The relay reads the hours from
`VIEWER_HOURS` (by rank) in `packages/relay/src/limits.ts`. Clients import only `protocol.ts`, which imports nothing.
`decodeClaims` accepts ranks 1 to 4 only. `AccountRelay` stores the rank in its plan and compares it when a newer
ticket arrives. Regressions: `test/remote-ticket-api.test.ts` checks that each plan's ticket carries its computers and
rank and exactly the expected claim names, with no `viewerHours`. `test/remote-relay-contract.test.ts` keeps
`VIEWER_HOURS[rank]` equal to `REMOTE_LIMITS.viewerHours[plan]` for every plan. `packages/relay/test/source.test.ts`
checks that `protocol.ts` imports nothing. The fair-use cases give rank 1 a one-hour table through the harness, as they
gave `viewerHours: 1` before, and an upgrade moves to rank 3.

## A38 phone sign-in

**The signed-out page showed any `error_description` from the address.** Confirmed. `boot()` showed up to 200
characters of it whether or not this phone had started a sign-in, so anyone could put their own text inside Vector's
phone app with a link. **Repair:** `googleSignInFailed(storage)` in `phone/auth.ts` answers the fixed
`GOOGLE_SIGN_IN_FAILED` ("Google sign-in did not finish. Try again.") only while this phone's PKCE verifier is pending,
and forgets the verifier. The address's text is never read (`error` or `error_description` only marks a failure).
Regression (`packages/app/src/phone/auth.test.ts`): without a pending verifier nothing is said, and with one the fixed
words are said once. `app.tsx` reads neither parameter's value.

## Tests run here (one file at a time)

| Package | File | Result |
| --- | --- | --- |
| relay | `test/relay.test.ts` | 14 pass |
| relay | `test/fair-use.test.ts` | 8 pass |
| relay | `test/ticket.test.ts` | 9 pass |
| relay | `test/routing.test.ts` | 9 pass |
| relay | `test/source.test.ts` | 7 pass |
| relay | `test/internal.test.ts` | 11 pass |
| relay | `test/idle.test.ts` | 12 pass |
| relay | `test/limits.test.ts` | 13 pass |
| root | `test/remote-relay-contract.test.ts` | 7 pass |
| root | `test/remote-ticket-api.test.ts` | 29 pass |
| root | `test/remote-phone-api.test.ts` | 8 pass |
| app | `src/context/phone-alerts.test.ts` | 6 pass |
| app | `src/phone/auth.test.ts` | 10 pass |
| app | `src/components/settings-v2/notifications-model.test.ts` | 4 pass |
| app | `src/phone/phone.test.ts`, copy and CSP cases only (`-t`), not the bundle walk that starts a second process | 2 pass |

Typecheck: `packages/relay` `tsgo --noEmit` clean (src, test, e2e); root `tsconfig.json` (api) clean; `packages/app`
`tsgo -b` clean.

**CI only:** `packages/relay/e2e/relay-smoke.ts` under `wrangler dev --local` (its erase check is extended here), and
the phone bundle walk in `phone.test.ts` and `browser-bundle.test.ts`.

Edits to `api/_lib/model-plan-*.ts`: none.

## A36 Playbooks server (P6 addendum, 15 Nov 2026)

No phase review covered A36: the P6 review above took A37 to A43, and `codium-deviations.md` "Lane status (8 Nov
2026)" says so. This addendum reviews A36 on `codium-finish` at `2924d94b`: commit `fbc8ef1f`, then the later commits
on its files (`git log fbc8ef1f..HEAD` over `api/_lib/playbooks.ts`, `api/account/playbooks.ts`,
`packages/core/src/playbooks`, `packages/schema/src/playbooks.ts`, `script/playbooks-publish.ts` and
`api/_lib/codium-perks.ts`), of which `1bff87a4` (the nested-stage rule in `check.ts`, `install.ts`) and `63840b8a`
(`install.ts` transport) touch the playbook code. Each finding was checked against the code. Five are confirmed and
repaired (R36-15 came from the review of this package); nine checks hold. F28 has its own package. Line numbers are on the repaired source unless marked "old".
Contract readings are in `codium-deviations.md` ("P6 review addendum (15 Nov 2026)"). Nothing was published, listed,
committed or pushed in this step.

**R36-1. The playbook allowlist was a copy of the learned skills' list.** Confirmed, with no behavioural difference.
`packages/core/src/playbooks/commands.ts` (old `:15-189`) copied BrainSkill's allowlist
(`packages/core/src/brain/skill.ts:56-251`). With comments stripped the two differ only in that `helper` used
`SECRET_FILE` where BrainSkill uses `BrainSniff.SECRET_FILE` (the same constant, `brain/document/sniff.ts:12`), that
`commands.ts` adds `allowed`, and that `skill.ts` adds `target`, `SKILL_TEXT`, `ID`, `placeholder` and `DISCLAIMER`,
none of which is part of the allowlist. `commands.test.ts` ran the same cases as `brain/skill-commands.test.ts`
(except `target`). **Repair:** `commands.ts:12` re-exports `TARGETS`, `DENY_WORDS`, `CHECK_ENV`, `simple`, `helper`
and `check` from `../brain/skill`; `allowed` (`:15-17`) stays as helper or check. There is no import cycle: nothing in
`skill.ts`'s graph imports a playbook or orchestration module. Regression
(`packages/core/test/playbooks/commands.test.ts`, "the allowlist is BrainSkill's own, not a copy"): the six exports
are the same objects as BrainSkill's (`toBe`), and `allowed` takes `bun test` and `git status` and refuses `git push`,
`cat .env` and `make deploy` (explicit cases, so the test does not restate the implementation). On the old source it
failed at the first `toBe` (distinct arrays). The side effect of loading BrainSkill is a contract reading (deviations).

**R36-2. The publish and install check accepted any model.** Confirmed. The saved `WorkflowSpec` has a model field:
`Settings.model` (`packages/core/src/orchestration/spec.ts:17-19`), used by `defaults` (`:145`; merged into stages by
`plan.ts:81`), by an agent stage (`:90-91`) and by its verifier (`:82-83`); a nested stage (`:107`) and a connect stage
(`:113`) have none. `check.ts` (old `:125-128`) parsed the saved schema and checked only nested-stage names. The engine
resolves only `codium:(floor|default|ceiling)` and only for a personal Vector Playbook
(`packages/engine/src/orchestration/runs.ts:202-209`); any other named model goes straight to `SubagentModel.choose`,
so a playbook could pin a provider model the person pays for themselves, or one `vector-plan/...` model whatever their
plan's roles say. **Repair:** `check.ts:125-131` returns the schema's issues, keeps the nested-stage rule, and adds
`modelIssues` (`:139-161`): `/defaults/model`, `/stages/<i>/model` and `/stages/<i>/verify/model` must each be absent
or match `ROLE` (`:137`, `^codium:(?:floor|default|ceiling)$`). The same check runs at install
(`PlaybookInstall.download`, `install.ts:33`), so the client refuses such a file too. Regressions: the new
`packages/core/test/playbooks/check.test.ts`, "any other model is refused where it is named" (eight models, including
near misses such as `Codium:default`, `codium:default ` and `codium:floor:x`, in each of the three places, and all
three at once in order), failed on the old source (`Expected - 6, Received + 1`); "a playbook names a model only as a
Codium role, or leaves it to the runner" and "a playbook nests only other Vector Playbooks" (coverage for `1bff87a4`'s
rule, which no test had) pass on both. `packages/core/test/playbooks/install.test.ts`, "a playbook naming a model other
than a Codium role is never installed", failed on the old source (the file installed) and leaves the folder empty now.

**R36-3. A record's hash field was never compared with its name.** Confirmed; reachable only through a hand-edited or
corrupted store, because `recordPlaybook` (`api/_lib/playbooks.ts:163-170`) always writes field = name. The old
`readPlaybooks` read `HVALS` (old `:82`) and kept the newest record per `record.name` (old `:84-90`), and the old
`readPlaybook` (old `:95-101`) did `HGET` without a name check. So a valid record filed under field X was listed and
signed under its own name Y, `withdraw Y` removed only field Y and left the stray record listed (the owner's emergency
pull did not pull), and `publishPlan` could compare against another playbook's record. **Repair:** `readPlaybooks`
(`:85-96`) reads `HGETALL` and keeps a record only when it decodes and its name is its field; `readPlaybook`
(`:102-109`) answers undefined when the record under that name is another playbook's. The library comment (`:11-13`)
says so. The store fake gains `HGETALL` (`test/roadmap-fixture.ts`, additive; `brain-vault-api.test.ts` and
`roadmap-api.test.ts` still pass). Regression (`test/playbooks-api.test.ts`, "a record filed under another name is
never listed or signed, and withdrawing a name always takes it out"): a valid `vector-docs-drift 9.0.0` record under
the field `vector-misfiled` is not listed (on the old source the listing showed `vector-docs-drift 9.0.0`), is not
read by name, and after `withdraw vector-docs-drift` only `vector-flaky-tests` is left. `withdraw vector-misfiled`
still removes the stray field. A stray field stays in the hash until it is withdrawn by its field name, and `HGETALL`
still returns it, but it counts nowhere: no playbook path calls `HLEN`, and the 50-name cap and `Playbooks.MINIMUM`
count only `readPlaybooks`' answer (see R36-15).

**R36-4. "The library never goes back to an older version" was false after a withdraw.** Confirmed (wording). The
claim was in `docs/vector/MODEL-PLANS.md` (Publishing) and the old `publishPlan` comment. `withdraw` is an `HDEL`, so
`readPlaybook` then answers undefined and `publishPlan` answers `new` for any version (`:147`). Content immutability
holds: the bucket HEAD/ETag check (`script/playbooks-publish.ts:220-232`) refuses other content at any key it holds,
as `test/playbooks-api.test.ts` "a version never changes, and while published the library never goes back..." shows. **Repair:** the `publishPlan` comment
(`api/_lib/playbooks.ts:135-142`) and MODEL-PLANS.md now say the floor holds while a playbook stays published, and
`withdraw` (`script/playbooks-publish.ts:153-166`) names the version it removed and says to publish above it. It reads
the record with `.catch(() => undefined)` before the `HDEL`, so a store that cannot read the record never stops the
pull; it then prints the old sentence. `readPlaybook` throws only the store's 503 (`persistent-store.ts:10,18,20`; a
malformed record decodes to undefined), so the catch drops nothing else; the comment at `:155-156` says so. The test
that held the old "never goes back" wording in its title is renamed "a version never changes, and while published the
library never goes back; a bad playbook is never uploaded". Regressions (`test/playbooks-api.test.ts`): that test now
expects `vector-flaky-tests 1.10.0 is withdrawn (test store): ... To publish it again, use a version above 1.10.0.`
(failed on the old source), and the R36-3 case ends with a store that fails only `HGET`, where `withdraw` still empties
the library and prints the old sentence. Not built: a bucket-listing floor (see deviations).

**R36-5. Dark 404.** Holds. `api/account/playbooks.ts:36` answers 404 `NOT_FOUND` before `requireMethod` (`:37`), the
token (`:38-40`), the rate counter (`:41-46`) and the snapshot (`:48`); `listedPerks` (`api/_lib/codium-perks.ts:108-156`)
answers an empty set on any store error (`:153-156`). Test: `playbooks-api.test.ts:190` ("listed, Pro gets the
library; every reason it is not listed answers 404 ...").

**R36-6. Tokens.** Holds. Only `Bearer vct_<a>.<b>` passes the pattern (`playbooks.ts:38`), then
`requireUnrevokedCliToken` (`api/_lib/revocation.ts:40`) and `verifyCliTokenClaims` (`api/_lib/cli-token.ts:60`).
`vrt_` and `vht_` tokens, Basic auth, a malformed `vct_` and a website session get 401 `CLI_TOKEN_INVALID`. Test:
`playbooks-api.test.ts:352`, which now also sends a Supabase-shaped bearer (a website session) and checks the code of
each refusal.

**R36-7. Entitlement states.** Holds. `requireEntitlement` (`api/_lib/codium-entitlements.ts:41-57`) and
`requireUsableSnapshot` (`api/_lib/codium-snapshot.ts:149-177`): active and renewing within the grace download; paused
gets 402 `MODEL_PLAN_PAYMENT_REQUIRED`; ended 402 `MODEL_PLAN_REQUIRED` (409 while the account is closing); frozen 403
`MODEL_PLAN_BLOCKED`; renewing past the grace the shared 503 `MODEL_PLAN_RENEWING`. `playbooks` is true only for
vector-50, -100 and -200 (`packages/schema/src/codium-entitlements.ts:148,174,204,234`). Tests: the renewing download
is `playbooks-api.test.ts:253` (Ultra renewing); the refusals are `:305`, which now adds a renewing plan three hours
past its period end (503 `MODEL_PLAN_RENEWING`; no route test had it).

**R36-8. Links.** Holds. Links live `Playbooks.LINK_SECONDS` (600, `packages/schema/src/playbooks.ts:21`), signed at
`api/_lib/playbooks.ts:126-133` (`:131`); at most 50, sorted by name (`:94-95`). No route test had more than 50. Test (new):
`playbooks-api.test.ts:489`, "a listing names at most 50 playbooks, sorted by name; a 51st name is refused at publish, a
new version is not" (51 records, `vector-a00` to `vector-a50`, filed in reverse; the first 50 names, every
`X-Amz-Expires=600`, `decodeLinks` takes all 50, and publishing a new name, `vector-flaky-tests`, is refused before any
bucket call; the last part is R36-15's regression).

**R36-9. Answer shape.** Holds. `playbookLinks` returns exactly `{name, version, sha256, url}`; `bytes` and
`publishedAt` stay in the store. Test: `playbooks-api.test.ts:253` (`toEqual`).

**R36-10. Bucket key per mode.** Holds. `playbookObjectKey` (`:37-41`) and the decode's exact compare (`:64`); a live
server never reads the test library. Test: `playbooks-api.test.ts:387`.

**R36-11. Rate limit.** Holds. 60 an hour per account, `requirePersistent` (`api/account/playbooks.ts:41-46`). Test:
`playbooks-api.test.ts:377`.

**R36-12. Readiness.** Holds. `playbooksReady` (`api/_lib/playbooks.ts:116-123`): Track B live, the media bucket, the
store and `Playbooks.MINIMUM` (2); wired through `codium-perks.ts:64`. Test: `playbooks-api.test.ts:233`.

**R36-13. No amount or plan internal leaves the server (P1).** Holds. Refusals carry the code, the message and the
contract's detail only (`{perk, plan}`, `{reason, action}`, `{reason}`; `codium-snapshot.ts:121-136`), and the answer
carries no figure. Test: the refusal loop at `playbooks-api.test.ts:305` now checks each refusal's whole body, the new
503 included, against `{error: {code, message, ...detail}}` with the contract's exact detail (`{perk, plan}` for Plus,
`{reason, action}` paused, `{reason}` frozen and ended, none for no plan and the 503), so a figure under any other key
fails it. It also still scans every body for `$`, `usd`, `price`, `credit`, `cents`, `micro`, `cost` and `charge`.

**R36-14. Still open, out of scope.** The estimate API's `{kind: "playbook"}` band: `api/_lib/model-plan-estimate.ts:275`
refuses every `kind` with 400 `CODIUM_ESTIMATE_KIND`.

**R36-15. The 50-name cap refused a new version of a published name.** Confirmed (found in the review of this
package; it predates it). Reachable only through a hand-edited store, because the script itself never records a 51st
name. `publish` checked the cap against `readPlaybooks` (old `script/playbooks-publish.ts:196-197`), which slices to
`Playbooks.MAX_LISTED`, so with more than 50 valid records a new version of a published name that sorts past the 50th
was refused with "holds 50 playbooks" although the name was in the library. **Repair:** `publish` keeps the record it
already reads for `publishPlan` (`:193`) and checks the cap only for a name with no record (`:198-202`). Regression:
the end of `playbooks-api.test.ts:489` files `vector-flaky-tests 1.0.0` as the 52nd name and publishes `1.1.0`; on the
previous source it failed with "The library holds 50 playbooks" (`(fail)`, 16 pass, 1 fail), now the record is
`1.1.0`.

**Not confirmed (an A36 reading kept).** Commands written as plain text outside code spans and fenced blocks are not
parsed (`check.ts:163-212`, `strings`); the owner reviews every playbook before publishing it.

Mutations, each restored afterwards and checked with `cmp`: dropping `record.name === field` fails the R36-3 case;
dropping the verifier entry from `modelIssues` and loosening `ROLE` to `^codium:` each fail "any other model is
refused where it is named"; dropping the withdraw read's `.catch` fails the R36-3 case at its `HGET`-only failure;
adding `amount: 5` to the paused refusal's detail (`codium-snapshot.ts`) fails the refusal loop's body check, which the
word scan alone would have passed.

### Tests run here (one file at a time)

Run through `vector-serial` with `--timeout 30000`, with `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
`XDG_STATE_HOME` and `TMPDIR` under `/tmp/vector-v2/codium/r36/` for every root and core run (the engine's preload
sets its own XDG roots; `TMPDIR` was set there too).

| Package | File | Before (HEAD `2924d94b`) | After |
| --- | --- | --- | --- |
| root | `test/playbooks-api.test.ts` | 15 pass | 17 pass |
| root | `test/api-module-loading.test.ts` | not run | 2 pass |
| root | `test/roadmap-api.test.ts` (store fake changed) | not run | 16 pass, 1 skip (its Valkey block, CI only) |
| root | `test/brain-vault-api.test.ts` (store fake changed) | not run | 23 pass |
| core | `test/playbooks/commands.test.ts` | 11 pass | 12 pass |
| core | `test/playbooks/check.test.ts` (new) | 2 pass, 1 fail (red) | 3 pass |
| core | `test/playbooks/install.test.ts` | 3 pass | 4 pass |
| core | `test/brain/skill-commands.test.ts` | 6 pass | 6 pass |
| engine | `test/orchestration/playbooks.test.ts` (local only: unchanged, so CI's picker does not select it) | 2 pass | 2 pass |

Typecheck: `packages/core` and `packages/schema` `tsgo --noEmit` clean; the api tree (`bun typecheck --project
../../tsconfig.json` from `packages/engine`) clean. `script/playbooks-publish.ts` and `test/playbooks-api.test.ts` are
outside every typecheck config; under a scratch config (`/tmp/vector-v2/codium/r36/tsconfig.json`, the root options plus
bun and node types) both are clean, and the only errors are in other packages' modules compiled under the root's
stricter options. `prettier --check` passes on every changed file except `install.test.ts`, which was not
prettier-clean at HEAD and keeps its style. The full turbo typecheck is a pre-push step and was not run here.

Re-run on 15 Nov 2026, before the commit, on the same uncommitted tree with fresh roots under
`/tmp/vector-v2/codium/r36/run2/`: every file in the table above passed again with the same counts. Two more files
that the change reaches also passed: root `test/account-delete.test.ts` (37 pass, 1 skip for its Valkey block; it
loads the store fake through `brain-vault-fixture.ts`) and engine `test/server/httpapi-workflow.test.ts` (10 pass; it
calls the playbook install route). `bun typecheck` in core, schema and engine and the api tree were clean,
`prettier --check` passed on the changed files other than `install.test.ts`, and `git diff --check` was clean.

Review fixes, 15 Nov 2026, on the same uncommitted tree with fresh roots under `/tmp/vector-v2/codium/r36/run3/`. The
review of this package raised eight non-blocking points. Fixed: the immutability test's title (R36-4), the refusal
loop's exact body check (R36-13), explicit `allowed` cases (R36-1), the 50-name cap (R36-15) and the prettier wrapping
of the new `install.test.ts` case (only those lines; the rest of the file keeps its style). Kept, with the reasons in
`codium-deviations.md` ("P6 review addendum"): the BrainSkill import's folders, the copied `ROLE` pattern and the
withdraw read's catch. Ran: root `playbooks-api` (17 pass; red first, 16 pass and 1 fail, before the R36-15 repair),
core `playbooks/commands` (12), `playbooks/check` (3), `playbooks/install` (4) and `brain/skill-commands` (6); one
mutation (R36-13's `amount: 5`, restored and checked with `cmp` and `git diff`); `bun typecheck` in core and the api
tree; the scratch typecheck of the script and the root test (no error in either; the same other-package errors as
before); `prettier --check` on every changed code file except `install.test.ts`, whose new case matches prettier's
output (the lane docs keep their compact tables, which prettier would pad, as at HEAD); `git diff --check`. Not
re-run, because no file they load changed in this round: `api-module-loading`, `roadmap-api`, `brain-vault-api`,
`account-delete`, engine `orchestration/playbooks` and `server/httpapi-workflow`.

Commit gate, 15 Nov 2026, on the same tree with XDG roots under `/tmp/vector-v2/codium-finish/xdg/`: root
`playbooks-api` (17 pass), core `playbooks/commands` (12), `playbooks/install` (4) and `playbooks/check` (3), and
engine `orchestration/playbooks` (2) passed; `bun typecheck` in core and schema and the api tree were clean; the full
`bun turbo typecheck --concurrency=2` passed (27 of 27 tasks).

**CI only:** Vector Codium (`test/playbooks-api.test.ts`, `roadmap-api.test.ts` and `brain-vault-api.test.ts` as
`test/*.test.ts`, and the three changed or new core playbook tests as changed files) and typecheck.yml. CI: pending.
This step left the change uncommitted; the run and job ids go in a dated line under this section in the lane commit
that follows the runs. The Valkey and Postgres cases, the HttpApi exerciser and check:generated are not affected.

CI, 15 Nov 2026 (recorded by Codium finish F28): Vector Codium run 43685974875 (dispatched on `265f4ea7`, R36's commit)
and typecheck.yml run 43685977976 (success). Of the Vector Codium run's 18 jobs, 15 succeeded, 2 were skipped (the
hosted call's "Hosted tests" and its typecheck matrix, which `services_only` skips), and Codium tests job 132726419932
failed only at "Run HttpApi exerciser gates". That step's log (400-line tail) ends with exactly the four baseline MISS
lines, `DELETE /experimental/review-memory/previews/{previewId}`, `GET /experimental/review-memory`,
`POST /experimental/review-memory/confirm` and `POST /experimental/review-memory/prepare`, then
`summary pass=359 fail=0 skip=0 missing=4 extra=0`, with no FAIL line in the visible tail. The job's step list
(`get_workflow_job`) shows "Run the Codium test files" (2 min 25 s) and "Check generated client" succeeded. Under the
lane's baseline rule the run counts as green. The visible tail covers only the exerciser, so no file-level result for
the playbook tests is claimed from it; the step's success is the receipt.

CI, 15 Nov 2026 (recorded by Codium finish DZ): R36's vector-hosted-ci.yml run 43686386024, at `265f4ea7`,
concluded success. This is the run conclusion only; its Hosted tests log was not read. See `codium-deviations.md` "Lane
status (15 Nov 2026, codium-finish)".

Edits to `api/_lib/model-plan-*.ts`: none.

## A41 phone usage alert (F28, P6 addendum)

P4b confirmed F28 by reading and handed it to the P6 addendum, because A41 (`4caf1073`) is in P6's range
(`codium-p4-repairs.md` F28; `codium-deviations.md` "Hand-off to the P6 addendum (F28, A41)"). Read on `codium-finish`
`265f4ea7`; scratch under `/tmp/vector-v2/codium/f28/`. Old lines are at `265f4ea7`; new lines are on the repaired,
uncommitted tree. Contract readings are in `codium-deviations.md` ("P6 review addendum (15 Nov 2026)", the F28 bullet).
Nothing was committed or pushed in this step.

**F28. The phone usage alert repeated while the desktop notification failed.** Confirmed. In the old effect
(`packages/app/src/components/settings-vector-codium.tsx:67-100`) one key per account, plan and renewal
(`alertedPeriods`, old `:25`) guarded both channels. The phone alert went first (old `:86-90`), then the desktop
`notify` (old `:92-98`), and a failed `notify` removed the shared key (`.catch(() => alertedPeriods.delete(key))`, old
`:99`). `sendPhoneAlert` (`packages/app/src/context/phone-alerts.ts:36-41`) has no dedupe of its own. So with both
switches on and the desktop notification failing, every later run of the effect with Usage open (the share left moving
from 19% to 18%, or a good read after a failed one) sent the phone alert again. The desktop main process drops a
repeated phone alert (same event and title) only within 60 s (`packages/desktop/src/main/remote-notify.ts:23,73-74`);
Usage refreshes on focus at most once a minute, on Refresh and 15 s after a Codium turn ends, so reads further apart
than that window went through to the phones. The block also compared the raw `(status.plan.left ?? 1) > 0.2` (old
`:80`), which equals the share the card shows only because the server sends whole percentages (F24).

Every `sendPhoneAlert` caller was checked (read only): `context/notification.tsx:369` ("finished"), `:386`
("runGuard") and `:459` ("needsYou"), and `pages/layout/ask-notifications.ts:60` ("needsYou", Hands' file). The old
`settings-vector-codium.tsx:87` was the only sender of the "usage" event in app, desktop and core; the other matches
are the Settings row copy (`settings-v2/notifications-model.ts:23`) and the desktop event list and its test.

**Repair.** The decision moved into `packages/app/src/components/codium-usage-alert.ts` (`sendUsageAlert`, `:18-57`),
which takes the status, the identity, both switches, the dedupe state, `platform.notify` and the phone sender. A24's
shared key (`sent.periods`) is unchanged: one alert per account, plan and renewal for the app lifetime, and a failed
desktop notification removes it (`:56`) so the next read tries again. A second set, `sent.phone`, holds the periods
whose phone alert went or is on its way (`:42-47`), so the desktop retry never repeats the phone alert. Its key is added
before the send (`:43`), so overlapping reads cannot send twice, and removed only when `sendPhoneAlert` resolves false
(`:45`: it held the alert back for quiet hours, the event switch, the plan's listing or a missing sender, or the send
failed), so while the desktop notification keeps failing a held-back phone alert is tried at a later read, as before.
The threshold is `usageShare(left).used < 80` (`:36`), the whole percentage the card shows (H5). The component keeps the
state at module level (`settings-vector-codium.tsx:24`, both sets, for the app lifetime as before) and its effect
(`:66-77`) passes the same tracked reads as before (status, identity, both switches, and `sendPhoneAlert`'s own
synchronous reads of the event switch and quiet hours). Both titles and the desktop text are byte-identical. Defaults
are unchanged: `codium.alert80` false and `notifications.events.usage` false (`context/settings.tsx`, not touched).

**Regression** (`packages/app/src/components/codium-usage-alert.test.ts`, eight cases; the phone path runs through the
real `sendPhoneAlert` with a fake `phoneAlerts.send`, a plan read that lists alerts and a fixed noon clock, and
`resetPhoneAlerts()` runs before each case):

- "with both switches on, the phone alert goes once while a failing desktop notification is tried again (F28)": the
  desktop `notify` rejects at 19% and 18% left; exactly one `phoneAlerts.send`, the desktop tried twice, shown at 17%,
  and nothing more at 16%. This is the hand-off's test.
- "a phone alert held back by quiet hours goes at a later read while the desktop notification keeps failing": quiet
  hours (11:00 to 13:00) hold the phone alert back at 19% while the desktop fails; at 18%, quiet hours off and the
  desktop failing again, exactly one phone alert goes; nothing more at 17% (desktop shown) or 16%. A second window whose
  desktop notification is shown while quiet hours hold the phone back sends no phone alert later (A24's shared key, as
  before). Added after the package review (finding 1), so the repair only removes repeats.
- "above 20% left nothing is sent; the threshold is the share the Usage card shows (H5)": 1, 0.5, 0.21 and 0.207 send
  nothing; 0.2, 0.203 (shown as "80% used · 20% left"), 0.19 and 0 each send one of each.
- Unchanged behaviour, pinned: desktop only, a failed notification is tried at the next read and one that was shown is
  not repeated; both switches off sends nothing; the titles are exact and carry no amount, token, credit or dollar
  word, and their only digits are "80" twice; each account, plan and renewal alerts once, and nothing goes without an
  identity, a signed-in read, an error-free read, a plan or a share; a period that already alerted on one channel stays
  silent when the other switch is turned on later (A24's shared key, both orders).

The fake desktop `notify` is `async`, so a failure is a rejected promise (as `Platform.notify` always is), never a
synchronous throw; each read awaits the check and then `Bun.sleep(0)`, so the rejection handler, the phone sender's
plan read and its held-back key removal settle before the next read whether or not the check hands back the promise.
The fake platform is checked with `satisfies` against `Pick<Platform, "notify" | "phoneAlerts">` and
`Pick<VectorAccountPlatform, "codium">`, and cast to `Platform` only where `sendPhoneAlert` takes the whole type.

Red proof: the old effect body was transcribed into the module through the same seams
(`/tmp/vector-v2/codium/f28/codium-usage-alert.old.ts`, kept as scratch and not committed): `alertedPeriods` →
`input.sent.periods`, `sendPhoneAlert(platform, settings.notifications, x)` → `input.sendPhone(x)`,
`settings.codium.alert80()` → `input.desktop`, `settings.notifications.event("usage")` → `input.phone`, `state.status`
and `state.identity` → `input.status` and `input.identity`, and `void platform.notify(...)` → returned. The gate order,
the raw `left > 0.2`, the shared key, the phone sent first and the delete on failure are as at old `:73-99`. With the
final test file it gave 5 pass, 3 fail (34 `expect()` calls): the F28 case at its first assertion (`toEqual`,
`Expected - 0, Received + 4`: a second phone alert), the quiet-hours case at its last phone count (length 2, expected
1: the same repeat) and the H5 case at 0.203 (`phone: 0`, `desktop: 0`, expected 1 each). The first draft of the repair
(`/tmp/vector-v2/codium/f28/codium-usage-alert.new.ts`, which kept the phone key after a held-back send) gave 7 pass, 1
fail: the quiet-hours case (`[]`, expected one phone alert at 18%). With the final body
(`/tmp/vector-v2/codium/f28/codium-usage-alert.final.ts`): 8 pass, 0 fail, 44 `expect()` calls
(`/tmp/vector-v2/codium/f28/green-final.txt`, taken on the final test file; it replaces the earlier
`green-new-body.txt`, which predates the last test edits). The first red run also caught a test bug (an explicit
`undefined` identity took the parameter default), fixed before the counts above.

Mutations of the final body, each restored and checked with `cmp` against the saved final body:

| Mutation | Cases that fail |
| --- | --- |
| M1: drop `!input.sent.phone.has(key)` | the F28 case, quiet hours |
| M2: `.catch(() => undefined)` | the F28 case, quiet hours, desktop only |
| M3: the raw `(status.plan.left ?? 1) > 0.2` | the H5 case |
| M4: drop `if (input.sent.periods.has(key)) return` | the F28 case, quiet hours, desktop only, each period once, other switch later |
| M5: drop `if (!went) input.sent.phone.delete(key)` | quiet hours |

### Tests run here (one file at a time)

Run through `vector-serial` with `bun test --isolate --timeout 30000` from `packages/app`. App unit tests boot no
engine, so no XDG roots were needed.

| Package | File | Before | After |
| --- | --- | --- | --- |
| app | `src/components/codium-usage-alert.test.ts` (new) | old body: 5 pass, 3 fail (red) | 8 pass (44 `expect()` calls) |
| app | `src/context/phone-alerts.test.ts` | not re-run (no file it loads changed) | 6 pass |
| app | `src/components/settings-v2/codium-usage-model.test.ts` | not re-run (no file it loads changed) | 10 pass |
| app | `src/context/settings.test.ts` (asserts `codium.alert80` false) | not re-run (no file it loads changed) | 6 pass |
| app | `src/components/settings-v2/notifications-model.test.ts` (asserts `events.usage` false) | not re-run (no file it loads changed) | 4 pass |

Typecheck: `packages/app` `bun typecheck` (`tsgo -b`) clean, test file included. `prettier --check` passes on the three
code files (the component was prettier-clean at HEAD). `git diff --check` clean. The full turbo typecheck and the api
tree are pre-push steps and were not run here.

**CI only:** Vector Codium's Codium tests job (it selects `codium-usage-alert.test.ts` and `codium-usage-model.test.ts`
by name) and the browser spec `packages/app/e2e/regression/account-settings.spec.ts` ("Usage notifications require
opt-in and do not repeat on refresh", which drives the real component's desktop path; its name does not match the
picker, so it is passed as `browser_specs`), and typecheck.yml. CI: pending; the change is uncommitted, and the run and
job ids go in a dated line here in the lane commit that follows the runs. Never exercised: a real desktop with a paired
phone (B09's paired check, and the owner's listing of alerts, without which no phone receives anything).

Edits to `api/_lib/model-plan-*.ts`: none.

**CI, 15 Nov 2026 (recorded by Codium finish R45a).** On `ab784e44`: Vector Codium run 43689606818 had 18 jobs. 15
succeeded, 2 were skipped (Hosted services / Hosted tests and the hosted typecheck matrix, which the lane's call skips),
and Codium tests (job 132737256591) failed only at "Run HttpApi exerciser gates". That step's tail ends with exactly the
four baseline MISS lines (`DELETE /experimental/review-memory/previews/{previewId}`, `GET /experimental/review-memory`,
`POST /experimental/review-memory/confirm`, `POST /experimental/review-memory/prepare`) and
`summary pass=359 fail=0 skip=0 missing=4 extra=0`, with no FAIL line; the job's step list shows "Run the Codium test
files" and "Check generated client" succeeded. Under the lane rule the run counts as green. Codium browser specs job
132737256831 succeeded: its 400-line tail shows the three selected specs (`account-settings.spec.ts`,
`codium-image-routing.spec.ts`, `codium-usage-labels.spec.ts`), 25 tests on one worker with
`account-settings.spec.ts:586` "Usage notifications require opt-in and do not repeat on refresh" as 20/25, and
"25 passed (1.3m)". typecheck.yml run 43689609193 and vector-hosted-ci.yml run 43690118133 succeeded. The file-level
result of `codium-usage-alert.test.ts` inside the Codium tests step is not claimed: that output is above the visible
tail.
