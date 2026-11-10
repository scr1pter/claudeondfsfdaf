import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "@vectordevai/core/global"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, resetPromptTrust, tmpdir } from "../fixture/fixture"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// A company lock (lock: true in the managed local block, plan section 4.2): the keys it keeps come from company policy
// alone, a change to one fails with ConfigLocked, GET says which they are, and the user's own Vector Local settings
// apply only where the company leaves them to the user.

const guard = NetworkGuard.use()

const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const managedFixture: { restore?: () => void } = {}
const GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file))
const globalFile = path.join(Global.Path.config, "vector.json")
const ENVIRONMENT = ["VECTOR_LOCAL_WSL_NETWORK", "VECTOR_LOCAL_POLICY", "VECTOR_AGENT_SESSION"] as const
// These tests run as the owner would: a test runner started from Vector's own terminal would carry the agent marker.
delete process.env.VECTOR_AGENT_SESSION
const saved = Object.fromEntries(ENVIRONMENT.map((key) => [key, process.env[key]]))

const GPU = "http://10.0.0.5:8000"
const OTHER_GPU = "http://10.0.0.9:8000"
const LAN = "http://192.168.1.20:11434"
const CORP = "https://llm.corp.example.com"
const ELSEWHERE = "https://llm.elsewhere.example.com"
const GITHUB = { source: "github", reason: "Pull requests", added_at: 1, added_by: "cli" as const }

// An earlier test file in the run may leave a global config behind, and a PATCH writes to vector.jsonc before
// vector.json, the file these tests seed and read. What a test seeds there is the owner's config from before any
// approval, so no earlier test's prompt-trust baseline holds it.
beforeEach(() => {
  GLOBAL_FILES.forEach((file) => rmSync(file, { force: true }))
  resetPromptTrust()
})

afterEach(async () => {
  ENVIRONMENT.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  })
  GLOBAL_FILES.forEach((file) => rmSync(file, { force: true }))
  rmSync(managedDirectory, { recursive: true, force: true })
  managedFixture.restore?.()
  managedFixture.restore = undefined
  rmSync(Config.localConfirmedFile(), { force: true })
  // Removing the company's policy turns Vector Local off again, which waits for the owner; the owner here says yes.
  Config.refreshLocal()
  Config.confirmLocal()
  await disposeAllInstances()
  await resetDatabase()
  expect(guard.outside()).toEqual([])
})

function writeManaged(config: object, file = "vector.json") {
  mkdirSync(managedDirectory, { recursive: true })
  writeFileSync(path.join(managedDirectory, file), JSON.stringify(config))
  managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)
}

// The company's policy as it applies at once, with what the user's own config adds confirmed by the owner.
function applyPolicy() {
  Config.refreshLocal()
  return Config.confirmLocal()
}

function request(route: string, directory?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (directory) headers.set("x-vector-directory", directory)
  return Promise.resolve(Server.Default().app.request(route, { ...init, headers }))
}

function patch(route: string, body: unknown, directory?: string) {
  return request(route, directory, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function json(response: Response | Promise<Response>) {
  const settled = await response
  return { status: settled.status, body: (await settled.json()) as Record<string, any> }
}

// The user's global config, read fresh: config caches it until a change through the API, which this makes.
async function seedGlobal(content: object) {
  writeFileSync(globalFile, JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...content }, null, 2))
  expect((await patch("/global/config", { username: `seeded-${Math.random()}` })).status).toBe(200)
}

describe("a locked key", () => {
  test("a PATCH that sets one fails with ConfigLocked and writes nothing", async () => {
    writeManaged({ local: { lock: true, user_may: ["endpoints"], locked_keys: ["model"] }, model: "corp/coder" })
    expect(applyPolicy().lock).toBe(true)
    await seedGlobal({})
    const before = await Bun.file(globalFile).text()

    expect(await json(patch("/global/config", { share: "auto" }))).toEqual({
      status: 403,
      body: {
        name: "ConfigLocked",
        data: { keys: ["share"], message: "Set by your company. Ask your administrator to change it: share." },
      },
    })
    const both = await json(patch("/global/config", { model: "openai/gpt-5", autoupdate: true }))
    expect(both.status).toBe(403)
    expect([...both.body.data.keys].sort()).toEqual(["autoupdate", "model"])
    expect(both.body.data.message).toContain("Ask your administrator to change them")
    // The switch is the company's; the model servers are left to the user here.
    expect((await json(patch("/global/config", { local: { enabled: false } }))).body.data.keys).toEqual([
      "local.enabled",
    ])
    expect((await json(patch("/global/config", { local: { allow: [GITHUB] } }))).body.data.keys).toEqual([
      "local.allow",
    ])
    expect(await Bun.file(globalFile).text()).toBe(before)

    // What the company leaves to the user still changes: a model server, a site to deny and a server's identity pin.
    const allowed = await patch("/global/config", {
      local: {
        endpoints: [LAN],
        web_domains: { deny: ["ads.example"] },
        pins: { [LAN]: { kind: "ollama" } },
      },
    })
    expect(allowed.status).toBe(200)
    expect((await Bun.file(globalFile).json()).local.endpoints).toEqual([LAN])
    // So does any key the company does not keep.
    expect((await patch("/global/config", { shell: "/bin/zsh" })).status).toBe(200)
  })

  test("a repository's PATCH under a lock cannot set a locked key or a local block", async () => {
    writeManaged({ local: { lock: true, user_may: ["endpoints"] } })
    applyPolicy()
    await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
    expect((await json(patch("/config", { autoupdate: false }, tmp.path))).body.data.keys).toEqual(["autoupdate"])
    // A repository's local block never applies, so under a lock none is written there.
    expect((await json(patch("/config", { local: { endpoints: [LAN] } }, tmp.path))).body.data.keys).toEqual(["local"])
    expect((await Bun.file(path.join(tmp.path, "vector.json")).json()).autoupdate).toBeUndefined()
    expect((await patch("/config", { formatter: false, lsp: false, username: "repository" }, tmp.path)).status).toBe(
      200,
    )
  })

  test("a Web access the company leaves to the user may only get stricter", async () => {
    writeManaged({ local: { lock: true, web: "network", user_may: ["web"] } })
    applyPolicy()
    await seedGlobal({})
    expect((await json(patch("/global/config", { local: { web: "ask" } }))).body.data.keys).toEqual(["local.web"])
    expect((await patch("/global/config", { local: { web: "none" } })).status).toBe(200)
  })

  test("GET says which keys the lock keeps, and none without a lock", async () => {
    await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
    expect((await json(request("/global/config"))).body.locked).toEqual([])
    expect((await json(request("/config", tmp.path))).body.locked).toEqual([])
    // Without a lock nothing is refused, and a config a client read and sends back whole keeps no `locked` key.
    await seedGlobal({})
    expect((await patch("/global/config", { autoupdate: "notify", locked: ["share"] })).status).toBe(200)
    expect(await Bun.file(globalFile).json()).not.toHaveProperty("locked")

    writeManaged({ local: { lock: true, locked_keys: ["model", "agent", "not_a_key"] } })
    const policy = applyPolicy()
    await disposeAllInstances()
    const locked = ["local", "share", "autoshare", "autoupdate", "model", "agent", "mode"]
    expect((await json(request("/global/config"))).body.locked).toEqual(locked)
    expect((await json(request("/config", tmp.path))).body.locked).toEqual(locked)
    // A name that is not a top-level config key locks nothing, and the policy says so.
    expect(policy.warnings).toContain(
      "Ignored not_a_key in your company's locked_keys: Vector locks top-level config keys only, such as model or provider.",
    )
  })
})

describe("what config loads under a lock", () => {
  test("a locked key comes from company policy alone, so its list replaces the user's and the repository's", async () => {
    await seedGlobal({ instructions: ["mine.md"], small_model: "openai/gpt-5-mini", autoshare: true, model: "a/b" })
    writeManaged({
      local: { lock: true, locked_keys: ["instructions", "small_model", "model"] },
      instructions: ["company.md"],
      model: "corp/coder",
    })
    applyPolicy()
    await using tmp = await tmpdir({
      trusted: true,
      config: { formatter: false, lsp: false, instructions: ["repository.md"], small_model: "repo/small" },
    })
    const config = (await json(request("/config", tmp.path))).body
    expect(config.instructions).toEqual(["company.md"])
    expect(config.model).toBe("corp/coder")
    // Locked without a value of the company's, it keeps its default.
    expect(config.small_model).toBeUndefined()
    // autoshare is share's old switch, which the lock keeps with it.
    expect(config.share).toBe("manual")
  })

  test("trusted managed config from before the lock still loads as it did", async () => {
    await seedGlobal({ instructions: ["mine.md"] })
    writeManaged({ model: "corp/coder", share: "disabled", instructions: ["company.md"] })
    applyPolicy()
    await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false, model: "repo/model" } })
    const config = (await json(request("/config", tmp.path))).body
    expect(config.model).toBe("corp/coder")
    expect(config.share).toBe("disabled")
    // Without a lock the company's list still adds to the user's.
    expect(config.instructions).toEqual(["mine.md", "company.md"])
    expect(config.locked).toEqual([])
    expect(Config.local().lock).toBe(false)
  })
})

describe("Vector Local under a lock", () => {
  test("user values merge only for the keys in user_may", () => {
    writeFileSync(globalFile, JSON.stringify({ local: { endpoints: [LAN], allow: [GITHUB] } }))
    writeManaged({ local: { lock: true, user_may: ["endpoints"], endpoints: [GPU] } })
    const policy = applyPolicy()
    expect(policy.enabled).toBe(true)
    expect(policy.endpoints).toEqual([
      { origin: GPU, from: "managed" },
      { origin: LAN, from: "user" },
    ])
    expect(policy.allow).toEqual([])
    expect(policy.warnings).toContain("Your company set Vector Local, so allow in your user config do not apply.")
  })

  test("the company's lists replace the user's, and a later company file's replace an earlier one's", () => {
    writeFileSync(globalFile, JSON.stringify({ local: { endpoints: [LAN] } }))
    writeManaged({ local: { lock: true, endpoints: [GPU] } })
    expect(applyPolicy().endpoints).toEqual([{ origin: GPU, from: "managed" }])
    writeManaged({ local: { endpoints: [OTHER_GPU] } }, "vector.jsonc")
    expect(applyPolicy().endpoints).toEqual([{ origin: OTHER_GPU, from: "managed" }])
  })

  test("the model servers a user adds are limited to their network and the company's endpoint_domains", () => {
    writeFileSync(globalFile, JSON.stringify({ local: { endpoints: [LAN, CORP, ELSEWHERE] } }))
    writeManaged({ local: { lock: true, user_may: ["endpoints"], endpoint_domains: ["*.corp.example.com"] } })
    const policy = applyPolicy()
    expect(policy.endpoints.map((item) => item.origin)).toEqual([LAN, CORP])
    expect(policy.warnings).toContain(
      `Ignored ${ELSEWHERE}: your company allows only servers on your network or the ones it names.`,
    )
  })

  test("a name the user lists as on their network must resolve there, while the company's are reached wherever they resolve", () => {
    writeFileSync(globalFile, JSON.stringify({ local: { endpoints: ["http://nas.local:8000"] } }))
    writeManaged({ local: { lock: true, user_may: ["endpoints"], endpoints: ["http://gpu.internal:8000"] } })
    const policy = applyPolicy()
    expect(policy.endpoints.map((item) => item.origin)).toEqual(["http://gpu.internal:8000", "http://nas.local:8000"])
    expect([
      LocalPolicy.exempt(policy, "http://nas.local:8000/v1"),
      LocalPolicy.exempt(policy, "http://gpu.internal:8000/v1"),
    ]).toEqual([false, true])
  })

  test("in WSL's NAT networking, a server on this computer's loopback gets the Windows guidance", () => {
    process.env.VECTOR_LOCAL_POLICY = JSON.stringify({ enabled: true, endpoints: ["http://127.0.0.1:11434"] })
    process.env.VECTOR_LOCAL_WSL_NETWORK = "nat"
    const guidance =
      "Ollama on Windows listens on 127.0.0.1 only. Use WSL mirrored networking, or run Ollama inside WSL. Setting OLLAMA_HOST=0.0.0.0 exposes it to your whole network."
    expect(applyPolicy().warnings).toContain(guidance)
    process.env.VECTOR_LOCAL_WSL_NETWORK = "mirrored"
    expect(applyPolicy().warnings).not.toContain(guidance)
  })
})
