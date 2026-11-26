import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import semver from "semver"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import {
  buildAgentsWorkflow,
  buildWorkflowYaml,
  CLI_PACKAGE,
  cliVersionSpec,
  type AgentsWorkflowOptions,
} from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { Connect } from "@vectordevai/schema/connect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { ConnectAdapters } from "@/connect/adapters"
import { ConnectGithubAgentAdapter } from "@/connect/adapters/github-agent"
import { ConnectHandsAdapter } from "@/connect/adapters/hands"
import { VectorScopeAdapter } from "@/connect/adapters/vectorscope"
import { ConnectHub } from "@/connect/hub"
import { ConnectMembers } from "@/connect/members"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Parameters } from "@/tool/connect"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// @vector on GitHub in connected tools (CW-22): listed by its own adapter from this repository's workflow file, with
// its CLI pin, and never handed work. The hub over that adapter alone, on temporary repositories: no network, no Git
// process of the adapter's and no model. The workflows are @vector's own builder's output, never copied text.

afterEach(disposeAllInstances)

// How often connect asked the adapter to describe itself in the current test.
const counted = { describes: 0 }

const factory = Effect.map(ConnectGithubAgentAdapter.factory, (adapter) => ({
  ...adapter,
  describe: () =>
    Effect.suspend(() => {
      counted.describes++
      return adapter.describe()
    }),
}))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LayerNode.make({ service: ConnectHub.Service, layer: ConnectHub.layerWith([factory]), deps: ConnectHub.DEPS }),
      Session.node,
      Permission.node,
      Agent.node,
      SpendGuard.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
      BackgroundJob.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true })]],
  ),
)

const MIN = GithubAgents.MIN_AGENTS_CLI
const NEWER = semver.inc(MIN, "minor") ?? MIN
const BELOW = `${MIN}-beta.1`

const CODIUM: AgentsWorkflowOptions = {
  mode: "codium",
  provider: "vector",
  model: "vector-plan",
  keys: [],
  autoReview: false,
  version: MIN,
}

const own = (version: string, prompt = "Summarise yesterday's pull requests.") =>
  buildAgentsWorkflow({
    mode: "own-key",
    provider: "openai",
    model: "gpt-4.1",
    keys: ["OPENAI_API_KEY"],
    autoReview: true,
    version,
    schedules: [{ id: "daily", cron: "0 3 * * *", prompt }],
  })

const installed = (version = MIN) => buildAgentsWorkflow({ ...CODIUM, version })
const LINE = `${CLI_PACKAGE}@${MIN}`
const repin = (content: string, spec: string) => content.replaceAll(LINE, spec)
// The header is the first line; only it holds the options' JSON.
const reheader = (content: string, version: string) => content.replace(`"version":"${MIN}"`, `"version":"${version}"`)

const base = {
  id: "github-agent",
  kind: "agent",
  title: "@vector on GitHub",
  summary: "Answers @vector on pull requests from your own GitHub Actions. Connect never posts to GitHub.",
  owner: "vector-at-mention",
  place: "your-cloud",
  reach: "none",
} as const

const ready = (version: string): Connect.Member[] => [
  {
    ...base,
    state: "ready",
    summary: `Answers @vector on pull requests from your own GitHub Actions. Pinned to ${version}. Connect never posts to GitHub.`,
  },
]
const unavailable = (reason: string): Connect.Member[] => [{ ...base, state: "unavailable", reason }]
const below = (version: string) => unavailable(`Pinned to ${version}; @vector needs Vector CLI ${MIN} or newer.`)
const UNPINNED = unavailable(".github/workflows/vector.yml does not pin a Vector CLI version.")
const UNREADABLE = unavailable("Connect could not read which Vector CLI version .github/workflows/vector.yml pins.")
const MISSING: Connect.Member[] = [
  { ...base, state: "not-installed", reason: "Not set up in this repository (.github/workflows/vector.yml)." },
]
const LINKED = unavailable("Connect reads .github/workflows/vector.yml only as a regular file, never through a link.")
const NOT_FILE = unavailable(".github/workflows/vector.yml is not a regular file.")

const row = (list: readonly Connect.Member[]) => list.filter((item) => item.id === ConnectGithubAgentAdapter.ID)

const clear = (directory: string) => fs.rm(path.join(directory, ".github"), { recursive: true, force: true })

async function write(directory: string, content: string | Uint8Array) {
  await clear(directory)
  await fs.mkdir(path.join(directory, ".github", "workflows"), { recursive: true })
  await fs.writeFile(path.join(directory, ".github", "workflows", "vector.yml"), content)
}

// Pads a pinned workflow with a YAML comment to exactly `bytes` bytes.
const padded = (bytes: number) => {
  const content = installed()
  return content + "#" + "x".repeat(bytes - Buffer.byteLength(content) - 2) + "\n"
}

// Writes each variant, lists the members and returns the GitHub agent's row, labelled for a readable failure.
const rows = (variants: Record<string, string | Uint8Array>) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const hub = yield* ConnectHub.Service
    const found: Record<string, readonly Connect.Member[]> = {}
    for (const [name, content] of Object.entries(variants)) {
      yield* Effect.promise(() => write(test.directory, content))
      found[name] = row(yield* hub.members())
    }
    return found
  })

const each = <T>(names: Record<string, unknown>, value: T) =>
  Object.fromEntries(Object.keys(names).map((name) => [name, value]))

describe("the member list", () => {
  it.instance(
    "installed and pinned reads ready, with its pin, from the installer's own files",
    () =>
      Effect.gen(function* () {
        const variants = {
          codium: installed(),
          "own key, newer": own(NEWER),
          // Owner text in a schedule prompt sits in the header and in env values, never on an install line.
          "own key, a prompt naming the CLI": own(
            MIN,
            `bump ${CLI_PACKAGE}@latest, then try ${CLI_PACKAGE}@1.0.0 and npm install -g ${CLI_PACKAGE}@latest`,
          ),
          // A header @vector's reader does not accept is ignored, as the desktop ignores it: the jobs decide.
          "unknown header option": installed().replace("# vector-workflow: {", '# vector-workflow: {"later":true,'),
          "broken header": installed().replace(/^# vector-workflow: .*$/m, "# vector-workflow: {broken}"),
          // Comments and other commands naming the CLI are ignored, as the desktop ignores them.
          "a comment naming the CLI": `${installed()}# npx ${CLI_PACKAGE}@latest\n`,
        }
        const found = yield* rows(variants)
        expect(found).toEqual({ ...each(variants, ready(MIN)), "own key, newer": ready(NEWER) })
        const hub = yield* ConnectHub.Service
        expect(row(yield* hub.members({ tools: ["read"] }))).toEqual(ready(MIN))
      }),
    { git: true },
  )

  it.instance(
    "a pin below the minimum reads unavailable with the lowest version",
    () =>
      Effect.gen(function* () {
        const rc = `${semver.inc(MIN, "patch")}-rc-1`
        // @vector's builder accepts this version, but its review job falls back to the release's pin
        // (core review/workflow.ts cliVersionSpec), so the jobs disagree. The lowest decides, as on the desktop.
        const fallback = cliVersionSpec(rc).spec
        // Today's fallback (release.vectorRequiredCliVersion) is below MIN, so the file reads below with it. When the
        // release fallback reaches MIN, this fails: update the case to the outcome the rule then gives.
        expect(semver.lt(fallback, MIN)).toBe(true)
        const found = yield* rows({
          "every job": repin(installed(), `${CLI_PACKAGE}@${BELOW}`),
          "the header only": reheader(installed(), BELOW),
          "one job": installed().replace(LINE, `${CLI_PACKAGE}@${BELOW}`),
          "the v2 workflow": buildWorkflowYaml({
            provider: "openai",
            model: "gpt-4.1",
            keys: ["OPENAI_API_KEY"],
            autoReview: false,
            version: "1.17.14",
          }),
          "a hyphenated prerelease": own(rc),
        })
        expect(found).toEqual({
          "every job": below(BELOW),
          "the header only": below(BELOW),
          "one job": below(BELOW),
          "the v2 workflow": below("1.17.14"),
          "a hyphenated prerelease": below(fallback),
        })
      }),
    { git: true },
  )

  it.instance(
    "an install line without an exact version reads unpinned",
    () =>
      Effect.gen(function* () {
        const variants = {
          latest: repin(installed(), `${CLI_PACKAGE}@latest`),
          "no version": repin(installed(), CLI_PACKAGE),
          "one job's range": installed().replace(LINE, `${CLI_PACKAGE}@^${MIN}`),
          "an expression": repin(installed(), `${CLI_PACKAGE}@\${{ vars.VECTOR_CLI }}`),
          "an over-long prerelease": repin(installed(), `${CLI_PACKAGE}@${MIN}-${"a".repeat(60)}`),
          "a hand-added block line": `${installed()}      - run: |\n          npm install -g ${CLI_PACKAGE}@latest\n`,
          "a hand-added step": `${installed()}      - run: npm install -g ${CLI_PACKAGE}\n`,
        }
        expect(yield* rows(variants)).toEqual(each(variants, UNPINNED))
      }),
    { git: true },
  )

  it.instance(
    "a missing workflow reads not installed",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hub = yield* ConnectHub.Service
        expect(row(yield* hub.members())).toEqual(MISSING)
        yield* Effect.promise(() => fs.mkdir(path.join(test.directory, ".github", "workflows"), { recursive: true }))
        expect(row(yield* hub.members())).toEqual(MISSING)
        yield* Effect.promise(() => clear(test.directory))
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, ".github"), "not a folder"))
        expect(row(yield* hub.members())).toEqual(MISSING)
      }),
    { git: true },
  )

  it.instance(
    "a workflow whose pin cannot be read reads unavailable",
    () =>
      Effect.gen(function* () {
        const variants = {
          "header version not a version": reheader(installed(), "local"),
          "header newer than the jobs": reheader(installed(), NEWER),
          "no install line": "name: vector\non: push\n",
          // The installer never folds (lineWidth 0); a hand-folded install line is not read, so it never reads ready.
          "every install line folded": installed().replaceAll(
            `npm install -g ${CLI_PACKAGE}@`,
            `npm install -g\n            ${CLI_PACKAGE}@`,
          ),
          empty: "",
          binary: new Uint8Array([0, 159, 146, 150, 255, 0, 10]),
        }
        expect(yield* rows(variants)).toEqual(each(variants, UNREADABLE))
      }),
    { git: true },
  )

  it.instance(
    "connect reads at most 1 MiB",
    () =>
      Effect.gen(function* () {
        expect(
          yield* rows({
            limit: padded(ConnectGithubAgentAdapter.MAX_BYTES),
            over: padded(ConnectGithubAgentAdapter.MAX_BYTES + 1),
          }),
        ).toEqual({
          limit: ready(MIN),
          over: unavailable(".github/workflows/vector.yml is larger than the 1 MiB connect reads."),
        })
      }),
    { git: true },
  )

  const linking = process.platform === "win32" ? it.instance.skip : it.instance
  linking(
    "a link anywhere on the path is refused, never followed",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hub = yield* ConnectHub.Service
        const github = path.join(test.directory, ".github")
        const workflows = path.join(github, "workflows")
        const file = path.join(workflows, "vector.yml")
        // A real pinned workflow elsewhere in the repository, which every link below points at or through.
        const real = path.join(test.directory, "real")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(real, "workflows"), { recursive: true })
          await fs.writeFile(path.join(real, "workflows", "vector.yml"), installed())
          await fs.writeFile(path.join(real, "vector.yml"), installed())
        })
        const found: Record<string, readonly Connect.Member[]> = {}
        const linked = (name: string, setup: () => Promise<void>) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await clear(test.directory)
              await setup()
            })
            found[name] = row(yield* hub.members())
          })
        yield* linked("the file", async () => {
          await fs.mkdir(workflows, { recursive: true })
          await fs.symlink(path.join(real, "vector.yml"), file)
        })
        yield* linked("a dangling file", async () => {
          await fs.mkdir(workflows, { recursive: true })
          await fs.symlink(path.join(real, "gone.yml"), file)
        })
        yield* linked("the workflows folder", async () => {
          await fs.mkdir(github, { recursive: true })
          await fs.symlink(path.join(real, "workflows"), workflows, "dir")
        })
        yield* linked("the .github folder", async () => {
          await fs.symlink(real, github, "dir")
        })
        expect(found).toEqual({
          "the file": LINKED,
          "a dangling file": LINKED,
          "the workflows folder": LINKED,
          "the .github folder": LINKED,
        })
      }),
    { git: true },
  )

  it.instance(
    "a workflow that is not a regular file reads unavailable, and a FIFO never blocks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hub = yield* ConnectHub.Service
        const file = path.join(test.directory, ".github", "workflows", "vector.yml")
        yield* Effect.promise(() => fs.mkdir(file, { recursive: true }))
        expect(row(yield* hub.members())).toEqual(NOT_FILE)
        if (process.platform !== "linux") return
        yield* Effect.promise(() => fs.rmdir(file))
        expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0)
        expect(row(yield* hub.members().pipe(Effect.timeout("2 seconds")))).toEqual(NOT_FILE)
      }),
    { git: true },
  )

  it.instance(
    "outside Git nothing is read, so it reads not installed",
    () =>
      Effect.gen(function* () {
        const hub = yield* ConnectHub.Service
        expect(row(yield* hub.members())).toEqual(MISSING)
      }),
    { init: (directory) => Effect.promise(() => write(directory, installed())) },
  )

  it.instance(
    "Vector Local turns a ready GitHub agent off; one below the minimum stays unavailable",
    () =>
      Effect.gen(function* () {
        const found = yield* rows({ ready: installed(), below: installed().replace(LINE, `${CLI_PACKAGE}@${BELOW}`) })
        const local = (members: readonly Connect.Member[]) =>
          row(
            ConnectMembers.compose({ adapters: members, agents: [], skills: [], workflows: [], mcp: {}, local: true }),
          )
        expect(local(found.ready ?? [])).toEqual([
          {
            ...ready(MIN)[0],
            state: "off",
            reason: "Off in Vector Local: it runs in your own cloud accounts, not on this computer.",
          },
        ])
        expect(local(found.below ?? [])).toEqual(below(BELOW))
      }),
    { git: true },
  )

  it.effect("the engine's hub builds it last, with no services, no handle and no action", () =>
    Effect.gen(function* () {
      const adapter = yield* ConnectGithubAgentAdapter.factory
      expect([adapter.id, adapter.owner, adapter.handle]).toEqual(["github-agent", "vector-at-mention", undefined])
      const scope = ConnectAdapters.ADAPTERS.indexOf(VectorScopeAdapter.factory)
      const hands = ConnectAdapters.ADAPTERS.indexOf(ConnectHandsAdapter.factory)
      expect(scope).toBeGreaterThanOrEqual(0)
      expect(hands).toBeGreaterThan(scope)
      expect(ConnectAdapters.ADAPTERS.indexOf(ConnectGithubAgentAdapter.factory)).toBeGreaterThan(hands)
      expect([...ConnectAdapters.DEPS]).toEqual([...VectorScopeAdapter.DEPS, ...ConnectHandsAdapter.DEPS])
      // The model's connect tool and helper handles cannot name it either.
      expect(Option.isNone(Schema.decodeUnknownOption(Parameters)({ action: "review", to: "github-agent" }))).toBe(true)
      expect(ConnectHub.HELPER_MEMBERS.has("github-agent")).toBe(false)
      expect(ConnectHub.HELPER_AGENTS["github-agent"]).toBeUndefined()
    }),
  )
})

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

// ctx.ask as tool calls get it, recording each question.
function asker() {
  const asks: unknown[] = []
  const ask: Tool.Context["ask"] = (request) => Effect.sync(() => void asks.push(request))
  return { asks, ask }
}

// Prompt calls as a tool call lends them; connect must never prompt anything for the GitHub agent.
function recorder() {
  const prompts: SessionID[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.suspend(() => {
        prompts.push(input.sessionID)
        return Effect.die(new Error("connect prompted a session for the GitHub agent"))
      }),
  }
  return { ops, prompts }
}

const say = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
  })

describe("hand-offs to the GitHub agent", () => {
  it.instance(
    "connect hands nothing to @vector on GitHub, whoever asks, and never reads its workflow for it",
    () =>
      Effect.gen(function* () {
        counted.describes = 0
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const hub = yield* ConnectHub.Service
        const jobs = yield* BackgroundJob.Service
        const requester = yield* sessions.create({ title: "Requester" })
        yield* say(requester.id, "ask @vector to fix it")
        const actions = {
          review: { action: "review", target: { kind: "uncommitted" } },
          fix: { action: "fix", run: "cr_missing", findings: ["f1"], mode: "here" },
        }
        for (const [name, action] of Object.entries(actions)) {
          const { asks, ask } = asker()
          const { ops, prompts } = recorder()
          const request = { to: "github-agent", directory: test.directory, background: false, ...action }
          const agent = { kind: "agent", sessionID: requester.id, agent: "build" }
          const requesters: Record<string, ConnectHub.StartInput> = {
            agent: { request: { ...request, requester: agent } as ConnectHub.StartRequest, call: { ask } },
            user: {
              request: { ...request, requester: { kind: "user", sessionID: requester.id } } as ConnectHub.StartRequest,
              call: { ask },
            },
            workflow: {
              request: {
                ...request,
                requester: { kind: "workflow", sessionID: requester.id },
              } as ConnectHub.StartRequest,
              call: { ask },
            },
            background: {
              request: { ...request, requester: agent, background: true } as ConnectHub.StartRequest,
              call: { ask, promptOps: ops },
            },
            "after-run": {
              request: { ...request, requester: agent } as ConnectHub.StartRequest,
              call: { ask, promptOps: ops, unattended: true, afterRunCurrent: Effect.succeed(true) },
            },
          }
          for (const [who, input] of Object.entries(requesters)) {
            const run = yield* hub.run(input)
            expect([name, who, run.result?.state, run.result?.refusal]).toEqual([name, who, "refused", "unknown"])
            expect(run.result?.summary).toBe("github-agent is only listed; connect cannot hand work to it.")
            expect(run.result?.sessions).toEqual([])
          }
          expect(asks).toEqual([])
          expect(prompts).toEqual([])
        }
        expect((yield* jobs.list()).filter((job) => job.type === ConnectHub.JOB_TYPE)).toEqual([])
        expect(yield* hub.runs({ sessionID: requester.id })).toEqual([])
        // Refused before the member was described: the workflow file was never read for a hand-off.
        expect(counted.describes).toBe(0)
        expect(yield* sessions.children(requester.id)).toEqual([])
        // The listed row has no actions to start.
        const listed = row(yield* hub.members())
        expect(listed).toHaveLength(1)
        expect(listed[0]?.actions).toBeUndefined()
      }),
    { git: true, init: (directory) => Effect.promise(() => write(directory, installed())) },
  )
})
