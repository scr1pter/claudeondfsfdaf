import { expect, test } from "bun:test"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../../schema/src/codium-entitlements"
import { readCloudAgentsStatusMeter } from "../../../api/_lib/cloud-agents-status"

test("the cloud-agent meter exposes a bounded share and exhaustion flag from the canonical epoch", async () => {
  const now = Date.now()
  const snapshot: EntitlementSnapshot = {
    v: 1,
    version: 1,
    livemode: false,
    account: "00000000-0000-4000-8000-000000000001",
    state: "active",
    plan: "vector-10",
    subscription: "sub_status",
    periodStart: now - 1000,
    periodEnd: now + 86_400_000,
    meterEpoch: `sub_status:${now - 1000}`,
    cancelAtPeriodEnd: false,
    caps: ENTITLEMENTS["vector-10"],
    ramp: { hostedUntil: 0, browserFrom: 0 },
    source: "request",
    updatedAt: now,
    checkedAt: now,
  }
  const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN"] as const
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.KV_REST_API_URL = "https://fixture.invalid/kv"
  process.env.KV_REST_API_TOKEN = "fixture-only"
  try {
    let seconds = 9_000
    const requests: RequestInit[] = []
    const fetcher = Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {})
        const command = JSON.parse(String(init?.body)) as (string | number)[]
        expect(command[0]).toBe("EVAL")
        expect(command).toContain(snapshot.meterEpoch)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(init?.redirect).toBe("error")
        return Response.json({ result: String(seconds) })
      },
      { preconnect: fetch.preconnect },
    )
    expect(await readCloudAgentsStatusMeter(snapshot, fetcher, AbortSignal.timeout(1000))).toEqual({
      used: 0.5,
      exhausted: false,
    })
    seconds = 36_000
    expect(await readCloudAgentsStatusMeter(snapshot, fetcher, AbortSignal.timeout(1000))).toEqual({
      used: 1,
      exhausted: true,
    })
    const ended = await readCloudAgentsStatusMeter({ ...snapshot, state: "ended" }, fetcher, AbortSignal.timeout(1000))
    expect(ended).toBeUndefined()
    expect(requests).toHaveLength(2)
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
})
