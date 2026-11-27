# cx-everywhere-harness-close: the loopback route harness's close (EV-22)

PR #116 (head `everywhere-harness-close`, Codex's draft of 2026-11-24, commit `02e834bd`). Taken over by this v2 run
on 2026-11-26 because the draft had been idle for more than a day before the Saturday 2026-11-28 deadline. Test code
only: no production route, flag or copy changes.

Files: `packages/web/test/lib/everywhere-account.ts` (the shared fake), `packages/web/test/everywhere-route-harness.test.ts`
(new regression), `docs/vector/build/vector-everywhere-handoff.md` (Codex's closing note on the "Left open" item) and
this note.

## 2026-11-26, `RouteHarness.stop()` never returned after a route refused an unread POST body

**Bug.** The handoff's "Left open" list (EV-22) recorded that `RouteHarness.stop()` in
`packages/web/test/lib/everywhere-account.ts` never resolves once a route handler has answered a request with a body
it did not read, for example a 401 from the account check before the body is parsed. Under Bun's `node:http`, a
response ended before its request body is drained keeps the connection open, so `server.close()` waits forever and
the test file hangs at `afterAll`. The EV-22 refused-token cases in `everywhere-pages.test.ts` answer such writes'
401 in their request wrapper instead of letting the real route answer, for that reason.

**Lead ruling.** The item was "for the lead". Ruling: fix the shared fake, as Codex's draft does. It is the safest
option that fully closes the item: it changes only test code, leaves every production route as it is, and lets any
handler refuse a body it never read. Rejected: draining every body before the handler runs (it would hide the body
from handlers that read it, see the second mutation below) and changing the routes to read bodies they refuse.

**Fix (Codex's, kept as is).** When a request carries a body (a `transfer-encoding` header or a non-zero
`content-length`), the harness wraps `response.end`. If the handler ends the response while the body is still
unread, the wrapper drains the remaining bytes first and then ends the response. A handler that reads its body
normally is unchanged.

**Test.** `packages/web/test/everywhere-route-harness.test.ts`, "the route harness closes after an asynchronous
refusal leaves a POST body unread": a handler that reads the body echoes it, a handler that sleeps and answers 401
without reading still answers, and `stop()` must resolve within 2 s.

**Red before.** With `test/lib/everywhere-account.ts` restored to origin/main (`dbeb0666`), the case fails: expected
`true`, received `false` after 2009 ms. With the fix back, 1 pass.

**Mutation checks.** (1) The drain skipped (`finish()` called at once even with unread bytes): the case fails after
2011 ms. (2) An eager `request.resume()` before the handler runs: the read handler gets nothing (expected
`"synthetic body"`, received `undefined`). Restored, it passes.

**Other users of the harness, one file at a time after merging origin/main (`dbeb0666`).** All pass: everywhere-pages
(68, 1 skip), jobs-api (23), journey-actions (11, 2 skip), link-api (13), install-api (17), body-api (27, 5 skip),
repository-port (5), cloud-adapter (85, 3 skip), github (17), sweep (11), linear-oauth (16), jira-a2a (20, 3 skip),
intake (8), slack-events (12), control (13), linear-webhook (15, 4 skip), slack-oauth (5). The skips need a real
Valkey; they run in CI in the "Vector everywhere tests" job (`vector-everywhere.yml`, "Run every Vector everywhere
test file", with `VECTOR_TEST_REDIS_URL`), which also picks up the new test file by its name. `bun typecheck` in
packages/web: 0 errors.

**CI on Codex's head `02e834bd`.** The everywhere lane, web build and typecheck passed. Windows engine shards 2 and 12
failed in engine tests (task isolation resume, background shell owned-start recheck) and the computer-helper mac and
Linux desktop jobs failed or timed out; none of them reach `packages/web/test`, so they are not caused by this branch.

**Left for a follow-up (not edited here: open PRs #108, #123 and #157 touch the file).** The three request-wrapper
workarounds in `packages/web/test/everywhere-pages.test.ts` ("a request sent with the refused token cannot expire the
renewed session" and the two 401 wrappers in "a 401 comes before the state is read") can now let the real route
answer, and their comments saying the harness cannot close are out of date. The handoff's "Decisions waiting for the
lead" paragraph still lists "the shared loopback harness's close (EV-22)"; the "Left open" item it points to is
closed by this PR.
