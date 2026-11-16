// V18b: the agent phase with the process's own credential holder loaded from an own-key channel, as index.ts loads it
// before the account gate. The holder lives as long as its process, so the lane, which runs every engine GitHub file in
// one process, runs each case here in a fresh `bun test` child of this file; each child keeps the engine preload and its
// strict network guard. A child loads the holder from a channel line with an environment object of its own, so
// process.env is never changed, and runs with GITHUB_ACTIONS=false, so the Actions child filter is off and only the
// loader can keep a credential out of a tool's environment. The parent spawns Bun, so it runs in the lane; a child runs
// locally by itself with VECTOR_TEST_GITHUB_AGENT_CHANNEL set.

import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { githubAgentPhase } from "../../src/cli/cmd/github.agent"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { Env } from "../../src/env"
import { Provider } from "../../src/provider/provider"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { Session } from "../../src/session/session"
import { runtime, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { CHANNEL, RUN_ID, VALUES, cleanup, commitSetup, eventFile, fakeGithub, stepEnv } from "./github.agent-fixture"

const cases = ["environment", "codium-config"] as const
const mode = cases.find((value) => value === process.env.VECTOR_TEST_GITHUB_AGENT_CHANNEL)
const privateNames = ["GITHUB_TOKEN", "GH_TOKEN", "VECTOR_CLI_TOKEN", "VECTOR_RUN_TOKEN", ...Object.keys(CHANNEL.keys)]

if (!mode) {
  for (const value of cases) {
    test(`the agent phase with the process's channel holder: ${value}`, async () => {
      const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !privateNames.includes(name))),
          VECTOR_TEST_GITHUB_AGENT_CHANNEL: value,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 28_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, `${stdout}\n${stderr}`).toBe(0)
        expect(stderr).toContain("1 pass")
        expect(stderr).toContain("0 fail")
      } finally {
        clearTimeout(timer)
        child.kill("SIGKILL")
        await child.exited
      }
    }, 30_000)
  }
} else {
  const guard = NetworkGuard.use()
  const web = FakeWeb.start({ sites: {} })
  // A Codium catalog that lists a model, so only the provider layer's own-key rule keeps it out; its chat transport
  // records every request.
  const plans = { reads: [] as (string | undefined)[], chats: [] as string[] }
  const it = runtime(web, {
    replacements: [
      [
        ModelPlans.node,
        Layer.succeed(ModelPlans.Service, {
          catalog: (token) =>
            Effect.sync(() => {
              plans.reads.push(token)
              return {
                enabled: true,
                models: [{ id: "codium-x", name: "Codium X", contextLength: 100_000, maxOutputTokens: 8_000 }],
              }
            }),
          request: async (url) => {
            plans.chats.push(url)
            return Response.json({ error: { code: "MODEL_PLANS_DISABLED", message: "off" } }, { status: 400 })
          },
        }),
      ],
    ],
  })
  afterAll(async () => {
    await web.close()
    await cleanup()
  })

  beforeAll(async () => {
    // Names only: a failure must never print a value.
    expect(privateNames.filter((name) => process.env[name] !== undefined)).toEqual([])
    expect(GithubSecrets.credentials.loaded()).toBe(false)
    await GithubSecrets.credentials.load(
      { GITHUB_ACTIONS: "true", VECTOR_MODE: "own-key", VECTOR_SECRET_CHANNEL: "stdin" },
      (async function* () {
        yield JSON.stringify({
          v: 1,
          githubToken: CHANNEL.githubToken,
          cliToken: CHANNEL.cliToken,
          keys: CHANNEL.keys,
        }) + "\n"
      })(),
    )
    expect(GithubSecrets.ownKeyRun()).toBe(true)
  })

  const dispatch = Effect.fn("AgentChannelTest.dispatch")(function* (dir: string, github: string, prompt: string) {
    const lines: string[] = []
    const result = yield* githubAgentPhase({
      env: stepEnv({
        event: yield* Effect.promise(() => eventFile({ inputs: {}, sender: { login: "alice", type: "User" } })),
        eventName: "workflow_dispatch",
        thread: `dispatch-${RUN_ID}`,
        github,
        prompt,
      }),
      log: (line) => lines.push(line),
      error: (line) => lines.push(`error: ${line}`),
    }).pipe(Effect.ensuring(Effect.sync(() => LLMRequestPrep.pin(undefined))))
    return { result, lines, dir }
  })

  if (mode === "environment")
    it.instance(
      "channel credentials stay out of process.env and a tool's child process",
      () =>
        Effect.gen(function* () {
          const test = yield* setup()
          yield* Effect.promise(() => commitSetup(test.dir))
          const github = fakeGithub({ roles: { alice: "write" } })
          // A fixed check, printing one count per fixture value and never the environment itself.
          const command = VALUES.map(
            (value, index) => `printf 'value${index}=%s\\n' "$(env | grep -cF -e '${value}')"`,
          ).join("; ")
          yield* test.llm.tool("bash", { command, description: "Check the environment" })
          yield* test.llm.text("Checked.")
          yield* test.llm.text("Check the environment")
          const run = yield* dispatch(test.dir, github.url, "Check the environment")
          github.stop()
          expect(run.result).toMatchObject({ exitCode: 0 })
          const inputs = JSON.stringify(yield* test.llm.inputs)
          VALUES.forEach((_, index) => expect(inputs).toContain(`value${index}=0`))
          expect(VALUES.filter((value) => Object.values(process.env).includes(value))).toEqual([])
          expect(privateNames.filter((name) => process.env[name] !== undefined)).toEqual([])
          // The provider layer reads the keys from memory, and the process's holder still has every credential.
          const env = yield* Env.Service
          expect(yield* env.get("V18B_PROVIDER_CREDENTIAL")).toBe(CHANNEL.keys.V18B_PROVIDER_CREDENTIAL)
          expect(GithubSecrets.credentials.githubToken()).toBe(CHANNEL.githubToken)
          expect(GithubSecrets.credentials.cliToken()).toBe(CHANNEL.cliToken)
          expect(guard.outside()).toEqual([])
        }),
      { git: true },
      25_000,
    )

  if (mode === "codium-config")
    it.instance(
      "an own-key run sends no model request to Codium, whatever its configuration names",
      () =>
        Effect.gen(function* () {
          // The repository names Codium for its small model, the title agent, the build agent and the general
          // subagent; MODEL is own key. The task launches that subagent, which would otherwise send its turn to Codium.
          const test = yield* setup({
            small_model: "vector-plan/codium-x",
            agent: {
              build: { model: "vector-plan/codium-x" },
              title: { model: "vector-plan/codium-x" },
              general: { model: "vector-plan/codium-x" },
            },
          })
          yield* Effect.promise(() => commitSetup(test.dir))
          const github = fakeGithub({ roles: { alice: "write" } })
          yield* test.llm.tool("task", {
            description: "Read the notes",
            prompt: "Read NOTES.md and report",
            subagent_type: "general",
          })
          yield* test.llm.text("Done.")
          yield* test.llm.text("Read the notes")
          // "be thorough" offers the task tool from the first turn.
          const run = yield* dispatch(test.dir, github.url, "be thorough: have a general subagent read the notes")
          github.stop()
          expect(run.result).toMatchObject({ exitCode: 0 })
          expect(plans.chats).toEqual([])
          // The catalog listing is the CLI's own read (INV-K1 allows it); the provider layer still leaves Codium out.
          const provider = yield* Provider.Service
          expect((yield* provider.list())[ProviderV2.ID.make(ModelPlans.PROVIDER_ID)]).toBeUndefined()
          const refused = yield* provider
            .getModel(ProviderV2.ID.make(ModelPlans.PROVIDER_ID), ModelV2.ID.make("codium-x"))
            .pipe(Effect.flip)
          expect(refused.message).toContain(GithubSecrets.OWN_KEY_CODIUM)
          // small_model names Codium, so helper calls fall back to the run's own provider instead.
          expect(
            yield* provider.getSmallModel(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("test-model")),
          ).toBeUndefined()
          const sessionID = run.lines
            .find((line) => line.startsWith("vector session "))!
            .slice("vector session ".length)
          const sessions = yield* Session.Service
          const assistants = (yield* sessions.messages({ sessionID: sessionID as never })).flatMap((message) =>
            message.info.role === "assistant" ? [message.info.providerID] : [],
          )
          expect(assistants.length).toBeGreaterThan(0)
          expect(new Set(assistants.map(String))).toEqual(new Set(["lmstudio"]))
          expect(plans.chats).toEqual([])
          expect(guard.outside()).toEqual([])
        }),
      { git: true },
      25_000,
    )
}
