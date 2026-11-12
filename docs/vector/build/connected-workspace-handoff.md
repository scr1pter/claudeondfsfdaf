# Connected workspace: handoff (2026-11-11)

This build moves to a new agent. Start here, then read the contract (`connected-workspace-spec.md`) and the deviations log (`connected-workspace-deviations.md`) in this folder. The deviations log records every reading the build made where the contract was silent; it wins over the contract where they differ.

## Where it stands

- **Branch** `connected-workspace`, cut from `main` at `0dcbb8e2` (PR #20, the self-evolving merge). The branch is pushed and clean. Everything is on GitHub; nothing exists only on one computer.
- **Built, reviewed and repaired:** phases A1 to A3, which cover CW-01 to CW-08. After each phase, three reviews ran (does it work for real, security and fail-closed, fits the code base), followed by one repair commit.

| WP | What | Commit |
|---|---|---|
| CW-01 | Schema contracts | `ed7b05f99` |
| CW-02 | Pure policy | `5239f061f` |
| CW-03 | Engine hub | `8ff7bee55` |
| A1 review repairs | | `fe3c8bdb6` |
| CW-04 | VectorScope adapter | `3978b55c1` |
| CW-05 | The connect tool | `9e058ad58` |
| CW-06 | `/vectorscope` command | `c6fcde4b6` |
| A2 review repairs | | `0729667c3` |
| CW-07 | Fix and re-review | `f73afec6e` |
| CW-08 | Background runs | `40f99ae1b` |
| A3 review repairs | | `33c8cf309` |
| A3 CI fixes | | `07868188e`, `dbdb19738`, `232efe37c` |

- **CI at handoff:** on `232efe37c`, typecheck passed. `test` (run 43140948951) and `Verify` (run 43140954865) were still running. Check them first, and fix real failures before new work. Only this handoff note and the spec's status line came after that commit.

## What to build next, in order

1. **Phase B, CW-09: public surface** (routes and the generated client). Dispatch CI after it.
2. **Phase C1:** CW-10, CW-11, CW-12, CW-15 and CW-19 (surfaces).
3. **Phase C2:** CW-13, CW-14, CW-16, CW-17 and CW-18 (loops). Dispatch CI after it.
4. **Final review** of the whole branch (`ef73007d3..HEAD`), then repair.
5. **CW-20 to CW-25 wait**, as the contract says, for the other branches to merge: VectorScope, Hands (`hands`), Codium (`codium`), cloud workspaces (`cloud-workspaces`), and @vector (`vector-at-mention`). CW-25 (turn the flag on by default) also needs the owner's yes on Q1.

Each phase was built one WP at a time: build it, run its own test files, typecheck, commit. Then three reviews ran across the phase, one repair commit followed, then a push and CI. That pattern caught real bugs in every phase, so it's worth keeping.

## Owner decisions

- **Confirmed by the owner on 2026-11-09** (they said "Keep them" to the recommended answers):
  - Q2: keep the generic `/review` and add `/vectorscope`.
  - Q3: build `repair`, off by default.
  - Q4: `before_commit` defaults to `offer`.
  - Q6: connect keeps its own start route until VectorScope's VS-10 decides.
- **Still open:** Q1, whether Stage A may land on `main` behind `VECTOR_EXPERIMENTAL_CONNECT`. Nothing goes to `main` without the owner's yes.

## Blocked or left open by the repairs

Each item below is also in the deviations log.

- **MCP status read (A1, finding 11).** `members()` calls `MCP.status()`, which starts every configured MCP server on first use. A status read that does not start them needs an additive change in `packages/engine/src/mcp/index.ts`, which is outside connect's file plan. Ask the owner whether to allow that additive read, or whether to accept config-only MCP rows.
- **TUI consent text (A2).** In the terminal UI, the `connect_model` ask still reads only "Call tool connect_model". The fix belongs in `tui/src/routes/session/permission.tsx`, which the Hands branch edits. The request to that owner is in the deviations log. `VECTOR_EXPERIMENTAL_CONNECT` must stay off by default until this lands.
- **Background runs (CW-08):**
  - `vector run` does not wait for a background connect review. Its tracker lives in `cli/cmd/run.ts` and `run/background-wait.ts`, outside connect's files.
  - Reverting the message that started a review does not stop the review: `session/revert.ts` cancels only task and shell jobs.
  - The tool part's title is stale.
- **A3 leftovers:**
  - With the flag off, `vector agent list` still prints `connect_fix`. Registering it only when the flag is on needs `RuntimeFlags.node` in `agent.ts`'s deps line.
  - Ask rules on the requester's session still don't reach subagents, because `deriveSubagentSessionPermission` in `tool/task.ts` passes only denies.
- **Design change made in A3:** fix children now run no shell at all. This replaces the contract's "ask per command".

## How CI runs on this branch

`test.yml`, `typecheck.yml` and `verify.yml` run only on `main`, on pull requests, or when dispatched by hand:

```bash
gh workflow run test.yml -R scr1pter/claudeondfsfdaf --ref connected-workspace
gh workflow run typecheck.yml -R scr1pter/claudeondfsfdaf --ref connected-workspace
gh workflow run verify.yml -R scr1pter/claudeondfsfdaf --ref connected-workspace
```

Read failures with `gh run view <id> -R scr1pter/claudeondfsfdaf --log-failed`. Re-run once with `--failed` only when the failure is a known flake and nothing else failed in that job. Known flakes:
- a Bun segfault on a Linux shard;
- Windows: `local-fit.test.ts`, `prompt.test.ts` (3 s), `task-size.test.ts` (30 s), effect-flock contention, `local.test.ts` probe 400, engine `test/tool/task-manage-abort.test.ts` (2 s wait);
- packet capture DNS, or the 55-minute packet-capture setup timeout.

## Rules (from the owner; all still binding)

- **Never:**
  - push to or merge into `main`;
  - open or merge a pull request, cut a release, or delete a branch without asking the owner first;
  - force-push, use `--no-verify`, or use `git stash`.
- **Installs, tests and typecheck:**
  - Install with `bun install --ignore-scripts`.
  - Run tests one file at a time from the package directory (`bun test --timeout 30000 <file>`), and `bun typecheck` from package directories.
  - Full suites run in GitHub CI only. Heavy local suites have crashed the owner's Vector app.
- **Things to leave alone:**
  - Never read credential files.
  - Never put the owner's email address in the repository.
  - Never name the open-source project this code was forked from, anywhere.
  - Never touch tokenomics or benchmark files or branches. Another agent owns them, and they matter a lot.
- **Other agents' branches:** don't edit `hands`, `vector-at-mention` (Codex), `vectorscope`, `codium`, `codium-track` or `cloud-workspaces`. Connect to their tools through adapter contracts on this branch, and keep edits to shared files additive, at the contract's anchors.
- **The owner's machine:**
  - Never start or restart the Vector app.
  - Never operate the owner's real computer in tests.
- **Copy:** make no public or comparative claims in docs or copy without the owner's yes.
