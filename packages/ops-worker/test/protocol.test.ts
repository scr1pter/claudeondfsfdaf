import { describe, expect, test } from "bun:test"
import { ACCOUNT, Harness, NOW, SHA, planFor } from "./fakes"

// R46a (P7 addendum, R46-4): the bodies of protocol.ts. The plan, config and release bodies take exactly their fields:
// any other field, at any level, is refused and nothing is applied. state, erase, suspend and flags ignore a field they
// do not know, so the guard's read before a hold, a deletion, a hold or the kill switch still applies while the API and
// the Worker differ by a version.

const HOST = "status.vector-fixture.com"
const HOME = `https://${HOST}/`
const PLAN = planFor("vector-200")

/** The bodies as the API builds them (opsPlanFor, workerConfig, the release intake, the guard, the cleanup). */
const EXACT = {
  plan: { account: ACCOUNT, plan: PLAN },
  config: { account: ACCOUNT, domains: [HOST], monitors: [{ id: "home", url: HOME }] },
  release: {
    account: ACCOUNT,
    repositoryId: 42,
    environment: "production",
    sha: SHA("1"),
    deployment: "1001",
    at: NOW,
    urls: [HOME],
  },
  state: { account: ACCOUNT },
  suspend: { account: ACCOUNT, suspended: false, reason: "owner", at: 1 },
  flags: { kill: false },
  erase: { account: ACCOUNT },
}

async function configured() {
  const harness = new Harness()
  expect((await harness.call("plan", EXACT.plan)).status).toBe(200)
  expect((await harness.call("config", EXACT.config)).status).toBe(200)
  return harness
}

function snapshot(harness: Harness) {
  return {
    meta: harness.rows("SELECT k, v FROM meta ORDER BY k"),
    monitors: harness.rows("SELECT * FROM monitors ORDER BY position"),
    releases: harness.rows("SELECT * FROM releases"),
    alarm: harness.state.alarm,
    kill: harness.kv.values.get("kill") ?? null,
  }
}

const refused = { status: 400, body: { error: { code: "INTERNAL_BAD_REQUEST" } } }

describe("internal bodies", () => {
  test("the bodies the API sends are taken as they are", async () => {
    const harness = await configured()
    const release = await harness.call("release", EXACT.release)
    expect(release).toMatchObject({ status: 200, body: { accepted: true } })
    for (const action of ["state", "suspend", "flags", "erase"] as const)
      expect({ action, status: (await harness.call(action, EXACT[action])).status }).toEqual({ action, status: 200 })
  })

  test("a field the Worker does not know is refused at every level of plan, config and release", async () => {
    const harness = await configured()
    const before = snapshot(harness)
    // A newer plan that stops checks, an empty config and a new release: a Worker that ignored the extra field would
    // visibly apply each one.
    const stop = { ...PLAN, version: 2, onCall: null }
    const ownProto = Object.assign(JSON.parse('{"__proto__": {"x": 1}}') as object, { account: ACCOUNT, plan: stop })
    const bodies: Array<[string, string, Record<string, unknown>]> = [
      ["plan", "top level", { account: ACCOUNT, plan: stop, extra: 1 }],
      ["plan", "an own __proto__ field", ownProto as Record<string, unknown>],
      ["plan", "plan", { account: ACCOUNT, plan: { ...stop, extra: 1 } }],
      [
        "plan",
        "plan.onCall",
        { account: ACCOUNT, plan: { ...PLAN, version: 2, onCall: { ...PLAN.onCall!, extra: 1 } } },
      ],
      [
        "plan",
        "plan.releaseGuard",
        { account: ACCOUNT, plan: { ...PLAN, version: 2, releaseGuard: { ...PLAN.releaseGuard!, extra: 1 } } },
      ],
      ["config", "top level", { account: ACCOUNT, domains: [HOST], monitors: [], extra: 1 }],
      ["config", "a monitor", { account: ACCOUNT, domains: [HOST], monitors: [{ id: "other", url: HOME, extra: 1 }] }],
      ["release", "top level", { ...EXACT.release, extra: 1 }],
    ]
    for (const [action, where, body] of bodies)
      expect({ action, where, answer: await harness.call(action, body) }).toEqual({ action, where, answer: refused })
    expect(snapshot(harness)).toEqual(before)
    expect(before.releases).toEqual([])
  })

  test("state, erase, suspend and flags still apply with a field they do not know", async () => {
    const harness = await configured()
    const state = await harness.call("state", EXACT.state)
    expect(state.status).toBe(200)
    expect(await harness.call("state", { account: ACCOUNT, extra: 1 })).toEqual(state)
    expect(
      await harness.call("suspend", { account: ACCOUNT, suspended: true, reason: "owner", at: 5, extra: 1 }),
    ).toMatchObject({ status: 200, body: { applied: true, suspended: true } })
    expect(harness.rows("SELECT k FROM meta WHERE k = 'suspended'")).toHaveLength(1)
    expect(await harness.call("flags", { kill: true, extra: 1 })).toEqual({ status: 200, body: { kill: true } })
    expect(harness.kv.values.get("kill")).toBe("1")
    expect(await harness.call("erase", { account: ACCOUNT, extra: 1 })).toEqual({ status: 200, body: { erased: true } })
    expect(harness.rows("SELECT * FROM monitors")).toEqual([])
  })

  test("every field is required, at every level", async () => {
    const harness = await configured()
    const before = snapshot(harness)
    const without = (body: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(body).filter(([name]) => name !== key))
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ...Object.entries(EXACT).flatMap(([action, body]) =>
        Object.keys(body).map((key): [string, string, Record<string, unknown>] => [action, key, without(body, key)]),
      ),
      ...Object.keys(PLAN).map((key): [string, string, Record<string, unknown>] => [
        "plan",
        `plan.${key}`,
        { account: ACCOUNT, plan: without({ ...PLAN, version: 2 }, key) },
      ]),
      ...Object.keys(PLAN.onCall!).map((key): [string, string, Record<string, unknown>] => [
        "plan",
        `plan.onCall.${key}`,
        { account: ACCOUNT, plan: { ...PLAN, version: 2, onCall: without(PLAN.onCall!, key) } },
      ]),
      ...Object.keys(PLAN.releaseGuard!).map((key): [string, string, Record<string, unknown>] => [
        "plan",
        `plan.releaseGuard.${key}`,
        { account: ACCOUNT, plan: { ...PLAN, version: 2, releaseGuard: without(PLAN.releaseGuard!, key) } },
      ]),
      ...["id", "url"].map((key): [string, string, Record<string, unknown>] => [
        "config",
        `a monitor's ${key}`,
        { ...EXACT.config, monitors: [without(EXACT.config.monitors[0]!, key)] },
      ]),
    ]
    for (const [action, missing, body] of cases)
      expect({ action, missing, answer: await harness.call(action, body) }).toEqual({
        action,
        missing,
        answer: refused,
      })
    expect(snapshot(harness)).toEqual(before)
  })
})
