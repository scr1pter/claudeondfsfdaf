import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Global } from "@vectordevai/core/global"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Config } from "../../src/config/config"
import { runLocal } from "../../src/cli/cmd/run"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// `vector run --local` adds the VECTOR_LOCAL floor for its own run: Vector Local on, whatever the user's config says,
// and nothing looser than what the user and their company set. The programs the run starts inherit the floor, and the
// user's config is not written. With --attach, the server it attaches to is on the list for the run, wherever it is.

NetworkGuard.use()

const file = path.join(Global.Path.config, "vector.json")
const managedFixture: { restore?: () => void } = {}

afterEach(() => {
  delete process.env.VECTOR_LOCAL
  delete process.env.VECTOR_LOCAL_POLICY
  delete process.env[ChildEnvironment.AGENT_MARKER]
  rmSync(process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!, { recursive: true, force: true })
  managedFixture.restore?.()
  managedFixture.restore = undefined
  rmSync(file, { force: true })
  Config.refreshLocal()
  Config.confirmLocal()
  rmSync(Config.localConfirmedFile(), { force: true })
  ChildEnvironment.inherit({ agent: false })
})

test("turns Vector Local on for the run, keeps the user's stricter Web access and model servers, and writes nothing", async () => {
  mkdirSync(path.dirname(file), { recursive: true })
  const config = JSON.stringify({ local: { enabled: false, web: "none", endpoints: ["http://127.0.0.1:11434"] } })
  writeFileSync(file, config)
  expect(Config.refreshLocal().enabled).toBe(false)
  const policy = await runLocal()
  expect(policy).toMatchObject({
    enabled: true,
    web: "none",
    endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
  })
  expect(Config.local()).toBe(policy)
  expect(Config.localPending()).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe(config)
  // A nested vector, or any program the run starts, keeps Vector Local on with Web access None.
  expect(ChildEnvironment.untrustedChildEnvironment({})).toMatchObject({ VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "none" })
})

test("with no local block, the run gets Vector Local with Web access Ask and no model servers", async () => {
  const policy = await runLocal()
  expect(policy).toMatchObject({ enabled: true, web: "ask", endpoints: [] })
  expect(existsSync(file)).toBe(false)
})

test("writes no file: the user's config and Vector's copy of the block the owner let apply stay as they were", async () => {
  mkdirSync(path.dirname(file), { recursive: true })
  const config = JSON.stringify({ local: { enabled: false, web: "network", endpoints: ["http://10.0.0.9:8000"] } })
  writeFileSync(file, config)
  // Any start of Vector reads the config and keeps its copy of the user's block in its state folder up to date.
  Config.refreshLocal()
  const copy = Config.localConfirmedFile()
  const saved = () => (existsSync(copy) ? readFileSync(copy, "utf8") : undefined)
  const before = saved()
  expect(before).toContain("http://10.0.0.9:8000")
  expect((await runLocal()).enabled).toBe(true)
  expect(readFileSync(file, "utf8")).toBe(config)
  expect(saved()).toBe(before)
})

const ATTACHED = ["http://192.168.1.5:4096", "http://build-box.local:4096", "http://build-box:4096"]

test("with --attach, the server it attaches to is reachable for the run, on your network too, and nothing else", async () => {
  for (const origin of ATTACHED) {
    delete process.env.VECTOR_LOCAL_POLICY
    const policy = await runLocal(`${origin}/`)
    expect(policy.endpoints).toContainEqual({ origin, from: "environment" })
    // A request no part of Vector labelled, as the attached client's are, reaches it and only it.
    expect(LocalPolicy.decide(policy, { purpose: "unknown", url: `${origin}/session` }).decision).toBe("allow")
    expect(LocalPolicy.decide(policy, { purpose: "unknown", url: "http://192.168.1.6:4096/session" }).decision).toBe(
      "block",
    )
  }
  // The desktop's own policy for an engine in WSL keeps what it lists.
  process.env.VECTOR_LOCAL_POLICY = JSON.stringify({ web: "network", endpoints: ["http://10.0.0.9:8000"] })
  const both = await runLocal("http://192.168.1.5:4096")
  expect(both).toMatchObject({ web: "network" })
  expect(both.endpoints.map((item) => item.origin)).toEqual(["http://10.0.0.9:8000", "http://192.168.1.5:4096"])
  expect(existsSync(file)).toBe(false)
})

test("with --attach, a company lock decides the server as one the user lists, and a Vector the agent started lists none", async () => {
  const managed = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
  mkdirSync(managed, { recursive: true })
  writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { lock: true, user_may: [] } }))
  managedFixture.restore = useManagedPolicyFixture(managed)
  const locked = await runLocal("http://192.168.1.5:4096")
  expect(locked).toMatchObject({ enabled: true, lock: true, endpoints: [] })
  expect(LocalPolicy.decide(locked, { purpose: "unknown", url: "http://192.168.1.5:4096/" }).decision).toBe("block")
  rmSync(path.join(managed, "vector.json"), { force: true })
  delete process.env.VECTOR_LOCAL_POLICY

  process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
  const agent = await runLocal("http://192.168.1.5:4096")
  expect(agent.endpoints).toEqual([])
  expect(agent.warnings).toContain(
    "Ignored the model servers in VECTOR_LOCAL_POLICY: an agent or Vector's own terminal started this Vector, so it cannot add one.",
  )
})
