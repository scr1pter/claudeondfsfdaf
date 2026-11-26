# preserve-tool-metadata takeover: concurrent tool metadata (#167)

Branch `preserve-tool-metadata` (PR #167, worked locally as `cx-preserve-tool-metadata`). Codex opened it on 2026-11-24 and left it idle as a draft; this v2 run took it over on 2026-11-26 to finish it before the Saturday deadline. No feature flag changes, no public claims.

## 2026-11-26, a stale tool-call transition replaced the title and child session the executor saved

**Bug.** The AI SDK starts a local tool's executor on its own, apart from the stream consumer. For the task tool, the executor writes the running part's title and `metadata.sessionId` through `SessionProcessor.updateToolCall`. The stream consumer's `tool-call` handler moves the same part to running through `updateToolCall` as well, from a part it read before the executor wrote. When the executor's write fell between that read and the consumer's write, the consumer's write replaced the title and child session ID. This is the Windows failure behind #102: engine (windows, shard 3/18), "running task tool preserves metadata after tool-call transition", timed out waiting for running task metadata.

**Fix (Codex, commit `66234b07`).** Each tool call gets a one-permit semaphore (engine `session/processor.ts`, `serializeToolWrite`). `updateToolCall`, `completeToolCall`, `failToolCall` and the abort cleanup now read and write the part while they hold that permit. A writer that was waiting checks that the call is still the same call (the same `done` deferred) and does nothing if it has been settled or retried. The abort cleanup now settles each call inside the permit, so a late result cannot overwrite the aborted state. Model and tool execution run outside the permit.

**Test.** engine `test/session/processor-effect.test.ts`, "a tool annotation survives an overlapping provider transition". It uses the real `SessionProcessor` and holds the provider's running write after its read, while a concurrent `updateToolCall` saves the title and `sessionId`. The running part must keep both, and completion must still land.

**Red before.** With `processor.ts` set back to main's version, the case fails at the running-part check (title and `sessionId` missing). With the fix restored, it passes.

**Mutation check.** With the permit removed from `updateToolCall` only, the case fails (0 pass, 1 fail). Restored, it passes.

**Lead ruling (the #102 Windows evidence).** The PR body left "fresh qualifying evidence" for the exact Windows timeout open. The safest option that closes it: the fix lands now, because the race is reproduced on main and fixed by this PR. The original control, engine `test/session/prompt.test.ts` "running task tool preserves metadata after tool-call transition", passes here on macOS. The Windows evidence comes from the engine (windows) shards of this PR's CI run. The 10-second test deadline is unchanged.

## 2026-11-26, joined current main

Merged `origin/main` (`dbeb0666`, 63 commits) into the branch with no conflicts. Main changed none of the PR's files. The review pipeline digest (`REVIEW_PIPELINE_SOURCES`, `f9db452856d78a8c`) still matches, so core `test/review/model-evidence.test.ts` passes (37 tests) without a change.

**Stacking.** The branch contains PR #163 (`reclaim-dead-bindings`) whole, and through it older commits of #162, #161 and #128. It merges after #163 or together with it. PR #170 is stacked on this branch.

**CI.** Every job on the old head `66234b07` was cancelled after it had waited about six and a half hours in the queue. None of them ran, so there were no branch failures to read.

**Checked here (macOS, one file at a time).** Typecheck passes for app, client, cloud-workspaces, core, desktop, engine, protocol, schema, sdk/js, server, tui and web. All of the PR's test files pass, with one exception. Engine `test/connect/hub.test.ts`, "missing snapshot capability lists configuration without probing MCP", fails on this Mac with main's own sources as well, so it is not caused by this branch. The engine (linux) CI shards cover it. The Linux-only seccomp and offline-shell cases skip on macOS; the "Vector everywhere tests" CI job covers them.
