import { describe, expect, test } from "bun:test"
import {
  decodeVersion,
  negotiate,
  phoneBuild,
  phoneHello,
  shouldReload,
  staleBuild,
  versionFile,
  PHONE_MIN_DESKTOP_PROTOCOL,
  PHONE_PROTOCOL,
} from "./version"

// WP A38's version handshake: with the server (reload once onto a newer deployed build) and with the desktop
// (agree on a protocol both speak, or say which side must update).

describe("with the server", () => {
  test("a build writes a version file the app reads back", () => {
    expect(versionFile("1.17.14-abc123")).toEqual({
      build: "1.17.14-abc123",
      protocol: PHONE_PROTOCOL,
      minDesktop: PHONE_MIN_DESKTOP_PROTOCOL,
    })
    expect(decodeVersion(versionFile("1.17.14-abc123"))).toEqual(versionFile("1.17.14-abc123"))
  })

  test("a malformed version file is not trusted", () => {
    for (const body of [
      undefined,
      [],
      { build: "", protocol: 1, minDesktop: 1 },
      { build: "x y", protocol: 1, minDesktop: 1 },
      { build: "ok", protocol: 0, minDesktop: 1 },
      { build: "ok", protocol: 1, minDesktop: 2 },
      { build: "ok", protocol: 1.5, minDesktop: 1 },
    ])
      expect(decodeVersion(body)).toBeUndefined()
  })

  test("a newer deployed build reloads the app once, and a development bundle never", () => {
    const deployed = versionFile("b2")
    expect(staleBuild("b1", deployed)).toBe(true)
    expect(staleBuild("b2", deployed)).toBe(false)
    expect(staleBuild("b1", undefined)).toBe(false)
    expect(staleBuild("dev", deployed)).toBe(false)
    expect(shouldReload("b1", deployed, null)).toBe(true)
    // Already reloaded for b2 and a cache still served b1: stay, rather than reload forever.
    expect(shouldReload("b1", deployed, "b2")).toBe(false)
    expect(shouldReload("b1", versionFile("b3"), "b2")).toBe(true)
  })

  test("outside a build the bundle calls itself dev", () => {
    expect(phoneBuild()).toBe("dev")
  })
})

describe("with the desktop", () => {
  test("both sides speak the older protocol while each still allows it", () => {
    expect(negotiate({ protocol: 2, minPeer: 1 }, { protocol: 1, minPeer: 1 })).toEqual({ ok: true, protocol: 1 })
    expect(negotiate({ protocol: 1, minPeer: 1 }, { protocol: 3, minPeer: 1 })).toEqual({ ok: true, protocol: 1 })
    expect(negotiate(phoneHello(), { protocol: PHONE_PROTOCOL, minPeer: 1 })).toEqual({
      ok: true,
      protocol: PHONE_PROTOCOL,
    })
  })

  test("names the side that must update", () => {
    expect(negotiate({ protocol: 3, minPeer: 2 }, { protocol: 1, minPeer: 1 })).toEqual({
      ok: false,
      update: "desktop",
    })
    expect(negotiate({ protocol: 1, minPeer: 1 }, { protocol: 3, minPeer: 2 })).toEqual({ ok: false, update: "phone" })
  })

  test("a malformed hello is never guessed at", () => {
    for (const hello of [undefined, "v1", { protocol: "1", minPeer: 1 }, { protocol: 1, minPeer: 2 }, { protocol: 1 }])
      expect(negotiate(phoneHello(), hello)).toEqual({ ok: false, update: "desktop" })
  })
})
