import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Flag } from "@vectordevai/core/flag/flag"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Npm } from "@vectordevai/core/npm"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigErrorV1 } from "@vectordevai/core/v1/config/error"
import { COMPUTER_CAPS } from "@vectordevai/schema/everywhere"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ConfigParse } from "../../src/config/parse"
import { Env } from "../../src/env"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Server } from "../../src/server/server"
import { ServerAuth } from "../../src/server/auth"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { resetDatabase } from "../fixture/db"
import { TestInstance, disposeAllInstances, tmpdir, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { testEffect } from "../lib/effect"

// VE-40: only the user's own config files set `everywhere`. Every other source's copy is left out of the merged
// config, a guest never reads it, and a repository's config file is never written with it. Paths come from the
// fixtures' temporary folders, so the same cases run on Windows.

const user = { enabled: false, max_usd: 3, push: false }
const intruder = { enabled: true, max_usd: COMPUTER_CAPS.maxUsd.max, stay_awake: true }
const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const managedFixture: { restore?: () => void } = {}
const originalTestToken = process.env.TEST_TOKEN

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)
const configLayer = (options: { auth?: Layer.Layer<Auth.Service>; client?: HttpClient.HttpClient } = {}) =>
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, options.auth ?? AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)],
  ])
const layer = configLayer()
const it = testEffect(layer)

const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  managedFixture.restore?.()
  managedFixture.restore = undefined
  await fs.rm(managedDirectory, { force: true, recursive: true }).catch(() => {})
  setEnv("TEST_TOKEN", originalTestToken)
  await clear(true)
})

// Sets a variable, or removes it when `value` is undefined.
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) return void delete process.env[key]
  process.env[key] = value
}

const writeConfigEffect = (dir: string, config: object, name = "vector.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const writeManagedEffect = (settings: object) =>
  writeConfigEffect(managedDirectory, settings).pipe(
    Effect.andThen(
      Effect.sync(() => {
        managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)
      }),
    ),
  )

const withGlobalConfig = <A, E, R>(config: object | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (config) yield* writeConfigEffect(dir, { $schema: "https://vectordev.ai/config.json", ...config })
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        yield* clearEffect(true)
        return previous
      }),
      () => effect,
      (previous) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* clearEffect(true)
        }),
    )
  })

const withProcessEnv = <A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = process.env[key]
      setEnv(key, value)
      return original
    }),
    () => effect,
    (original) => Effect.sync(() => setEnv(key, original)),
  )

// The MDM profile or the Windows policy key as ConfigManaged.read() reports them, which no test reads from the machine.
const withPolicies = <A, E, R>(policies: readonly ConfigManaged.Policy[], effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ConfigManaged.useTestPolicies(policies)),
    () => effect,
    () => Effect.sync(() => ConfigManaged.useTestPolicies(undefined)),
  )

describe("a repository cannot set everywhere", () => {
  test("projectExecutableConfig drops it, trusted or not", () => {
    for (const trusted of [false, true])
      for (const base of [{}, { everywhere: user }]) {
        const next = Config.projectExecutableConfig({ everywhere: intruder, username: "x" }, trusted, base)
        expect(next.everywhere).toBeUndefined()
        expect(next.username).toBe("x")
      }
  })

  for (const trusted of [false, true]) {
    it.instance(
      `project config, trusted=${trusted}`,
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.username).toBe("everywhere-project-fixture")
        expect(config.everywhere).toBeUndefined()
      }),
      { trusted, config: { everywhere: intruder, username: "everywhere-project-fixture" } },
    )
  }

  for (const name of ["vector.json", "vector.jsonc", "vector.local.json"]) {
    it.instance(`a trusted project's .vector/${name}`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = path.join(test.directory, ".vector")
        yield* writeConfigEffect(directory, { everywhere: intruder, username: "dot-vector-fixture" }, name)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const config = yield* Config.use.get()
        expect(config.username).toBe("dot-vector-fixture")
        expect(config.everywhere).toBeUndefined()
      }),
    )
  }
})

describe("only the user's own config files set everywhere", () => {
  it.instance("the user's block is the merged one, whatever a trusted repository says", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const projects = [{ directory: test.directory, repository: "acme/widgets" }]
      yield* writeConfigEffect(test.directory, { everywhere: { ...intruder, projects } })
      yield* Effect.promise(() => trustWorkspace(test.directory))
      yield* withGlobalConfig(
        { everywhere: user },
        Effect.gen(function* () {
          expect((yield* Config.use.get()).everywhere).toEqual(user)
          expect((yield* Config.use.getGlobal()).everywhere).toEqual(user)
        }),
      )
    }),
  )

  it.instance("a company's managed file is left out", () =>
    withGlobalConfig(
      { everywhere: user },
      Effect.gen(function* () {
        yield* writeManagedEffect({ everywhere: intruder, username: "managed-fixture" })
        const config = yield* Config.use.get()
        expect(config.username).toBe("managed-fixture")
        expect(config.everywhere).toEqual(user)
      }),
    ),
  )

  // The policy loop merges after every other source and outside merge(), so it leaves the key out on its own.
  for (const [name, global] of [
    ["alone", undefined],
    ["beside the user's block", { everywhere: user }],
  ] as const)
    it.instance(`the company's MDM profile and Windows policy key are left out, ${name}`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const everywhere = { ...intruder, projects: [{ directory: test.directory, repository: "acme/widgets" }] }
        const source = "mobileconfig:/Library/Managed Preferences/ai.vector.managed.plist"
        yield* withPolicies(
          [
            { source, text: JSON.stringify({ everywhere }) },
            {
              source: `registry:${ConfigManaged.REGISTRY_KEY}`,
              text: JSON.stringify({ everywhere, username: "policy-fixture" }),
            },
          ],
          withGlobalConfig(
            global,
            Effect.gen(function* () {
              const config = yield* Config.use.get()
              expect(config.username).toBe("policy-fixture")
              expect(config.everywhere).toEqual(global?.everywhere)
            }),
          ),
        )
      }),
    )

  // A lock keeps every source's copy out of the merged config, the user's own included, while GET /global/config
  // still returns the user's files as written: EV-17 reads the latter and treats `locked` naming the key as off.
  it.instance("a company lock on everywhere empties the merged block, not the global config", () =>
    withProcessEnv(
      // Under the agent marker the owner's yes below would not count, and the lock would outlive this case.
      "VECTOR_AGENT_SESSION",
      undefined,
      Effect.acquireUseRelease(
        writeManagedEffect({ local: { lock: true, locked_keys: ["everywhere"] }, everywhere: intruder }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              Config.refreshLocal()
              Config.confirmLocal()
            }),
          ),
        ),
        () =>
          withGlobalConfig(
            { everywhere: user },
            Effect.gen(function* () {
              expect(Config.lockedKeys()).toContain("everywhere")
              expect((yield* Config.use.get()).everywhere).toBeUndefined()
              expect((yield* Config.use.getGlobal()).everywhere).toEqual(user)
            }),
          ),
        () =>
          Effect.promise(async () => {
            await fs.rm(managedDirectory, { force: true, recursive: true })
            managedFixture.restore?.()
            managedFixture.restore = undefined
            await fs.rm(Config.localConfirmedFile(), { force: true })
            // Removing the company's policy loosens Vector Local, which waits for the owner; the owner here says yes.
            Config.refreshLocal()
            Config.confirmLocal()
          }),
      ),
    ),
  )

  it.instance("VECTOR_CONFIG_CONTENT is left out", () =>
    withProcessEnv(
      "VECTOR_CONFIG_CONTENT",
      JSON.stringify({ everywhere: intruder, username: "env-fixture" }),
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.username).toBe("env-fixture")
        expect(config.everywhere).toBeUndefined()
      }),
    ),
  )

  it.instance("a custom config directory is left out", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* writeConfigEffect(directory, { everywhere: intruder, username: "custom-directory-fixture" })
      yield* withProcessEnv(
        "VECTOR_AGENT_CONFIG_DIR",
        directory,
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("custom-directory-fixture")
          expect(config.everywhere).toBeUndefined()
        }),
      )
    }),
  )

  // The desktop starts its engine with its own config folder outside any repository (localFiles().desktop), and that
  // folder is the user's as much as the global one is.
  it.instance("the desktop's own config folder is a user source", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* writeConfigEffect(directory, { everywhere: user, username: "desktop-directory-fixture" })
      yield* withProcessEnv(
        "VECTOR_CLIENT",
        "desktop",
        withProcessEnv(
          "VECTOR_AGENT_CONFIG_DIR",
          directory,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.username).toBe("desktop-directory-fixture")
            expect(config.everywhere).toEqual(user)
          }),
        ),
      )
    }),
  )

  const organization = testEffect(
    configLayer({
      auth: Layer.mock(Auth.Service)({
        all: () =>
          Effect.succeed({
            "https://example.com": new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
          }),
      }),
      client: HttpClient.make((request) =>
        request.url.includes(".well-known/vector")
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ config: { everywhere: intruder, username: "org-fixture" } }),
              ),
            )
          : Effect.die(`unexpected http request: ${request.method} ${request.url}`),
      ),
    }),
  )
  organization.instance("an organization's remote config is left out", () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.username).toBe("org-fixture")
      expect(config.everywhere).toBeUndefined()
    }),
  )

  // GET /global/config reads only the files in the user's config folder, as written, so none of the sources above can
  // reach it either.
  it.instance("the global config is the user's files as written, and an invalid block fails the load", () =>
    Effect.gen(function* () {
      yield* writeManagedEffect({ everywhere: intruder })
      yield* withProcessEnv(
        "VECTOR_CONFIG_CONTENT",
        JSON.stringify({ everywhere: intruder }),
        withGlobalConfig(
          { everywhere: user, username: "global-fixture" },
          Effect.gen(function* () {
            const global = yield* Config.use.getGlobal()
            expect(global.everywhere).toEqual(user)
            expect(global.username).toBe("global-fixture")
          }),
        ),
      )
      // An unknown key makes the file invalid, as an out-of-range value does: loading fails and names the file, so
      // nothing runs on a config with the user's other settings left out.
      yield* withGlobalConfig(
        { everywhere: { ...user, pushh: false }, username: "invalid-fixture" },
        Effect.gen(function* () {
          for (const exit of [yield* Effect.exit(Config.use.getGlobal()), yield* Effect.exit(Config.use.get())]) {
            expect(Exit.isFailure(exit)).toBe(true)
            const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            expect(ConfigErrorV1.InvalidError.isInstance(error)).toBe(true)
            if (ConfigErrorV1.InvalidError.isInstance(error)) expect(path.basename(error.data.path)).toBe("vector.json")
          }
        }),
      )
    }),
  )
})

describe("the engine's parser enforces the limits", () => {
  test("accepts the user's block and names the file it refuses", () => {
    const file = "/home/u/.config/vector/vector.json"
    expect(ConfigParse.schema(ConfigV1.Info, { everywhere: user }, "vector.json").everywhere).toEqual(user)
    for (const everywhere of [
      { max_usd: COMPUTER_CAPS.maxUsd.max + 1 },
      { at_once: 0 },
      { minutes: 1.5 },
      { push: false, pushh: false },
      { projects: [{ directory: "relative/repo", repository: "acme/widgets" }] },
      { projects: [{ directory: "C:\\a/b", repository: "acme/widgets" }] },
    ])
      expect(() => ConfigParse.schema(ConfigV1.Info, { everywhere }, file)).toThrow(
        expect.objectContaining({
          name: ConfigErrorV1.InvalidError.tag,
          data: expect.objectContaining({ path: file }),
        }),
      )
  })

  test("a company lock refuses writes of everywhere", () => {
    const policy = LocalPolicy.resolve({ managed: { lock: true, locked_keys: ["everywhere"] } })
    expect(Config.lockedKeys(policy)).toContain("everywhere")
    for (const scope of ["global", "repository"] as const)
      expect(Config.lockedIn({ everywhere: { enabled: true } }, scope, policy)).toEqual(["everywhere"])
  })
})

describe("the config routes", () => {
  const ENVIRONMENT = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("a guest never reads everywhere, and a repository's config file is never written with it", async () => {
    await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
    const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
    const previous = Object.fromEntries(ENVIRONMENT.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      VECTOR_SERVER_USERNAME: "vector",
      VECTOR_SERVER_PASSWORD: "owner-secret",
      VECTOR_SERVER_GUEST_USERNAME: "guest",
      VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
      VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
      VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
      VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
    })
    const files = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))
    const originals = await Promise.all(
      files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : undefined)),
    )
    const repositoryFile = path.join(tmp.path, "vector.json")
    const repositoryBefore = await Bun.file(repositoryFile).text()
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
    const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
    const call = (route: string, init: RequestInit = {}) =>
      fetch(new URL(route, listener.url), { ...init, keepalive: false })
    const instance = (route: string) => `${route}?directory=${encodeURIComponent(tmp.path)}`
    const everywhere = { ...user, projects: [{ directory: tmp.path, repository: "acme/widgets" }] }
    const read = async (route: string, headers: Record<string, string>) => {
      const response = await call(route, { headers })
      expect(response.status).toBe(200)
      return (await response.json()) as { everywhere?: unknown }
    }
    try {
      Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
      const saved = await call("/global/config", {
        method: "PATCH",
        headers: owner,
        body: JSON.stringify({ everywhere }),
      })
      expect(saved.status).toBe(200)
      expect((await read("/global/config", owner)).everywhere).toEqual(everywhere)
      expect((await read(instance("/config"), owner)).everywhere).toEqual(everywhere)
      for (const route of ["/global/config", instance("/config")]) {
        const forGuest = await read(route, guest)
        expect(forGuest.everywhere).toBeUndefined()
        expect(JSON.stringify(forGuest)).not.toContain("acme/widgets")
      }
      const refused = await call(instance("/config"), {
        method: "PATCH",
        headers: owner,
        body: JSON.stringify({ everywhere: { enabled: true } }),
      })
      expect(refused.status).toBe(400)
      expect(await Bun.file(repositoryFile).text()).toBe(repositoryBefore)
    } finally {
      Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
      const restore = () =>
        Promise.all(
          files.map((file, index) => {
            const original = originals[index]
            return original === undefined ? fs.rm(file, { force: true }) : Bun.write(file, original)
          }),
        )
      await restore()
      // A real change through the route loads the restored files, then they are restored once more.
      await call("/global/config", { method: "PATCH", headers: owner, body: JSON.stringify({ username: "restored" }) })
      await restore()
      await listener.stop(true)
      for (const key of ENVIRONMENT) setEnv(key, previous[key])
    }
  }, 30_000)
})
