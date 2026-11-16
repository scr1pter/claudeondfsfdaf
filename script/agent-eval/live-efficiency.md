# Owner-run live efficiency check

No paid model calls were made during this integration. Offline scripts execute fixed tool calls against a local fake provider; they cannot establish model quality, real prompt-cache warmth, or a live price/speed advantage. The prior archive still has `decisiveClaimPermitted: false`.

These commands consume your provider allowance or credits. Run them yourself only when ready to spend approximately $1 per matched round (actual usage can vary). Use your normal CLI sign-ins; do not copy, print, or inspect credential stores. Keep generated transcripts and logs private. The matched-run and current nine-task commands below launch the CLIs normally and do not open their credential files. The recovered historical evaluator uses the derived final-source adapter described below, which delegates sign-in to the runtime.

## Prepare the exact final revision

From a clean checkout of the released main commit, record the revision and installed CLI versions. The `vector-source` launcher this block creates, used by the reasoning context experiment and the nine-task suite below, runs that checkout's engine, so an older globally installed Vector cannot silently enter the comparison. Nothing in this block calls a model. Install dependencies first with `bun install --frozen-lockfile` if needed.

```sh
git rev-parse HEAD
bun --version
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
export VECTOR_BENCH_SOURCE="$PWD"
export VECTOR_BENCH_WORK="$(mktemp -d -t vector-live-efficiency)"
cp docs/benchmarks/vector-codex-2026-10/harness/{runner.ts,tasks.ts,score.ts,meter.ts,runner-self-test.ts,extra-behavior.test.ts} "$VECTOR_BENCH_WORK/"
cat > "$VECTOR_BENCH_WORK/vector-source" <<'SH'
#!/bin/sh
exec bun run --conditions=browser "$VECTOR_BENCH_SOURCE/packages/engine/src/index.ts" "$@"
SH
chmod 700 "$VECTOR_BENCH_WORK/vector-source"
```

Connect Vector to OpenAI using **Sign in with ChatGPT** in its normal UI. Confirm the normal Codex CLI is signed in too. Both sides use `gpt-6.1-sol`, medium effort. Live runs intentionally inherit normal account configuration for sign-in, unlike the isolated offline harness. Record and hold user settings, plugins, custom agent rules and enabled tools constant; do not call these pristine environments. Do not run a paid probe merely to check setup. The runners report unavailable authentication, quota and model failures separately; retain those failures and do not replace them with selectively successful attempts.

Create configurations without handling credentials:

```sh
bun -e '
const root = process.env.VECTOR_BENCH_SOURCE
const work = process.env.VECTOR_BENCH_WORK
if (!root || !work) throw new Error("Set the two benchmark paths first")
const configuration = {
  vector: {
    command: process.execPath,
    prefix: ["run", "--conditions=browser", `${root}/packages/engine/src/index.ts`],
    model: "openai/gpt-6.1-sol", variant: "medium",
    extraArgs: ["--print-logs", "--log-level", "INFO"],
    env: { VECTOR_DISABLE_WEBSOCKETS: "0", VECTOR_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { setCacheKey: true } } } }) },
  },
  codex: {
    command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    model: "gpt-6.1-sol", effort: "medium",
  },
  timeoutSeconds: 600,
  metadata: { purpose: "Owner-authorized live comparison", revision: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim() },
}
await Bun.write(`${work}/key-on.json`, JSON.stringify(configuration, null, 2))
configuration.vector.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ provider: { openai: { options: { setCacheKey: false } } } })
await Bun.write(`${work}/key-off.json`, JSON.stringify(configuration, null, 2))
configuration.vector.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ provider: { openai: { options: { setCacheKey: true } } } })
configuration.vector.env.VECTOR_DISABLE_WEBSOCKETS = "1"
await Bun.write(`${work}/http.json`, JSON.stringify(configuration, null, 2))
configuration.vector.env.VECTOR_DISABLE_WEBSOCKETS = "0"
configuration.vector.env.VECTOR_EXPERIMENTAL_REASONING_CONTEXT = "all_turns"
await Bun.write(`${work}/context-on.json`, JSON.stringify(configuration, null, 2))
'
cd "$VECTOR_BENCH_WORK"
bun ./runner-self-test.ts
```

## Matched nine runs per runtime

Three archived tasks repeated three times give nine fresh sessions for each runtime. The runner alternates execution order. Keep the same machine, effort, fixtures, deadlines, tools and checks. Avoid unrelated builds during timing measurements.

```sh
bun runner.ts --config key-on.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-key-on
```

Each following command is a **separate paid round**. Run all cells when comparing an option; do not compare a handpicked fast run with a median.

```sh
bun runner.ts --config key-off.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-key-off
bun runner.ts --config http.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-http
```

Report pass rate and protected-file violations before latency or estimated cost. Include all failures, wall time, sampled process-tree RSS, per-session token categories, and both median and spread. Subscription usage is API-equivalent cost, not a billing invoice. Preserve title/helper spend. Do not compare Claude Code live; that comparison remains offline only.

## Cache and transport evidence

Vector emits bounded `openai transport` diagnostic records in the captured stderr: `selected`, `request_sent`, `terminal`, `failure`, transport, continuation mode, bytes and elapsed time. They exclude credentials and request content. Confirm the sign-in runs actually selected WebSocket and later requests sent `continuation: incremental`; report full resend/fallback cases too. An HTTP run must select HTTP. Use the recorded logs, not the environment flag alone, as evidence.

The runner captures each Vector `step_finish` event. For **each new session**, record the first provider turn's input tokens and `tokens.cache.read`, then all later turns separately. Keep first-request warmth separate from within-session cache share. Codex's aggregate turn totals alone do not establish its first-request `cached_tokens`; obtain per-request usage through the CLI's supported diagnostics if available, otherwise label that field unavailable. Do not infer a cache hit from a byte-identical prefix or previous_response_id.

The shipped code restores `prompt_cache_key` by default, with `setCacheKey: false` as the A/B opt-out above. Read the first-request cache reads of new sessions in both arms, not only the within-session share: OpenAI routes a request by its opening tokens combined with the key, so a key that changes with every session may send each new session to a machine that does not hold the prefix an earlier session warmed, while the key-off arm routes every session with the same opening tokens together. Which effect wins on the sign-in backend is exactly what this A/B measures; the offline harness cannot model routing. The ChatGPT sign-in path separates stable instructions from a per-session developer item; the API-key path was already stable. Keep the sign-in path consistent across comparisons.

## Reasoning context experiment

OpenAI's reasoning guide documents `reasoning.context` with three values: `auto` (the model's default, the same as omitting it), `current_turn` (earlier turns' reasoning is not rendered into the next sample) and `all_turns` (available, compatible reasoning from earlier turns is rendered). It names the GPT-5.6 family, which already defaults to `all_turns`, and GPT-6.1 Sol as the models that support `all_turns`; it does not state GPT-6.1 Sol's default. The captured Codex CLI request for gpt-6.1-sol sends `all_turns`. The bundled SDK has no option for it, so Vector sends the field only when `VECTOR_EXPERIMENTAL_REASONING_CONTEXT` is set to one of those three values, and then only on OpenAI Responses reasoning requests to the GPT-5.6 family or GPT-6.1 Sol, over HTTP and the WebSocket alike. Each request is judged by the model its own body names, so a title or helper request to another model in the same process carries no field. It is **off by default**; nothing in this release enables it, and no result for it exists yet.

The guide also says each response reports the mode it ran with. Over the sign-in WebSocket, every `openai transport` `terminal` record now carries it as `effectiveReasoningContext`, next to the requested `reasoningContext` when one was sent. Read it first from the ordinary runs above, which cost nothing extra: if gpt-6.1-sol already reports `all_turns` without the flag, setting it changes nothing for that model and the paid comparison below is unnecessary. HTTP records do not parse the response stream and carry no effective mode.

Check the wire shape offline first, without provider calls, and keep the dumps private:

```sh
VECTOR_EXPERIMENTAL_REASONING_CONTEXT=all_turns bun --no-env-file script/agent-eval/footprint.ts \
  --runtime vector-openai --scenario solo-fix --openai-model gpt-6.1-sol --dump "$VECTOR_BENCH_WORK/context-http"
VECTOR_EXPERIMENTAL_REASONING_CONTEXT=all_turns bun --no-env-file script/agent-eval/footprint.ts \
  --runtime vector-openai --scenario solo-fix --openai-model gpt-6.1-sol --ws --dump "$VECTOR_BENCH_WORK/context-ws"
VECTOR_EXPERIMENTAL_REASONING_CONTEXT=all_turns bun --no-env-file script/agent-eval/footprint.ts \
  --runtime vector-openai --scenario solo-fix --openai-model gpt-5.5 --dump "$VECTOR_BENCH_WORK/context-other-model"
```

Every request in the first two dumps should show `reasoning.context: "all_turns"`, and the WebSocket requests after the first should still carry `previous_response_id`. No request in the `gpt-5.5` dump should carry the field.

The field changes only what is rendered from earlier **user turns**, and each archived task is a single prompt, so `context-on.json` in the nine-run matrix is a regression check (pass rate, cost, time), not the test of the hypothesis. That test needs a follow-up prompt in the same session. Run each arm the same number of times, each from its own fresh clone, using the `vector-source` launcher created under "Prepare the exact final revision" above:

```sh
for context in off all_turns; do
  for attempt in 1 2 3; do
    dir="$(mktemp -d -t "vector-context-${context}")"
    git clone -q "$VECTOR_BENCH_SOURCE" "$dir/repo" && cd "$dir/repo"
    flag=$([ "$context" = off ] || echo "$context")
    VECTOR_EXPERIMENTAL_REASONING_CONTEXT="$flag" "$VECTOR_BENCH_WORK/vector-source" run --model openai/gpt-6.1-sol --variant medium --format json \
      "Read packages/engine/src/provider/transform.ts and explain how the OpenAI prompt cache key is chosen. Do not edit files." > "$dir/turn-1.jsonl"
    VECTOR_EXPERIMENTAL_REASONING_CONTEXT="$flag" "$VECTOR_BENCH_WORK/vector-source" run --continue --model openai/gpt-6.1-sol --variant medium --format json \
      "Which other providers get a cache key, and under which option name? Do not edit files." > "$dir/turn-2.jsonl"
    cd "$VECTOR_BENCH_SOURCE"
  done
done
```

For each attempt, compare the second prompt's first `step_finish`: input tokens, `tokens.cache.read`, output and reasoning tokens, and whether the answer is correct. `all_turns` is expected to raise input tokens (earlier reasoning is rendered again, mostly from cache); it is worth enabling only if answers or later-turn cost improve. Keep every attempt. Do not enable it globally without that evidence.

## Behavioral gate

The original frozen evaluator was recovered on the handoff machine at:

```text
~/.codex/benchmarks/vector-codex-20261007-7deUGe/round4/diagnosis/prompt-consolidation-proposal/behavior-evaluation-v12
```

Its `scenarios.json`, `rubric-v4.json`, `execution-plan.json`, `collector.ts`, `broker.ts`, actor sources, fixtures and completed reviews are present. Preserve this directory and its referenced sibling studies/source snapshots; it is not a standalone repository command. The original candidate result remains **15/18**, against a historical baseline of **14/18**. No final-code live rerun has superseded it.

The 18 candidate cells are the six original families (`general-unavailable`, `plan-only`, `nested-specialist`, `blocked-todos`, `complex-delegation-launch`, `failed-resume`) across `gpt-6.1-sol`, `gpt-6-astra` and `gpt-6-luna`, at medium effort. Matching both source arms produces 36 episodes. The gate requires every applicable criterion in all 18 candidate episodes to pass, with no critical candidate violation or candidate-only behavioral regression. Missing evidence is inconclusive, never a pass. Two independent blinded reviewers judge complete episodes; root adjudication covers every failure, inconclusive and disagreement plus the frozen positive sample before unblinding. This is a capped behavioral checkpoint screen, not proof of completed implementations or end-to-end task quality.

These recovered input hashes identify the original gate:

| File              | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `scenarios.json`  | `931bc371f73acca8e9fd6013abe6b1531d9021608b58622793acacb6d66137cb` |
| `rubric-v4.json`  | `0d19d40cb9e2ccdb45caed3f2fd9f4f7239dd3395d9cffd74a43a52b53b78e5a` |
| `completion.json` | `7e10211f8835a657ae4d79c101d068311f72d217007c08357fa124638be51159` |

The exact historical live entry points, from that directory, were `bun run broker.ts --execute-first-block` and then `bun run broker.ts --execute-second-block`. The supplied `execute-first-block.sh` and `execute-second-block.sh` wrap them with macOS `caffeinate`. The first block runs six episodes, capped at 18 sends; the remaining 30 require a separate protocol-feasibility review and are capped at 90 sends. Each episode permits at most three turns, with a 120-second request timeout. Preserve all attempts and protocol failures; do not automatically retry or select successful replacements.

**Do not run those archived live commands as a final-code check.** They bind old V4/V11 source paths, import the archived V8 transport, require Bun 1.3.14, pin October 10 request shapes and completed run IDs, and directly read a configured OAuth credential file before connecting to the ChatGPT WebSocket endpoint. Changing an environment variable does not select the final checkout. The recorded study made 49 provider requests and estimated **$1.34958074 API-equivalent cost** using its frozen rates; actual subscription billing is unknown. That historical amount is not a current price or a promised rerun cost.

The repository now includes a [derived final-source adapter and exact preparation/live commands](behavior-v12/README.md). It runs the original native seeds and checkpoint policies through the selected checkout's engine, freezes original scenarios/rubric, source and fixture bytes, and preserves the original response, shell, source-consumption and blinded-review validators. Its declared transport change uses each source runtime's own OpenAI HTTP integration instead of the archived V8 WebSocket broker; the harness never reads credentials or authorization headers. The owner signs into a fresh CLI-only data directory normally, then explicitly starts the two live blocks after offline/protocol review. Both final candidate and original V4 baseline run all 18 cells. The historical gate remains unmet until the complete new live evidence passes blinded review.

Prepare from the clean final `VECTOR_BENCH_SOURCE` commit, and review all declared adapter differences before spending. Rebind actual request shapes and dates without weakening scenario checks. The old request contract required candidate cache-key omission, whereas the integrated code restores that key; the adapter records the current emitted shape instead of pretending that the old wire contract remains current. Its offline 36-cell preflight and six-cell rehearsal validate instrumentation with scripted responses, never model quality. Preserve every failed study and attempt; do not replace unsuccessful cells selectively.

The archived broker also implements `--check` (frozen integrity only), `--preflight <fresh-run-id>` (36 scripted loopback episodes) and `--rehearse-first-block <fresh-run-id>` (six synthetic WebSocket episodes). Their non-live branches do not read the configured real credentials or contact the provider, but they still target historical sources; preflight/rehearsal write artifacts. Use the derived adapter's separate commands for final-code preparation, offline checks and owner-run live blocks through the normal runtime. Passing synthetic responses cannot establish the 18/18 model-behavior gate. The archive itself was inspected read-only during this integration; none of these commands was executed.

The current repository's separate nine-task objective suite can be run manually as an additional paid check (it does not replace the historical 18-scenario gate), with the `vector-source` launcher from the preparation step:

```sh
cd "$VECTOR_BENCH_SOURCE"
VECTOR_EVAL_ENGINE="$VECTOR_BENCH_WORK/vector-source" bun script/agent-eval/run.ts --runtime vector --model openai/gpt-6.1-sol --tasks all --repeat 2 --keep --out "$VECTOR_BENCH_WORK/current-behavior.json"
```

Local prompt seams, real-runtime edit-before-check ordering, cancellation, title usage, fixture completion and terminal-usage tests are part of the offline validation. Their passing results do not establish live behavioral parity. Do not publish a "cheaper/faster than Codex" claim unless the matched live data and quality gates support it.

## Subagent orchestration release checks

The October subagent study in `docs/benchmarks/vector-subagents-2026-10/` is offline only. Its scripted provider validates controls, complete work, and request footprint; it does not validate delegation judgment or actual provider cost. Do not infer Claude Code price parity or success on the historical 18-cell behavior gate from it.

After preparing `VECTOR_BENCH_SOURCE`, `VECTOR_BENCH_WORK`, and the `vector-source` launcher above, the owner can run a capped live workflow probe. It consumes provider allowance. Use an explicitly chosen model available in the account, and keep models, effort, agent configuration and plugins fixed for every attempt. Do not substitute an unavailable model or hide failed attempts. This intentionally small fixture tests the orchestration path, not whether a model naturally chooses substantial work worth delegating.

Create a fresh fixture without making any provider call:

```sh
export VECTOR_SUBAGENT_FIXTURE="$(mktemp -d -t vector-subagent-live)"
cd "$VECTOR_BENCH_SOURCE"
bun --no-env-file -e '
const { taskById } = await import("./script/agent-eval/tasks.ts")
const task = taskById("bugfix-overdue-invoices")
const directory = process.env.VECTOR_SUBAGENT_FIXTURE
if (!task || !directory) throw new Error("Missing fixture or destination")
for (const [path, content] of Object.entries(task.files)) await Bun.write(`${directory}/${path}`, content)
'
cd "$VECTOR_SUBAGENT_FIXTURE"
git -c init.defaultBranch=bench init
git add .
git -c user.name=Benchmark -c user.email=benchmark@example.invalid commit -m 'test: seed subagent fixture'
```

The following command is paid. The dollar cap is a catalog-price Run Guard threshold; already-running provider calls may finish beyond it. The step cap also bounds subscription/free routes that have no per-token invoice. No automatic retry is implied.

```sh
"$VECTOR_BENCH_WORK/vector-source" run --model openai/gpt-6.1-sol --variant medium \
  --max-cost 2 --max-steps 30 --format json \
  'This is an explicit orchestration probe. Launch two background read-only workers: one inspects src/invoice.ts, the other test/invoice.test.ts. While they run, explain what each owns in one sentence. Use event-driven waiting, never shell sleeps or status polling. Integrate their findings, make the minimal source fix, run bun test yourself, and report every worker result and verification. Do not edit test/ or add dependencies.' \
  > "$VECTOR_BENCH_WORK/subagents-live-1.jsonl"
bun test
git diff --exit-code -- test/
```

Preserve the JSONL and exit codes, every child and helper usage event, exact source revision, model/effort, tool access and all verification. Inspect per-request provider cache-read usage separately for each child's first request and later turns; do not infer it from a shared prefix or cache key. API-equivalent subscription cost is not actual billed dollars. Repeat the complete protocol from fresh fixtures for any before/after comparison, alternating source order and keeping all attempts.

Interactive release checks complement that probe: start substantial background work in the app, send an unrelated user question, ask what one worker is doing, steer it, answer a Needs-you request, and stop another worker while retaining partial work. Verify reconnect/restart displays abandoned execution as stopped rather than silently retrying paid work. Check parent totals against direct parent usage plus descendant usage exactly once, with internal helpers hidden but counted. Those observations require complete transcripts and independent review before making any user-experience or quality claim.
