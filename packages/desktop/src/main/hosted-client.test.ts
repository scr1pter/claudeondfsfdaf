import { afterEach, describe, expect, test } from "bun:test"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import {
  createHostedClient,
  LIVE_VIEW_PARTITION,
  liveViewPartition,
  liveViewStep,
  liveViewTarget,
  liveViewTitle,
  liveViewWindowOptions,
  type LiveViewTarget,
} from "./hosted-client"

// WP A56 on the desktop: the composer's "Run on my cloud computer", the bar and the live view ask the main process,
// which holds the account token and sends only the requests the screens may make to vectordev.ai, through Vector
// Local's `cloud-computer` source. The live view opens only the computer's own viewer page, in a sandboxed window with
// no preload and an in-memory session. Requests go to fakes; any other connection off this computer throws.
NetworkGuard.use()

const SITE = "https://vectordev.ai"
const TOKEN = "vct_fixture-account-token"
const SESSION = `hs_${"a".repeat(26)}`
const VIEWER = `https://vh-abc-6080.sandbox.example#vt=vvt1.eyJhdWQiOiJ2ZWN0b3Itdmlld2VyIn0.c2lnbmF0dXJl`

afterEach(() => Egress.configure(LocalPolicy.OFF))

type Call = { url: string; method: string; authorization?: string; body?: unknown; redirect?: string }

function world(answer: (call: Call) => Response | Promise<Response>, token: string | null = TOKEN) {
  const calls: Call[] = []
  const windows: LiveViewTarget[] = []
  const opened: string[] = []
  const client = createHostedClient({
    token: async () => token ?? undefined,
    site: SITE,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const call: Call = {
        url,
        method: init.method ?? "GET",
        ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
        ...(init.redirect ? { redirect: init.redirect } : {}),
      }
      calls.push(call)
      return answer(call)
    },
    openLiveView: (target) => void windows.push(target),
    openExternal: (url) => void opened.push(url),
  })
  return { client, calls, windows, opened }
}

describe("requests", () => {
  test("only the screens' requests, with the account token, no redirects, to vectordev.ai", async () => {
    const fixture = world(() => Response.json({ available: true, access: "start", sessions: [] }))
    expect(await fixture.client.request({ kind: "status" })).toEqual({
      ok: true,
      body: { available: true, access: "start", sessions: [] },
    })
    await fixture.client.request({ kind: "estimate", size: "standard", minutes: 60 })
    await fixture.client.request({ kind: "start", size: "standard", jobMinutes: 60, prompt: "Tidy the docs" })
    expect(fixture.calls).toEqual([
      { url: `${SITE}/api/hosted/status`, method: "GET", authorization: `Bearer ${TOKEN}`, redirect: "error" },
      {
        url: `${SITE}/api/model-plans/estimate`,
        method: "POST",
        authorization: `Bearer ${TOKEN}`,
        body: { kind: "hosted", minutes: 60, size: "standard" },
        redirect: "error",
      },
      {
        url: `${SITE}/api/hosted/sessions`,
        method: "POST",
        authorization: `Bearer ${TOKEN}`,
        body: { size: "standard", jobMinutes: 60, prompt: "Tidy the docs" },
        redirect: "error",
      },
    ])
  })

  test("anything else is refused before the network, and signed out asks to sign in", async () => {
    const fixture = world(() => Response.json({}))
    for (const input of [{ kind: "admin/flags" }, { kind: "stop", id: "../x" }, "status", null])
      expect(await fixture.client.request(input)).toMatchObject({ ok: false })
    expect(fixture.calls).toEqual([])
    const signedOut = world(() => Response.json({}), null)
    expect(await signedOut.client.request({ kind: "status" })).toMatchObject({ ok: false, status: 401, code: "SIGN_IN" })
    expect(signedOut.calls).toEqual([])
  })

  test("a refusal carries vectordev.ai's code and words; an unreadable answer is a failure", async () => {
    const refused = world(() =>
      Response.json(
        { error: { code: "HOSTED_NOT_INCLUDED", message: "This computer size is not included in your plan." } },
        { status: 403 },
      ),
    )
    expect(await refused.client.request({ kind: "start", size: "large", jobMinutes: 60, prompt: "x" })).toEqual({
      ok: false,
      status: 403,
      code: "HOSTED_NOT_INCLUDED",
      message: "This computer size is not included in your plan.",
    })
    const garbled = world(() => new Response("<html>"))
    expect(await garbled.client.request({ kind: "status" })).toMatchObject({ ok: false })
    const list = world(() => Response.json([1, 2]))
    expect(await list.client.request({ kind: "status" })).toMatchObject({ ok: false })
    const down = world(() => {
      throw new Error("offline")
    })
    expect(await down.client.request({ kind: "status" })).toMatchObject({ ok: false, message: expect.stringContaining("reach") })
  })

  test("Vector Local keeps the cloud computer off: nothing is sent, and the screen says why", async () => {
    const fixture = world(() => Response.json({}))
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    expect(await fixture.client.request({ kind: "status" })).toMatchObject({ ok: false, code: "LOCAL_OFF" })
    expect(fixture.calls).toEqual([])
    expect(Egress.events({ blocked: true }).map((event) => `${event.source} ${event.origin}`)).toContain(
      `cloud-computer ${SITE}`,
    )
  })
})

describe("the live view", () => {
  test("asks for a link and opens it in the live view window, view or control", async () => {
    const fixture = world((call) => Response.json({ url: VIEWER, mode: (call.body as { mode: string }).mode, expiresAt: 1 }))
    expect(await fixture.client.liveView({ id: SESSION, mode: "view" })).toEqual({ ok: true })
    expect(await fixture.client.liveView({ id: SESSION, mode: "control" })).toEqual({ ok: true })
    expect(fixture.calls.map((call) => [call.url, call.body])).toEqual([
      [`${SITE}/api/hosted/sessions/${SESSION}/viewer`, { mode: "view" }],
      [`${SITE}/api/hosted/sessions/${SESSION}/viewer`, { mode: "control" }],
    ])
    expect(fixture.windows).toEqual([
      { url: VIEWER, origin: "https://vh-abc-6080.sandbox.example", mode: "view", session: SESSION },
      { url: VIEWER, origin: "https://vh-abc-6080.sandbox.example", mode: "control", session: SESSION },
    ])
  })

  test("a link that is not the computer's own viewer page is never opened", async () => {
    for (const url of ["https://evil.example/", "https://vh.sandbox.example/x#vt=a", `http://vh.sandbox.example#vt=vvt1.a.b`]) {
      const fixture = world(() => Response.json({ url, mode: "view", expiresAt: 1 }))
      expect(await fixture.client.liveView({ id: SESSION, mode: "view" })).toMatchObject({ ok: false })
      expect(fixture.windows).toEqual([])
    }
    const refused = world(() =>
      Response.json({ error: { code: "HOSTED_TAKEOVER_REQUIRED", message: "Take over first." } }, { status: 409 }),
    )
    expect(await refused.client.liveView({ id: SESSION, mode: "control" })).toMatchObject({
      ok: false,
      code: "HOSTED_TAKEOVER_REQUIRED",
    })
    expect(refused.windows).toEqual([])
  })

  test("the window: sandboxed, no preload, no webview, its own in-memory session, Vector's title", () => {
    const options = liveViewWindowOptions("view", SESSION)
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
    })
    expect("preload" in options.webPreferences).toBe(false)
    expect(options.webPreferences.partition).toBe(`${LIVE_VIEW_PARTITION}-${SESSION}`)
    expect(options.webPreferences.partition.startsWith("persist:")).toBe(false)
    expect(liveViewPartition("hs_a/../b")).toBe(`${LIVE_VIEW_PARTITION}-hs_ab`)
    expect(options.title).toBe("Vector is using its cloud computer")
    expect(liveViewTitle("control")).toBe("You have control of the cloud computer")
    expect(options.backgroundColor).toBe("#7c3aed")
  })

  test("the window loads only its computer's origin: the page over https and its socket over wss", () => {
    const origin = "https://vh-abc-6080.sandbox.example"
    expect(liveViewStep(`${origin}/`, origin)).toBe("load")
    expect(liveViewStep(`${origin}/viewer.js`, origin)).toBe("load")
    expect(liveViewStep("wss://vh-abc-6080.sandbox.example/socket", origin)).toBe("load")
    for (const url of [
      "http://vh-abc-6080.sandbox.example/",
      "ws://vh-abc-6080.sandbox.example/socket",
      "https://other.sandbox.example/",
      "https://vectordev.ai/api/hosted/status",
      "https://user:pass@vh-abc-6080.sandbox.example/",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(liveViewStep(url, origin)).toBe("cancel")
    expect(liveViewTarget({ url: VIEWER, origin, mode: "view", session: SESSION })).toBeDefined()
    expect(liveViewTarget({ url: VIEWER, origin: "https://other.example", mode: "view", session: SESSION })).toBeUndefined()
    expect(liveViewTarget({ url: "https://evil.example/", origin: "https://evil.example", mode: "view", session: SESSION })).toBeUndefined()
  })
})

describe("files and links", () => {
  test("files: packing answers not ready; a ready link to vectordev.ai's download route opens in the browser", async () => {
    const packing = world(() => Response.json({ ready: false }, { status: 202 }))
    expect(await packing.client.files({ id: SESSION })).toEqual({ ok: true, ready: false })
    expect(packing.opened).toEqual([])
    const link = `${SITE}/api/hosted/sessions/${SESSION}/download?t=abc.def`
    const ready = world(() => Response.json({ ready: true, url: link, expiresAt: 1 }))
    expect(await ready.client.files({ id: SESSION })).toEqual({ ok: true, ready: true })
    expect(ready.opened).toEqual([link])
    const elsewhere = world(() => Response.json({ ready: true, url: "https://evil.example/x", expiresAt: 1 }))
    expect(await elsewhere.client.files({ id: SESSION })).toMatchObject({ ok: false })
    expect(elsewhere.opened).toEqual([])
  })

  test("only a job's pull request or a recording's signed link opens, and nothing is fetched for it", async () => {
    const fixture = world(() => Response.json({}))
    expect(await fixture.client.open({ kind: "pull-request", url: "https://github.com/acme/site/pull/7" })).toEqual({ ok: true })
    const recording = `https://${"ab".repeat(16)}.r2.cloudflarestorage.com/vector-media/r/1.ts?X-Amz-Signature=1`
    expect(await fixture.client.open({ kind: "recording", url: recording })).toEqual({ ok: true })
    for (const input of [
      { kind: "pull-request", url: "https://evil.example/pull/1" },
      { kind: "recording", url: "https://github.com/acme/site/pull/7" },
      { kind: "anything", url: "https://github.com/acme/site/pull/7" },
    ])
      expect(await fixture.client.open(input)).toMatchObject({ ok: false })
    expect(fixture.opened).toEqual(["https://github.com/acme/site/pull/7", recording])
    expect(fixture.calls).toEqual([])
  })
})
