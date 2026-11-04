#!/usr/bin/env bun
// Offline request-cost benchmark. Runs a real agent (Vector's `vector run`, the Claude Code CLI or the Codex CLI)
// against a local fake model server (Anthropic Messages, or the OpenAI Responses API) that plays a fixed script of
// tool calls, records every request the agent sends, and prices each one under the provider's prompt-caching rules
// (prompt-cache.ts). No real API key or model calls are used. Concurrent request order can affect the estimates.
// The scripted work permits request-footprint comparisons. It measures what each runtime sends, not how well a
// model would do with it; the live harness in run.ts measures that.
//
//   bun script/agent-eval/footprint.ts                                   Vector, every scenario
//   bun script/agent-eval/footprint.ts --runtime vector,claude-code      side by side on Anthropic Messages
//   bun script/agent-eval/footprint.ts --runtime vector-openai,codex --codex /path/to/codex
//                                                                        side by side on the OpenAI Responses API
//   bun script/agent-eval/footprint.ts --sessions 2                      each scenario twice, to see a second
//                                                                        session start on a warm cache
//   bun script/agent-eval/footprint.ts --scenario solo-fix --out report.json --dump requests/
//   bun script/agent-eval/footprint.ts --runtime vector,vector-openai --scenario solo-fix --sessions 2 --task-size standard --judge off

import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { taskById } from "./tasks"
import { actorScript, type ActorPlan, type ActorStep } from "./footprint-actors"
import { footprintControlArgs, footprintControls } from "./footprint-controls"
import {
  continued,
  createPromptCache,
  dollars,
  estimate,
  price,
  strip,
  toolSignature,
  toolsOf,
  type PromptCache,
  type Rates,
  type Recorded,
  type RequestCost,
} from "./prompt-cache"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const MODEL = "claude-sonnet-4-5"
// Per million tokens. Anthropic Messages runs are priced at Claude Sonnet 4.5 list prices, with a 5-minute cache write
// at 1.25x input and a read at 0.1x. OpenAI Responses runs are priced at the rates of the October 2026 live
// Vector/Codex archive (gpt-6.1-sol: $2 input, $0.10 cached input, $10 output; writes are free), so offline and live
// numbers can be read side by side. Only compare runtimes on the same API.
const RATES = {
  messages: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  responses: { input: 2, cacheWrite: 0, cacheRead: 0.1, output: 10 },
} satisfies Record<string, Rates>

type Runtime = "vector" | "vector-openai" | "claude-code" | "codex"
const RUNTIMES: Runtime[] = ["vector", "vector-openai", "claude-code", "codex"]

type Step = ActorStep
type Scenario = ActorPlan & { id: string; title: string; task: string }

// Whole lines, so the same edit also works as a patch hunk.
const FIX: Step = {
  kind: "edit",
  path: "src/invoice.ts",
  from: "  return invoices.filter((invoice) => !invoice.paidOn && invoice.dueOn <= today)",
  to: "  return invoices.filter((invoice) => !invoice.paidOn && invoice.dueOn < today)",
}
const TEST: Step = { kind: "bash", command: "bun test", description: "Run the test suite", verify: true }

const SCENARIOS: Scenario[] = [
  {
    id: "solo-fix",
    title: "Fix a failing test alone: run the suite, read, edit, re-run, answer",
    task: "bugfix-overdue-invoices",
    steps: [
      { ...TEST, verify: false },
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Fixed: an invoice due today is no longer counted as overdue. The whole suite passes." },
    ],
  },
  {
    id: "delegate-explore",
    title: "Hand the search to a read-only explore subagent, then fix and verify",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        agent: "explore",
        description: "find the failing boundary",
        prompt: "Find why `bun test` fails in this repository. Report the file, the line and the cause.",
      },
      // The subagent's own steps.
      { kind: "search", pattern: "dueOn" },
      { kind: "read", path: "src/invoice.ts" },
      {
        kind: "answer",
        text: "src/invoice.ts line 5: `invoice.dueOn <= today` counts an invoice due today as overdue.",
        sub: true,
      },
      // Back in the parent.
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "delegate-general",
    title: "Hand the whole fix to a general subagent, then check its work",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        agent: "general",
        description: "fix the failing boundary",
        prompt: "Make `bun test` pass in this repository without editing test/. Report the change and the test run.",
      },
      // The subagent's own steps.
      { ...TEST, verify: false },
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Changed `<=` to `<` in src/invoice.ts line 5; `bun test` passes (3 tests).", sub: true },
      // Back in the parent.
      TEST,
      { kind: "answer", text: "Fixed the boundary in src/invoice.ts; the suite passes." },
    ],
  },
  {
    id: "long-loop",
    title: "A 12-step investigation: how the prompt cache holds up as a tool loop grows",
    task: "discipline-single-file-fix",
    steps: [
      { ...TEST, verify: false },
      { kind: "list", pattern: "**/*.ts" },
      { kind: "read", path: "README.md" },
      { kind: "search", pattern: "export function" },
      { kind: "read", path: "src/args.ts" },
      { kind: "read", path: "src/logger.ts" },
      { kind: "read", path: "src/config.ts" },
      { kind: "search", pattern: "TODO" },
      { kind: "bash", command: "git status --short", description: "Check the working tree" },
      { ...TEST, verify: false },
      { kind: "list", pattern: "test/**/*.ts" },
      { kind: "answer", text: "Investigation finished; the failing case is in src/args.ts." },
    ],
  },
  {
    id: "delegate-multi",
    title: "Two background readers, event-driven waits, then a verified parent fix",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        actor: "boundary",
        agent: "explore",
        description: "Locate overdue boundary",
        prompt: "Inspect the invoice boundary in src/invoice.ts; report the comparison used. Do not edit.",
        background: true,
      },
      {
        kind: "delegate",
        actor: "tests",
        agent: "explore",
        description: "Read invoice test expectations",
        prompt: "Inspect test/invoice.test.ts; report what due-today and paid cases expect. Do not edit.",
        background: true,
      },
      { kind: "manage", action: "wait", actor: "boundary" },
      { kind: "manage", action: "wait", actor: "tests" },
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      { kind: "answer", text: "Both readers completed. Fixed the boundary and independently verified the suite." },
    ],
    actors: {
      boundary: [
        { kind: "search", pattern: "dueOn" },
        { kind: "read", path: "src/invoice.ts" },
        {
          kind: "answer",
          text: "The current comparison invoice.dueOn <= today incorrectly includes due-today invoices.",
        },
      ],
      tests: [
        { kind: "read", path: "test/invoice.test.ts" },
        { kind: "answer", text: "Due-today and paid invoices must be excluded; the suite has three checks." },
      ],
    },
  },
  {
    id: "delegate-dependency",
    title: "Reader hands its finding to a dependent editor, followed by parent verification",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        actor: "research",
        agent: "explore",
        description: "Find boundary for editor",
        prompt:
          "Read src/invoice.ts and test/invoice.test.ts. Report the precise boundary bug for the dependent editor.",
        background: true,
      },
      {
        kind: "delegate",
        actor: "editor",
        agent: "general",
        description: "Repair researched invoice boundary",
        prompt:
          "Apply the prerequisite reader's finding to src/invoice.ts, verify with bun test, and report the change. Do not edit test/.",
        background: true,
        dependsOn: ["research"],
      },
      { kind: "manage", action: "wait", actor: "editor" },
      TEST,
      { kind: "answer", text: "The reader's handoff was applied by the editor; independent verification passes." },
    ],
    actors: {
      research: [
        { kind: "read", path: "src/invoice.ts" },
        { kind: "read", path: "test/invoice.test.ts" },
        {
          kind: "answer",
          text: "DEPENDENCY_FINDING: Replace invoice.dueOn <= today with invoice.dueOn < today; due-today invoices are not overdue.",
        },
      ],
      editor: [
        { kind: "read", path: "src/invoice.ts", requires: "DEPENDENCY_FINDING" },
        FIX,
        TEST,
        { kind: "answer", text: "Applied the reader's boundary finding. bun test passes, with test files unchanged." },
      ],
    },
  },
  {
    id: "delegate-steer",
    title: "Steer a live worker at its next provider boundary, then verify the completed fix",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        actor: "editor",
        agent: "general",
        description: "Repair invoice with steering",
        prompt:
          "Inspect the invoice boundary, fix it, and run bun test. The parent will add one verification detail while you work.",
        background: true,
      },
      {
        kind: "manage",
        action: "message",
        actor: "editor",
        text: "STEER_CHECK: Include the paid-invoice case in your report; keep test/ unchanged.",
        after: { actor: "editor", requests: 1 },
      },
      { kind: "manage", action: "wait", actor: "editor" },
      TEST,
      {
        kind: "answer",
        text: "The worker received the correction and verified paid and due-today cases; parent verification passes.",
      },
    ],
    actors: {
      editor: [
        { kind: "read", path: "src/invoice.ts", releaseOn: "message" },
        { ...FIX, requires: "STEER_CHECK" },
        TEST,
        {
          kind: "answer",
          text: "Changed <= to <; all three tests pass, including the paid-invoice case. Test files unchanged.",
        },
      ],
    },
  },
  {
    id: "delegate-stop",
    title: "Stop a worker during a provider request, preserve its partial observation, finish and verify",
    task: "bugfix-overdue-invoices",
    steps: [
      {
        kind: "delegate",
        actor: "reader",
        agent: "explore",
        description: "Inspect invoice until stopped",
        prompt:
          "Read src/invoice.ts and report the boundary; the parent may stop the investigation after the first read.",
        background: true,
      },
      {
        kind: "manage",
        action: "stop",
        actor: "reader",
        text: "The parent has enough context; stop and retain partial work.",
        after: { actor: "reader", requests: 2 },
      },
      { kind: "read", path: "src/invoice.ts" },
      FIX,
      TEST,
      {
        kind: "answer",
        text: "Stopped the reader during its next request, retained its partial read, and completed and verified the fix.",
      },
    ],
    actors: {
      reader: [
        { kind: "read", path: "src/invoice.ts" },
        { kind: "hold", text: "Partial read completed before cancellation.", releaseOn: "stop" },
      ],
    },
  },
]

type Call =
  | { name: string; input: Record<string, unknown> }
  | { name: string; custom: string; namespace?: string }
  | { text: string }

// The call each runtime makes for a step, with its own tool names and parameters. Claude Code has no separate search
// or list tool, so those run through Bash with ripgrep, as it does them; Codex does everything but edits through its
// shell tool, and edits with an apply_patch hunk. Vector on a GPT model edits with its own apply_patch tool, as it is
// offered there instead of edit and write.
function toolCall(
  runtime: Runtime,
  step: Step,
  dir: string,
  taskID: (actor: string) => string,
  taskResult: (actor: string) => string,
): Call {
  const path = (relative: string) => join(dir, relative)
  const patch = (edit: { path: string; from: string; to: string }) =>
    `*** Begin Patch\n*** Update File: ${edit.path}\n@@\n-${edit.from}\n+${edit.to}\n*** End Patch`
  if (step.kind === "answer" || step.kind === "hold") return { text: step.text }
  if (step.kind === "manage") {
    const id = taskID(step.actor)
    if (runtime === "vector" || runtime === "vector-openai")
      return {
        name: "task_manage",
        input:
          step.action === "wait"
            ? { action: "wait", task_ids: [id], mode: "all", timeout: 60000 }
            : step.action === "stop"
              ? {
                  action: "stop",
                  task_ids: [id],
                  reason: step.text ?? "The fixture requests a stop; retain partial work.",
                }
              : { action: "message", task_id: id, text: step.text ?? "", delivery: "steer" },
      }
    if (runtime === "claude-code")
      return step.action === "wait"
        ? { name: "TaskOutput", input: { task_id: id, block: true, timeout: 60000 } }
        : step.action === "stop"
          ? { name: "TaskStop", input: { task_id: id } }
          : {
              name: "SendMessage",
              input: { to: id, message: step.text ?? "", summary: "Fixture steering correction for active worker" },
            }
    throw new Error("This orchestration scenario requires native child management")
  }
  if (runtime === "codex") {
    if (step.kind === "edit") return { name: "apply_patch", custom: `${patch(step)}\n` }
    const cmd =
      step.kind === "bash"
        ? step.command
        : step.kind === "read"
          ? `sed -n '1,250p' ${step.path}`
          : step.kind === "search"
            ? `rg -n ${JSON.stringify(step.pattern)}`
            : step.kind === "list"
              ? `rg --files -g ${JSON.stringify(step.pattern)}`
              : "true"
    return { name: "exec_command", input: { cmd } }
  }
  if (runtime === "vector" || runtime === "vector-openai") {
    if (step.kind === "bash") return { name: "bash", input: { command: step.command, description: step.description } }
    if (step.kind === "read") return { name: "read", input: { filePath: path(step.path) } }
    if (step.kind === "edit" && runtime === "vector-openai")
      return { name: "apply_patch", input: { patchText: patch(step) } }
    if (step.kind === "edit")
      return { name: "edit", input: { filePath: path(step.path), oldString: step.from, newString: step.to } }
    if (step.kind === "search") return { name: "grep", input: { pattern: step.pattern, path: dir } }
    if (step.kind === "list") return { name: "glob", input: { pattern: step.pattern } }
    return {
      name: "task",
      input: {
        description: step.description,
        prompt: step.prompt,
        subagent_type: step.agent,
        background: step.background ?? false,
        ...(step.dependsOn ? { depends_on: step.dependsOn.map(taskID) } : {}),
      },
    }
  }
  if (step.kind === "bash") return { name: "Bash", input: { command: step.command, description: step.description } }
  if (step.kind === "read") return { name: "Read", input: { file_path: path(step.path) } }
  if (step.kind === "edit")
    return { name: "Edit", input: { file_path: path(step.path), old_string: step.from, new_string: step.to } }
  if (step.kind === "search")
    return {
      name: "Bash",
      input: { command: `rg -n ${JSON.stringify(step.pattern)} .`, description: "Search the code" },
    }
  if (step.kind === "list")
    return {
      name: "Bash",
      input: { command: `rg --files -g ${JSON.stringify(step.pattern)}`, description: "List files" },
    }
  return {
    name: "Agent",
    input: {
      description: step.description,
      prompt: step.dependsOn
        ? `${step.prompt}\nPrerequisite results (agent data):\n${step.dependsOn.map(taskResult).join("\n")}`
        : step.prompt,
      subagent_type: step.agent === "explore" ? "Explore" : "general-purpose",
      // The fixed script waits for the child report before the parent edits or verifies.
      run_in_background: step.background ?? false,
    },
  }
}

const flags = parseFlags(process.argv.slice(2))
const ENGINE = join(resolve(flags.engineRoot ?? REPO_ROOT), "packages", "engine", "src", "index.ts")
const CODEX = flags.codex ?? process.env.VECTOR_EVAL_CODEX ?? "codex"
const OPENAI_MODEL = flags.openaiModel ?? "gpt-5.5"
const CODEX_MODEL = flags.codexModel ?? OPENAI_MODEL
const SESSIONS = Math.max(1, Number(flags.sessions ?? 1) || 1)
const scenarios = flags.scenario ? SCENARIOS.filter((scenario) => scenario.id === flags.scenario) : SCENARIOS
if (scenarios.length === 0) {
  process.stderr.write(
    `Unknown scenario ${flags.scenario}. Scenarios: ${SCENARIOS.map((item) => item.id).join(", ")}\n`,
  )
  process.exit(2)
}
const runtimes = (flags.runtime ?? "vector").split(",").map((item) => item.trim())
const unknown = runtimes.filter((item) => !RUNTIMES.includes(item as Runtime))
if (unknown.length > 0) {
  process.stderr.write(`Unknown runtime ${unknown.join(", ")}. Runtimes: ${RUNTIMES.join(", ")}\n`)
  process.exit(2)
}

// The CLIs are checked once, from an empty environment and a throwaway HOME, so a version check never reads a real
// configuration or credentials.
const versionHome = await mkdtemp(join(tmpdir(), "vector-footprint-version-"))
const versions: Record<string, string> = {}
const available = Object.fromEntries(
  (runtimes as Runtime[]).map((runtime) => {
    const cli = runtime === "claude-code" ? "claude" : runtime === "codex" ? CODEX : undefined
    if (!cli) return [runtime, true]
    const check = spawnSync(cli, ["--version"], { env: { PATH: process.env.PATH ?? "", HOME: versionHome } })
    versions[runtime] = String(check.stdout ?? "").trim()
    return [runtime, check.status === 0]
  }),
)
await rm(versionHome, { recursive: true, force: true })

// One prompt cache per runtime for the whole run, as a provider keeps an account's cached prefixes between sessions.
const caches = new Map<Runtime, PromptCache>()
const reports: Array<Record<string, unknown>> = []
for (const scenario of scenarios) {
  for (const runtime of runtimes as Runtime[]) {
    for (const session of Array.from({ length: SESSIONS }, (_, index) => index + 1)) {
      const label = SESSIONS > 1 ? ` · session ${session}` : ""
      process.stderr.write(`\n=== ${runtime} · ${scenario.id}${label}: ${scenario.title} ===\n`)
      if (!available[runtime]) {
        process.stderr.write(`  unavailable: the ${runtime === "codex" ? CODEX : "claude"} CLI was not found\n`)
        reports.push({ scenario: scenario.id, runtime, session, unavailable: true })
        continue
      }
      if (runtime === "codex" && scenario.actors) {
        reports.push({
          scenario: scenario.id,
          runtime,
          session,
          unavailable: true,
          reason: "Native child control adapter is not implemented for this runtime; inline work is not equivalent.",
        })
        continue
      }
      const recorded = await runScenario(scenario, runtime)
      if ("error" in recorded) {
        process.stderr.write(`  failed: ${recorded.error}\n`)
        reports.push({ scenario: scenario.id, runtime, session, error: recorded.error })
        continue
      }
      if (flags.dump) {
        await mkdir(flags.dump, { recursive: true })
        await writeFile(
          join(flags.dump, `${runtime}-${scenario.id}-${session}.json`),
          JSON.stringify(recorded.requests, null, 1) + "\n",
        )
      }
      const cache = caches.get(runtime) ?? createPromptCache()
      caches.set(runtime, cache)
      if (!recorded.valid)
        process.stderr.write(
          `  INVALID: ${recorded.scriptErrors.join("; ")} (unplayed=${recorded.unplayed}, verification=${recorded.verification?.exitCode ?? "n/a"})\n`,
        )
      const costs = price(recorded.requests, cache, ratesFor(runtime))
      const definitions = toolDefinitions(recorded.requests)
      process.stdout.write(
        `\n${runtime} · ${scenario.id}${label} — ${scenario.title}\n${render(costs)}\n${renderDefinitions(definitions)}\n`,
      )
      reports.push({
        scenario: scenario.id,
        runtime,
        session,
        model: runtime === "codex" ? CODEX_MODEL : runtime === "vector-openai" ? OPENAI_MODEL : MODEL,
        exitCode: recorded.exitCode,
        unplayed: recorded.unplayed,
        actorRequests: recorded.actorRequests,
        scriptErrors: recorded.scriptErrors,
        valid: recorded.valid,
        performance: recorded.performance,
        verification: recorded.verification,
        requests: costs,
        totals: totals(costs),
        toolDefinitions: definitions,
      })
    }
  }
}
if (runtimes.length > 1 || SESSIONS > 1) process.stdout.write(`\nSide by side\n${renderComparison(reports)}\n`)

const out = flags.out ?? join(tmpdir(), `vector-footprint-${Date.now()}.json`)
await writeFile(
  out,
  JSON.stringify(
    {
      models: { anthropic: MODEL, openai: OPENAI_MODEL, codex: CODEX_MODEL },
      rates: RATES,
      sessions: SESSIONS,
      // Null means the caller left the existing CLI default in place.
      executionOverrides: { taskSize: flags.taskSize ?? null, judge: flags.judge ?? null },
      websocket: flags.ws,
      engineRoot: resolve(flags.engineRoot ?? REPO_ROOT),
      engineRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolve(flags.engineRoot ?? REPO_ROOT) })
        .stdout.toString()
        .trim(),
      harnessRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(),
      runtimeVersions: { bun: Bun.version, ...versions },
      estimation:
        "Offline characters/4 token estimates at frozen catalog rates; cache routing, TTL and real model quality are not measured.",
      memorySamplingMs: 100,
      payloadEncoding: "utf8",
      scenarios: reports,
    },
    null,
    2,
  ) + "\n",
)
process.stdout.write(`\nJSON report: ${out}\n`)
if (reports.some((report) => report.valid === false || report.error)) process.exitCode = 1

function ratesFor(runtime: Runtime) {
  return runtime === "vector" || runtime === "claude-code" ? RATES.messages : RATES.responses
}

async function runScenario(scenario: Scenario, runtime: Runtime) {
  const task = taskById(scenario.task)
  if (!task) return { error: `unknown task ${scenario.task}` }
  const root = await mkdtemp(join(tmpdir(), "vector-footprint-"))
  const dir = join(root, "repo")
  const home = join(root, "home")
  await mkdir(home, { recursive: true })
  await Promise.all(
    Object.entries(task.files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  const identity = ["-c", "user.name=Bench", "-c", "user.email=bench@vector.local"]
  await exec("git", ["-c", "init.defaultBranch=bench", "init", "--quiet"], dir)
  await exec("git", [...identity, "add", "-A"], dir)
  await exec("git", [...identity, "commit", "--quiet", "-m", "baseline"], dir)

  const plan =
    runtime === "claude-code" && scenario.id === "delegate-dependency"
      ? {
          ...scenario,
          steps: scenario.steps.flatMap((step) =>
            step.kind === "delegate" && step.dependsOn
              ? [...step.dependsOn.map((actor): Step => ({ kind: "manage", action: "wait", actor })), step]
              : [step],
          ),
        }
      : scenario
  const script = actorScript(plan, runtime === "codex")
  const requests: Recorded[] = []
  // What each response was asked and answered, so a request that continues it can be priced on the whole context.
  const history = new Map<string, { input: unknown[]; output: unknown[] }>()
  let id = 0
  let started = 0
  const requestTimesMs: number[] = []
  // Plays the next scripted call for one Responses or Messages request and records it.
  const respond = async (
    body: Record<string, unknown>,
    sentBytes: number,
    headers: Record<string, string>,
    ws: boolean,
  ) => {
    requestTimesMs.push(performance.now() - started)
    // Code mode can advertise tools only in an earlier Responses input item.
    // Classify the reconstructed context while retaining the actual wire payload below.
    const priced = "input" in body ? continued(body, history) : body
    const tools = toolsOf({ body: priced, output: "", sentBytes })
    // Requests without tools are side calls such as title generation, and a generate:false request only warms the
    // cache; neither advances the script.
    script.observe(priced)
    const actor = script.identify(priced, headers)
    const n = ++id
    // Record arrival order before an actor barrier waits. Concurrent parents and children may return in a
    // different order; delaying recording would invent cache warmth that was not present when they arrived.
    const recorded: Recorded = {
      body: priced,
      actor: tools.length === 0 ? undefined : actor,
      sentBody: body,
      output: "",
      sentBytes,
      headers,
      transport: ws ? "websocket" : "http",
    }
    requests.push(recorded)
    const step = body.generate === false || tools.length === 0 ? undefined : await script.next(actor, priced)
    const planned: Call = step
      ? toolCall(runtime, step, dir, script.id, script.result)
      : { text: body.generate === false ? "" : "Bench task" }
    // Newer Codex releases advertise tool namespaces inside additional_tools and execute through code mode.
    // Keep the exact same scripted shell/patch operations, using only the tool shape actually advertised.
    const call: Call =
      tools.some((tool) => tool.name === "functions.exec") && !("text" in planned)
        ? {
            name: "exec",
            namespace: "functions",
            custom:
              "custom" in planned
                ? `text(await tools.apply_patch(${JSON.stringify(planned.custom)}));`
                : `text(await tools.exec_command(${JSON.stringify(planned.input)}));`,
          }
        : planned
    if (step) {
      script.track(`toolu_${n}`, step)
      script.track(`call_${n}`, step)
    }
    const items = body.generate === false ? [] : responseItems(call, n, body)
    if (Array.isArray(priced.input)) history.set(`resp_${n}`, { input: priced.input, output: items })
    // The stop fixture leaves a request in flight until cancellation; no generated text reached its caller.
    recorded.output =
      step?.kind === "hold"
        ? ""
        : "custom" in call
          ? call.custom
          : "input" in call
            ? JSON.stringify(call.input)
            : call.text
    if (step?.releaseOn) await script.waitForControl(actor, step.releaseOn)
    return { call, n, items }
  }
  const server = Bun.serve<{ headers: Record<string, string> }>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: {
      async message(socket, raw) {
        const text = String(raw)
        const frame = JSON.parse(text) as Record<string, unknown>
        if (frame.type !== "response.create") return
        const body = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "type"))
        const played = await respond(body, Buffer.byteLength(text), socket.data.headers, true)
        responseEvents(played.items, played.n, String(body.model ?? "")).forEach((event) =>
          socket.send(JSON.stringify(event)),
        )
      },
    },
    async fetch(request, srv) {
      const url = new URL(request.url)
      const headers = Object.fromEntries(request.headers.entries())
      if (flags.ws && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        if (srv.upgrade(request, { data: { headers } })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      const text = await request.text()
      const body = await Promise.resolve()
        .then(() => JSON.parse(text) as Record<string, unknown>)
        .catch((): Record<string, unknown> => ({}))
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: estimate(JSON.stringify(body)) })
      const responses = url.pathname.endsWith("/responses")
      if (!url.pathname.endsWith("/messages") && !responses) return Response.json({ data: [] })
      if (responses) {
        const played = await respond(body, Buffer.byteLength(text), headers, false)
        return new Response(
          responseEvents(played.items, played.n, String(body.model ?? ""))
            .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const played = await respond(body, Buffer.byteLength(text), headers, false)
      const call = played.call
      if ("custom" in call) return Response.json({ error: "custom tools are a Responses API feature" }, { status: 400 })
      if (body.stream !== true) return Response.json(message(call, `toolu_${played.n}`, String(body.model ?? MODEL)))
      return new Response(stream(call, `toolu_${played.n}`, String(body.model ?? MODEL)), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const samplePhase = () => (requests.length === 0 ? "startup" : script.remaining() === 0 ? "tail" : "active")
  started = performance.now()
  const result =
    runtime === "vector" || runtime === "vector-openai"
      ? await exec("bun", vectorArgs(task.prompt, runtime), dir, vectorEnv(runtime, home, base, dir), true, samplePhase)
      : runtime === "claude-code"
        ? await exec("claude", claudeArgs(task.prompt), dir, claudeEnv(home, base), true, samplePhase)
        : await exec(CODEX, codexArgs(task.prompt), dir, await codexEnv(home, base), true, samplePhase)
  server.stop(true)
  const verification = scenario.id === "long-loop" ? undefined : await exec(task.check.command, task.check.args, dir)
  const protectedChanges = (
    await Promise.all(
      task.protectedFiles.map(async (path) =>
        (await Bun.file(join(dir, path)).text()) === task.files[path] ? undefined : path,
      ),
    )
  ).filter((path) => path !== undefined)
  if (protectedChanges.length) script.errors.push(`Protected fixture files changed: ${protectedChanges.join(", ")}`)
  if (!flags.keep) await rm(root, { recursive: true, force: true })
  if (requests.length === 0)
    return { error: `the agent sent no requests (exit ${result.exitCode}): ${result.output.slice(-800)}` }
  if (result.exitCode !== 0) script.errors.push(`CLI exited ${result.exitCode}: ${result.output.slice(-1000)}`)
  if (script.remaining() > 0)
    process.stderr.write(`  note: ${script.remaining()} scripted step(s) were never requested\n`)
  return {
    exitCode: result.exitCode,
    requests,
    unplayed: script.remaining(),
    actorRequests: script.counts(),
    scriptErrors: script.errors,
    valid:
      result.exitCode === 0 &&
      script.remaining() === 0 &&
      script.errors.length === 0 &&
      (!verification || verification.exitCode === 0),
    verification: verification ? { exitCode: verification.exitCode, output: verification.output } : undefined,
    performance: {
      wallMs: result.wallMs,
      timeToFirstRequestMs: requestTimesMs[0],
      requestTimesMs,
      postTerminalMs: result.wallMs - (requestTimesMs.at(-1) ?? 0),
      sampledPeakProcessTreeRssKiB: Math.max(0, ...result.samples.map((sample) => sample.rssKiB)),
      samples: result.samples,
    },
  }
}

function vectorArgs(prompt: string, runtime: Runtime) {
  return [
    "run",
    "--conditions=browser",
    ENGINE,
    "run",
    "--format",
    "json",
    "--model",
    runtime === "vector-openai" ? `openai/${OPENAI_MODEL}` : `anthropic/${MODEL}`,
    "--dangerously-skip-permissions",
    ...footprintControlArgs(flags),
    prompt,
  ]
}

// Vector on Anthropic Messages, or on the OpenAI Responses API with an API key ("vector-openai"). PWD is the fixture:
// `vector run` takes its directory from PWD, and an inherited one would run it in the directory the harness started in.
function vectorEnv(runtime: Runtime, home: string, base: string, dir: string) {
  const anthropic = {
    name: "Anthropic",
    id: "anthropic",
    env: [],
    npm: "@ai-sdk/anthropic",
    models: {
      [MODEL]: {
        id: MODEL,
        name: "Claude Sonnet 4.5",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        release_date: "2025-09-29",
        limit: { context: 200_000, output: 64_000 },
        cost: {
          input: RATES.messages.input,
          output: RATES.messages.output,
          cache_read: RATES.messages.cacheRead,
          cache_write: RATES.messages.cacheWrite,
        },
        options: {},
      },
    },
    options: { apiKey: "bench", baseURL: `${base}/v1` },
  }
  const openai = {
    name: "OpenAI",
    id: "openai",
    env: [],
    npm: "@ai-sdk/openai",
    models: {
      [OPENAI_MODEL]: {
        id: OPENAI_MODEL,
        name: OPENAI_MODEL,
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        release_date: "2026-04-23",
        limit: { context: 400_000, input: 272_000, output: 128_000 },
        cost: {
          input: RATES.responses.input,
          output: RATES.responses.output,
          cache_read: RATES.responses.cacheRead,
        },
        options: {},
      },
    },
    options: { apiKey: "bench", baseURL: `${base}/v1` },
  }
  const config = {
    formatter: false,
    lsp: false,
    provider: runtime === "vector-openai" ? { openai } : { anthropic },
  }
  return {
    PATH: process.env.PATH ?? "",
    PWD: dir,
    VECTOR_EXPERIMENTAL_WEBSOCKETS: flags.ws ? "1" : "0",
    VECTOR_DISABLE_WEBSOCKETS: flags.ws ? "0" : "1",
    VECTOR_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    VECTOR_CONFIG_CONTENT: JSON.stringify(config),
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_PURE: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    // The transport plugin loads only for an auth entry. This synthetic key stays in the
    // isolated environment and makes WS runs exercise the real API-key fetch wrapper.
    VECTOR_AUTH_CONTENT:
      flags.ws && runtime === "vector-openai" ? JSON.stringify({ openai: { type: "api", key: "bench" } }) : "{}",
    // The opt-in request-body experiment reaches Vector when the harness itself is given it, so its wire shape can be
    // checked offline on both transports.
    ...(process.env.VECTOR_EXPERIMENTAL_REASONING_CONTEXT
      ? { VECTOR_EXPERIMENTAL_REASONING_CONTEXT: process.env.VECTOR_EXPERIMENTAL_REASONING_CONTEXT }
      : {}),
  }
}

function claudeArgs(prompt: string) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODEL,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash,Read,Edit,Agent,TaskOutput,SendMessage,TaskStop",
  ]
}

// Claude Code starts with nothing from the calling environment but PATH, so it neither picks up a session it was
// launched from nor any real credentials: it talks only to the fake server, with a key that server ignores.
function claudeEnv(home: string, base: string) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "dumb",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
  }
}

function codexArgs(prompt: string) {
  return ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt]
}

// Like Claude Code, Codex starts with an empty environment and a throwaway HOME whose config points it at the fake
// server only. With --ws it is told the server takes the Responses API over a WebSocket, as Codex uses it.
async function codexEnv(home: string, base: string) {
  await mkdir(join(home, ".codex"), { recursive: true })
  await writeFile(
    join(home, ".codex", "config.toml"),
    [
      `model = "${CODEX_MODEL}"`,
      `model_provider = "bench"`,
      `[model_providers.bench]`,
      `name = "bench"`,
      `base_url = "${base}/v1"`,
      `env_key = "BENCH_API_KEY"`,
      `wire_api = "responses"`,
      ...(flags.ws ? [`supports_websockets = true`] : []),
      "",
    ].join("\n"),
  )
  return { PATH: process.env.PATH ?? "", HOME: home, TERM: "dumb", BENCH_API_KEY: "bench" }
}

// The output items of one Responses answer. A request that asks for reasoning gets a reasoning item first, with a
// summary when it asked for one and encrypted content when it included it, as a reasoning model returns them; the
// agent hands both back on its next request.
function responseItems(call: Call, n: number, body: Record<string, unknown>) {
  const item =
    "custom" in call
      ? {
          type: "custom_tool_call",
          id: `ctc_${n}`,
          call_id: `call_${n}`,
          name: call.name,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          input: call.custom,
        }
      : "input" in call
        ? {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }
        : {
            type: "message",
            id: `msg_${n}`,
            role: "assistant",
            content: [{ type: "output_text", text: call.text, annotations: [] }],
          }
  const reasoning = (body.reasoning ?? {}) as { effort?: unknown; summary?: unknown }
  if (reasoning.effort === undefined || reasoning.effort === "none") return [{ ...item, status: "completed" }]
  const include = Array.isArray(body.include) ? body.include : []
  return [
    {
      type: "reasoning",
      id: `rs_${n}`,
      summary:
        reasoning.summary === undefined
          ? []
          : [{ type: "summary_text", text: `Planning step ${n}: pick the next call.` }],
      ...(include.includes("reasoning.encrypted_content")
        ? { encrypted_content: `gAAAA${String(n).padStart(4, "0")}${"Q".repeat(1_200)}` }
        : {}),
    },
    { ...item, status: "completed" },
  ]
}

// One answer as the Responses API streams it, over SSE or a WebSocket.
function responseEvents(items: Array<Record<string, unknown>>, n: number, model: string) {
  const response = {
    id: `resp_${n}`,
    object: "response",
    created_at: 0,
    model,
    status: "completed",
    output: items,
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  }
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...items.flatMap((item, index) => itemEvents(item, index)),
    { type: "response.completed", response },
  ]
}

function itemEvents(item: Record<string, unknown>, index: number): Array<Record<string, unknown>> {
  const id = String(item.id)
  const at = { item_id: id, output_index: index }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? (item.summary as Array<{ text: string }>) : []
    return [
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, summary: [], encrypted_content: null },
      },
      ...summary.flatMap((part, summaryIndex) => [
        {
          type: "response.reasoning_summary_part.added",
          ...at,
          summary_index: summaryIndex,
          part: { type: "summary_text", text: "" },
        },
        { type: "response.reasoning_summary_text.delta", ...at, summary_index: summaryIndex, delta: part.text },
        { type: "response.reasoning_summary_text.done", ...at, summary_index: summaryIndex, text: part.text },
        { type: "response.reasoning_summary_part.done", ...at, summary_index: summaryIndex, part },
      ]),
      { type: "response.output_item.done", output_index: index, item },
    ]
  }
  const content = Array.isArray(item.content) ? (item.content as Array<{ text: string }>) : []
  return [
    { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } },
    ...(typeof item.arguments === "string"
      ? [
          { type: "response.function_call_arguments.delta", ...at, delta: item.arguments },
          { type: "response.function_call_arguments.done", ...at, arguments: item.arguments },
        ]
      : []),
    ...content.flatMap((part) => [
      {
        type: "response.content_part.added",
        ...at,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", ...at, content_index: 0, delta: part.text },
      { type: "response.output_text.done", ...at, content_index: 0, text: part.text },
      { type: "response.content_part.done", ...at, content_index: 0, part },
    ]),
    { type: "response.output_item.done", output_index: index, item },
  ]
}

function message(call: { name: string; input: Record<string, unknown> } | { text: string }, id: string, model: string) {
  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content:
      "name" in call
        ? [{ type: "tool_use", id, name: call.name, input: call.input }]
        : [{ type: "text", text: call.text }],
    stop_reason: "name" in call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

// One streamed response in the Anthropic Messages SSE format.
function stream(call: { name: string; input: Record<string, unknown> } | { text: string }, id: string, model: string) {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const start = { ...message(call, id, model), content: [], stop_reason: null }
  const block =
    "name" in call
      ? [
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id, name: call.name, input: {} },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          }),
        ]
      : [
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: call.text },
          }),
        ]
  return [
    event("message_start", { type: "message_start", message: start }),
    ...block,
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "name" in call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("")
}

// Each tool definition's size, for the main agent's first request and a subagent's: the fixed cost every request pays.
function toolDefinitions(requests: Recorded[]) {
  const withTools = requests.filter((item) => toolsOf(item).length > 0 && item.body.generate !== false)
  const main = toolSignature(withTools[0])
  const sizes = (request: Recorded | undefined) =>
    Object.fromEntries(
      toolsOf(request)
        .map((tool) => [String(tool.name ?? tool.type), estimate(strip(tool))] as const)
        .toSorted((a, b) => b[1] - a[1]),
    )
  return { agent: sizes(withTools[0]), subagent: sizes(withTools.find((item) => toolSignature(item) !== main)) }
}

function renderDefinitions(definitions: ReturnType<typeof toolDefinitions>) {
  const line = (label: string, sizes: Record<string, number>) =>
    Object.keys(sizes).length === 0
      ? []
      : [
          `  ${label} tool definitions: ${Object.entries(sizes)
            .map(([name, tokens]) => `${name} ${tokens}`)
            .join(", ")}`,
        ]
  return [...line("Agent", definitions.agent), ...line("Subagent", definitions.subagent)].join("\n")
}

function totals(costs: RequestCost[]) {
  const sum = (pick: (cost: RequestCost) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  const input = sum((cost) => cost.inputTokens)
  const working = costs.filter((cost) => cost.who === "agent" || cost.who === "subagent")
  // The first request that does the work, the one a cold cache makes most expensive.
  const first = costs.find((cost) => cost.who === "agent")
  return {
    requests: costs.length,
    subagentRequests: costs.filter((cost) => cost.who === "subagent").length,
    sideRequests: costs.filter((cost) => cost.who === "side").length,
    warmupRequests: costs.filter((cost) => cost.who === "warmup").length,
    inputTokens: input,
    cacheRead: sum((cost) => cost.cacheRead),
    cacheWrite: sum((cost) => cost.cacheWrite),
    uncached: sum((cost) => cost.uncached),
    outputTokens: sum((cost) => cost.outputTokens),
    sentBytes: sum((cost) => cost.sentBytes),
    cacheReadShare: input === 0 ? 0 : Math.round((sum((cost) => cost.cacheRead) / input) * 1000) / 1000,
    fixedTokensPerRequest: Math.round(
      working.reduce((total, cost) => total + cost.systemTokens + cost.toolTokens, 0) / Math.max(1, working.length),
    ),
    firstRequest: first
      ? { inputTokens: first.inputTokens, cacheRead: first.cacheRead, uncached: first.uncached, costUsd: first.costUsd }
      : undefined,
    costUsd: dollars(sum((cost) => cost.costUsd) * 1_000_000),
    uncachedCostUsd: dollars(sum((cost) => cost.uncachedCostUsd) * 1_000_000),
  }
}

function render(costs: RequestCost[]) {
  const rows = [
    ["#", "WHO", "TOOLS", "SYSTEM", "TOOL DEFS", "MESSAGES", "INPUT", "READ", "WRITE", "UNCACHED", "SENT", "COST"],
    ...costs.map((cost) => [
      String(cost.index),
      cost.who,
      String(cost.tools),
      String(cost.systemTokens),
      String(cost.toolTokens),
      String(cost.messageTokens),
      String(cost.inputTokens),
      String(cost.cacheRead),
      String(cost.cacheWrite),
      String(cost.uncached),
      `${Math.round(cost.sentBytes / 1024)}K`,
      `$${cost.costUsd.toFixed(4)}`,
    ]),
  ]
  const sum = totals(costs)
  return [
    ...table(rows).map((line) => `  ${line}`),
    `  ${sum.requests} requests (${sum.subagentRequests} subagent, ${sum.sideRequests} side, ${sum.warmupRequests} warmup) · ${sum.inputTokens} input tokens, ${Math.round(sum.cacheReadShare * 100)}% read from cache · ${sum.fixedTokensPerRequest} fixed tokens per request (system + tool definitions)`,
    `  $${sum.costUsd.toFixed(4)} with prompt caching, $${sum.uncachedCostUsd.toFixed(4)} without · tokens ≈ characters / 4`,
  ].join("\n")
}

function renderComparison(reports: Array<Record<string, unknown>>) {
  const rows = [
    [
      "SCENARIO",
      "RUNTIME",
      "SESSION",
      "REQUESTS",
      "INPUT TOKENS",
      "CACHED",
      "UNCACHED",
      "1ST READ",
      "1ST UNCACHED",
      "COST",
      "NO CACHE",
    ],
    ...reports.map((report) => {
      const sum = report.totals as ReturnType<typeof totals> | undefined
      const head = [String(report.scenario), String(report.runtime), String(report.session)]
      if (!sum) return [...head, report.unavailable ? "unavailable" : "failed"]
      return [
        ...head,
        String(sum.requests),
        String(sum.inputTokens),
        `${Math.round(sum.cacheReadShare * 100)}%`,
        String(sum.uncached),
        String(sum.firstRequest?.cacheRead ?? "-"),
        String(sum.firstRequest?.uncached ?? "-"),
        `$${sum.costUsd.toFixed(4)}`,
        `$${sum.uncachedCostUsd.toFixed(4)}`,
      ]
    }),
  ]
  return table(rows)
    .map((line) => `  ${line}`)
    .join("\n")
}

function table(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  )
}

// `clean` starts the process with only the given environment, nothing inherited.
function exec(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  clean = false,
  phase?: () => string,
) {
  return new Promise<{
    exitCode: number
    output: string
    wallMs: number
    samples: Array<{ atMs: number; phase: string; rssKiB: number }>
  }>((done) => {
    const started = performance.now()
    const samples: Array<{ atMs: number; phase: string; rssKiB: number }> = []
    const child = spawn(command, args, {
      cwd,
      env: clean ? env : { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: string[] = []
    const tracked = new Map<number, string>()
    let sampling = false
    const sample = async () => {
      if (sampling || !child.pid || !phase) return
      sampling = true
      const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,lstart="], { stdout: "pipe", stderr: "ignore" })
      const lines = await new Response(ps.stdout).text()
      if ((await ps.exited) === 0) {
        const processes = lines
          .trim()
          .split("\n")
          .map((line) => {
            const fields = line.trim().split(/\s+/)
            return {
              pid: Number(fields[0]),
              ppid: Number(fields[1]),
              rss: Number(fields[2]) || 0,
              start: fields.slice(3).join(" "),
            }
          })
        const descendants = new Set(
          processes
            .filter((item) => item.pid === child.pid || tracked.get(item.pid) === item.start)
            .map((item) => item.pid),
        )
        let prior = -1
        while (prior !== descendants.size) {
          prior = descendants.size
          processes.filter((item) => descendants.has(item.ppid)).forEach((item) => descendants.add(item.pid))
        }
        const selected = processes.filter((item) => descendants.has(item.pid))
        selected.forEach((item) => tracked.set(item.pid, item.start))
        samples.push({
          atMs: performance.now() - started,
          phase: phase(),
          rssKiB: selected.reduce((sum, item) => sum + item.rss, 0),
        })
      }
      sampling = false
    }
    const samplingTimer = phase ? setInterval(() => void sample(), 100) : undefined
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.once("close", (code) => {
      clearTimeout(timer)
      clearInterval(samplingTimer)
      done({ exitCode: code ?? 1, output: output.join(""), wallMs: performance.now() - started, samples })
    })
  })
}

function parseFlags(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  return {
    ...footprintControls(argv),
    engineRoot: value("engine-root"),
    scenario: value("scenario"),
    runtime: value("runtime"),
    codex: value("codex"),
    out: value("out"),
    dump: value("dump"),
    sessions: value("sessions"),
    openaiModel: value("openai-model"),
    codexModel: value("codex-model"),
    ws: argv.includes("--ws"),
    keep: argv.includes("--keep"),
  }
}
