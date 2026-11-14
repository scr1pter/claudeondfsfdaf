import { afterEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "node:os"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { CallbackResponse, OnBeforeRequestListenerDetails } from "electron"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { billingStep } from "./billing-navigation"
import { createEgressFilter, decideChromium, type Kind, type Step } from "./egress-filter"

// Any connection off this computer throws: these tests decide requests, they never send one.
NetworkGuard.use()
afterEach(() => void Egress.configure(LocalPolicy.OFF))

// The billing window's own step comes from billing-window.ts, which reaches Electron's windows and the app's log.
const electron = { app: { getPath: () => tmpdir(), isPackaged: false }, shell: { openExternal: async () => {} } }
mock.module("electron", () => ({ default: electron, ...electron, BrowserWindow: class {} }))
mock.module("./logging", () => ({ write: () => {} }))
const { billingRequests } = await import("./billing-window")

const policy = (local: Parameters<typeof LocalPolicy.resolve>[0]["global"] = {}) =>
  LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://127.0.0.1:11434"], ...local } })
const OFF = LocalPolicy.OFF
const ASK = policy()
const NETWORK = policy({ web: "network", web_domains: { allow: ["intranet.corp.test"] } })
const NONE = policy({ web: "none" })
const FEED = "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-updates/latest-mac.yml"

describe("decideChromium", () => {
  const cases: [kind: Kind, url: string, policy: LocalMode.Policy, decision: string, rule: string, source: string][] = [
    // Vector Local off lets everything through, as before.
    ["app", "https://vectordev.ai/changelog.json", OFF, "allow", "local-off", "release-notes"],
    ["research-browser", "http://127.0.0.1:4096/", OFF, "allow", "local-off", "research-browser"],
    // Vector's own windows: their files, this computer, Vector servers on your network and the model servers.
    ["app", "oc://renderer/index.html", NONE, "allow", "loopback", "unlabelled"],
    ["app", "file:///Applications/Vector.app/icon.png", NONE, "allow", "loopback", "unlabelled"],
    ["app", "data:image/png;base64,AAAA", NONE, "allow", "loopback", "unlabelled"],
    ["app", "blob:oc://renderer/1f0e", NONE, "allow", "loopback", "unlabelled"],
    ["app", "devtools://devtools/bundled/inspector.html", NONE, "allow", "loopback", "unlabelled"],
    ["app", "http://127.0.0.1:4096/global/health", NONE, "allow", "listed", "unlabelled"],
    ["app", "ws://localhost:4096/pty", NONE, "allow", "listed", "unlabelled"],
    ["app", "http://build-box.lan:4096/global/health", NETWORK, "allow", "private-remote", "unlabelled"],
    ["app", "http://192.168.1.20:4096/session", ASK, "allow", "private-remote", "unlabelled"],
    // With Web access None, only what the app's own code sends reaches your network (the next test).
    ["app", "http://build-box.lan:4096/global/health", NONE, "block", "web-none", "unlabelled"],
    // What the app fetches from the internet is decided as the registry source it is.
    ["app", "https://vectordev.ai/changelog.json", ASK, "block", "vector-service", "release-notes"],
    ["app", "https://vectordev.ai/favicon-96x96-v3.png", ASK, "block", "vector-service", "site-assets"],
    ["app", "https://o12.ingest.us.sentry.io/api/34/envelope/", ASK, "block", "vector-service", "crash-reports"],
    [
      "app",
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
      ASK,
      "ask",
      "download-grant",
      "dictation-model",
    ],
    [
      "app",
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
      NONE,
      "block",
      "web-none",
      "dictation-model",
    ],
    // Anything else no part of Vector labelled reaches only this computer and the list.
    ["app", "https://avatars.githubusercontent.com/u/1", ASK, "block", "unlabelled", "unlabelled"],
    ["app", "wss://relay.example.com/socket", ASK, "block", "unlabelled", "unlabelled"],
    ["app", "ftp://files.example.com/a", ASK, "block", "unlabelled", "unlabelled"],
    ["billing", "https://checkout.stripe.com/c/pay", ASK, "block", "unlabelled", "unlabelled"],
    ["other", "https://my-site.vercel.app/", ASK, "block", "unlabelled", "unlabelled"],
    ["other", "http://127.0.0.1:11434/api/tags", NONE, "allow", "listed", "unlabelled"],
    // The agent's browser follows Web access, and pages on this computer stay on it.
    ["agent-browser", "https://example.org/", ASK, "allow", "web-ask", "agent-browser"],
    ["agent-browser", "https://example.org/", NETWORK, "block", "web-network", "agent-browser"],
    ["agent-browser", "https://intranet.corp.test/wiki", NETWORK, "allow", "web-allow", "agent-browser"],
    ["agent-browser", "http://10.0.0.8/", NETWORK, "allow", "web-allow", "agent-browser"],
    ["agent-browser", "https://example.org/", NONE, "block", "web-none", "agent-browser"],
    ["agent-browser", "http://localhost:5173/", NONE, "allow", "loopback", "agent-browser"],
    ["agent-browser", "wss://example.org/live", NONE, "block", "web-none", "agent-browser"],
    [
      "agent-browser",
      "https://ads.example.net/pixel.gif",
      policy({ web_domains: { deny: ["example.net"] } }),
      "block",
      "web-deny",
      "agent-browser",
    ],
    ["agent-browser", "about:blank", NONE, "allow", "loopback", "agent-browser"],
    // A research browser follows Web access too, but never reaches this computer, your network or Vector's pages.
    ["research-browser", "https://example.org/paper", ASK, "allow", "web-ask", "research-browser"],
    ["research-browser", "https://example.org/paper", NONE, "block", "web-none", "research-browser"],
    ["research-browser", "http://127.0.0.1:4096/session", ASK, "block", "private-destination", "research-browser"],
    ["research-browser", "http://[::1]:8080/", ASK, "block", "private-destination", "research-browser"],
    ["research-browser", "http://192.168.0.1/", ASK, "block", "private-destination", "research-browser"],
    ["research-browser", "http://printer.local/", ASK, "block", "private-destination", "research-browser"],
    ["research-browser", "file:///etc/passwd", ASK, "block", "unlabelled", "research-browser"],
    ["research-browser", "oc://renderer/index.html", ASK, "block", "unlabelled", "research-browser"],
    ["research-browser", "devtools://devtools/inspector.html", ASK, "block", "unlabelled", "research-browser"],
    ["research-browser", "data:image/png;base64,AAAA", NONE, "allow", "loopback", "research-browser"],
    ["research-browser", "about:srcdoc", NONE, "allow", "loopback", "research-browser"],
    // The updater checks only as `updates` allows: a company mirror, never automatically.
    ["updates", FEED, ASK, "block", "automatic-update", "updates"],
    ["updates", FEED, NONE, "block", "web-none", "updates"],
    [
      "updates",
      "https://mirror.corp.test/vector/latest-mac.yml",
      LocalPolicy.resolve({
        managed: { enabled: true, updates: { url: "https://mirror.corp.test/vector/" } },
      }),
      "allow",
      "mirror",
      "updates",
    ],
  ]

  test.each(cases)("%s %s", (kind, url, local, decision, rule, source) => {
    const decided = decideChromium({ url, kind, policy: local })
    expect({ decision: decided.decision, rule: decided.rule, source: decided.source }).toEqual({
      decision,
      rule,
      source,
    })
  })

  test("until the policy is read, reaches this computer and the app's own files only", () => {
    const pending = LocalPolicy.PENDING
    const decide = (url: string, kind: Kind, resource?: string, granted?: Set<string>) => {
      const decided = decideChromium({ url, kind, policy: pending, resource, granted })
      return `${decided.decision} ${decided.rule}`
    }
    expect(decide("oc://renderer/index.html", "app")).toBe("allow loopback")
    expect(decide("http://127.0.0.1:4096/global/health", "app", "xhr")).toBe("allow pending")
    expect(decide("http://build-box.lan:4096/session", "app", "xhr")).toBe("block pending")
    expect(decide("http://192.168.1.20:4096/session", "app", "webSocket")).toBe("block pending")
    expect(decide(FEED, "updates", "other", new Set([new URL(FEED).origin]))).toBe("block pending")
    expect(decide("https://example.org/", "agent-browser", "mainFrame")).toBe("block pending")
    expect(decide("http://localhost:5173/", "agent-browser", "mainFrame")).toBe("allow pending")
    // A research browser still never reaches this computer.
    expect(decide("http://127.0.0.1:4096/session", "research-browser", "mainFrame")).toBe("block private-destination")
  })

  test("with Web access None, lets the app's own requests reach a Vector server on your network, and no page's", () => {
    const decide = (url: string, resource: string, local = NONE) =>
      decideChromium({ url, kind: "app", policy: local, resource }).decision
    // The app's own client talks to the server it connects to: its requests, its event stream and its terminal.
    expect(decide("http://build-box.lan:4096/session", "xhr")).toBe("allow")
    expect(decide("ws://build-box.lan:4096/pty/1/connect", "webSocket")).toBe("allow")
    // A reply the app shows cannot make it load anything there: an image, a frame, a page, a font.
    for (const resource of ["image", "media", "subFrame", "mainFrame", "font", "stylesheet", "ping", "other"])
      expect([resource, decide("http://exfil.lan/?d=secret", resource)]).toEqual([resource, "block"])
    expect(decide("https://box.tail1234.ts.net/?d=secret", "image")).toBe("block")
    // This computer, and Web access that lets your network through, are as before.
    expect(decide("http://127.0.0.1:4096/file?path=a.png", "image")).toBe("allow")
    expect(decide("http://exfil.lan/a.png", "image", NETWORK)).toBe("allow")
    expect(decide("http://exfil.lan/a.png", "image", ASK)).toBe("allow")
  })

  test("lets the updater reach a feed the user just asked to check, and nothing else", () => {
    const granted = new Set([new URL(FEED).origin])
    expect(decideChromium({ url: FEED, kind: "updates", policy: ASK, granted })).toMatchObject({
      decision: "allow",
      rule: "manual-check",
    })
    expect(
      decideChromium({ url: "https://vectordev.ai/download", kind: "updates", policy: ASK, granted }).decision,
    ).toBe("block")
  })

  test("offers Allow… for Vector's own services, and not for what no part of Vector labelled", () => {
    expect(decideChromium({ url: "https://vectordev.ai/changelog.json", kind: "app", policy: ASK }).allowable).toBe(
      true,
    )
    expect(decideChromium({ url: "https://vectordev.ai/changelog.json", kind: "app", policy: ASK }).purpose).toBe(
      "release-notes",
    )
    expect(decideChromium({ url: "https://example.com/", kind: "app", policy: ASK }).allowable).toBe(false)
  })

  test("lets release notes through once the user allows them", () => {
    const allowed = policy({
      allow: [{ source: "release-notes", reason: "What changed", added_at: 1, added_by: "app" }],
    })
    expect(decideChromium({ url: "https://vectordev.ai/changelog.json", kind: "app", policy: allowed })).toMatchObject({
      decision: "allow",
      rule: "allowed-source",
    })
  })
})

// A Chromium session as the dispatcher sees it: the one onBeforeRequest listener it holds.
const fakeSession = () => {
  const session = {
    listener: undefined as Step | undefined,
    replaced: 0,
    dictionaries: undefined as string | undefined,
    webRequest: {
      onBeforeRequest: (listener: Step | null) => {
        if (session.listener) session.replaced++
        session.listener = listener ?? undefined
      },
    },
    setSpellCheckerDictionaryDownloadURL: (url: string) => {
      session.dictionaries = url
    },
  }
  return session
}
type FakeSession = ReturnType<typeof fakeSession>

let ids = 0
const details = (url: string, resourceType: OnBeforeRequestListenerDetails["resourceType"] = "mainFrame", more = {}) =>
  ({
    id: ++ids,
    url,
    method: "GET",
    resourceType,
    referrer: "",
    timestamp: 0,
    uploadData: [],
    webContentsId: 7,
    ...more,
  }) as OnBeforeRequestListenerDetails
const send = (session: FakeSession, request: OnBeforeRequestListenerDetails) =>
  new Promise<CallbackResponse>((resolve) => session.listener!(request, resolve))

const filterWith = (local: () => LocalMode.Policy, platform: NodeJS.Platform = "darwin") => {
  const recorded: { source: string; origin: string; decision: string; resource?: string }[] = []
  const filter = createEgressFilter({
    policy: local,
    platform,
    record: (request, verdict) =>
      recorded.push({
        source: request.source,
        origin: new URL(String(request.url)).origin,
        decision: verdict.decision,
        ...(request.resource ? { resource: request.resource } : {}),
      }),
  })
  return { filter, recorded }
}

describe("the Chromium dispatcher", () => {
  test("puts one listener on a session, however many steps register on it", () => {
    const { filter } = filterWith(() => OFF)
    const session = fakeSession()
    filter.prepare(session, "app")
    filter.register(session, (_details, callback) => callback({}))
    filter.register(session, (_details, callback) => callback({}))
    filter.prepare(session)
    expect(session.listener).toBeDefined()
    expect(session.replaced).toBe(0)
  })

  test("decides Vector Local first and runs a window's step only for a request it lets go", async () => {
    const local = { current: policy({ endpoints: ["https://checkout.stripe.com"] }) }
    const { filter, recorded } = filterWith(() => local.current)
    const session = fakeSession()
    const order: string[] = []
    filter.register(
      session,
      (request, callback) => {
        order.push(`billing ${new URL(request.url).hostname}`)
        callback({})
      },
      { kind: "billing" },
    )
    expect(await send(session, details("https://checkout.stripe.com/c/pay"))).toEqual({})
    expect(await send(session, details("https://evil.example.com/"))).toEqual({ cancel: true })
    // The refused request never reached the window's step.
    expect(order).toEqual(["billing checkout.stripe.com"])
    expect(recorded.map((item) => `${item.decision} ${item.origin}`)).toEqual([
      "allow https://checkout.stripe.com",
      "block https://evil.example.com",
    ])
  })

  test("keeps billing's routing: a return to the site is cancelled and routed, with Vector Local off", async () => {
    const { filter, recorded } = filterWith(() => OFF)
    const session = fakeSession()
    const origin = "https://vectordev.ai"
    const routed: string[] = []
    // The site's own pages finish the billing window instead of loading in it, as the window's route does.
    filter.register(
      session,
      billingRequests(origin, (target) => {
        const next = billingStep(target, origin)
        routed.push(next.load ? "load" : (next.finish ?? (next.browser ? "browser" : "kept")))
      }),
      { kind: "billing" },
    )
    expect(await send(session, details("https://checkout.stripe.com/c/pay"))).toEqual({})
    expect(await send(session, details(`${origin}/account?model_plan=success`))).toEqual({ cancel: true })
    expect(await send(session, details(`${origin}/account?model_plan=cancelled`))).toEqual({ cancel: true })
    expect(await send(session, details(`${origin}/pricing`))).toEqual({ cancel: true })
    // A frame of the site is not the window's page, so it loads.
    expect(await send(session, details(`${origin}/frame`, "subFrame"))).toEqual({})
    expect(routed).toEqual(["completed", "cancelled", "browser"])
    // Vector Local off logs nothing.
    expect(recorded).toEqual([])
  })

  test("stops at the first step that cancels or redirects, and cancels a request whose step throws", async () => {
    const { filter } = filterWith(() => OFF)
    const session = fakeSession()
    const ran: string[] = []
    filter.register(session, (request, callback) => {
      ran.push("first")
      if (request.url.includes("redirect")) return callback({ redirectURL: "https://example.org/landed" })
      if (request.url.includes("throw")) throw new Error("a broken step")
      callback({})
    })
    const unregister = filter.register(session, (_request, callback) => {
      ran.push("second")
      callback({ cancel: true })
    })
    expect(await send(session, details("https://example.org/redirect"))).toEqual({
      redirectURL: "https://example.org/landed",
    })
    expect(await send(session, details("https://example.org/throw"))).toEqual({ cancel: true })
    expect(await send(session, details("https://example.org/next"))).toEqual({ cancel: true })
    unregister()
    expect(await send(session, details("https://example.org/after"))).toEqual({})
    expect(ran).toEqual(["first", "first", "first", "second", "first"])
  })

  test("refuses this computer to a research browser before its own step runs", async () => {
    const { filter } = filterWith(() => ASK)
    const session = fakeSession()
    const ran: string[] = []
    filter.register(
      session,
      (request, callback) => {
        ran.push(request.url)
        callback({})
      },
      { kind: "research-browser" },
    )
    expect(await send(session, details("http://127.0.0.1:4096/session"))).toEqual({ cancel: true })
    expect(await send(session, details("https://example.org/"))).toEqual({})
    expect(ran).toEqual(["https://example.org/"])
  })

  test("logs a page as a page, and what it loaded once per host, and nothing that stays on this computer", async () => {
    const { filter, recorded } = filterWith(() => ASK)
    const session = fakeSession()
    filter.prepare(session, "agent-browser")
    const page = details("https://news.example.org/")
    await send(session, page)
    // A redirect hop of the same page is the page reaching another host.
    await send(session, { ...page, url: "https://www.news.example.org/" })
    await send(session, details("https://cdn.example.net/app.js", "script"))
    await send(session, details("https://cdn.example.net/style.css", "stylesheet"))
    await send(session, details("https://fonts.example.com/a.woff2", "font"))
    await send(session, details("http://localhost:5173/hot", "script"))
    await send(session, details("data:image/png;base64,AAAA", "image"))
    await send(session, details("https://docs.example.org/", "mainFrame"))
    await send(session, details("https://cdn.example.net/app.js", "script"))
    // Another web contents' page is its own page.
    await send(session, details("https://cdn.example.net/app.js", "script", { webContentsId: 9 }))
    // A page on this computer is not logged, but what it loads from the internet is logged for it.
    await send(session, details("http://localhost:5173/", "mainFrame"))
    await send(session, details("https://cdn.example.net/app.js", "script"))
    expect(recorded.map((item) => `${item.resource} ${item.origin}`)).toEqual([
      "page https://news.example.org",
      "subresource https://www.news.example.org",
      "subresource https://cdn.example.net",
      "subresource https://fonts.example.com",
      "page https://docs.example.org",
      "subresource https://cdn.example.net",
      "subresource https://cdn.example.net",
      "subresource https://cdn.example.net",
    ])
  })

  test("logs a blocked host once per page, with the source it was decided as", async () => {
    const { filter, recorded } = filterWith(() => ASK)
    const session = fakeSession()
    filter.prepare(session, "app")
    await send(session, details("oc://renderer/index.html"))
    for (const _ of [1, 2, 3]) await send(session, details("https://o12.ingest.us.sentry.io/api/34/envelope/", "xhr"))
    await send(session, details("https://vectordev.ai/changelog.json", "xhr"))
    expect(recorded).toEqual([
      { source: "crash-reports", origin: "https://o12.ingest.us.sentry.io", decision: "block" },
      { source: "release-notes", origin: "https://vectordev.ai", decision: "block" },
    ])
  })

  test("logs a request a window's step stops as blocked by that window's rule, never as a page", async () => {
    Egress.configure(ASK)
    const filter = createEgressFilter({
      policy: Egress.policy,
      record: (request, verdict) => void Egress.record(request, verdict),
    })
    const research = fakeSession()
    // The research browsers' navigation rule refuses a page outside the run's addresses, as research-navigation does.
    filter.register(
      research,
      (request, callback) =>
        callback(request.resourceType === "mainFrame" && request.url.includes("outside") ? { cancel: true } : {}),
      { kind: "research-browser" },
    )
    filter.attribute(31, { sessionID: "ses_navigator", rootID: "ses_navigation" })
    const at = { webContentsId: 31 }
    expect(await send(research, details("https://journal.example.org/abstract", "mainFrame", at))).toEqual({})
    expect(await send(research, details("https://outside.example.net/", "mainFrame", at))).toEqual({ cancel: true })
    // What the page already open loads is still that page's.
    await send(research, details("https://figures.example.com/figure.png", "image", at))
    expect(Egress.summary("ses_navigation")).toMatchObject({ pages: 1, hosts: 1, blocked: { "research-browser": 1 } })
    const refused = Egress.events().find((event) => event.origin === "https://outside.example.net")
    expect(refused).toMatchObject({ decision: "block", rule: "window-rule", resource: "page" })
    expect(Egress.events().find((event) => event.origin === "https://figures.example.com")?.resource).toBe(
      "subresource",
    )
  })

  test("lets a session reach an origin only while a check the user asked for runs", async () => {
    const { filter } = filterWith(() => ASK)
    const session = fakeSession()
    filter.prepare(session, "updates")
    expect(await send(session, details(FEED, "other"))).toEqual({ cancel: true })
    const during = await filter.allowing(session, [FEED], () => send(session, details(FEED, "other")))
    expect(during).toEqual({})
    expect(await send(session, details(FEED, "other"))).toEqual({ cancel: true })
  })

  test("keeps Chromium's spellcheck dictionaries on this computer on Windows and Linux with Vector Local on", () => {
    const expectations: [NodeJS.Platform, LocalMode.Policy, string | undefined][] = [
      ["win32", ASK, "http://127.0.0.1:9/"],
      ["linux", ASK, "http://127.0.0.1:9/"],
      ["darwin", ASK, undefined],
      ["win32", OFF, undefined],
    ]
    for (const [platform, local, dictionaries] of expectations) {
      const { filter } = filterWith(() => local, platform)
      const session = fakeSession()
      filter.prepare(session)
      expect([platform, local.enabled, session.dictionaries]).toEqual([platform, local.enabled, dictionaries])
    }
  })

  test("points every session it is on at this computer's dictionaries once Vector Local is turned on", () => {
    const local = { current: OFF }
    const { filter } = filterWith(() => local.current, "win32")
    const first = fakeSession()
    const second = fakeSession()
    filter.prepare(first, "app")
    filter.prepare(second, "agent-browser")
    expect([first.dictionaries, second.dictionaries]).toEqual([undefined, undefined])
    local.current = ASK
    filter.refresh()
    expect([first.dictionaries, second.dictionaries]).toEqual(["http://127.0.0.1:9/", "http://127.0.0.1:9/"])
  })

  test("counts a research browser's page in its run's counters, and an agent browser's in its session's", async () => {
    Egress.configure(ASK)
    const filter = createEgressFilter({
      policy: Egress.policy,
      record: (request, verdict) => void Egress.record(request, verdict),
    })
    const research = fakeSession()
    const agent = fakeSession()
    filter.prepare(research, "research-browser")
    filter.prepare(agent, "agent-browser")
    const stop = filter.attribute(21, { sessionID: "ses_researcher", rootID: "ses_lead", agent: "researcher" })
    filter.attribute(22, { sessionID: "ses_build" })
    await send(research, details("https://paper.example.org/abstract", "mainFrame", { webContentsId: 21 }))
    await send(research, details("https://cdn.example.net/app.js", "script", { webContentsId: 21 }))
    await send(agent, details("https://docs.example.org/", "mainFrame", { webContentsId: 22 }))
    expect(Egress.summary("ses_lead")).toMatchObject({ requests: 2, pages: 1 })
    expect(Egress.summary("ses_build")).toMatchObject({ requests: 1, pages: 1 })
    expect(Egress.events().find((event) => event.origin === "https://paper.example.org")).toMatchObject({
      session_id: "ses_researcher",
      root_session_id: "ses_lead",
      resource: "page",
    })
    // A closed browser's next web contents with the same ID is no longer the run's.
    stop()
    await send(research, details("https://other.example.org/", "mainFrame", { webContentsId: 21 }))
    expect(Egress.summary("ses_lead").pages).toBe(1)
  })

  test("keeps WebRTC to the proxy on a web contents with Vector Local on", () => {
    const local = { current: OFF }
    const { filter } = filterWith(() => local.current)
    const policies: string[] = []
    const contents = { setWebRTCIPHandlingPolicy: (value: string) => void policies.push(value) }
    expect(filter.protect(contents)).toBe(false)
    local.current = ASK
    expect(filter.protect(contents)).toBe(true)
    expect(policies).toEqual(["disable_non_proxied_udp"])
  })
})
