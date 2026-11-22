# Windows engine suite: eighteen shards (22 November 2026)

Branch `windows-shard-split`, from `main` at `609763f7`.

## What was wrong

Two `main` push runs of `test.yml` failed only because `engine (windows, shard 7/12)` hit the 45-minute
"Run Engine shard" step limit while every test it reached was passing:

- run 44937950225 at `b87cc462` (the #66 merge), job 136989623935;
- run 44957526120 at `23d09a96` (the #69 merge), job 137019720504.

Bun's `--shard=i/N` deals the sorted test files round-robin: sorted file k goes to shard `k % N + 1`. Which files
share a shard therefore depends only on the file list, and since #56 added four `test/everywhere` files the
heavy files fall together in shard 7.

## Measurement

Green run 44968700872 (PR #62, all twelve Windows shards passed) gives per-file times: the gap between one file
header and the next in each shard's log. Twelve shards took 8.0, 10.5, 5.3, 5.6, 18.7, 10.7, 21.6, 16.4, 8.9, 8.1,
13.4 and 25.9 minutes of test time (153 in all). `test/task/isolation.test.ts` alone took 17.7 minutes.

Interleaving the twelve shards' file lists rebuilds Bun's sorted order (676 files; the rebuilt list is sorted),
and replaying the per-file times over N shards reproduces the twelve measured totals exactly. For other N:

| Shards | Largest shard | Next largest |
|---|---|---|
| 12 | 25.9 | 21.6 |
| 14 | 26.8 | 16.6 |
| 15 | 22.3 | 15.9 |
| 16 | 23.7 | 20.4 |
| 18 | 20.9 | 12.5 |
| 20 | 20.9 | 12.7 |

## Change

- `.github/workflows/test.yml`: the `engine-windows` matrix runs shards 1 to 18 and `bun test --shard=.../18`.
  The 45-minute step limit, the per-test deadlines and every other step are unchanged.
- `scripts/release-readiness/policy-199113.json`: the `main` and `release-fixes` required-check lists name
  `engine (windows, shard 1/18)` to `18/18`, as #67 did for the Linux shards.

## Checks

From each package, through the serial lock: `packages/cloud` `src/workflow-compliance.test.ts` 61 pass,
`packages/desktop` `scripts/computer-workflow.test.ts` 40 pass and
`scripts/diagnose-computer-overlay-electron-signature.test.ts` 7 pass, `packages/web` `test/everywhere-lane.test.ts`
14 pass. The YAML parses, with 18 matrix entries.

## Limits

- The round-robin is fragile: adding or removing a test file changes which files share a shard. The table shows
  13 shards would put the isolation shard at 34 minutes. Eighteen is the best of the counts tried, not a guarantee.
- The shard holding `isolation.test.ts` stays the largest (20.9 minutes), and a runner twice as slow would bring it
  close to 45 minutes. If it ever crosses, the next step is to give `isolation.test.ts` its own job, not a longer
  limit.
- Six more Windows jobs per run, about 3.5 minutes of setup each.

## First PR run (44984266486, 22 Nov)

Every Windows shard step ran in 1.9 to 17.9 minutes. Two shards failed.

**Shard 1/18: a leak the new grouping exposed (fixed here).** Both failures were in
`test/server/local-app-models.test.ts`, in its afterEach check `expect(guard.outside()).toEqual([])`, which received
one refused `github.com:443` attempt of kind `proxied`. The source is `test/server/httpapi-reference.test.ts`, which
now runs directly before it in the same Bun process (sorted files 432 and 450). Its git reference forks a clone of
`github.com/Effect-TS/effect` into the server's location services. The file's afterEach only ran
`disposeAllInstances`, which does not end those services (they idle for an hour), so the clone outlived the file.
Its `git` copies the proxy variables when it starts; on a slow runner it started after `local-app-models` had
installed its own strict network guard, and that guard recorded the refused CONNECT. Under 12 shards the next file
had no guard of its own, so the leak never showed.

Fix: `httpapi-reference.test.ts`'s afterEach now first posts `/global/dispose` (as `test/server/local.test.ts`
already does) and expects 200. That invalidates the location services and interrupts the clone. Test-only; nothing
skipped, loosened or lengthened.

Proof, on Linux, the two files run together in one process from `packages/engine` through the serial lock:
without the fix 3 of 6 runs failed with the same `github.com` `proxied` entry, with it 6 of 6 passed. A stand-in that
holds the repository-cache lock for 1.5 s after the reference file ends (to mimic the slow runner) failed without
the fix and passed with it. `bun typecheck` in `packages/engine` exits 0.

Left for later: the shared `disposeAllInstances` fixture never ends the server's location services, so other
location-scoped background work could leak across files the same way.

**Shard 2/18: runner speed, not the grouping (not changed).** `test/session/prompt.test.ts` "running task tool
preserves metadata after tool-call transition" timed out in its 5-second `pollWithTimeout` (5.3 s). That poll also
covers the engine instance's cold start. Under 12 shards the same test took 1.8 to 4.2 s on Windows. This runner was
about 1.3 times slower than main's across the whole file and before any test ran (its build step too), while 8/18 and
14/18, built from the same old shards, ran at main's speed. Waiting for the first model request before the poll would
pass, but it moves the cold start out of the 5-second window, which in effect lengthens the deadline, so it is not
done here. The push that carries the shard 1 fix re-runs it; a second failure is real, and then the fix is a cheaper
instance cold start in the engine. Its sibling "running subtask preserves metadata" passed at 4.7 s against a 5 s
test timeout and has the same thin margin.
