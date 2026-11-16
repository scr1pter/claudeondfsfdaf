import { afterEach, beforeEach, expect, test } from "bun:test"
import { CODIUM_AUTO_ROLES, CODIUM_TIER_MODELS } from "../../../api/_lib/codium-catalog"
import { artifactCryptoReady } from "../../../api/_lib/cloud-agents-artifact"
import { brainUploadCryptoReady } from "../../../api/_lib/cloud-agents-brain"
import { createCloudAgentsReadiness } from "../../../api/_lib/cloud-agents-readiness"
import { runTokenCryptoReady } from "../../../api/_lib/cloud-agents-run-crypto"
import type { ModelPlanModel } from "../../../api/_lib/model-plan-config"
import { githubAppFixture } from "./github-app-fixture"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"

const KEYS = {
  VECTOR_RUN_TOKEN_SECRET: "fixture-run-readiness-secret-32-characters",
  VECTOR_RUN_ARTIFACT_SECRET: "fixture-artifact-readiness-secret-32-characters",
}
const BRAIN = { ...KEYS, VECTOR_GITHUB_BRAIN_ENABLED: "true", CODIUM_TRACK_B_LIVE: "true" }
const model = CODIUM_TIER_MODELS.find((entry) => entry.id === CODIUM_AUTO_ROLES["vector-10"].floor)!
const accepted = (candidate: ModelPlanModel) => candidate.id === model.id
const catalog = { models: [model], qualify: accepted }
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    VECTOR_RUN_TOKEN_SECRET: undefined,
    VECTOR_RUN_ARTIFACT_SECRET: undefined,
    VECTOR_LICENSE_SECRET: undefined,
    VECTOR_GITHUB_BRAIN_ENABLED: undefined,
    CODIUM_TRACK_B_LIVE: undefined,
  })
})
afterEach(() => restore())

function transport() {
  const fake = codiumFakes()
  const state = { pong: "PONG" as unknown, down: false }
  const commands: unknown[][] = []
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe(new URL(process.env.KV_REST_API_URL!).origin)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-kv-token")
    const command: unknown = JSON.parse(String(init?.body))
    if (!Array.isArray(command)) throw new Error("Expected protected-store protocol")
    expect(["PING", "SMEMBERS"]).toContain(command[0])
    commands.push(command)
    if (state.down) return new Response("fixture unavailable", { status: 503 })
    if (command[0] === "PING") return Response.json({ result: state.pong })
    return fake.fetcher(input, init)
  }, fake.fetcher)
  return { fake, state, commands, fetcher }
}

test("real HMAC, separated artifact derivation and synthetic key-wrap probes return booleans only", () => {
  const ports = [runTokenCryptoReady, artifactCryptoReady, brainUploadCryptoReady]
  expect(ports.map((port) => port({}))).toEqual([false, false, false])
  expect(ports.map((port) => port({ VECTOR_LICENSE_SECRET: "x".repeat(31) }))).toEqual([false, false, false])
  for (const env of [
    KEYS,
    { VECTOR_LICENSE_SECRET: "fixture-license-readiness-secret-32-characters" },
    {
      ...KEYS,
      VECTOR_RUN_TOKEN_SECRET: "rotated-fixture-run-readiness-secret",
      VECTOR_RUN_ARTIFACT_SECRET: "rotated-fixture-artifact-readiness-secret",
    },
  ]) {
    const result = ports.map((port) => port(env))
    expect(result).toEqual([true, true, true])
    expect(JSON.stringify(result)).toBe("[true,true,true]")
  }
  expect(runTokenCryptoReady({ VECTOR_RUN_TOKEN_SECRET: "x".repeat(31) })).toBe(false)
  expect(artifactCryptoReady({ VECTOR_RUN_ARTIFACT_SECRET: "x".repeat(31) })).toBe(false)
  expect(brainUploadCryptoReady({ VECTOR_RUN_ARTIFACT_SECRET: "x".repeat(31) })).toBe(false)
})

test("an actual ephemeral App JWT verifies only fixed App identity, never an installation or dispatch", async () => {
  await using github = await githubAppFixture()
  expect(await github.app.readiness()).toBe(true)
  expect(github.state.requests).toEqual(["/app"])
  github.state.appId++
  expect(await github.app.readiness()).toBe(false)
  github.state.appId = Number(github.config.id)
  github.state.appSlug = "wrong-app"
  expect(await github.app.readiness()).toBe(false)
  github.state.appSlug = github.config.slug
  github.state.enabled = false
  const before = github.state.requests.length
  expect(await github.app.readiness()).toBe(false)
  expect(github.state.requests).toHaveLength(before)
  github.state.enabled = true
  github.config.privateKey = "invalid-fixture-key"
  expect(await github.app.readiness()).toBe(false)
  expect(github.state.requests).toHaveLength(before)
  expect(github.state.minted).toEqual([])
  expect(github.state.dispatches).toEqual([])
  expect(github.tokens.size).toBe(0)
})

test("App outages and redirects fail closed without following a caller-selected destination", async () => {
  await using github = await githubAppFixture()
  github.state.failPath = "/app"
  expect(await github.app.readiness()).toBe(false)
  github.state.failPath = ""
  github.state.redirectPath = "/app"
  expect(await github.app.readiness()).toBe(false)
  expect(github.state.requests).toEqual(["/app", "/app"])
  expect(github.state.minted).toEqual([])
})

test("actual store protocol and qualified usable catalogs prove base dependency availability without App authority", async () => {
  await using github = await githubAppFixture()
  const io = transport()
  const ready = createCloudAgentsReadiness({ app: github.app, env: KEYS, catalog })
  expect(await ready.agents(io.fetcher)).toBe(true)
  expect(github.state.requests).toEqual([])
  expect(await ready.noSecret(io.fetcher)).toBe(true)
  expect(github.state.requests).toEqual(["/app"])
  github.state.enabled = false
  expect(await ready.agents(io.fetcher)).toBe(true)
  expect(await ready.noSecret(io.fetcher)).toBe(false)
  expect(io.commands.some(([command]) => command === "PING")).toBe(true)
  expect(io.fake.openRouter.calls).toEqual([])
  expect(io.fake.stripe.calls).toEqual([])
  expect(github.state.dispatches).toEqual([])
  expect(github.state.minted).toEqual([])
})

test("wrong store replies, outages and absent signing material cannot manufacture readiness", async () => {
  const io = transport()
  const missing = createCloudAgentsReadiness({ env: {}, catalog })
  expect(await missing.agents(io.fetcher)).toBe(false)
  expect(io.commands).toEqual([])
  const ready = createCloudAgentsReadiness({ env: KEYS, catalog })
  for (const pong of [null, true, "OK", ["PONG"]]) {
    io.state.pong = pong
    expect(await ready.agents(io.fetcher)).toBe(false)
  }
  io.state.pong = "PONG"
  io.state.down = true
  expect(await ready.agents(io.fetcher)).toBe(false)
  expect(io.fake.openRouter.calls).toEqual([])
  expect(io.fake.stripe.calls).toEqual([])
})

test("unaccepted, missing, manual-only or locked catalogs do not become available from an enable flag", async () => {
  const io = transport()
  for (const selected of [
    { models: [], qualify: accepted },
    { models: [model], qualify: () => false },
    { models: [{ ...model, manualOnly: true as const }], qualify: accepted },
    { models: [{ ...model, minPlan: "vector-200" as const }], qualify: accepted },
  ])
    expect(await createCloudAgentsReadiness({ env: BRAIN, catalog: selected }).agents(io.fetcher)).toBe(false)
  expect(await createCloudAgentsReadiness({ env: KEYS }).agents(io.fetcher)).toBe(false)
  expect(io.fake.openRouter.calls).toEqual([])
})

test("Brain transport requires its independent gates and real App but no helper selector or listed-brain parent", async () => {
  await using github = await githubAppFixture()
  const io = transport()
  // This usable fixture model is not a Codium Auto/helper role. Approved context/import needs no helper inference.
  const repositoryModel = { ...model, id: "fixture-repository-model" }
  const ordinary = { models: [repositoryModel], qualify: (entry: ModelPlanModel) => entry.id === repositoryModel.id }
  for (const env of [
    KEYS,
    { ...BRAIN, VECTOR_GITHUB_BRAIN_ENABLED: "false" },
    { ...BRAIN, CODIUM_TRACK_B_LIVE: "false" },
  ]) {
    expect(await createCloudAgentsReadiness({ app: github.app, env, catalog: ordinary }).brainCloud(io.fetcher)).toBe(
      false,
    )
  }
  expect(io.commands).toEqual([])
  expect(github.state.requests).toEqual([])
  expect(
    await createCloudAgentsReadiness({ app: github.app, env: BRAIN, catalog: ordinary }).brainCloud(io.fetcher),
  ).toBe(true)
  github.state.enabled = false
  expect(
    await createCloudAgentsReadiness({ app: github.app, env: BRAIN, catalog: ordinary }).brainCloud(io.fetcher),
  ).toBe(false)
  expect(io.fake.openRouter.calls).toEqual([])
  expect(io.fake.stripe.calls).toEqual([])
  expect(github.state.dispatches).toEqual([])
  expect(github.state.minted).toEqual([])
  expect(io.commands.every(([command]) => command === "PING" || command === "SMEMBERS")).toBe(true)
})

test("an App adapter rejection becomes false and never turns dependency availability into admission", async () => {
  const io = transport()
  const ready = createCloudAgentsReadiness({
    env: BRAIN,
    catalog,
    app: {
      readiness: async () => {
        throw new Error("fixture dependency failure")
      },
    },
  })
  expect(await ready.agents(io.fetcher)).toBe(true)
  expect(await ready.noSecret(io.fetcher)).toBe(false)
  expect(await ready.brainCloud(io.fetcher)).toBe(false)
  expect(io.commands.every(([command]) => command === "PING" || command === "SMEMBERS")).toBe(true)
  expect(io.fake.openRouter.calls).toEqual([])
})
