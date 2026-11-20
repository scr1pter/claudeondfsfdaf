import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Npm } from "@vectordevai/core/npm"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Global } from "@vectordevai/core/global"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { managedPolicyAcl, useManagedPolicyFixture } from "../fixture/managed-policy"

// Vector Local's policy as the engine resolves it: once, from the user's own config and the company's policy, with
// the environment and the config overrides only tightening it, and a loosening edit held until the owner confirms.

const guard = NetworkGuard.use()

const globalFile = path.join(Global.Path.config, "vector.json")
const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const managedFixture: { restore?: () => void } = {}
const engineDirectory = path.resolve(import.meta.dir, "../..")
const ENVIRONMENT = [
  "VECTOR_AGENT_SESSION",
  "VECTOR_LOCAL",
  "VECTOR_LOCAL_WEB",
  "VECTOR_LOCAL_POLICY",
  "VECTOR_CONFIG_CONTENT",
  "VECTOR_AGENT_CONFIG",
  "VECTOR_AGENT_CONFIG_DIR",
  "VECTOR_CLIENT",
] as const
// These tests run as the owner would: a test runner started from Vector's own terminal would carry the agent marker.
delete process.env.VECTOR_AGENT_SESSION
const saved = Object.fromEntries(ENVIRONMENT.map((key) => [key, process.env[key]]))

const SERVER = "http://127.0.0.1:11434"
const GPU_BOX = "http://10.0.0.5:8000"
const OTHER_BOX = "http://10.0.0.9:8000"
const GITHUB = { source: "github", reason: "PRs", added_at: 1, added_by: "cli" as const }
const CATALOG = { source: "catalog", reason: "Models", added_at: 1, added_by: "app" as const }
const CONFIG = JSON.stringify(new URL("../../src/config/config.ts", import.meta.url).href)
const EGRESS = JSON.stringify(new URL("../../../core/src/local-mode/egress.ts", import.meta.url).href)
const PAGE = { source: "webfetch", url: "https://docs.example.com/guide" }
const DAY = 24 * 60 * 60 * 1000
const logDirectory = path.join(Global.Path.data, "local")

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ]),
)

afterEach(() => {
  // A test that leaves company policy in the managed folder without the fixture reads it, on Windows, through the real
  // PowerShell ACL reader, whose start a busy runner can push past its timeout (job 136322673267).
  const unfixed = existsSync(managedDirectory) && managedFixture.restore === undefined
  managedFixture.restore?.()
  managedFixture.restore = undefined
  ENVIRONMENT.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  })
  rmSync(globalFile, { force: true })
  rmSync(Config.localConfirmedFile(), { force: true })
  rmSync(managedDirectory, { recursive: true, force: true })
  // Removing a test's config can loosen Vector Local, which waits for the owner; the owner here says yes.
  Config.refreshLocal()
  Config.confirmLocal()
  expect(Config.localPending()).toBe(undefined)
  expect(guard.outside()).toEqual([])
  expect(unfixed).toBe(false)
})

function writeGlobal(local: object | undefined) {
  writeFileSync(globalFile, JSON.stringify({ $schema: "https://vectordev.ai/config.json", local }))
}

function writeManaged(config: object) {
  mkdirSync(managedDirectory, { recursive: true })
  writeFileSync(path.join(managedDirectory, "vector.json"), JSON.stringify(config))
  managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)
}

// A folder's watch on macOS can miss a write made just as it starts, so a test that edits a file the watcher reads
// writes it again until the change arrives; writing the same text again changes nothing more.
async function writeUntil<T>(write: () => void, change: Promise<T>) {
  const timer = setInterval(write, 250)
  write()
  return await change.finally(() => clearInterval(timer))
}

function nextChange(type: Config.LocalChange["type"]) {
  const change = Promise.withResolvers<Config.LocalChange>()
  const timer = setTimeout(() => change.reject(new Error(`no ${type} change within 5 seconds`)), 5_000)
  const unsubscribe = Config.subscribeLocal((next) => {
    if (next.type !== type) return
    clearTimeout(timer)
    unsubscribe()
    change.resolve(next)
  })
  return change.promise
}

async function run(
  script: string,
  env: Record<string, string | undefined>,
  cwd = engineDirectory,
  flags: readonly string[] = [],
) {
  const child = Bun.spawn([process.execPath, ...flags, "--eval", script], {
    cwd,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`the child exited with ${code}: ${stderr}`)
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
}

// What a fresh process resolves at start, with this environment.
function start(env: Record<string, string | undefined>, cwd?: string, flags?: readonly string[]) {
  return run(
    `
    const { Config } = await import(${CONFIG})
    process.stdout.write(JSON.stringify({ policy: Config.local(), pending: Config.localPending()?.changes ?? null }) + "\\n")
    process.exit(0)
    `,
    env,
    cwd,
    flags,
  )
}

// What a fresh process decides at start: the policy, the held changes, a model call to each server and a web page.
function decisions(env: Record<string, string | undefined>) {
  return run(
    `
    const { Config } = await import(${CONFIG})
    const { Egress } = await import(${EGRESS})
    const inference = (origin) => Egress.decide({ source: "local-inference", url: origin + "/v1/chat/completions" }).decision
    process.stdout.write(JSON.stringify({
      policy: Config.local(),
      pending: Config.localPending()?.changes ?? null,
      servers: [${JSON.stringify(SERVER)}, ${JSON.stringify(GPU_BOX)}, ${JSON.stringify(OTHER_BOX)}].map(inference),
      page: Egress.decide(${JSON.stringify(PAGE)}).decision,
    }) + "\\n")
    process.exit(0)
    `,
    env,
  )
}

function inference(origin: string) {
  return Egress.decide({ source: "local-inference", url: `${origin}/v1/chat/completions` }).decision
}

// A network log file of `days` ago.
function dated(days: number) {
  return path.join(logDirectory, `egress-${new Date(Date.now() - days * DAY).toISOString().slice(0, 10)}.jsonl`)
}

describe("resolved at start", () => {
  test("the policy is resolved before the first catalog fetch", async () => {
    await using dir = await tmpdir()
    const managed = path.join(dir.path, "managed")
    mkdirSync(managed)
    writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { enabled: true, web: "none" } }))
    const requests: string[] = []
    using mirror = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return Response.json({})
      },
    })
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href)
    // The backstop comes first, as in the CLI's entry, then the engine's runtime, and nothing has run yet: no layer is
    // built and the catalog has not been asked for. The floor children get and the policy Egress decides with are both
    // set when the policy is resolved, so they show it was already in effect.
    const result = await run(
      `
      await import(${url("../../../core/src/local-mode/backstop.ts")})
      const { ConfigManaged } = await import(${url("../../../core/src/config/managed.ts")})
      ConfigManaged.useTestDirectory(${JSON.stringify(managed)})
      const { useManagedPolicyFixture } = await import(${url("../fixture/managed-policy.ts")})
      useManagedPolicyFixture(${JSON.stringify(managed)})
      const { untrustedChildEnvironment } = await import(${url("../../../core/src/child-environment.ts")})
      const { Egress } = await import(${url("../../../core/src/local-mode/egress.ts")})
      const { AppRuntime } = await import(${url("../../src/effect/app-runtime.ts")})
      const { Config } = await import(${CONFIG})
      const floor = untrustedChildEnvironment({})
      const egress = { same: Egress.policy() === Config.local(), policy: Egress.policy() }
      const { ModelCatalog } = await import(${url("../../../core/src/model-catalog.ts")})
      await AppRuntime.runPromise(ModelCatalog.Service.use((catalog) => catalog.get()))
      process.stdout.write(JSON.stringify({ floor, egress }) + "\\n")
      await AppRuntime.dispose()
      process.exit(0)
      `,
      {
        ...process.env,
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
        XDG_DATA_HOME: path.join(dir.path, "data"),
        XDG_CACHE_HOME: path.join(dir.path, "cache"),
        VECTOR_MODELS_URL: `http://127.0.0.1:${mirror.port}/models`,
        VECTOR_MODELS_PATH: undefined,
        VECTOR_DISABLE_MODELS_FETCH: undefined,
      },
    )
    expect(result.floor).toEqual({ VECTOR_AGENT_SESSION: "1", VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "none" })
    expect(result.egress.same).toBe(true)
    expect(result.egress.policy).toMatchObject({ enabled: true, web: "none" })
    expect(result.egress.policy.pending).toBe(undefined)
    expect(requests).toContain("/models/api.json")
  }, 30_000)

  test("Vector Local the environment turned on stops holding everything once its policy is resolved", async () => {
    await using dir = await tmpdir()
    const managed = path.join(dir.path, "managed")
    mkdirSync(managed)
    writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { endpoints: [GPU_BOX] } }))
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href)
    // VECTOR_LOCAL=1, as a nested vector inherits it: the backstop holds everything but this computer from the first
    // import, and resolving the policy lets the company's model server through, which nothing else may reach.
    const result = await run(
      `
      await import(${url("../../../core/src/local-mode/backstop.ts")})
      const { Egress } = await import(${url("../../../core/src/local-mode/egress.ts")})
      const inference = { source: "local-inference", url: ${JSON.stringify(`${GPU_BOX}/v1/chat/completions`)} }
      const before = { pending: Egress.policy().pending, decision: Egress.decide(inference).decision }
      const { ConfigManaged } = await import(${url("../../../core/src/config/managed.ts")})
      ConfigManaged.useTestDirectory(${JSON.stringify(managed)})
      const { useManagedPolicyFixture } = await import(${url("../fixture/managed-policy.ts")})
      useManagedPolicyFixture(${JSON.stringify(managed)})
      const { Config } = await import(${CONFIG})
      const after = {
        same: Egress.policy() === Config.local(),
        policy: Egress.policy(),
        decision: Egress.decide(inference).decision,
        elsewhere: Egress.decide({ ...inference, url: "http://10.0.0.6:8000/v1/chat/completions" }).decision,
      }
      process.stdout.write(JSON.stringify({ before, after }) + "\\n")
      process.exit(0)
      `,
      {
        ...process.env,
        VECTOR_LOCAL: "1",
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
        XDG_DATA_HOME: path.join(dir.path, "data"),
        XDG_CACHE_HOME: path.join(dir.path, "cache"),
      },
    )
    expect(result.before).toEqual({ pending: true, decision: "block" })
    expect(result.after.same).toBe(true)
    expect(result.after.policy).toMatchObject({
      enabled: true,
      web: "ask",
      endpoints: [{ origin: GPU_BOX, from: "managed" }],
    })
    expect(result.after.policy.pending).toBe(undefined)
    expect(result.after.decision).toBe("allow")
    expect(result.after.elsewhere).toBe("block")
  }, 30_000)

  test("resolving it is synchronous and waits on no other service", () => {
    writeManaged({ local: { enabled: true, endpoints: [SERVER] } })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "ask", endpoints: [{ origin: SERVER, from: "managed" }] })
    expect(policy.pending).toBe(undefined)
    expect(Config.local()).toBe(policy)
  })
})

describe("Egress decides with the policy in effect", () => {
  const page = { source: "webfetch", url: "https://docs.example.com/guide" }

  test("an edit that loosens Vector Local does not reach Egress until the owner confirms it", () => {
    writeGlobal({ enabled: true, web: "none" })
    Config.refreshLocal()
    expect(Egress.policy()).toBe(Config.local())
    expect(Egress.decide(page).decision).toBe("block")
    writeGlobal({ enabled: true, web: "ask" })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual(["sets Web access to Ask"])
    expect(Egress.policy()).toBe(Config.local())
    expect(Egress.decide(page).decision).toBe("block")
    Config.confirmLocal()
    expect(Egress.policy()).toMatchObject({ enabled: true, web: "ask" })
    expect(Egress.decide(page).decision).toBe("allow")
  })

  test("turning Vector Local off reaches Egress at once when the company turned it on", () => {
    writeManaged({ local: { enabled: true, web: "none" } })
    Config.refreshLocal()
    expect(Egress.decide(page).decision).toBe("block")
    rmSync(managedDirectory, { recursive: true, force: true })
    Config.refreshLocal()
    expect(Config.localPending()).toBe(undefined)
    expect(Egress.policy()).toBe(Config.local())
    expect(Egress.decide(page)).toMatchObject({ decision: "allow", rule: "local-off" })
  })

  test.skipIf(process.platform === "win32")(
    "while Vector Local is on, the network log is in Vector's data folder for the user only, kept as long as the company says",
    async () => {
      const DAY = 24 * 60 * 60 * 1000
      const directory = path.join(Global.Path.data, "local")
      const dated = (days: number) =>
        path.join(directory, `egress-${new Date(Date.now() - days * DAY).toISOString().slice(0, 10)}.jsonl`)
      mkdirSync(directory, { recursive: true })
      writeFileSync(dated(10), "")
      writeFileSync(dated(40), "")
      writeGlobal({ enabled: true, web: "none" })
      Config.refreshLocal()
      Egress.decide({ source: "model-catalog", url: "https://models.dev/api.json" })
      const logged = await Egress.exported()
      expect(logged.at(-1)).toMatchObject({ source: "model-catalog", decision: "block", origin: "https://models.dev" })
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(dated(0)).mode & 0o777).toBe(0o600)
      // 30 days by default.
      expect(existsSync(dated(10))).toBe(true)
      expect(existsSync(dated(40))).toBe(false)
      // The company's policy shortens it, and the log applies it at once.
      writeManaged({ local: { log: { retain_days: 5 } } })
      Config.refreshLocal()
      expect(existsSync(dated(10))).toBe(false)
      expect(existsSync(dated(0))).toBe(true)
      await Egress.erase()
      rmSync(directory, { recursive: true, force: true })
    },
  )
})

describe("repository config", () => {
  const repository = { local: { enabled: false, web: "ask" as const, endpoints: [GPU_BOX] } }

  for (const trusted of [true, false])
    it.instance(
      `a ${trusted ? "trusted" : "untrusted"} repository's local block is dropped`,
      Effect.gen(function* () {
        writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
        Config.refreshLocal()
        const config = yield* Config.use.get()
        // Config.local() is the only reader: the merged config carries no local block at all.
        expect(config.local).toBe(undefined)
        expect(Config.local()).toMatchObject({
          enabled: true,
          web: "network",
          endpoints: [{ origin: SERVER, from: "user" }],
        })
        // The policy this repository reports says its own block was left out.
        const policy = yield* Config.use.localPolicy()
        expect(policy.warnings).toContain(LocalPolicy.REPOSITORY_IGNORED)
        expect(policy).toMatchObject({ enabled: true, web: "network", endpoints: [{ origin: SERVER }] })
        expect(Config.local().warnings).not.toContain(LocalPolicy.REPOSITORY_IGNORED)
      }),
      {
        trusted,
        config: repository,
        init: (directory) =>
          Effect.sync(() => {
            mkdirSync(path.join(directory, ".vector"))
            writeFileSync(path.join(directory, ".vector", "vector.json"), JSON.stringify(repository))
          }),
      },
    )

  it.instance(
    "a repository cannot turn Vector Local on either",
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.local).toBe(undefined)
      expect(Config.local().enabled).toBe(false)
    }),
    { trusted: true, config: { local: { enabled: true, web: "none" } } },
  )

  it.instance(
    "a repository without a local block reports no warning",
    Effect.gen(function* () {
      expect((yield* Config.use.localPolicy()).warnings).toEqual([])
    }),
    { trusted: true, config: { model: "repository/model" } },
  )
})

describe("the egress guard", () => {
  test("decides under the policy config resolves, from the moment it is resolved", () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX] })
    const policy = Config.refreshLocal()
    expect(Egress.policy()).toBe(policy)
    expect(Egress.decide({ source: "local-inference", url: `${GPU_BOX}/v1` }).rule).toBe("listed")
    rmSync(globalFile, { force: true })
    Config.refreshLocal()
    Config.confirmLocal()
    expect(Egress.policy().enabled).toBe(false)
  })
})

describe("the environment only tightens", () => {
  test("VECTOR_LOCAL and VECTOR_LOCAL_WEB add a floor", () => {
    writeGlobal({ enabled: false, web: "ask", endpoints: [SERVER] })
    expect(Config.refreshLocal().enabled).toBe(false)
    process.env.VECTOR_LOCAL = "1"
    process.env.VECTOR_LOCAL_WEB = "network"
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
  })

  test("they cannot loosen what the user's config sets", () => {
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    process.env.VECTOR_LOCAL = "0"
    process.env.VECTOR_LOCAL_WEB = "ask"
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none" })
    expect(policy.warnings).toContain("Ignored VECTOR_LOCAL_WEB=ask: it can only be none or network.")
  })

  test("VECTOR_LOCAL_POLICY can add a server but cannot lock or allow a service", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    process.env.VECTOR_LOCAL_POLICY = JSON.stringify({
      enabled: true,
      web: "ask",
      endpoints: [GPU_BOX],
      lock: true,
      allow: [GITHUB],
    })
    const policy = Config.refreshLocal()
    expect(policy.lock).toBe(false)
    expect(policy.allow).toEqual([])
    expect(policy.endpoints).toEqual([
      { origin: SERVER, from: "user" },
      { origin: GPU_BOX, from: "environment" },
    ])
  })

  test("under the agent marker, VECTOR_LOCAL_POLICY can still tighten but adds no model server", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    // Only the desktop sets it, for an engine it starts in WSL; under the marker a program the agent started could have.
    process.env.VECTOR_AGENT_SESSION = "1"
    process.env.VECTOR_LOCAL_POLICY = JSON.stringify({ web: "none", endpoints: [GPU_BOX] })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(policy.warnings).toContain(
      "Ignored the model servers in VECTOR_LOCAL_POLICY: an agent or Vector's own terminal started this Vector, so it cannot add one.",
    )
  })
})

describe("config overrides only tighten", () => {
  test("VECTOR_CONFIG_CONTENT cannot loosen Vector Local", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER], web_domains: { deny: ["tracker.example"] } })
    process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({
      local: {
        enabled: false,
        web: "ask",
        endpoints: [GPU_BOX],
        allow: [GITHUB],
        web_domains: { allow: ["docs.example.com"], deny: ["ads.example"] },
        lock: false,
      },
    })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({
      enabled: true,
      web: "network",
      endpoints: [{ origin: SERVER, from: "user" }],
      allow: [],
      web_domains: { allow: [], deny: ["tracker.example", "ads.example"] },
    })
    expect(policy.warnings).toContain(
      "Ignored enabled, web, endpoints, allow, web_domains.allow, lock in the local block of VECTOR_CONFIG_CONTENT: it can only make Vector Local stricter.",
    )
  })

  test("VECTOR_CONFIG_CONTENT can tighten Vector Local", () => {
    writeGlobal({ endpoints: [SERVER] })
    Config.refreshLocal()
    process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ local: { enabled: true, web: "none" } })
    expect(Config.refreshLocal()).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [{ origin: SERVER, from: "user" }],
      warnings: [],
    })
  })

  it.instance(
    "the merged config never carries VECTOR_CONFIG_CONTENT's local block",
    Effect.gen(function* () {
      writeGlobal({ enabled: true, endpoints: [SERVER] })
      process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ model: "content/model", local: { enabled: false } })
      Config.refreshLocal()
      const config = yield* Config.use.get()
      expect(config.model).toBe("content/model")
      expect(config.local).toBe(undefined)
      expect(Config.local().enabled).toBe(true)
    }),
  )

  test("a local block Vector cannot read keeps Vector Local on with Web access None", () => {
    writeGlobal({ enabled: false, web: "sometimes" })
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none" })
    expect(policy.warnings).toEqual([
      `Vector could not read the local block in ${globalFile}, so Vector Local stays on with Web access None until it is fixed.`,
    ])
    // Fixing it needs no confirmation: the unreadable block never counted as one the owner let apply.
    writeGlobal({ enabled: false })
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localPending()).toBe(undefined)
  })
})

describe("children inherit the Local floor", () => {
  test("untrusted children get VECTOR_LOCAL, a Web access at least as strict and the agent marker", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(
      untrustedChildEnvironment({
        PATH: "/usr/bin",
        VECTOR_LOCAL: "0",
        VECTOR_LOCAL_WEB: "ask",
        vector_local_web: "ask",
      }),
    ).toEqual({ PATH: "/usr/bin", VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "network", VECTOR_AGENT_SESSION: "1" })
    // A stricter setting a child already has is kept, as is the session a marker names.
    expect(untrustedChildEnvironment({ VECTOR_LOCAL_WEB: "none", VECTOR_AGENT_SESSION: "ses_parent" })).toEqual({
      VECTOR_LOCAL: "1",
      VECTOR_LOCAL_WEB: "none",
      VECTOR_AGENT_SESSION: "ses_parent",
    })
  })

  test("with Vector Local off, children get only the agent marker", () => {
    writeGlobal({ enabled: false })
    Config.refreshLocal()
    expect(untrustedChildEnvironment({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", VECTOR_AGENT_SESSION: "1" })
  })

  test("a nested vector keeps Local on whatever XDG_CONFIG_HOME it reads, and holds what that config adds whatever copy it finds", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    await using dir = await tmpdir()
    // The nested process reads another config folder, which turns Vector Local off and adds to it, and a state folder
    // whose copy of the block the owner let apply says the same, as the agent could write both.
    const block = { enabled: false, web: "ask", endpoints: [GPU_BOX], allow: [GITHUB] }
    mkdirSync(path.join(dir.path, "config", "vector"), { recursive: true })
    writeFileSync(path.join(dir.path, "config", "vector", "vector.json"), JSON.stringify({ local: block }))
    const env = untrustedChildEnvironment(process.env, {
      XDG_CONFIG_HOME: path.join(dir.path, "config"),
      XDG_STATE_HOME: path.join(dir.path, "state"),
    })
    const copy: string = await run(
      `
      const { Config } = await import(${CONFIG})
      process.stdout.write(JSON.stringify(Config.localConfirmedFile()) + "\\n")
      process.exit(0)
      `,
      env,
    )
    mkdirSync(path.dirname(copy), { recursive: true })
    writeFileSync(copy, JSON.stringify({ local: block }))
    const next = await start(env)
    expect(next.policy).toMatchObject({ enabled: true, web: "network", endpoints: [], allow: [] })
    expect(next.pending).toEqual([`adds the model server ${GPU_BOX}`, "allows github for any host"])
  }, 30_000)
})

describe("config-path overrides", () => {
  test("VECTOR_AGENT_CONFIG only tightens", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "agent.json")
    writeFileSync(
      file,
      JSON.stringify({ local: { enabled: false, web: "none", endpoints: [GPU_BOX], allow: [GITHUB] } }),
    )
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
    Config.refreshLocal()
    // What VECTOR_AGENT_CONFIG says when Vector starts is the baseline; an edit to it later can only tighten (below).
    const next = await start({ ...process.env, VECTOR_AGENT_CONFIG: file })
    expect(next.policy).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [{ origin: SERVER, from: "user" }],
      allow: [],
    })
    expect(next.policy.warnings).toContain(
      `Ignored enabled, endpoints, allow in the local block of ${file}: it can only make Vector Local stricter.`,
    )
    expect(next.pending).toBe(null)
  }, 30_000)

  test("editing or deleting the VECTOR_AGENT_CONFIG file after start cannot loosen Vector Local", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "agent.json")
    writeFileSync(file, JSON.stringify({ local: { web: "none" } }))
    writeGlobal({ enabled: true, web: "ask" })
    Config.refreshLocal()
    const steps = await run(
      `
      const { rmSync, writeFileSync } = await import("fs")
      const { Config } = await import(${CONFIG})
      const show = () => ({ web: Config.local().web, pending: Config.localPending()?.changes ?? null })
      const steps = [show()]
      writeFileSync(${JSON.stringify(file)}, "{}")
      Config.refreshLocal()
      steps.push(show())
      rmSync(${JSON.stringify(file)})
      Config.refreshLocal()
      steps.push(show())
      process.stdout.write(JSON.stringify(steps) + "\\n")
      process.exit(0)
      `,
      { ...process.env, VECTOR_AGENT_CONFIG: file },
    )
    expect(steps).toEqual([
      { web: "none", pending: null },
      { web: "none", pending: ["sets Web access to Ask"] },
      { web: "none", pending: ["sets Web access to Ask"] },
    ])
  }, 30_000)

  test("emptying or deleting a config folder override that turned Vector Local on is held", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "agent", "vector.json")
    mkdirSync(path.dirname(file))
    writeFileSync(file, JSON.stringify({ local: { enabled: true, web: "network" } }))
    writeGlobal({ enabled: false })
    process.env.VECTOR_AGENT_CONFIG_DIR = path.dirname(file)
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    writeFileSync(file, "{}")
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
    rmSync(file)
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
  })

  test("a VECTOR_AGENT_CONFIG_DIR that is not the desktop's own config folder only tightens", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "agent")
    mkdirSync(folder)
    writeFileSync(
      path.join(folder, "vector.json"),
      JSON.stringify({ local: { enabled: false, web: "ask", allow: [CATALOG] } }),
    )
    writeGlobal({ enabled: true, web: "none" })
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none", allow: [] })
    expect(policy.warnings).toContain(
      `Ignored enabled, web, allow in the local block of ${path.join(folder, "vector.json")}: it can only make Vector Local stricter.`,
    )
    expect(Config.localPending()).toBe(undefined)
  })

  test("the desktop's own config folder sets Vector Local, and what it adds later is held", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "userData", "config", "vector")
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, "vector.json")
    writeFileSync(file, JSON.stringify({ local: { enabled: true, endpoints: [SERVER] } }))
    process.env.VECTOR_CLIENT = "desktop"
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    try {
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, endpoints: [{ origin: SERVER, from: "user" }] })
      writeFileSync(file, JSON.stringify({ local: { enabled: true, endpoints: [SERVER, GPU_BOX] } }))
      expect(Config.refreshLocal().endpoints).toEqual([{ origin: SERVER, from: "user" }])
      expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    } finally {
      rmSync(file)
      Config.refreshLocal()
      Config.confirmLocal()
      rmSync(Config.localConfirmedFile(), { force: true })
    }
  })

  test("a config folder inside the repository Vector started in is not read", async () => {
    await using dir = await tmpdir()
    const repository = path.join(dir.path, "repository")
    const folder = path.join(repository, "agentcfg")
    mkdirSync(path.join(repository, ".git"), { recursive: true })
    mkdirSync(folder)
    writeFileSync(path.join(folder, "vector.json"), JSON.stringify({ local: { enabled: true, allow: [CATALOG] } }))
    writeGlobal({ enabled: false })
    // A repository's .envrc can name its own folder, and say the desktop started Vector.
    process.env.VECTOR_CLIENT = "desktop"
    process.env.VECTOR_AGENT_CONFIG_DIR = folder
    const previous = process.cwd()
    process.chdir(path.join(repository, ".git"))
    try {
      const policy = Config.refreshLocal()
      // Not even to tighten: a repository cannot turn Vector Local on either.
      expect(policy).toMatchObject({ enabled: false, allow: [] })
      expect(policy.warnings).toEqual([
        `Ignored ${folder}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
      ])
    } finally {
      process.chdir(previous)
    }
  })

  test("a VECTOR_AGENT_CONFIG inside the repository Vector started in is not read", async () => {
    await using dir = await tmpdir()
    const repository = path.join(dir.path, "repository")
    mkdirSync(path.join(repository, ".git"), { recursive: true })
    const file = path.join(repository, "agent.json")
    writeFileSync(file, JSON.stringify({ local: { enabled: true, web: "none" } }))
    writeGlobal({ enabled: false })
    const next = await start({ ...process.env, VECTOR_AGENT_CONFIG: file }, repository)
    expect(next.policy).toMatchObject({ enabled: false, web: "ask" })
    expect(next.policy.warnings).toEqual([
      `Ignored ${file}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
    ])
  }, 30_000)
})

describe("loosening edits wait for the owner", () => {
  test("a loosening edit to global config produces a confirmation event and does not apply until confirmed", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    expect(Config.refreshLocal().enabled).toBe(true)
    const toasts: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      if (event.payload?.type === TuiEvent.ToastShow.type) toasts.push(event)
    }
    GlobalBus.on("event", onEvent)
    const stop = Config.watchLocal()
    try {
      const change = await writeUntil(
        () => writeGlobal({ enabled: false, endpoints: [SERVER, GPU_BOX] }),
        nextChange("loosening"),
      )
      expect(change).toMatchObject({ type: "loosening", changes: ["turns Vector Local off"] })
      // Nothing loosened: the policy in effect and what children inherit stay as they were.
      expect(Config.local()).toMatchObject({ enabled: true, web: "network", endpoints: [{ origin: SERVER }] })
      expect(untrustedChildEnvironment({}).VECTOR_LOCAL).toBe("1")
      expect(Config.localPending()?.proposed.enabled).toBe(false)
      expect(toasts.map((event) => event.payload.properties.message)).toEqual([
        `A change to your config would loosen Vector Local: it turns Vector Local off. Vector applies the parts that make it stricter and holds the rest. To apply it now, confirm it with /local in the terminal UI. vector local confirm in a terminal applies it when this Vector next starts.`,
      ])

      const applied = nextChange("updated")
      Config.confirmLocal()
      expect((await applied).type).toBe("updated")
      expect(Config.local().enabled).toBe(false)
      expect(Config.localPending()).toBe(undefined)
      expect(untrustedChildEnvironment({})).toEqual({ VECTOR_AGENT_SESSION: "1" })
    } finally {
      stop()
      GlobalBus.off("event", onEvent)
    }
  })

  test("a tightening edit applies at once", async () => {
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    const stop = Config.watchLocal()
    try {
      const applied = await writeUntil(
        () => writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] }),
        nextChange("updated"),
      )
      expect(applied.type).toBe("updated")
      expect(Config.local()).toMatchObject({ web: "none", endpoints: [{ origin: SERVER }] })
      expect(Config.localPending()).toBe(undefined)
    } finally {
      stop()
    }
  })

  it.instance(
    "the config service watches while it is up",
    Effect.gen(function* () {
      writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
      Config.refreshLocal()
      yield* Config.use.get()
      const change = yield* Effect.promise(() =>
        writeUntil(
          () => writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER, GPU_BOX] }),
          nextChange("loosening"),
        ),
      )
      expect(change).toMatchObject({ changes: [`adds the model server ${GPU_BOX}`] })
      expect(Config.local().endpoints).toEqual([{ origin: SERVER, from: "user" }])
    }),
  )

  test("an edit made while Vector is closed is held at the next start", async () => {
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8"))).toEqual({
      local: { enabled: true, web: "none", endpoints: [SERVER] },
    })
    writeGlobal({
      enabled: true,
      web: "ask",
      endpoints: [SERVER, GPU_BOX],
      allow: [GITHUB],
      web_domains: { allow: ["docs.example.com"] },
    })
    const next = await start(process.env)
    expect(next.policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER }], allow: [] })
    expect(next.pending).toEqual([
      "sets Web access to Ask",
      `adds the model server ${GPU_BOX}`,
      "allows github for any host",
      "lets web pages reach docs.example.com",
    ])
  }, 30_000)

  test("at start, a missing or unreadable copy counts as the user's block at start, so starting without it applies a held edit", async () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    writeGlobal({ enabled: true, endpoints: [SERVER, GPU_BOX], allow: [CATALOG] })
    expect((await start(process.env)).pending).toEqual([
      `adds the model server ${GPU_BOX}`,
      "allows catalog for any host",
    ])
    // What the held change tells the owner to do, with Vector Local on through the user's config or the environment.
    for (const copy of [undefined, "garbage", JSON.stringify({ local: { enabled: "yes" } })]) {
      rmSync(Config.localConfirmedFile(), { force: true })
      if (copy) writeFileSync(Config.localConfirmedFile(), copy)
      const next = await start({ ...process.env, VECTOR_LOCAL: "1" })
      expect(next.policy).toMatchObject({
        enabled: true,
        endpoints: [
          { origin: SERVER, from: "user" },
          { origin: GPU_BOX, from: "user" },
        ],
        allow: [CATALOG],
      })
      expect(next.pending).toBe(null)
    }
  }, 60_000)

  test("under the agent marker the copy is never read, so the user's config only tightens the floor", async () => {
    writeGlobal({ endpoints: [GPU_BOX], allow: [CATALOG] })
    // A copy that lists what the config adds, as a program the agent started could write it.
    writeFileSync(Config.localConfirmedFile(), JSON.stringify({ local: { endpoints: [GPU_BOX], allow: [CATALOG] } }))
    const copy = readFileSync(Config.localConfirmedFile(), "utf8")
    const next = await start({ ...process.env, VECTOR_LOCAL: "1", VECTOR_AGENT_SESSION: "1" })
    expect(next.policy).toMatchObject({ enabled: true, endpoints: [], allow: [] })
    expect(next.pending).toEqual([`adds the model server ${GPU_BOX}`, "allows catalog for any host"])
    // Nor written.
    expect(readFileSync(Config.localConfirmedFile(), "utf8")).toBe(copy)
  }, 30_000)

  test("a nested vector cannot launder an edit that the next start would hold", async () => {
    writeGlobal({ enabled: true, web: "network" })
    Config.refreshLocal()
    // The agent turns Vector Local off in the user's config, then runs vector with the floor every child gets, with
    // the agent marker and without it. The floor keeps Local on in both, so neither changes anything in effect.
    writeGlobal({ enabled: false, web: "ask" })
    const floor = { VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "network" }
    const marked = await start({ ...process.env, ...floor, VECTOR_AGENT_SESSION: "1" })
    expect(marked.policy).toMatchObject({ enabled: true, web: "network" })
    const unmarked = await start({ ...process.env, ...floor })
    expect(unmarked.policy).toMatchObject({ enabled: true, web: "network" })
    expect(unmarked.pending).toEqual(["turns Vector Local off"])
    // Neither saved the edit as the block the next start compares with.
    expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8")).local).toMatchObject({
      enabled: true,
      web: "network",
    })
    const next = await start(process.env)
    expect(next.policy).toMatchObject({ enabled: true, web: "network" })
    expect(next.pending).toEqual(["turns Vector Local off"])
  }, 60_000)

  test("deleting or corrupting the saved copy while Vector runs changes nothing", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    rmSync(Config.localConfirmedFile())
    writeGlobal({ enabled: false })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
    writeFileSync(Config.localConfirmedFile(), "garbage")
    // The held edit took the server off the list, which applied, so listing it again waits too.
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER], allow: [GITHUB] })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network", endpoints: [], allow: [] })
    expect(Config.localPending()?.changes).toEqual([
      "sets Web access to Ask",
      `adds the model server ${SERVER}`,
      "allows github for any host",
    ])
  })

  for (const via of ["VECTOR_LOCAL", "company policy"] as const)
    test(`with Vector Local on through ${via} and no local block of the user's, what the user adds is held`, () => {
      if (via === "VECTOR_LOCAL") {
        process.env.VECTOR_LOCAL = "1"
        process.env.VECTOR_LOCAL_WEB = "network"
      }
      if (via === "company policy") writeManaged({ local: { enabled: true, web: "network" } })
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
      writeGlobal({ allow: [CATALOG], endpoints: [GPU_BOX], web_domains: { allow: ["*.example.com"] } })
      expect(Config.refreshLocal()).toMatchObject({
        enabled: true,
        web: "network",
        endpoints: [],
        allow: [],
        web_domains: { allow: [] },
      })
      expect(Config.localPending()?.changes).toEqual([
        `adds the model server ${GPU_BOX}`,
        "allows catalog for any host",
        "lets web pages reach *.example.com",
      ])
    })

  for (const via of ["VECTOR_LOCAL", "company policy"] as const)
    test(`with Vector Local on through ${via}, turning the user's own block off is held, so the saved copy keeps it`, () => {
      if (via === "VECTOR_LOCAL") {
        process.env.VECTOR_LOCAL = "1"
        process.env.VECTOR_LOCAL_WEB = "network"
      }
      if (via === "company policy") writeManaged({ local: { enabled: true, web: "network" } })
      writeGlobal({ enabled: true, web: "network" })
      Config.refreshLocal()
      // Nothing changes in effect, but a start without that environment or policy would turn Vector Local off.
      writeGlobal({ enabled: false, web: "ask" })
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
      expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
      expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8")).local).toMatchObject({
        enabled: true,
        web: "network",
      })
    })

  test("an edit that tightens one setting and loosens another applies the tightening and holds the rest", () => {
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER], web_domains: { deny: ["ads.example"] } })
    Config.refreshLocal()
    writeGlobal({
      enabled: true,
      web: "none",
      endpoints: [SERVER, GPU_BOX],
      web_domains: { deny: ["tracker.example"] },
    })
    expect(Config.refreshLocal()).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [{ origin: SERVER, from: "user" }],
      web_domains: { deny: ["ads.example", "tracker.example"] },
    })
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`, "stops blocking ads.example"])
    // Undoing the part that applied is a loosening of its own.
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER, GPU_BOX], web_domains: { deny: ["tracker.example"] } })
    expect(Config.refreshLocal()).toMatchObject({ web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(Config.localPending()?.changes).toEqual([
      "sets Web access to Ask",
      `adds the model server ${GPU_BOX}`,
      "stops blocking ads.example",
    ])
    // Confirming applies the edit as written.
    Config.confirmLocal()
    expect(Config.local()).toMatchObject({
      web: "ask",
      endpoints: [
        { origin: SERVER, from: "user" },
        { origin: GPU_BOX, from: "user" },
      ],
      web_domains: { deny: ["tracker.example"] },
    })
    expect(Config.localPending()).toBe(undefined)
  })

  it.instance(
    "a change held before anything listened is announced once a repository's config loads",
    Effect.gen(function* () {
      writeGlobal({ enabled: true, endpoints: [SERVER] })
      Config.refreshLocal()
      // Held with nothing listening, as a change held at start is: the first resolution runs when Vector loads.
      writeGlobal({ enabled: true, endpoints: [SERVER, GPU_BOX] })
      Config.refreshLocal()
      const toasts: string[] = []
      const onEvent = (event: GlobalEvent) => {
        if (event.payload?.type === TuiEvent.ToastShow.type) toasts.push(event.payload.properties.message)
      }
      GlobalBus.on("event", onEvent)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))
      yield* Config.use.get()
      expect(toasts).toEqual([
        `A change to your config would loosen Vector Local: it adds the model server ${GPU_BOX}. Vector applies the parts that make it stricter and holds the rest. To apply it now, confirm it with /local in the terminal UI. vector local confirm in a terminal applies it when this Vector next starts.`,
      ])
    }),
  )

  test("under the agent marker, Vector never saves the copy and cannot confirm a held change", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    const copy = readFileSync(Config.localConfirmedFile(), "utf8")
    process.env.VECTOR_AGENT_SESSION = "1"
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER] })
    expect(Config.refreshLocal().web).toBe("none")
    expect(readFileSync(Config.localConfirmedFile(), "utf8")).toBe(copy)
    writeGlobal({ enabled: true, endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    Config.confirmLocal()
    expect(Config.local()).toMatchObject({ web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(Config.localPending()?.changes).toEqual(["sets Web access to Ask", `adds the model server ${GPU_BOX}`])
  })

  test("deleting the user's config is held too", () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    rmSync(globalFile)
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "network" })
    expect(Config.localPending()?.changes).toEqual(["turns Vector Local off"])
  })

  test("the owner's confirmation stands when the files are read again before the change is written", () => {
    writeGlobal({ enabled: true, web: "network" })
    Config.refreshLocal()
    const release = Config.confirmingLocal({ enabled: true, web: "network", endpoints: [SERVER] })
    // The watcher, or a catalog the provider service loads, can resolve the files while the Local API writes them.
    expect(Config.refreshLocal().endpoints).toEqual([])
    expect(Config.localConfirmedBlock()).toEqual({ enabled: true, web: "network", endpoints: [SERVER] })
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    release()
    expect(Config.localPending()).toBe(undefined)
    expect(Config.local().endpoints).toEqual([{ origin: SERVER, from: "user" }])
    // Once the write has applied it, the files decide again: a later edit that loosens is held as before.
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
  })

  test("a confirmation whose write never lands lets the files decide", () => {
    writeGlobal({ enabled: true, web: "network" })
    Config.refreshLocal()
    const release = Config.confirmingLocal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    release()
    expect(Config.localConfirmedBlock()).toEqual({ enabled: true, web: "network" })
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${SERVER}`])
    expect(Config.local().endpoints).toEqual([])
  })

  test("a company change applies without asking", () => {
    writeManaged({ local: { enabled: true, web: "none" } })
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "none" })
    rmSync(managedDirectory, { recursive: true })
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localPending()).toBe(undefined)
  })

  test("the held change says how to apply it from where this Vector runs", () => {
    expect(Config.localHeldAdvice()).toBe(
      "To apply it now, confirm it with /local in the terminal UI. vector local confirm in a terminal applies it when this Vector next starts.",
    )
    // The desktop app applies a held change itself, from Settings > Vector Local.
    process.env.VECTOR_CLIENT = "desktop"
    expect(Config.localHeldAdvice()).toBe("To apply it, open Settings → Vector Local and choose Review and apply.")
    process.env.VECTOR_AGENT_SESSION = "1"
    expect(Config.localHeldAdvice()).toBe(
      "An agent or Vector's own terminal started this Vector, so it cannot apply a change like this.",
    )
  })

  test("a confirmation another Vector records stands: this one never writes over it, and the next start applies it", async () => {
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER] })
    Config.refreshLocal()
    writeGlobal({ enabled: true, web: "network", endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    // vector local confirm in a terminal: a process of its own confirms the held change and records it.
    const listed = await run(
      `
      const { Config } = await import(${CONFIG})
      Config.confirmLocal()
      process.stdout.write(JSON.stringify(Config.local().endpoints.length) + "\\n")
      process.exit(0)
      `,
      process.env,
    )
    expect(listed).toBe(2)
    const copy = readFileSync(Config.localConfirmedFile(), "utf8")
    // This Vector still holds it, and what it tightens since does not write over that copy.
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER, GPU_BOX] })
    expect(Config.refreshLocal()).toMatchObject({ web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    expect(readFileSync(Config.localConfirmedFile(), "utf8")).toBe(copy)
    const next = await start(process.env)
    expect(next.pending).toBe(null)
    expect(next.policy).toMatchObject({
      web: "none",
      endpoints: [
        { origin: SERVER, from: "user" },
        { origin: GPU_BOX, from: "user" },
      ],
    })
  }, 30_000)

  test("turning Vector Local on holds what the user's block lets reach the internet until the owner confirms it", () => {
    const internet = "https://models.example.com"
    const block = { endpoints: [SERVER, internet], allow: [GITHUB], web_domains: { allow: ["docs.example.com"] } }
    // Nothing is held while Vector Local is off, so anything could have written these.
    writeGlobal(block)
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localPending()).toBe(undefined)
    writeGlobal({ ...block, enabled: true, web: "network" })
    expect(Config.refreshLocal()).toMatchObject({
      enabled: true,
      web: "network",
      endpoints: [{ origin: SERVER, from: "user" }],
      allow: [],
      web_domains: { allow: [] },
    })
    expect(Config.localPending()?.changes).toEqual([
      `adds the model server ${internet}`,
      "allows github for any host",
      "lets web pages reach docs.example.com",
    ])
    Config.confirmLocal()
    expect(Config.local()).toMatchObject({
      endpoints: [
        { origin: SERVER, from: "user" },
        { origin: internet, from: "user" },
      ],
      allow: [GITHUB],
      web_domains: { allow: ["docs.example.com"] },
    })
    expect(Config.localPending()).toBe(undefined)
  })

  test("a new identity pin for a server on the list, or none, is held, and the server keeps the one it had", () => {
    const pin = { kind: "ollama", version: "0.12.6", models: "sha256:aaa" }
    writeGlobal({ enabled: true, endpoints: [SERVER], pins: { [SERVER]: pin } })
    expect(Config.refreshLocal().pins).toEqual({ [SERVER]: pin })
    writeGlobal({ enabled: true, endpoints: [SERVER], pins: { [SERVER]: { ...pin, version: "9.9.9" } } })
    expect(Config.refreshLocal().pins).toEqual({ [SERVER]: pin })
    expect(Config.localPending()?.changes).toEqual([`accepts a new identity for ${SERVER}`])
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    expect(Config.refreshLocal().pins).toEqual({ [SERVER]: pin })
    expect(Config.localPending()?.changes).toEqual([`stops checking the identity of ${SERVER}`])
    // The same pin written in another order is no new identity, and pinning a server for the first time tightens.
    writeGlobal({
      enabled: true,
      endpoints: [SERVER, GPU_BOX],
      pins: { [SERVER]: { models: pin.models, version: pin.version, kind: pin.kind } },
    })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
  })

  test("under the agent marker, what would loosen Vector Local once it is on counts while it is off", () => {
    writeGlobal({ endpoints: [SERVER] })
    expect(Config.refreshLocal().enabled).toBe(false)
    expect(Config.localLoosening({ endpoints: [SERVER, GPU_BOX], allow: [GITHUB] })).toEqual([])
    process.env.VECTOR_AGENT_SESSION = "1"
    expect(Config.localLoosening({ endpoints: [SERVER, GPU_BOX], allow: [GITHUB] })).toEqual([
      `adds the model server ${GPU_BOX}`,
      "allows github for any host",
    ])
    // Turning it on, or a stricter Web access, still only tightens.
    expect(Config.localLoosening({ enabled: true, web: "none", endpoints: [SERVER] })).toEqual([])
  })

  test.skipIf(process.platform === "win32")("the confirmed block is readable by the user only", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    expect(statSync(Config.localConfirmedFile()).mode & 0o777).toBe(0o600)
  })
})

// Root reads any file, and Windows has no mode bits to take away.
const unreadable = process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test

describe("sources Vector cannot read", () => {
  unreadable("a user config Vector cannot read keeps the last block in effect, with no web while Local is on", () => {
    writeGlobal({ enabled: true, web: "ask", endpoints: [SERVER] })
    Config.refreshLocal()
    chmodSync(globalFile, 0o000)
    try {
      const policy = Config.refreshLocal()
      expect(policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER }] })
      expect(policy.warnings).toEqual([
        `Vector could not read ${globalFile}.`,
        `Vector Local stays on with Web access None until Vector can read ${globalFile}.`,
      ])
      expect(Config.localPending()).toBe(undefined)
    } finally {
      chmodSync(globalFile, 0o644)
    }
    expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "ask", warnings: [] })
  })

  unreadable("a company policy file Vector cannot read or check turns Local on with Web access None", () => {
    writeGlobal({ endpoints: [SERVER] })
    Config.refreshLocal()
    writeManaged({ local: { enabled: true, endpoints: [GPU_BOX] } })
    const file = path.join(managedDirectory, "vector.json")
    chmodSync(file, 0o000)
    try {
      // Vector Local was off for this user, and the policy might turn it on: it is on, and the pane says why.
      const policy = Config.refreshLocal()
      expect(policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
      expect(policy.warnings).toHaveLength(2)
      // Depending on the platform, the metadata check or the subsequent file read reports the denial.
      expect(policy.warnings[0]).toMatch(/^Vector could not (?:read|check who may change) /)
      expect(policy.warnings[0]).toContain(file)
      expect(policy.warnings[1]).toBe(
        `Vector Local stays on with Web access None until Vector can read ${file}, which may hold your company's policy.`,
      )
    } finally {
      chmodSync(file, 0o644)
    }
    expect(Config.refreshLocal()).toMatchObject({
      enabled: true,
      web: "ask",
      endpoints: [
        { origin: GPU_BOX, from: "managed" },
        { origin: SERVER, from: "user" },
      ],
      warnings: [],
    })
  })

  test("a company policy file that is a folder turns Local on with Web access None", () => {
    const file = path.join(managedDirectory, "vector.json")
    mkdirSync(file, { recursive: true })
    managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)
    const policy = Config.refreshLocal()
    expect(policy).toMatchObject({ enabled: true, web: "none" })
    expect(policy.warnings).toEqual([
      `Vector could not read ${file}.`,
      `Vector Local stays on with Web access None until Vector can read ${file}, which may hold your company's policy.`,
    ])
  })

  test("on Windows the fixture lets only SYSTEM change a company policy folder named vector.json, so reading it fails", () => {
    const file = path.join(managedDirectory, "vector.json")
    mkdirSync(file, { recursive: true })
    managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)
    // The folder test's warnings must come from reading the folder, never from a failed ACL read of it.
    expect(ConfigManaged.check(file, { platform: "win32", acl: managedPolicyAcl(managedDirectory), user: true })).toBe(
      undefined,
    )
    expect(
      managedPolicyAcl(managedDirectory)([managedDirectory, file, path.join(managedDirectory, "other.json")]),
    ).toEqual({
      entries: { [managedDirectory]: { owner: "S-1-5-18", rules: [] }, [file]: { owner: "S-1-5-18", rules: [] } },
    })
  })
})

describe("an edit that loosens one part and tightens another", () => {
  test("replacing a model server blocks the old one at once and holds the new one", () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX] })
    Config.refreshLocal()
    expect(inference(GPU_BOX)).toBe("allow")

    writeGlobal({ enabled: true, endpoints: [OTHER_BOX] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${OTHER_BOX}`])
    expect(Config.local().endpoints).toEqual([])
    expect(Egress.policy()).toBe(Config.local())
    expect(inference(GPU_BOX)).toBe("block")
    expect(inference(OTHER_BOX)).toBe("block")

    Config.confirmLocal()
    expect(Config.local().endpoints).toEqual([{ origin: OTHER_BOX, from: "user" }])
    expect(inference(OTHER_BOX)).toBe("allow")
    expect(inference(GPU_BOX)).toBe("block")
  })

  test("Web access None with a new model server: None applies at once and the server waits", () => {
    writeGlobal({ enabled: true, endpoints: [SERVER] })
    Config.refreshLocal()
    expect(Egress.decide(PAGE).decision).toBe("allow")

    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    expect(Config.local()).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(Egress.decide(PAGE).decision).toBe("block")
    expect(inference(GPU_BOX)).toBe("block")
    expect(untrustedChildEnvironment({}).VECTOR_LOCAL_WEB).toBe("none")
  })

  test("a site the edit denies and a service it allows: the denial applies at once", () => {
    writeGlobal({ enabled: true, web_domains: { deny: ["ads.example"] } })
    Config.refreshLocal()
    writeGlobal({ enabled: true, web_domains: { deny: ["docs.example.com"] }, allow: [GITHUB] })
    Config.refreshLocal()
    expect(Config.localPending()?.changes).toEqual(["allows github for any host", "stops blocking ads.example"])
    expect(Config.local()).toMatchObject({ allow: [], web_domains: { deny: ["ads.example", "docs.example.com"] } })
    expect(Egress.decide(PAGE).decision).toBe("block")
  })

  test("listing a server again that a held edit removed is held too", () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX] })
    Config.refreshLocal()
    writeGlobal({ enabled: true, endpoints: [OTHER_BOX] })
    Config.refreshLocal()
    writeGlobal({ enabled: true, endpoints: [GPU_BOX, OTHER_BOX] })
    Config.refreshLocal()
    expect(Config.local().endpoints).toEqual([])
    expect(Config.localPending()?.changes).toEqual([
      `adds the model server ${GPU_BOX}`,
      `adds the model server ${OTHER_BOX}`,
    ])
  })

  test("what applied still applies after a restart, and what was held is still held", async () => {
    writeGlobal({ enabled: true, endpoints: [SERVER, GPU_BOX] })
    Config.refreshLocal()
    writeGlobal({ enabled: true, web: "none", endpoints: [SERVER, OTHER_BOX] })
    Config.refreshLocal()
    expect(JSON.parse(readFileSync(Config.localConfirmedFile(), "utf8")).local).toMatchObject({
      enabled: true,
      web: "none",
      endpoints: [SERVER],
    })

    const next = await decisions(process.env)
    expect(next.policy).toMatchObject({ enabled: true, web: "none", endpoints: [{ origin: SERVER, from: "user" }] })
    expect(next.pending).toEqual([`adds the model server ${OTHER_BOX}`])
    expect(next.servers).toEqual(["allow", "block", "block"])
    expect(next.page).toBe("block")
  }, 30_000)
})

describe("the network log", () => {
  test("a folder Vector cannot use keeps Vector Local on, logs in memory and says so, at start and later", async () => {
    rmSync(logDirectory, { recursive: true, force: true })
    mkdirSync(path.dirname(logDirectory), { recursive: true })
    writeFileSync(logDirectory, "not a folder")
    const warning = `Vector could not write its network log in ${logDirectory}`
    try {
      writeGlobal({ enabled: true, web: "none" })
      const started = await start(process.env)
      expect(started.policy).toMatchObject({ enabled: true, web: "none" })
      expect(started.policy.warnings).toHaveLength(1)
      expect(started.policy.warnings[0]).toStartWith(warning)

      // The watcher's path: the edit applies, and the warning is part of the policy in effect.
      const policy = Config.refreshLocal()
      expect(policy).toMatchObject({ enabled: true, web: "none" })
      expect(policy.warnings).toHaveLength(1)
      expect(policy.warnings[0]).toStartWith(warning)
      expect(policy.warnings[0]).toEndWith(
        "so it keeps this session's log in memory only. It tries again the next time it reads its settings.",
      )
      expect(Egress.policy()).toBe(Config.local())
      Egress.decide({ source: "model-catalog", url: "https://models.dev/api.json" })
      expect((await Egress.exported()).at(-1)).toMatchObject({ source: "model-catalog", decision: "block" })

      // Once the folder can be used, the next read of the settings writes the log there.
      rmSync(logDirectory)
      expect(Config.refreshLocal().warnings).toEqual([])
      Egress.decide({ source: "model-catalog", url: "https://models.dev/api.json" })
      await Egress.exported()
      expect(existsSync(dated(0))).toBe(true)
    } finally {
      await Egress.erase()
      rmSync(logDirectory, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")(
    "a shorter log in the user's config waits for the owner, and a longer one applies at once",
    async () => {
      mkdirSync(logDirectory, { recursive: true })
      try {
        writeGlobal({ enabled: true, web: "none" })
        Config.refreshLocal()
        writeFileSync(dated(10), "")
        writeGlobal({ enabled: true, web: "none", log: { retain_days: 1 } })
        Config.refreshLocal()
        expect(Config.localPending()?.changes).toEqual(["keeps the network log 1 day instead of 30 days"])
        expect(existsSync(dated(10))).toBe(true)

        writeFileSync(dated(45), "")
        writeFileSync(dated(70), "")
        writeGlobal({ enabled: true, web: "none", log: { retain_days: 60 } })
        Config.refreshLocal()
        expect(Config.localPending()).toBe(undefined)
        expect(existsSync(dated(45))).toBe(true)
        expect(existsSync(dated(70))).toBe(false)
      } finally {
        await Egress.erase()
        rmSync(logDirectory, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform === "win32")(
    "under a company lock, the user's log setting does not apply, and a shorter one is still held",
    async () => {
      mkdirSync(logDirectory, { recursive: true })
      try {
        writeManaged({ local: { lock: true } })
        Config.refreshLocal()
        writeFileSync(dated(10), "")
        writeGlobal({ log: { retain_days: 2 } })
        Config.refreshLocal()
        // The lock leaves the user's setting out, so the log keeps 30 days. The edit is held all the same, so it never
        // becomes the block a later start compares with once the lock is gone.
        expect(existsSync(dated(10))).toBe(true)
        expect(Config.localPending()?.changes).toEqual(["keeps the network log 2 days instead of 30 days"])
        // A longer log loosens nothing.
        writeGlobal({ log: { retain_days: 60 } })
        Config.refreshLocal()
        expect(Config.localPending()).toBe(undefined)
        expect(existsSync(dated(10))).toBe(true)
      } finally {
        await Egress.erase()
        rmSync(logDirectory, { recursive: true, force: true })
      }
    },
  )
})

describe("cloud AI services the model catalog lists", () => {
  // A host no real catalog lists: the cloud hosts of every catalog this process read stay known for good, so a real
  // provider's host would already count as a cloud AI service whenever an earlier test file loaded the catalog.
  const LLAMA = "https://api.cloud-ai.example"

  test("cannot be one of the user's model servers, and a catalog Vector loads applies that at once", () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX] })
    Config.refreshLocal()
    // Not in the registry's list, and this build carries no catalog of its own, so it is a server like any other.
    writeGlobal({ enabled: true, endpoints: [GPU_BOX, LLAMA] })
    Config.refreshLocal()
    Config.confirmLocal()
    expect(Config.local().endpoints.map((item) => item.origin)).toEqual([GPU_BOX, LLAMA])
    expect(inference(LLAMA)).toBe("allow")

    Config.localCatalog({ llama: { api: `${LLAMA}/compat/v1/` } })
    expect(Config.localPending()).toBe(undefined)
    expect(Config.local().endpoints).toEqual([{ origin: GPU_BOX, from: "user" }])
    expect(Config.local().warnings).toContain(
      `Ignored ${LLAMA}: it is a cloud AI service, not a server you host. Your company's policy can list it.`,
    )
    expect(inference(LLAMA)).toBe("block")
    expect(inference(GPU_BOX)).toBe("allow")

    // A company can still list it.
    writeManaged({ local: { endpoints: [LLAMA] } })
    expect(Config.refreshLocal().endpoints).toContainEqual({ origin: LLAMA, from: "managed" })
    expect(inference(LLAMA)).toBe("allow")
  })

  test("the catalog a build carries applies from the start", async () => {
    writeGlobal({ enabled: true, endpoints: [GPU_BOX, LLAMA] })
    // A build substitutes its catalog for VECTOR_MODEL_CATALOG, as --define does here.
    const catalog = JSON.stringify({ llama: { api: `${LLAMA}/compat/v1/` } })
    const next = await start(process.env, undefined, ["--define", `VECTOR_MODEL_CATALOG=${catalog}`])
    expect(next.policy.endpoints).toEqual([{ origin: GPU_BOX, from: "user" }])
    expect(next.policy.warnings).toContain(
      `Ignored ${LLAMA}: it is a cloud AI service, not a server you host. Your company's policy can list it.`,
    )
    expect(next.pending).toBe(null)
  }, 30_000)
})

describe("what counts as loosening", () => {
  const on = LocalPolicy.resolve({ global: { enabled: true, web: "network", endpoints: [SERVER] } })

  test("turning Local on, a stricter Web access, fewer servers or more denied sites only tighten", () => {
    const off = LocalPolicy.resolve({})
    expect(Config.loosening(off, on)).toEqual([])
    expect(Config.loosening(on, LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))).toEqual([])
    expect(
      Config.loosening(
        on,
        LocalPolicy.resolve({
          global: { enabled: true, web: "network", endpoints: [SERVER], web_domains: { deny: ["ads.example"] } },
        }),
      ),
    ).toEqual([])
  })

  test("a site no longer denied loosens", () => {
    const denying = LocalPolicy.resolve({ global: { enabled: true, web_domains: { deny: ["ads.example"] } } })
    expect(Config.loosening(denying, LocalPolicy.resolve({ global: { enabled: true } }))).toEqual([
      "stops blocking ads.example",
    ])
  })
})

describe("an organization's config", () => {
  const ORG = "https://org.example.invalid"
  const org = testEffect(
    LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
      [
        Auth.node,
        Layer.mock(Auth.Service)({
          all: () =>
            Effect.succeed({ [ORG]: new Auth.WellKnown({ type: "wellknown", key: "ORG_TOKEN", token: "org-token" }) }),
        }),
      ],
      [Npm.node, NpmTest.noop],
      [httpClient, FetchHttpClient.layer],
    ]),
  )

  org.instance(
    "is read as remote config, and while Vector Local blocks it the rest of the config still loads",
    Effect.gen(function* () {
      writeGlobal({ enabled: true })
      Config.refreshLocal()
      const config = yield* Config.use.get()
      expect(config.model).toBe("repository/model")
      expect(Egress.events().filter((event) => event.source === "remote-config" && event.origin === ORG)).toEqual([
        expect.objectContaining({ decision: "block", purpose: "config-remote" }),
      ])
    }),
    { trusted: true, config: { model: "repository/model" } },
  )
})
