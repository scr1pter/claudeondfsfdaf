import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Npm } from "@vectordevai/core/npm"
import { Global } from "@vectordevai/core/global"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { TaskSize } from "@vectordevai/schema/task-size"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceRuntime } from "@/project/instance-runtime"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import {
  TestInstance,
  tmpdirScoped,
  trustWorkspace,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Multi-agent contract 4.2 and I10/I28: the subagent and workflow keys nest in budget and sizing, a repository's
// values only narrow the user's, trusted or not, and an older engine still loads a config that carries them.

type Info = ConfigV1.Info

const user: Info = {
  budget: {
    subagents: { usd: 40, running: 10, per_request: 50 },
    workflow: {
      max_agents: 200,
      concurrency: 8,
      usd: 30,
      tokens: 2_000_000,
      steps: 5000,
      per_agent_steps: 80,
      minutes: 300,
      runs: 2,
    },
  },
  sizing: { subagents: { fork: true, models: ["anthropic/claude-opus", "openai/gpt-5"], ask_timeout: 30 } },
}

describe("a repository's subagent and workflow keys", () => {
  const repository: Info = {
    budget: {
      subagents: { usd: 1000, steps: 5, warnAt: 0.5, unpricedSteps: 3, running: 12, per_request: 20 },
      workflow: {
        max_agents: 500,
        concurrency: 4,
        usd: 100,
        tokens: 1_000_000,
        steps: 9000,
        per_agent_steps: 40,
        minutes: 600,
        runs: 1,
      },
    },
    sizing: {
      subagents: {
        fork: false,
        models: ["openai/gpt-5", "x/expensive"],
        ask_timeout: 10,
        isolation: { lsp: true, mcp: true, link: ["node_modules"], max_kept: 200 },
      },
    },
  }

  test("trusted: counts and workflow ceilings take the lower of the repository's and the user's", () => {
    const next = Config.projectExecutableConfig(repository, true, user)
    expect(next.budget).toEqual({
      subagents: { running: 10, per_request: 20 },
      workflow: {
        max_agents: 200,
        concurrency: 4,
        usd: 30,
        tokens: 1_000_000,
        steps: 5000,
        per_agent_steps: 40,
        minutes: 300,
        runs: 1,
      },
    })
  })

  test("trusted: the spend keys are dropped and only the user's budget.subagents.usd applies", () => {
    const next = Config.projectExecutableConfig(
      { budget: { subagents: { usd: 1, steps: 2, warnAt: 0.1, unpricedSteps: 1 } } },
      true,
      user,
    )
    expect(next.budget).toBeUndefined()
    expect(Config.ignoredSpendKeys(repository)).toEqual([
      "budget.subagents.usd",
      "budget.subagents.steps",
      "budget.subagents.warnAt",
      "budget.subagents.unpricedSteps",
    ])
    expect(Config.ignoredSpendKeys({ budget: { run: { usd: 1 }, subagents: { running: 2 } } })).toEqual(["budget.run"])
  })

  test("trusted: with no user value a count is lowered against the default", () => {
    const next = Config.projectExecutableConfig(repository, true, {})
    expect(next.budget?.subagents).toEqual({
      running: ConfigV1.SubagentDefaults.running,
      per_request: 20,
    })
    expect(next.budget?.workflow).toEqual({
      max_agents: ConfigV1.WorkflowDefaults.max_agents,
      concurrency: 4,
      // No default: the repository's ceiling is narrower than none.
      usd: 100,
      tokens: 1_000_000,
      // The default is 40 steps for each of the user's 100 agents.
      steps: 4000,
      per_agent_steps: 40,
      minutes: ConfigV1.WorkflowDefaults.minutes,
      runs: 1,
    })
    // A repository's lower values stand against the defaults.
    expect(
      Config.projectExecutableConfig({ budget: { subagents: { running: 2, per_request: 4 } } }, true, {}).budget,
    ).toEqual({ subagents: { running: 2, per_request: 4 } })
  })

  test("trusted: forks only turn off, models narrow the user's list, ask_timeout only shortens, isolation is dropped", () => {
    expect(Config.projectExecutableConfig(repository, true, user).sizing).toEqual({
      subagents: { fork: false, models: ["openai/gpt-5"], ask_timeout: 10 },
    })
    // Turning forks on, a model list without the user's, and an ask_timeout without the user's are all dropped.
    expect(
      Config.projectExecutableConfig(
        { sizing: { subagents: { fork: true, models: ["x/expensive"], ask_timeout: 5, isolation: { lsp: true } } } },
        true,
        {},
      ).sizing,
    ).toBeUndefined()
    // A longer ask_timeout than the user's is dropped; an empty intersection narrows to no extra model.
    expect(
      Config.projectExecutableConfig(
        { sizing: { subagents: { models: ["x/expensive"], ask_timeout: 90 } } },
        true,
        user,
      ).sizing,
    ).toEqual({ subagents: { models: [] } })
  })

  test("trusted: other budget and sizing keys keep today's rules", () => {
    const next = Config.projectExecutableConfig(
      {
        budget: { run: { usd: 1 }, loop: { enabled: false }, subagents: { running: 3 } },
        sizing: { judge: "off", subagents: { fork: false } },
      },
      true,
      user,
    )
    expect(next.budget).toEqual({ loop: { enabled: false }, subagents: { running: 3 } })
    expect(next.sizing).toEqual({ judge: "off", subagents: { fork: false } })
  })

  test("untrusted: every subagent and workflow key is dropped, as budget and sizing collapse today", () => {
    expect(Config.projectExecutableConfig(repository, false, user).budget).toBeUndefined()
    expect(Config.projectExecutableConfig(repository, false, user).sizing).toBeUndefined()
    const next = Config.projectExecutableConfig(
      {
        ...repository,
        budget: { ...repository.budget, loop: { enabled: true } },
        sizing: { ...repository.sizing, judge: "off" },
      },
      false,
      user,
    )
    expect(next.budget).toEqual({ loop: { enabled: true } })
    expect(next.sizing).toEqual({ judge: "off" })
  })

  test("the narrowing never touches the user's own config object", () => {
    const before = structuredClone(repository)
    Config.repositorySubagents(repository, user)
    expect(repository).toEqual(before)
  })
})

// The 1.99.111 shape: the same top-level keys, with budget and sizing as that version declared them.
const RELEASED_TOP_LEVEL = [
  "$schema",
  "shell",
  "logLevel",
  "server",
  "command",
  "skills",
  "references",
  "reference",
  "watcher",
  "snapshot",
  "plugin",
  "share",
  "autoshare",
  "autoupdate",
  "disabled_providers",
  "enabled_providers",
  "model",
  "small_model",
  "default_agent",
  "username",
  "mode",
  "agent",
  "provider",
  "mcp",
  "formatter",
  "lsp",
  "instructions",
  "layout",
  "permission",
  "tools",
  "attachment",
  "enterprise",
  "tool_output",
  "compaction",
  "budget",
  "sizing",
  "local",
  "research",
  "experimental",
]
const Released = Schema.Struct({
  ...ConfigV1.Info.fields,
  budget: Schema.optional(
    Schema.Struct({
      run: Schema.optional(RunBudget.Info),
      loop: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    }),
  ),
  sizing: Schema.optional(
    Schema.Struct({ auto: Schema.optional(Schema.Boolean), judge: Schema.optional(TaskSize.JudgeMode) }),
  ),
})

const everyKey = {
  budget: {
    run: { usd: 5 },
    loop: { enabled: true },
    subagents: { usd: 25, steps: 400, warnAt: 0.8, unpricedSteps: 50, running: 8, per_request: 32 },
    workflow: {
      max_agents: 100,
      concurrency: 16,
      usd: 10,
      tokens: 100_000,
      steps: 4000,
      per_agent_steps: 60,
      minutes: 120,
      runs: 1,
    },
  },
  sizing: {
    auto: true,
    judge: "off",
    learn: true,
    subagents: {
      fork: true,
      models: ["anthropic/*"],
      ask_timeout: 15,
      isolation: { lsp: false, mcp: false, link: ["node_modules"], max_kept: 20 },
    },
  },
  permission: { workflow: "ask", task: { fork: "ask" } },
  tools: { workflow: false },
}

describe("version skew", () => {
  test("no new top-level key", () => {
    expect(Object.keys(ConfigV1.Info.fields).sort()).toEqual([...RELEASED_TOP_LEVEL].sort())
  })

  test("a config with every new key decodes against the 1.99.111 shape and passes its top-level check", () => {
    const released = ConfigParse.schema(Released, everyKey, "vector.json")
    expect(released.budget).toEqual({ run: { usd: 5 }, loop: { enabled: true } })
    expect(released.sizing).toEqual({ auto: true, judge: "off" })
  })

  test("the current shape keeps every new key", () => {
    expect(ConfigParse.schema(ConfigV1.Info, everyKey, "vector.json")).toEqual(everyKey as never)
  })

  test("out-of-range values are refused", () => {
    for (const config of [
      { budget: { subagents: { running: 0 } } },
      { budget: { subagents: { running: 17 } } },
      { budget: { subagents: { per_request: 1001 } } },
      { budget: { subagents: { usd: 0 } } },
      { budget: { workflow: { concurrency: 17 } } },
      { budget: { workflow: { runs: 5 } } },
      { budget: { workflow: { minutes: 1441 } } },
      { sizing: { subagents: { ask_timeout: 0 } } },
      { sizing: { subagents: { models: Array.from({ length: 33 }, (_, index) => `p/m${index}`) } } },
      { sizing: { subagents: { isolation: { max_kept: 201 } } } },
    ])
      expect(() => ConfigParse.schema(ConfigV1.Info, config, "vector.json")).toThrow()
  })
})

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)
const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])
const it = testEffect(layer)
const clear = () =>
  Effect.runPromise(
    Config.use
      .invalidate()
      .pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
      ),
  )
beforeEach(clear)
afterEach(clear)

const write = (directory: string, config: object) =>
  FSUtil.use.writeWithDirs(path.join(directory, "vector.json"), JSON.stringify(config))
const withInstance = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory }),
    provideInstanceEffect(directory),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
  )
const withGlobal = <A, E, R>(config: object, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* write(directory, config)
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = directory
        return previous
      }).pipe(Effect.tap(() => Effect.promise(clear))),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }).pipe(Effect.andThen(Effect.promise(clear))),
    )
  })
const notices = Effect.gen(function* () {
  const seen: string[] = []
  const listener = (event: GlobalEvent) => {
    if (event.payload.type === "tui.toast.show" && event.payload.properties.title === "Repository spend cap ignored")
      seen.push(event.payload.properties.message)
  }
  GlobalBus.on("event", listener)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
  return seen
})

describe("loading a repository's subagent keys", () => {
  it.live("a trusted repository narrows field by field, and absent fields keep the user's or the default", () =>
    withGlobal(
      { budget: { subagents: { usd: 40, running: 6 } }, sizing: { subagents: { models: ["a/b", "c/d"] } } },
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* write(path.join(directory, ".vector"), {
          budget: { subagents: { usd: 500, running: 12, per_request: 64 }, workflow: { runs: 1 } },
          sizing: { subagents: { models: ["c/d", "e/f"], isolation: { lsp: true } } },
        })
        yield* Effect.promise(() => trustWorkspace(directory))
        const config = yield* withInstance(directory, Config.use.get())
        expect(config.budget?.subagents).toEqual({ usd: 40, running: 6, per_request: 32 })
        expect(config.budget?.workflow).toEqual({ runs: 1 })
        expect(config.sizing?.subagents).toEqual({ models: ["c/d"] })
      }),
    ),
  )

  it.live("an untrusted repository's subagent keys do not apply", () =>
    withGlobal(
      { budget: { subagents: { running: 6 } } },
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* write(directory, { budget: { subagents: { running: 2 } }, sizing: { subagents: { fork: false } } })
        const config = yield* withInstance(directory, Config.use.get())
        expect(config.budget).toEqual({ subagents: { running: 6 } })
        expect(config.sizing).toBeUndefined()
      }),
    ),
  )

  it.live("the one-time notice names a repository's subagent spend keys", () =>
    withGlobal(
      {},
      Effect.gen(function* () {
        const seen = yield* notices
        const directory = yield* tmpdirScoped()
        yield* write(path.join(directory, ".vector"), { budget: { subagents: { usd: 500, running: 2 } } })
        yield* Effect.promise(() => trustWorkspace(directory))
        const config = yield* withInstance(directory, Config.use.get())
        expect(config.budget?.subagents).toEqual({ running: 2 })
        expect(seen).toHaveLength(1)
        expect(seen[0]).toContain(`This repository's ${path.join(".vector", "vector.json")} sets budget.subagents.usd`)
        expect(seen[0]).toContain("spend limits now cover all your repositories together")
        expect(seen[0]).not.toContain("--max-cost")
      }),
    ),
  )

  it.live("a file already noticed for budget.run is noticed again for a subagent spend key it adds", () =>
    withGlobal(
      {},
      Effect.gen(function* () {
        const seen = yield* notices
        const directory = yield* tmpdirScoped({ git: true })
        const file = path.join(directory, ".vector")
        yield* write(file, { budget: { run: { usd: 1 } } })
        yield* Effect.promise(() => trustWorkspace(directory))
        yield* withInstance(directory, Config.use.get())
        expect(seen).toHaveLength(1)
        expect(seen[0]).toContain("sets budget.run,")

        yield* write(file, { budget: { run: { usd: 1 }, subagents: { usd: 500 } } })
        yield* Effect.promise(clear)
        yield* withInstance(directory, Config.use.get())
        expect(seen).toHaveLength(2)
        expect(seen[1]).toContain(`This repository's ${path.join(".vector", "vector.json")} sets budget.subagents.usd,`)
        expect(seen[1]).not.toContain("budget.run")

        yield* Effect.promise(clear)
        yield* withInstance(directory, Config.use.get())
        expect(seen).toHaveLength(2)
      }),
    ),
  )
})
