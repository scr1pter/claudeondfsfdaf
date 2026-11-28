import { expect, test } from "bun:test"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { PREFERENCE_MESSAGE, preferenceMessage, preferenceRequester } from "./everywhere-preference-bridge"
import { READ_EVERYWHERE_PREFERENCES, updateEverywherePreferences } from "./everywhere-preference-control"

const update = { version: 1, kind: "update", revision: 0, settings: { enabled: true } } as const

function fixture() {
  const messages = new Set<(message: unknown) => void>()
  const operations: string[] = []
  const snapshot: { revision: number; everywhere: EverywherePreferenceWire.Snapshot["everywhere"]; locked: string[] } =
    {
      revision: 0,
      everywhere: {},
      locked: [],
    }
  let offered = true
  let remote = false
  let authority = 1
  const transport = preferenceRequester({
    listen: (callback) => {
      messages.add(callback)
      return () => {
        messages.delete(callback)
      }
    },
    send: (wire) => {
      const routed = preferenceMessage(wire)!
      const request = routed.request as EverywherePreferenceWire.Request
      operations.push(request.kind)
      if (request.kind === "update") {
        snapshot.revision += 1
        snapshot.everywhere = request.settings
      }
      for (const callback of messages) {
        callback({ type: PREFERENCE_MESSAGE, id: "unrelated", result: { version: 1, kind: "locked" } })
        callback({ type: PREFERENCE_MESSAGE, id: routed.id, result: { version: 1, kind: "ready", snapshot } })
      }
    },
  })
  return {
    snapshot,
    operations,
    get listeners() {
      return messages.size
    },
    notOffered() {
      offered = false
    },
    swapAccount() {
      authority++
    },
    access: {
      transport: () => transport,
      authorityRevision: () => authority,
      offered: async () => offered,
      confirm: async (withRemote: boolean) => {
        operations.push(`confirm:${withRemote}`)
        return true
      },
      remote: () => ({
        enabled: remote,
        enable: async () => {
          operations.push("enable Remote")
          remote = true
          return true
        },
      }),
      refresh: async () => {
        operations.push("refresh")
      },
    },
  }
}

test("taking jobs needs owner confirmation before Remote, a versioned durable acknowledgement and runner refresh", async () => {
  const f = fixture()
  expect(await updateEverywherePreferences(update, f.access)).toMatchObject({
    kind: "ready",
    snapshot: { revision: 1 },
  })
  expect(f.operations).toEqual(["read", "confirm:true", "read", "enable Remote", "update", "refresh"])
  expect(f.snapshot.everywhere).toEqual({ enabled: true })
  expect(f.listeners).toBe(0)
})

test("renderer consent assertions, owner cancellation and stale authority cannot turn on jobs", async () => {
  const f = fixture()
  expect(await updateEverywherePreferences({ ...update, consent: true }, f.access)).toMatchObject({ kind: "invalid" })
  expect(await updateEverywherePreferences(update, { ...f.access, confirm: async () => false })).toMatchObject({
    kind: "cancelled",
  })
  expect(
    await updateEverywherePreferences(update, {
      ...f.access,
      confirm: async () => {
        f.swapAccount()
        return true
      },
    }),
  ).toMatchObject({ kind: "stale" })
  expect(f.operations).toEqual(["read", "read"])
  expect(f.snapshot.everywhere).toEqual({})
})

test("an unlisted owner can stop taking jobs and a company lock blocks writes", async () => {
  const f = fixture()
  f.notOffered()
  expect(await updateEverywherePreferences(update, f.access)).toMatchObject({ kind: "not-offered" })
  f.snapshot.everywhere = { enabled: true }
  expect(await updateEverywherePreferences({ ...update, settings: { enabled: false } }, f.access)).toMatchObject({
    kind: "ready",
  })
  f.snapshot.locked = ["everywhere"]
  expect(await updateEverywherePreferences({ ...update, revision: 1 }, f.access)).toMatchObject({ kind: "locked" })
  expect(f.operations).toEqual(["read", "read", "update", "refresh", "read"])
})

test("a failed durable write leaves the separately approved Remote setting in place", async () => {
  const f = fixture()
  const original = f.access.transport()
  const refused = async (request: EverywherePreferenceWire.Request) => {
    if (request.kind === "update") return { version: 1, kind: "locked" } as const
    return original(request)
  }
  expect(await updateEverywherePreferences(update, { ...f.access, transport: () => refused })).toEqual({
    version: 1,
    kind: "remote-stayed-on",
  })
  expect(f.access.remote().enabled).toBe(true)
  expect(f.snapshot.everywhere).toEqual({})
  expect(f.operations).toEqual(["read", "confirm:true", "read", "enable Remote"])
})

test("unsupported utility reply fails closed and never returns unrecognized fields", async () => {
  const transport = preferenceRequester({
    listen: (callback) => {
      receive = callback
      return () => {}
    },
    send: (wire) => receive({ ...(wire as object), result: { version: 2, kind: "ready", snapshot: {} } }),
  })
  let receive: (message: unknown) => void
  expect(await transport(READ_EVERYWHERE_PREFERENCES)).toEqual({ version: 1, kind: "unavailable" })
})
