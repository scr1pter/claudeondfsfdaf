import { describe, expect, test } from "bun:test"
import {
  ALERT_AAD,
  clickTarget,
  decodePushPayload,
  notificationFor,
  openAlert,
  routeForTag,
  UNREADABLE_ALERT,
} from "./alerts"
import { base64url } from "./auth"

// WP A38: the service worker shows what A37's server sends (P7): a server alert's title only, or a desktop alert
// opened on the phone with the alert key it paired with. Anything else shows a notification without content.

async function alertKey(raw = crypto.getRandomValues(new Uint8Array(32))) {
  return {
    raw,
    key: await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]),
    sealing: await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]),
  }
}

// What A41's desktop sender does: nonce ‖ AES-256-GCM(ciphertext ‖ tag), additional data "vector-alert-v1".
async function seal(sealing: CryptoKey, plaintext: unknown, aad = ALERT_AAD) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      sealing,
      new TextEncoder().encode(JSON.stringify(plaintext)),
    ),
  )
  return base64url(new Uint8Array([...iv, ...sealed]))
}

describe("decodePushPayload", () => {
  test("takes the two shapes the server sends", () => {
    expect(decodePushPayload(JSON.stringify({ v: 1, kind: "title", title: " Site down ", tag: "on-call" }))).toEqual({
      v: 1,
      kind: "title",
      title: "Site down",
      tag: "on-call",
    })
    expect(decodePushPayload(JSON.stringify({ v: 1, kind: "e2e", c: "abc", k: "mac-1" }))).toEqual({
      v: 1,
      kind: "e2e",
      c: "abc",
      k: "mac-1",
    })
  })

  test("refuses anything else", () => {
    for (const text of [
      undefined,
      "",
      "not json",
      JSON.stringify([]),
      JSON.stringify({ v: 2, kind: "title", title: "x" }),
      JSON.stringify({ v: 1, kind: "title", title: "" }),
      JSON.stringify({ v: 1, kind: "title", title: "a".repeat(121) }),
      JSON.stringify({ v: 1, kind: "title", title: "two\nlines" }),
      JSON.stringify({ v: 1, kind: "title", title: "ok", tag: "Not A Tag" }),
      JSON.stringify({ v: 1, kind: "e2e", c: 5 }),
      JSON.stringify({ v: 1, kind: "e2e", c: "abc", k: "bad key" }),
      JSON.stringify({ v: 1, kind: "html", body: "<b>x</b>" }),
    ])
      expect(decodePushPayload(text)).toBeUndefined()
  })
})

describe("openAlert", () => {
  const noKey = async () => undefined

  test("a server alert shows its title, and its tag says where a tap goes", async () => {
    const alert = await openAlert(
      { v: 1, kind: "title", title: "Release Guard opened a revert PR", tag: "release-guard" },
      noKey,
    )
    expect(alert).toEqual({ title: "Release Guard opened a revert PR", tag: "release-guard", route: "ops" })
    expect(notificationFor(alert)).toEqual({
      title: "Release Guard opened a revert PR",
      options: {
        tag: "release-guard",
        icon: "/phone/icons/icon-192.png",
        badge: "/phone/icons/icon-192.png",
        data: { url: "/phone/ops" },
      },
    })
  })

  test("a desktop alert opens with the key it names", async () => {
    const { key, sealing } = await alertKey()
    const c = await seal(sealing, { v: 1, title: "Your agent needs you", route: "approvals" })
    const keys = new Map([["mac-1", key]])
    const alert = await openAlert({ v: 1, kind: "e2e", c, k: "mac-1" }, async (id) => keys.get(id))
    expect(alert).toEqual({ title: "Your agent needs you", tag: "approvals", route: "approvals" })
    // Without `k`, the default key is used.
    const fallback = await openAlert({ v: 1, kind: "e2e", c }, async (id) => (id === "default" ? key : undefined))
    expect(fallback.title).toBe("Your agent needs you")
  })

  test("an alert this phone cannot open still shows, without content", async () => {
    const { key, sealing } = await alertKey()
    const other = await alertKey()
    const good = await seal(sealing, { v: 1, title: "Finished" })
    const keys = async () => key
    expect(await openAlert({ v: 1, kind: "e2e", c: good }, noKey)).toEqual(UNREADABLE_ALERT)
    expect(await openAlert({ v: 1, kind: "e2e", c: good }, async () => other.key)).toEqual(UNREADABLE_ALERT)
    expect(await openAlert({ v: 1, kind: "e2e", c: await seal(sealing, { v: 1, title: "x" }, "other") }, keys)).toEqual(
      UNREADABLE_ALERT,
    )
    expect(await openAlert({ v: 1, kind: "e2e", c: await seal(sealing, { v: 1, title: "a\nb" }) }, keys)).toEqual(
      UNREADABLE_ALERT,
    )
    expect(await openAlert({ v: 1, kind: "e2e", c: await seal(sealing, { title: "no version" }) }, keys)).toEqual(
      UNREADABLE_ALERT,
    )
    expect(await openAlert({ v: 1, kind: "e2e", c: "AAAA" }, keys)).toEqual(UNREADABLE_ALERT)
    expect(await openAlert(undefined, keys)).toEqual(UNREADABLE_ALERT)
    // A route the phone does not have is dropped, the title kept.
    const odd = await openAlert(
      { v: 1, kind: "e2e", c: await seal(sealing, { v: 1, title: "Hi", route: "admin" }) },
      keys,
    )
    expect(odd).toEqual({ title: "Hi", tag: "desktop" })
    expect(notificationFor(UNREADABLE_ALERT).options.data.url).toBe("/phone/")
  })
})

test("a tap opens a page inside the phone app only", () => {
  expect(clickTarget({ url: "/phone/ops" })).toBe("/phone/ops")
  expect(clickTarget({ url: "https://example.com/" })).toBe("/phone/")
  expect(clickTarget({ url: "/phone/../api/x" })).toBe("/phone/")
  expect(clickTarget(undefined)).toBe("/phone/")
  expect(routeForTag("ship-desk")).toBe("ops")
  expect(routeForTag("overnight")).toBe("computer")
  expect(routeForTag("unknown")).toBeUndefined()
})
