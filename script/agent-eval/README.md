# Agent eval harness

The repository has hundreds of test files that verify Vector's _code_. This
directory is the only thing that measures Vector's _agent_ — whether the thing
we ship gets better or worse between releases.

It works by building small throwaway repositories on disk, pointing a coding
agent at one of them with a prompt, and then checking objectively whether the
repository ended up in the state the task demanded. Because Vector hosts four
runtimes, the same task set runs against all of them.

```
bun script/agent-eval/run.ts --list
bun script/agent-eval/run.ts --runtime vector --tasks all
bun script/agent-eval/run.ts --runtime codex --tasks bugfix-overdue-invoices
bun script/agent-eval/run.ts --compare vector,claude-code,codex --tasks all
bun script/agent-eval/run.ts --compare vector,claude-code,codex,cursor --tasks all --repeat 5
```

| Flag              | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--runtime <id>`  | `vector`, `claude-code`, `codex`, or `cursor` (default `vector`)   |
| `--compare <ids>` | Comma-separated runtimes, run in sequence and printed side by side |
| `--tasks <spec>`  | `all` (default) or a comma-separated list of task ids              |
| `--model <id>`    | Passed through to the runtime's own `--model` flag                 |
| `--out <path>`    | Where to write the JSON report (default: a file in `$TMPDIR`)      |
| `--timeout <sec>` | Per-task agent timeout, overriding the task's own                  |
| `--repeat <n>`    | Repeat every task 1–20 times to expose run-to-run variance         |
| `--keep`          | Keep the fixture directories so you can inspect what the agent did |
| `--list`          | Print the task set and exit                                        |

Fixtures are created under `$TMPDIR` and deleted unless you pass `--keep`. A
JSON report with every per-task record is always written; the path is printed at
the end.

## Requirements

`bun` and `git`, plus whichever runtime CLI you are measuring. The fixtures have
zero dependencies and never touch the network, so there is no install step and a
failing check is attributable to the agent rather than to a flaky registry.

For `--runtime vector` the runner looks for a `vector` or `vector` binary on
`PATH`, then falls back to running the engine straight from source
(`packages/engine/src/index.ts`), which is the normal case during development.
Set `VECTOR_EVAL_ENGINE` to point at a specific build.

## The task set

Nine tasks. Each one builds its own fixture repository, and each declares its
objective check and the exact files it expects to be edited before any agent
sees it, so the pass bar cannot drift to fit a result.

| Id                               | Category     | What it measures                                                                                                                                                         |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bugfix-overdue-invoices`        | bug-fix      | A failing test exposes an off-by-one boundary bug. Can the agent read a red suite and fix the source?                                                                    |
| `feature-retry-schedule`         | feature      | A provided test specifies a `retrySchedule` export that does not exist yet. Can the agent implement to a spec it has to read?                                            |
| `refactor-rename-symbol`         | refactor     | Rename an exported symbol across four files with no behaviour change and no compatibility alias left behind.                                                             |
| `discipline-single-file-fix`     | bug-fix      | A one-line fix in a repository seeded with a typo'd README, a stale doc, and a `TODO`-laden module. The prompt says to change exactly one file.                          |
| `test-writing-parse-duration`    | test-writing | Write tests for an untested function. Scored by whether the tests actually catch four seeded defects, not by whether they are green.                                     |
| `bugfix-idempotent-webhooks`     | bug-fix      | Make a billing projection safe under duplicate and out-of-order webhook delivery without dropping valid credit grants.                                                   |
| `security-path-containment`      | bug-fix      | Close a sibling-prefix traversal bug while preserving valid root and nested paths.                                                                                       |
| `bugfix-concurrent-reservations` | bug-fix      | Prevent two concurrent model requests from reserving more than one shared allowance.                                                                                     |
| `refactor-structured-logging`    | refactor     | Move twelve modules in three packages onto a shared structured logger. Spans enough files that an agent may split it among subagents, so it shows what delegation costs. |

Every task nominates **protected files** — usually the tests that define
success. Changing one invalidates the run outright, because deleting the test is
otherwise the cheapest way to make a suite pass.

## How a task is scored

The objective check is a command that must exit 0, in the spirit of desktop's
`detectWorkspaceChecks` / `validateWorkspace`, except that the task declares its
check instead of the harness guessing one. For these fixtures it is always
`bun test`. Some tasks add content assertions (for example: after the rename,
the old symbol must not appear anywhere in `src/`).

A task **passes** when all three hold:

1. the check exits 0,
2. no protected file was modified,
3. every content assertion holds.

Diff surface comes from git: the harness commits the pristine fixture, and after
the run stages everything and diffs against that baseline. That survives an
agent that decides to commit its own work, and it counts created and deleted
files too. Agent scratch state (`.claude/`, `.codex/`, `node_modules/`,
lockfiles) is excluded; build output is deliberately _not_ excluded, because
producing it in a fixture this small is itself a discipline signal.

```
disciplinePenalty = min(45, 12 * outOfScopeFiles + 0.25 * outOfScopeLines)
mutationScore     = seeded == 0 ? 1 : caught / seeded
score             = passed ? max(0, 100 * mutationScore - disciplinePenalty) : 0
```

The penalty is capped at 45 so that a sprawling pass still ranks above a clean
failure — solving the task is worth more than being tidy about it.

Mutation scoring only applies to `test-writing-parse-duration`. Once the agent's
tests are green, the harness breaks the implementation four different ways, one
at a time, and re-runs the suite. Each mutation the suite fails to notice costs
a quarter of the score. Without this, `expect(true).toBe(true)` would score 100.

Scoring lives in `score.ts` and is pure — no disk, no processes — so a recorded
run can be re-scored with different weights without spending another model call.
`score.test.ts` covers it.

## What a run cost

Every run also records what it spent, read from the runtime's own JSON event
stream by `meter.ts` (pure, like `score.ts`, and covered by `meter.test.ts`):
cost in USD, provider requests, and tokens split into uncached input, cache
reads, cache writes, output, and the reasoning part of output.

The runtimes report these differently, so `meter.ts` converts them to one
shape before anything is compared: Codex counts cached input inside
`input_tokens`, Vector keeps reasoning out of `output`, and Claude Code's
`usage` covers only its main model while `modelUsage` also covers subagents on
a smaller model. Vector's JSON output includes its subagents' steps, marked
`subagent: true`, so a run's cost is the whole task's cost.

The report shows `COST`, `TOKENS`, `CACHED` (the share of input read from the
prompt cache, the measure of how well a runtime reuses its prompt) and `REQ`
per task, and the cost per pass for each runtime. A cost per pass includes the
attempts that failed, since they were billed too, and is left out unless every
measured task reported its cost. Codex reports no price, so its cost is shown
as unknown, never as zero.

Compare cost only between runs on the same model: a cheaper model is not a
more efficient agent.

## Request cost without a model

`footprint.ts` measures what an agent sends, with no API key, no network and no
model variance. It runs the real `vector run` (or the Claude Code or Codex CLI)
against a local fake model server that plays a fixed script of tool calls on one
of the fixtures, records every request, and prices each one under the
provider's prompt-caching rules (`prompt-cache.ts`):

- **Anthropic Messages** (`vector`, `claude-code`): Claude Sonnet 4.5 list
  prices, 5-minute cache writes, breakpoints as the request places them,
  nothing under 1,024 tokens cached.
- **OpenAI Responses** (`vector-openai`, Vector with an OpenAI API key, and
  `codex`): the longest prefix seen before is read, to the token, in 128-token
  steps from 1,024 tokens, and writing is free. Priced at the October 2026 live
  archive's gpt-6.1-sol rates ($2 input, $0.10 cached input, $10 output per
  million tokens). An input item's own id is not prompt text and is not part of
  the prefix. A request that names `previous_response_id` is priced on the whole
  context the provider rebuilds, and a `generate:false` warmup is a request of
  its own (`warmup`), so nothing is hidden.

The cache lasts for the whole harness run, one per runtime, as a provider keeps
an account's prefixes between sessions. `--sessions 2` runs every scenario twice
in fresh directories, so the second session's first request shows how much of
its prefix the first one already warmed (`1ST READ`).

```
bun script/agent-eval/footprint.ts
bun script/agent-eval/footprint.ts --scenario delegate-explore --out report.json
bun script/agent-eval/footprint.ts --runtime vector,claude-code --sessions 2
bun script/agent-eval/footprint.ts --runtime vector-openai,codex --codex /path/to/codex --sessions 2
bun script/agent-eval/footprint.ts --runtime vector-openai --openai-model gpt-6.1-sol --dump requests/
```

`--openai-model` picks the model Vector (and Codex) ask for, `--codex-model`
Codex's alone; `--dump <dir>` writes every request body and its headers;
`--ws` lets Codex use the Responses API over a WebSocket, as it does with a
ChatGPT sign-in (warmup plus `previous_response_id` continuations). The Claude
Code and Codex CLIs, version check included, start from an empty environment
and a throwaway HOME whose config points only at the fake server, so they never
read real settings or credentials.

Per request it reports the system prompt, tool definitions and messages, the
input read from and written to the cache, the bytes sent and the cost; per
scenario the share of input read from the cache, the first request's cached and
uncached input, the fixed tokens every request pays, the cost with and without
caching, and the size of each tool definition for the main agent and for a
subagent. The same build always gives the same numbers, so run it before and
after a change to see exactly what the change saved. Tokens are estimated as
characters / 4, the same way everywhere. Compare costs only between runtimes on
the same API.

Scenarios: `solo-fix` (run the tests, read, edit, re-run), `delegate-explore`
(an explore subagent finds the bug, the parent fixes it), `delegate-general` (a
general subagent does the fix, the parent checks it) and `long-loop` (a 12-step
investigation, to show how the cache holds up as a loop grows).

What it cannot show: how a real provider routes requests between cache
machines (prompt_cache_key, request rates), how long it keeps a prefix, or
anything about output length or the number of turns a model chooses. Those need
a live check. It also cannot drive Vector's ChatGPT sign-in path, whose
endpoint is fixed to the provider and which needs a real sign-in:
`vector-openai` sends the same system text and tools over an API key, but as one
developer item where a ChatGPT sign-in sends `instructions` plus a developer
item, and the provider's order for `instructions` against `tools` is not public.

## Does the brain compound?

`compounding/` asks whether Vector's brain carries what one task taught into the
later tasks on the same repository that need it, at what cost, and whether it
misleads once a fact has changed. Nineteen tasks over seven simulated weeks run
on _ledger_, a small invoicing and refunds service, where later tasks need what
earlier ones taught: a preference the user states once (pnpm), a decision and
its reason (integer cents), a check that breaks on a stale generated file,
values and requirements from a spec PDF the owner adds to memory, a naming
convention, and a flaky-test fix. In week 7 two of those go out of date: the
user changes the refund window the PDF gives, and a teammate's commit, which
nobody mentions, removes `pnpm gen`.

```
bun script/agent-eval/compounding/run.ts --out docs/benchmarks/vector-compounding-<date>
bun script/agent-eval/compounding/run.ts --arms off,on --tasks t01-slugify,t08-csv-export --dump requests/
```

Three arms run the same prompts from the same starting files: _off_ (no memory
tool, databases in memory, a fresh home per task), _on_ (one home, learning on)
and _blind_, a control that keeps the brain on but has the fake model server
delete everything the brain added before the scripted model reads the request.
Brain off cannot carry anything between tasks, so its repeated mistakes follow
from the task design; it is there to price the brain. The scripted model
(`policy.ts`) is a pure function of each request: it gets a fact right only when
the fact is in the request, goes by a correction when it is shown one, and acts
on an out-of-date fact when that is all it has. What it saves, and when it
opens a document pointer, come from the task definition. Mistakes are read from
the run (an `npm install`, a stale route table, a `pnpm gen` that no longer
exists, a hidden acceptance test of a fact or of acting on an out-of-date one),
never from the script. The report gives tokens, steps, re-reads, repeated
mistakes, mistakes from out-of-date facts and checks passed per task, per week
and cumulatively, and the line that brought each fact, as `README.md` and
`report.json`. Arms run under their folder's real path: Vector matches a file
the model reads against the root git reports, which resolves symlinks, so under
macOS's symlinked temporary folder no document pointer would show.

`--live` runs the off and on arms against a real model: a local
OpenAI-compatible endpoint (`--provider openai-compatible --base-url ...`) or a
provider the owner picks (`--provider anthropic --api-key-env NAME`). It prints a
cost estimate and does nothing without `--yes`, and refuses to run in CI. It
refuses a paid provider (`anthropic`, `openai`, or an endpoint that is not on
this machine) without `--price-input` and `--price-output`, because spend is
counted from the tokens the provider reports at those prices: a task is stopped
at the step that reaches what is left of `--max-spend` (default $5; that one
step can take it past the cap), and no task starts once it is spent. A local
endpoint may run unpriced, and the estimate then says the cap limits nothing.
**Live, the model gets a shell with every permission**
(`--dangerously-skip-permissions`): its home is redirected and its PATH
narrowed, but absolute paths outside the work folder are reachable, so run it
inside a container or a throwaway machine with a copy of the repository.

The tests run from `script/agent-eval/compounding`, one file at a time:
`tasks.test.ts` (each reference solution passes, each missing fact fails its
check, and acting on an out-of-date fact fails its `stale:` check),
`policy.test.ts` and `measure.test.ts` (pure), `run.test.ts` (live mode's
refusals and estimate, with nothing run), and `harness.test.ts` (four tasks
against the real engine: the same numbers twice, brain off never reads a
planted `brain.db`, and the blind control loses brain on's advantage).

## Do prompt changes help?

`prompt-evolve/` runs prompt variants of Vector's own agents against the compounding
tasks with a clause-aware scripted model, the footprint scenarios and your own
recorded traces, all offline, and against a real model only with `--live --yes`.
Each variant is checked against contracts that list every safety sentence of the
built-in prompts, and the report lists every sentence a variant removes or
changes. A variant is promotable only when it keeps every contract clause, costs
no more offline and is not worse live; you then apply its diff by hand on a
normal branch. Replays run on a clone without remotes, and live runs get an
environment built from scratch. Live and replay results are never committed. See
[`prompt-evolve/README.md`](prompt-evolve/README.md).

```
bun script/agent-eval/prompt-evolve/run.ts --variants <id> --tasks t01-slugify --scenario solo-fix
```

## Unavailable is not zero

The rule this harness must never break: **a runtime that cannot be measured is
reported as `unavailable` and excluded from every aggregate.** It is never
scored 0, and `passRate` / `meanScore` come back undefined rather than 0 when
nothing was measured. "We could not find out" and "it failed everything" are
very different claims and must never render as the same number.

A runtime is unavailable when its CLI is missing, or when it exits non-zero
having made **no edits at all** and its output matches a login/provider/model
failure. That gate is deliberately one-directional: a run that produced edits is
always scored, so the heuristic can never turn a real attempt into a non-result.
The report quotes the matched text so you can check the call yourself.

This is not theoretical. The first live run of this harness against Vector's own
engine on a developer machine died on ``The model `whisper-large-v3-turbo` does
not support chat completions`` — a provider/model-resolution problem that an
auth-only check scored as a flat 0 for the agent.

Harness failures — git missing, a fixture that would not build — are reported
separately as `error` and are likewise excluded from the aggregates.

## What this does NOT measure

Be honest about the ceiling here. This harness does **not** measure:

- **Anything at real-codebase scale.** The fixtures are a handful of files with
  no dependencies. Nothing here says how an agent behaves in a large monorepo
  with a slow test suite and a real type graph.
- **Interactive behaviour.** Every run is one headless prompt. Clarifying
  questions, steering mid-task, permission prompts, plan mode, and recovery from
  a bad first attempt are all invisible.
- **Code quality.** A passing check is a passing check. The scoring cannot tell
  elegant from ugly, and diff surface is a proxy for discipline, not for taste.
- **Tool-use breadth.** No task exercises the web, MCP servers, images, LSP,
  or long-context retrieval. Only `refactor-structured-logging` is big enough
  to invite subagents, and whether an agent delegates is its own choice.
- **Vector's product surface.** This measures the agent, not the desktop app,
  the cloud backend, or the editor.
- **Broad statistical significance.** `--repeat` exposes run-to-run variance,
  but a handful of local runs is still not a publishable population and does
  not control for provider or model changes.

Nine tasks that run honestly are worth more than fifty that are hand-waved, but
this set is still a smoke test for agent quality, not a benchmark of real-repository work.

## Reading results responsibly

**Results move with model choice and provider state, so only same-session
comparisons mean anything.** A number from last week and a number from today
were produced against different model versions, different provider routing,
possibly different default model resolution, and different server load. Do not
put two such numbers next to each other and call the difference a regression.

Practically:

- To compare runtimes, use `--compare` in a single invocation.
- Use `--repeat 5` or more before treating a pass-rate difference as a signal;
  repeated attempts get fresh repositories and remain separate in the JSON.
- To compare two Vector builds, run both back to back in one sitting, and pin
  `--model` so the model is not a free variable.
- Re-run before believing any single result.
- No results of `run.ts` are checked into this repository, and none should be.
  There are no published numbers for this harness and nothing here should be
  quoted as a benchmark score. The offline compounding benchmark is different:
  the same revision gives the same numbers, so its dated reports are kept in
  `docs/benchmarks/`.

## Adding a task

Append to `TASKS` in `tasks.ts`. A task is worth adding only if its success
condition is objective — a command that exits 0, plus optional content
assertions. If you find yourself wanting to score "did it explain itself well",
that belongs somewhere else. Give the task a protected file so a green check
cannot be faked, and keep the fixture dependency-free.
