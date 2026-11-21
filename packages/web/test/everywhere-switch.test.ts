import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { SWITCH_NAMES, SWITCH_VALUES, switchKey } from "../../../api/_lib/codium-switches"
import { ENV_NAMES, readConfig } from "../../../api/_lib/everywhere/config"
import {
  admits,
  codiumSwitches,
  fromCodium,
  readEverywhereSwitch,
  readRemoteSwitch,
  strictest,
  type CodiumSwitches,
} from "../../../api/_lib/everywhere/switch"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, useKv } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-03 and E10: the kill switch reads `stop` by default, `no-new` refuses new jobs only, and `stop` also stops
 * running ones. Codium's switch can only make it stricter, and an unreadable switch reads `stop`.
 */

const on = readConfig({ [ENV_NAMES.enabled]: "true", [ENV_NAMES.dataKey]: randomBytes(32).toString("base64") })
const off = readConfig({})

function codium(values: Partial<Record<"everywhere" | "remote", string>>): CodiumSwitches {
  return async (name) => values[name]
}
const broken: CodiumSwitches = async () => {
  throw new Error("store down")
}

describe("the everywhere switch", () => {
  test("it reads stop by default: no env, or the env without a usable data key", async () => {
    expect(await readEverywhereSwitch(off, codium({ everywhere: "on" }))).toBe("stop")
    expect(await readEverywhereSwitch(readConfig({ [ENV_NAMES.enabled]: "true" }), codium({}))).toBe("stop")
    expect(
      await readEverywhereSwitch(
        readConfig({ [ENV_NAMES.enabled]: "true", [ENV_NAMES.dataKey]: randomBytes(16).toString("base64") }),
        codium({}),
      ),
    ).toBe("stop")
  })

  test("with the env on and no Codium value it is on", async () => {
    expect(await readEverywhereSwitch(on, codium({}))).toBe("on")
  })

  test("Codium's switch can make it stricter, never looser", async () => {
    expect(await readEverywhereSwitch(on, codium({ everywhere: "on" }))).toBe("on")
    expect(await readEverywhereSwitch(on, codium({ everywhere: "no-new" }))).toBe("no-new")
    expect(await readEverywhereSwitch(on, codium({ everywhere: "stop" }))).toBe("stop")
    expect(await readEverywhereSwitch(on, codium({ everywhere: "off" }))).toBe("stop")
    expect(await readEverywhereSwitch(off, codium({ everywhere: "no-new" }))).toBe("stop")
  })

  test("an unknown Codium value or an unreadable switch reads stop", async () => {
    expect(await readEverywhereSwitch(on, codium({ everywhere: "maybe" }))).toBe("stop")
    expect(await readEverywhereSwitch(on, broken)).toBe("stop")
  })
})

describe("what each value lets through", () => {
  test("on lets new and running work through", () => {
    expect(admits("on", "new")).toBe(true)
    expect(admits("on", "running")).toBe(true)
  })

  test("no-new refuses new jobs only", () => {
    expect(admits("no-new", "new")).toBe(false)
    expect(admits("no-new", "running")).toBe(true)
  })

  test("stop also stops running ones", () => {
    expect(admits("stop", "new")).toBe(false)
    expect(admits("stop", "running")).toBe(false)
  })

  test("strictest and fromCodium", () => {
    expect(strictest()).toBe("on")
    expect(strictest("on", "no-new")).toBe("no-new")
    expect(strictest("no-new", "stop", "on")).toBe("stop")
    expect(fromCodium("on")).toBe("on")
    expect(fromCodium("no-new")).toBe("no-new")
    for (const value of ["off", "stop", "", "ON", undefined, null, 1]) expect(fromCodium(value)).toBe("stop")
  })
})

describe("the remote switch", () => {
  test("Codium's on reads on; off, absent or unreadable reads stop", async () => {
    expect(await readRemoteSwitch(codium({ remote: "on" }))).toBe("on")
    expect(await readRemoteSwitch(codium({ remote: "off" }))).toBe("stop")
    expect(await readRemoteSwitch(codium({}))).toBe("stop")
    expect(await readRemoteSwitch(broken)).toBe("stop")
  })
})

describe("the seam over Codium's readSwitch", () => {
  let restore: () => void
  const previousMode = process.env.CODIUM_STRIPE_MODE
  beforeAll(() => {
    restore = useKv()
    process.env.CODIUM_STRIPE_MODE = "test"
  })
  afterAll(() => {
    restore()
    if (previousMode === undefined) delete process.env.CODIUM_STRIPE_MODE
    else process.env.CODIUM_STRIPE_MODE = previousMode
  })

  // Codium caches each read for 30 s per fetcher, so every read below uses a fresh FakeStore.
  test("Codium lists everywhere with on, no-new and stop (R-C6)", () => {
    expect(SWITCH_NAMES).toContain("everywhere")
    expect(SWITCH_VALUES.everywhere).toEqual(["on", "no-new", "stop"])
  })

  test("an absent record reads on with the env on, from one read of Codium's own key", async () => {
    const fake = new FakeStore()
    expect(await readEverywhereSwitch(on, codiumSwitches(fake.fetch))).toBe("on")
    expect(fake.commands).toEqual([["GET", switchKey("everywhere")]])
    expect(switchKey("everywhere")).toBe("vector:codium:test:switch:everywhere")
  })

  test("no-new and stop stored by Codium reach readEverywhereSwitch", async () => {
    for (const value of ["on", "no-new", "stop"] as const)
      for (const raw of [JSON.stringify({ value, changedAt: 1, generation: "g1" }), value]) {
        const store = new FakeStore()
        store.send(["SET", switchKey("everywhere"), raw])
        expect(await readEverywhereSwitch(on, codiumSwitches(store.fetch))).toBe(value)
      }
  })

  test("Codium's off, an unknown value or a corrupt record is unreadable and reads stop", async () => {
    for (const raw of [
      "off",
      JSON.stringify({ value: "off", changedAt: 1, generation: "g1", offSince: 1 }),
      "maybe",
      "{broken",
    ]) {
      const store = new FakeStore()
      store.send(["SET", switchKey("everywhere"), raw])
      await expect(codiumSwitches(store.fetch)("everywhere")).rejects.toMatchObject({
        code: "CODIUM_SWITCH_UNAVAILABLE",
      })
      expect(await readEverywhereSwitch(on, codiumSwitches(store.fetch))).toBe("stop")
    }
  })

  test("with the env off it reads stop whatever Codium says, before any read", async () => {
    for (const config of [off, readConfig({ [ENV_NAMES.enabled]: "true" })])
      for (const value of [undefined, "on", "no-new", "stop"]) {
        const store = new FakeStore()
        if (value) store.send(["SET", switchKey("everywhere"), value])
        const sent = store.commands.length
        expect(await readEverywhereSwitch(config, codiumSwitches(store.fetch))).toBe("stop")
        expect(store.commands).toHaveLength(sent)
      }
  })

  test("the remote switch is read from Codium's own record", async () => {
    const stored = new FakeStore()
    stored.send(["SET", switchKey("remote"), JSON.stringify({ value: "off", changedAt: 1, generation: "g1", offSince: 1 })])
    expect(await readRemoteSwitch(codiumSwitches(stored.fetch))).toBe("stop")
    expect(stored.commands.at(-1)).toEqual(["GET", "vector:codium:test:switch:remote"])

    const missing = new FakeStore()
    expect(await readRemoteSwitch(codiumSwitches(missing.fetch))).toBe("on")
  })

  test("a store outage behind Codium's switch reads stop", async () => {
    const fake = new FakeStore()
    fake.down = true
    expect(await readRemoteSwitch(codiumSwitches(fake.fetch))).toBe("stop")
    expect(await readEverywhereSwitch(on, codiumSwitches(fake.fetch))).toBe("stop")
  })
})
