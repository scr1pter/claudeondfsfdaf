import { describe, expect, test } from "bun:test"
import { openAlert } from "../../../app/src/phone/alerts"
import { fromBase64url, toBase64url } from "./remote-crypto"
import { alertTitle, createRemoteNotify, NOTIFY_URL } from "./remote-notify"

function setup(options: { paired?: boolean; status?: number; token?: string } = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const key = { key: toBase64url(raw), id: "alert-key-0123456789" }
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const clock = { now: 1_000_000 }
  const notify = createRemoteNotify({
    token: async () => ("token" in options ? options.token : "vct_desktop"),
    alertKey: () => (options.paired === false ? undefined : key),
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(String(init.body)) })
      return new Response("{}", { status: options.status ?? 200 })
    },
    now: () => clock.now,
  })
  return { notify, requests, raw, key, clock }
}

describe("phone alerts from this computer", () => {
  test("sends only ciphertext that the paired phone opens", async () => {
    const { notify, requests, raw, key } = setup()
    const result = await notify.send({
      event: "finished",
      title: "An agent finished: Fix the login",
      route: "sessions",
    })
    expect(result).toEqual({ sent: true })
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe(NOTIFY_URL)
    expect((request.init.headers as Record<string, string>).authorization).toBe("Bearer vct_desktop")
    expect(request.init.redirect).toBe("error")
    expect(Object.keys(request.body).sort()).toEqual(["ciphertext", "key", "urgency"])
    expect(request.body.key).toBe(key.id)
    expect(request.body.urgency).toBe("normal")
    // vectordev.ai never sees the title (P7).
    expect(String(request.init.body)).not.toContain("Fix the login")
    expect(String(request.init.body)).not.toContain("finished")
    const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])
    const alert = await openAlert({ v: 1, kind: "e2e", c: request.body.ciphertext as string, k: key.id }, async (id) =>
      id === key.id ? cryptoKey : undefined,
    )
    expect(alert).toEqual({ title: "An agent finished: Fix the login", tag: "sessions", route: "sessions" })
  })

  test("asks for high urgency only when an agent needs the person", async () => {
    const { notify, requests } = setup()
    await notify.send({ event: "needsYou", title: "An agent needs you", route: "approvals" })
    expect(requests[0]!.body.urgency).toBe("high")
  })

  test("sends nothing with no phone paired, while signed out, or for an alert it does not know", async () => {
    expect(await setup({ paired: false }).notify.send({ event: "finished", title: "x" })).toEqual({
      sent: false,
      reason: "not-paired",
    })
    const signedOut = setup({ token: undefined })
    expect(await signedOut.notify.send({ event: "finished", title: "x" })).toEqual({
      sent: false,
      reason: "signed-out",
    })
    expect(signedOut.requests).toEqual([])
    const { notify, requests } = setup()
    for (const input of [
      { event: "other", title: "x" },
      { event: "finished", title: "   " },
      { event: "finished", title: "x", route: "settings" },
      "finished",
      null,
    ])
      expect((await notify.send(input)).reason).toBe("invalid")
    expect(requests).toEqual([])
  })

  test("sends an alert asked for by several windows once, and at most 50 an hour", async () => {
    const { notify, requests, clock } = setup()
    await notify.send({ event: "finished", title: "Same" })
    expect(await notify.send({ event: "finished", title: "Same" })).toEqual({ sent: false, reason: "duplicate" })
    clock.now += 60_000
    expect((await notify.send({ event: "finished", title: "Same" })).sent).toBe(true)
    for (let index = 0; index < 60; index++) await notify.send({ event: "finished", title: `Run ${index}` })
    expect(requests).toHaveLength(50)
    expect(await notify.send({ event: "finished", title: "One more" })).toEqual({ sent: false, reason: "limited" })
    clock.now += 3_600_000
    expect((await notify.send({ event: "finished", title: "One more" })).sent).toBe(true)
  })

  test("reports a refused send", async () => {
    expect(await setup({ status: 402 }).notify.send({ event: "usage", title: "Codium usage" })).toEqual({
      sent: false,
      reason: "failed",
    })
  })

  test("keeps titles to one line of 120 characters", () => {
    expect(alertTitle("  An agent\nfinished\t ")).toBe("An agent finished")
    const long = alertTitle("x".repeat(200))!
    expect(long.length).toBe(120)
    expect(long.endsWith("…")).toBe(true)
    expect(alertTitle(7)).toBeUndefined()
    expect(fromBase64url(toBase64url(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]))
  })
})
