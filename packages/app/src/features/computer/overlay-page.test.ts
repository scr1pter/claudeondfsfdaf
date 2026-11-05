import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerOverlayPage } from "./overlay-page"

const EDGES = ["top", "right", "bottom", "left"] as const
const PAGES = [
  ...EDGES.map((edge) => [`glow ${edge}`, ComputerOverlayPage.glowStripPage(edge)] as const),
  ["banner", ComputerOverlayPage.bannerPage()] as const,
  ["cursor", ComputerOverlayPage.cursorPage()] as const,
]
const PHASES = [
  "off",
  "setup",
  "ready",
  "working",
  "asking",
  "handoff",
  "paused",
  "waiting",
  "done",
  "stopped",
] as const
const ACTIVE = ["working", "asking", "handoff", "paused", "waiting"] as const

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID: "ses_holder", directory: "/repo", title: "Receipts", startedAt: 1, actions: 4 },
    apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: Hands.STOP_CHORD.darwin,
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

function ask(kind: Computer.AskKind, patch: Partial<NonNullable<Computer.ComputerState["ask"]>> = {}) {
  return {
    requestID: `perm_${kind}`,
    directory: "/repo",
    kind,
    title: `Title for ${kind}`,
    canAlways: false,
    shownAt: 1000,
    ...patch,
  }
}

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html")
const scriptOf = (html: string) => parse(html).querySelector("script")!.textContent ?? ""
const styleOf = (html: string) => parse(html).querySelector("style")!.textContent ?? ""

/** Each `@keyframes` block's property names. */
function keyframes(css: string) {
  return [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map((match) => {
    const start = match.index! + match[0].length
    let depth = 1
    let end = start
    while (depth > 0) {
      if (css[end] === "{") depth++
      if (css[end] === "}") depth--
      end++
    }
    const body = css.slice(start, end - 1)
    return { name: match[1]!, properties: [...body.matchAll(/([\w-]+)\s*:/g)].map((property) => property[1]!) }
  })
}

describe("pages", () => {
  test("the CSP is present and no http appears", () => {
    for (const [name, html] of PAGES) {
      const doc = parse(html)
      const metas = Array.from(doc.head.children)
      expect(metas[0]?.getAttribute("charset"), name).toBe("utf-8")
      expect(metas[1]?.getAttribute("http-equiv"), name).toBe("Content-Security-Policy")
      expect(metas[1]?.getAttribute("content"), name).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      )
      expect(ComputerOverlayPage.CSP).toBe(metas[1]!.getAttribute("content")!)
      // The CSP comes before every style and script.
      expect(doc.querySelectorAll("meta[http-equiv]")).toHaveLength(1)
      expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<style>"))
      // The only "http" is the meta's own attribute name: no URL, font, import or resource reference anywhere.
      expect(html.replaceAll('http-equiv="Content-Security-Policy"', ""), name).not.toMatch(/http/i)
      expect(html, name).not.toMatch(/\/\/|url\(|@import|@font-face|\ssrc\s*=|\shref\s*=|xlink/i)
      expect(doc.querySelectorAll("link, img, iframe, object, embed, video, audio, source, base, form")).toHaveLength(0)
      expect(doc.querySelectorAll("script")).toHaveLength(1)
      expect(doc.querySelector("script")!.hasAttribute("src")).toBe(false)
    }
  })

  test("the reduced-motion rules exist", () => {
    for (const [name, html] of PAGES) {
      const css = styleOf(html)
      expect(css, name).toContain("@media (prefers-reduced-motion: reduce)")
      expect(css, name).toContain("[data-reduce-motion]")
    }
  })

  test("only opacity is animated", () => {
    for (const [name, html] of PAGES) {
      const css = styleOf(html)
      const frames = keyframes(css)
      expect(frames.length, name).toBeGreaterThan(0)
      for (const frame of frames)
        expect(new Set(frame.properties), `${name} ${frame.name}`).toEqual(new Set(["opacity"]))
      // Transitions are opacity only, except the ghost cursor's glide, which reduced motion removes.
      for (const transition of css.matchAll(/transition:\s*([^;]+);/g)) {
        if (transition[1] === "none") continue
        if (name === "cursor" && transition[1] === "transform 240ms ease-out") continue
        expect(transition[1], name).toMatch(/^opacity \d+ms/)
      }
    }
    expect(styleOf(ComputerOverlayPage.glowStripPage("top"))).toContain(
      `transition: opacity ${Computer.LIMITS.overlayFadeMs}ms`,
    )
    expect(keyframes(styleOf(ComputerOverlayPage.glowStripPage("left"))).map((frame) => frame.name)).toEqual([
      "vector-breathe",
    ])
  })

  test("glow strips are pointer-events:none", () => {
    for (const edge of EDGES) {
      const html = ComputerOverlayPage.glowStripPage(edge)
      const doc = parse(html)
      expect(styleOf(html)).toContain("* { pointer-events: none;")
      expect(doc.documentElement.dataset.edge).toBe(edge)
      expect(doc.querySelector(".glow > .breathe > .layer")).not.toBeNull()
      expect(doc.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0)
    }
    expect(styleOf(ComputerOverlayPage.cursorPage())).toContain("* { pointer-events: none;")
    // Each strip's layer runs past the strip only on the three sides that are not the screen's edge.
    const inset = (edge: (typeof EDGES)[number]) =>
      styleOf(ComputerOverlayPage.glowStripPage(edge)).match(/\.layer \{ inset: ([^;]+); \}/)![1]
    expect(inset("top")).toBe("0 0 -400px 0")
    expect(inset("right")).toBe("-400px 0 -400px -400px")
    expect(inset("bottom")).toBe("-400px 0 0 0")
    expect(inset("left")).toBe("-400px -400px -400px 0")
  })

  test("the banner contains exactly the BANNER sentence; no innerHTML", () => {
    const html = ComputerOverlayPage.bannerPage()
    const doc = parse(html)
    expect(doc.querySelector(".title")!.textContent).toBe(Hands.BANNER)
    expect(html.split(Hands.BANNER)).toHaveLength(2)
    const line = doc.querySelector(".line")!
    expect(line.getAttribute("role")).toBe("status")
    expect(line.getAttribute("aria-live")).toBe("polite")
    for (const [name, page] of PAGES) {
      const script = scriptOf(page)
      for (const sink of [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "Function(",
        "srcdoc",
      ])
        expect(script, `${name} ${sink}`).not.toContain(sink)
      expect(script, name).not.toContain("</")
      for (const element of Array.from(parse(page).querySelectorAll("*")))
        for (const attribute of Array.from(element.attributes)) expect(attribute.name, name).not.toMatch(/^on/i)
    }
  })

  test("every page shares one script whose constants match the schema", () => {
    const scripts = new Set(PAGES.map(([, html]) => scriptOf(html)))
    expect(scripts.size).toBe(1)
    const script = [...scripts][0]!
    expect(JSON.parse(script.match(/const LIMITS = (\{[^}]*\});/)![1]!)).toEqual({
      askArmMs: Computer.LIMITS.askArmMs,
      overlayFadeMs: Computer.LIMITS.overlayFadeMs,
    })
    expect(JSON.parse(script.match(/const ACTIONS = (\[[^\]]*\]);/)![1]!)).toEqual([...Computer.OverlayAction.literals])
    expect(script).not.toContain("always")
  })
})

describe("views", () => {
  test("the Esc keycap shows only in the foreground working phase", () => {
    for (const phase of PHASES)
      for (const mode of ["foreground", "background"] as const)
        for (const escStops of [true, false]) {
          const view = ComputerOverlayPage.bannerView(state({ phase, mode, escStops }))
          if (phase === "off" || phase === "setup" || phase === "ready") {
            expect(view).toBeUndefined()
            continue
          }
          const expected =
            phase === "done" || phase === "stopped"
              ? ""
              : escStops && phase === "working" && mode === "foreground"
                ? "Esc"
                : "⌘⇧Esc"
          expect(view!.key, `${phase} ${mode} ${escStops}`).toBe(expected)
        }
    const windows = { backend: "local-windows" as const, stopChord: Hands.STOP_CHORD.win32 }
    expect(ComputerOverlayPage.bannerView(state({ ...windows, phase: "asking" }))!.key).toBe("Ctrl+Alt+Shift+Esc")
    expect(ComputerOverlayPage.bannerView(state({ ...windows }))!.key).toBe("Esc")
    expect(ComputerOverlayPage.bannerView(state({ phase: "paused", stopChord: "Control+Option+K" }))!.key).toBe("⌃⌥K")
    // A state without a chord still names the platform's default, never nothing.
    expect(ComputerOverlayPage.bannerView(state({ phase: "paused", stopChord: "" }))!.key).toBe("⌘⇧Esc")
    expect(ComputerOverlayPage.bannerView(state({ ...windows, phase: "paused", stopChord: "" }))!.key).toBe(
      "Ctrl+Alt+Shift+Esc",
    )
  })

  test("banner state is rendered from Vector-built fields only", () => {
    const secret = "SENTINEL-model-text"
    const tainted = (patch: Partial<Computer.ComputerState>) =>
      state({
        holder: { sessionID: "ses_holder", directory: `/${secret}`, title: secret, startedAt: 1, actions: 4 },
        queue: [
          { sessionID: "ses_a", title: secret },
          { sessionID: "ses_b", title: `${secret} 2` },
        ],
        ...patch,
      })
    const views = [
      ...PHASES.map((phase) => tainted({ phase })),
      ...(["app", "sensitive", "handoff", "pointer", "check_in"] as const).flatMap((kind) =>
        (["asking", "handoff", "paused"] as const).map((phase) =>
          tainted({ phase, ask: ask(kind, { detail: secret, directory: `/${secret}` }) }),
        ),
      ),
    ].map(ComputerOverlayPage.bannerView)
    for (const view of views) expect(JSON.stringify(view ?? null)).not.toContain(secret)
    expect(ComputerOverlayPage.bannerView(tainted({}))!.waiting).toBe("+2 waiting")
  })

  test("buttons for each phase and ask", () => {
    const buttons = (patch: Partial<Computer.ComputerState>) =>
      ComputerOverlayPage.bannerView(state(patch))!.buttons.map((button) => button.label)
    expect(buttons({})).toEqual(["Take over", "Stop"])
    expect(buttons({ phase: "waiting" })).toEqual(["Take over", "Stop"])
    expect(buttons({ mode: "background" })).toEqual(["Stop"])
    expect(buttons({ phase: "asking", ask: ask("app") })).toEqual(["Deny", "Allow", "Stop"])
    expect(buttons({ phase: "asking", ask: ask("sensitive") })).toEqual(["Deny", "Allow once", "Stop"])
    expect(buttons({ phase: "handoff", ask: ask("handoff") })).toEqual(["Continue", "Stop"])
    expect(buttons({ phase: "asking", ask: ask("check_in") })).toEqual(["Keep going", "Stop"])
    expect(buttons({ phase: "paused", pause: "pointer", ask: ask("pointer") })).toEqual([
      "Hand over",
      "Not now",
      "Stop",
    ])
    expect(buttons({ phase: "paused", pause: "pointer" })).toEqual(["Stop"])
    expect(buttons({ phase: "paused", pause: "away" })).toEqual(["Keep going", "Stop"])
    expect(buttons({ phase: "paused", pause: "input" })).toEqual(["Resume", "Stop"])
    expect(buttons({ phase: "paused" })).toEqual(["Resume", "Stop"])
    expect(buttons({ phase: "handoff" })).toEqual(["Stop"])
    expect(buttons({ phase: "asking" })).toEqual(["Stop"])
    expect(buttons({ phase: "done" })).toEqual([])
    expect(buttons({ phase: "stopped" })).toEqual([])
    // A stale ask left in state while working is not offered.
    expect(buttons({ ask: ask("app") })).toEqual(["Take over", "Stop"])

    const actions = (patch: Partial<Computer.ComputerState>) =>
      ComputerOverlayPage.bannerView(state(patch))!.buttons.map((button) => button.action)
    expect(actions({ phase: "paused", pause: "away" })).toEqual(["resume", "stop"])
    expect(actions({ phase: "asking", ask: ask("check_in") })).toEqual(["keep-going", "stop"])
    expect(actions({ phase: "paused", pause: "pointer", ask: ask("pointer") })).toEqual([
      "hand-over",
      "not-now",
      "stop",
    ])
  })

  test("asks are request-bound, armed and never offer Always; Stop is plain in every active phase", () => {
    const all = [
      ...PHASES.flatMap((phase) =>
        ["foreground", "background"].map((mode) => state({ phase, mode: mode as "foreground" })),
      ),
      ...(["app", "sensitive", "handoff", "pointer", "check_in"] as const).flatMap((kind) =>
        ACTIVE.map((phase) => state({ phase, ask: ask(kind, { canAlways: true }) })),
      ),
      ...(["input", "away", "pointer", "secure_input", "helper"] as const).map((pause) =>
        state({ phase: "paused", pause }),
      ),
    ]
    for (const item of all) {
      const view = ComputerOverlayPage.bannerView(item)
      if (!view) continue
      for (const button of view.buttons) {
        expect(button.action).not.toMatch(/always/i)
        expect(button.label).not.toMatch(/always/i)
        if (button.action === "stop") {
          expect(button).toEqual({ action: "stop", label: "Stop" })
          continue
        }
        expect(Boolean(button.arm)).toBe(button.action === "allow")
        expect(Boolean(button.clickOnly)).toBe(item.ask?.kind === "sensitive" && view.tone === "ask")
        if (view.tone === "ask" && item.ask) expect(button.requestID).toBe(item.ask.requestID)
        else expect(button.requestID).toBeUndefined()
        // Main checks exactly these actions against the open ask, so every button bound to a request is one of them.
        expect(Computer.OVERLAY_ANSWERS.includes(button.action), button.action).toBe(button.requestID !== undefined)
      }
      const active = item.phase !== "done" && item.phase !== "stopped"
      expect(view.buttons.filter((button) => button.action === "stop")).toHaveLength(active ? 1 : 0)
      if (active) expect(view.buttons.at(-1)!.action).toBe("stop")
    }
  })

  test("status lines", () => {
    const line = (patch: Partial<Computer.ComputerState>) => ComputerOverlayPage.bannerView(state(patch))!.line
    expect(line({})).toBe("Clicking “Save” in Numbers")
    expect(line({ step: undefined })).toBe("Working in Numbers")
    expect(line({ step: undefined, apps: [] })).toBe("Working")
    expect(line({ phase: "asking", ask: ask("app", { title: "Allow it?" }) })).toBe("Allow it?")
    expect(line({ phase: "handoff", ask: ask("handoff", { title: "" }) })).toBe("Your turn")
    expect(line({ phase: "handoff" })).toBe("Your turn")
    expect(line({ phase: "paused", pause: "input" })).toBe("Paused — you have control")
    expect(line({ phase: "paused", pause: "secure_input", secureInputHolder: "Mail" })).toBe(
      "Paused — secure typing is on in Mail",
    )
    expect(line({ phase: "done" })).toBe("Done — your computer is yours again")
    expect(line({ phase: "stopped" })).toBe("Stopped — your computer is yours again")
    const end = ComputerOverlayPage.bannerView(state({ phase: "done", queue: [{ sessionID: "ses_q", title: "Q" }] }))!
    expect(end).toMatchObject({ tone: "end", key: "", waiting: "", buttons: [] })
    expect(ComputerOverlayPage.bannerView(state({ phase: "paused", ask: ask("pointer") }))!.tone).toBe("ask")
    expect(ComputerOverlayPage.bannerView(state({ phase: "paused" }))!.tone).toBe("paused")
    expect(ComputerOverlayPage.bannerView(state({ reduceMotion: true }))!.reduceMotion).toBe(true)
  })

  test("remote and idle phases have no overlay; the glow dims while paused or handed off", () => {
    for (const phase of PHASES) {
      expect(ComputerOverlayPage.bannerView(state({ phase, backend: "remote" }))).toBeUndefined()
      expect(ComputerOverlayPage.glowView(state({ phase, backend: "remote" }))).toBeUndefined()
    }
    for (const phase of ["off", "setup", "ready"] as const) {
      expect(ComputerOverlayPage.bannerView(state({ phase }))).toBeUndefined()
      expect(ComputerOverlayPage.glowView(state({ phase }))).toBeUndefined()
    }
    const variant = (patch: Partial<Computer.ComputerState>) => ComputerOverlayPage.glowView(state(patch))!.variant
    expect(variant({})).toBe("working")
    expect(variant({ phase: "asking" })).toBe("working")
    expect(variant({ mode: "background" })).toBe("background")
    expect(variant({ phase: "paused" })).toBe("dim")
    expect(variant({ phase: "handoff", mode: "background" })).toBe("dim")
    expect(ComputerOverlayPage.glowView(state({ reduceMotion: true }))).toEqual({
      type: "glow",
      variant: "working",
      end: false,
      reduceMotion: true,
    })
    // Only the Done or Stopped flash is an end view, and it keeps the run's look until the fade.
    for (const phase of PHASES) {
      const view = ComputerOverlayPage.glowView(state({ phase, mode: "background" }))
      if (!view) continue
      expect(view.end, phase).toBe(phase === "done" || phase === "stopped")
      if (view.end) expect(view.variant).toBe("background")
    }
  })
})

describe("page script", () => {
  type Act = { action: string; requestID?: string }
  let acts: Act[]
  let hovers: boolean[]
  let answer: (act: Act) => unknown

  beforeEach(() => {
    vi.useFakeTimers()
    acts = []
    hovers = []
    answer = () => Promise.resolve(true)
    Object.assign(window, {
      computerOverlay: {
        onState: () => {},
        act: (action: string, requestID?: string) => {
          acts.push(requestID === undefined ? { action } : { action, requestID })
          return answer({ action, requestID })
        },
        hover: (on: boolean) => hovers.push(on),
      },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, "computerOverlay")
  })

  // Loads a page into the test document, with a fresh root element, and runs its script the way the browser would.
  function load(html: string, attributes: Record<string, string> = {}) {
    const doc = parse(html)
    const script = doc.querySelector("script")!
    script.remove()
    for (const [name, value] of Object.entries(attributes)) doc.documentElement.setAttribute(name, value)
    const next = document.importNode(doc.documentElement, true)
    document.documentElement.remove()
    document.appendChild(next)
    new Function(script.textContent ?? "")()
  }
  const send = (data: unknown, source: unknown = window) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }))
  const flush = async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve()
  }
  const root = () => document.documentElement
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".buttons button")).find(
      (node) => node.textContent === label,
    )!
  const labels = () => Array.from(document.querySelectorAll(".buttons button")).map((node) => node.textContent)
  const click = (node: HTMLElement, detail = 1) =>
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }))
  const banner = (patch: Partial<Computer.ComputerState>) => ComputerOverlayPage.bannerView(state(patch))!

  test("a glow's visible layout can stay 24px high and update independently of its native viewport", () => {
    load(ComputerOverlayPage.glowStripPage("bottom"))
    new Function(ComputerOverlayPage.glowSizeScript({ width: 1024, height: 24 }))()
    const glow = document.querySelector<HTMLElement>(".glow")!
    expect(glow.style.width).toBe("1024px")
    expect(glow.style.height).toBe("24px")
    expect(glow.style.right).toBe("auto")
    expect(glow.style.bottom).toBe("auto")
    expect(styleOf(ComputerOverlayPage.glowStripPage("bottom"))).toContain(".layer { inset: -400px 0 0 0; }")
    new Function(ComputerOverlayPage.glowSizeScript({ width: 1360, height: 24 }))()
    expect(glow.style.width).toBe("1360px")
    expect(glow.style.height).toBe("24px")
    for (const width of [0, -1, 1.5, Infinity, 1_000_001])
      expect(() => ComputerOverlayPage.glowSizeScript({ width, height: 24 })).toThrow()
  })

  test("a label containing markup renders as text", () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ step: "Clicking “<b>Save</b>” in <i>Numbers</i>", queue: [{ sessionID: "q", title: "x" }] }))
    const line = document.querySelector(".line")!
    expect(line.textContent).toBe("Clicking “<b>Save</b>” in <i>Numbers</i>")
    expect(line.querySelector("b, i")).toBeNull()
    expect(document.querySelector(".banner b, .banner i")).toBeNull()
    expect(document.querySelector<HTMLElement>(".waiting")!.hidden).toBe(false)
    expect(document.querySelector(".waiting")!.textContent).toBe("+1 waiting")
    expect(document.querySelector(".key")!.textContent).toBe("Esc")
    expect(labels()).toEqual(["Take over", "Stop"])
    expect(document.querySelector(".title")!.textContent).toBe(Hands.BANNER)
    // A label with markup in a button is text too.
    send({ ...banner({}), buttons: [{ action: "resume", label: "<img src=x>Resume" }] })
    expect(labels()).toEqual(["<img src=x>Resume"])
    expect(document.querySelector("img")).toBeNull()
  })

  test("Stop is there and works before the first message", async () => {
    load(ComputerOverlayPage.bannerPage())
    expect(labels()).toEqual(["Stop"])
    click(button("Stop"))
    await flush()
    expect(acts).toEqual([{ action: "stop" }])
  })

  test("only the page's own window and well-formed messages are applied", () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ step: "First" }))
    send(banner({ step: "From another frame" }), null)
    send(banner({ step: "From an object" }), {})
    send({ ...banner({}), tone: "loud", line: "Bad tone" })
    send({ ...banner({}), buttons: "Stop", line: "Bad buttons" })
    send(ComputerOverlayPage.glowView(state())!)
    send("banner")
    send(null)
    expect(document.querySelector(".line")!.textContent).toBe("First")
    // Unknown actions and unlabeled buttons are dropped; the rest render.
    send({
      ...banner({}),
      buttons: [
        { action: "always", label: "Always allow" },
        { action: "resume", label: "" },
        { action: "allow", label: "Allow", requestID: 7 },
        { action: "stop", label: "Stop" },
      ],
    })
    expect(labels()).toEqual(["Stop"])
  })

  test("Allow is inert for 700 ms from when the page first shows the ask, then answers once", async () => {
    load(ComputerOverlayPage.bannerPage())
    // The ask opened long ago (it waited in the dock); the banner still holds Allow for 700 ms from now.
    send(banner({ phase: "asking", ask: ask("app", { requestID: "perm_1", shownAt: 1 }) }))
    expect(labels()).toEqual(["Deny", "Allow", "Stop"])
    const allow = button("Allow")
    expect(allow.disabled).toBe(true)
    expect(allow.dataset.arming).toBe("")
    expect(allow.style.getPropertyValue("--arm")).toBe("700ms")
    expect(button("Deny").disabled).toBe(false)
    click(allow)
    await flush()
    expect(acts).toEqual([])

    // A repeated state does not restart the delay.
    vi.advanceTimersByTime(400)
    send(banner({ phase: "asking", ask: ask("app", { requestID: "perm_1", shownAt: 1 }) }))
    expect(button("Allow")).toBe(allow)
    vi.advanceTimersByTime(299)
    expect(allow.disabled).toBe(true)
    vi.advanceTimersByTime(1)
    expect(allow.disabled).toBe(false)
    expect(allow.dataset.arming).toBeUndefined()

    click(allow)
    click(allow)
    click(button("Deny"))
    await flush()
    expect(acts).toEqual([{ action: "allow", requestID: "perm_1" }])
    expect(allow.disabled).toBe(true)
    expect(button("Deny").disabled).toBe(true)

    // Stop is never latched with the ask.
    expect(button("Stop").disabled).toBe(false)
    click(button("Stop"))
    await flush()
    expect(acts.at(-1)).toEqual({ action: "stop" })

    // The next ask is armed again from its own first showing.
    send(banner({ phase: "asking", ask: ask("app", { requestID: "perm_2", shownAt: Date.now() }) }))
    expect(button("Allow").disabled).toBe(true)
    vi.advanceTimersByTime(700)
    expect(button("Allow").disabled).toBe(false)
  })

  test("a wall-clock step in either direction neither shortens nor extends the 700 ms", () => {
    const start = Date.now()
    const again = () => send(banner({ phase: "asking", ask: ask("app", { requestID: "perm_clock" }) }))
    load(ComputerOverlayPage.bannerPage())
    again()
    vi.advanceTimersByTime(100)
    // The wall clock jumps an hour ahead (a manual change, or an NTP step after wake), then a state push arrives.
    setSystemTime(new Date(start + 3_600_000))
    again()
    expect(button("Allow").disabled).toBe(true)
    vi.advanceTimersByTime(500)
    // Now two hours back.
    setSystemTime(new Date(start - 3_600_000))
    again()
    expect(button("Allow").disabled).toBe(true)
    vi.advanceTimersByTime(99)
    expect(button("Allow").disabled).toBe(true)
    vi.advanceTimersByTime(1)
    expect(button("Allow").disabled).toBe(false)
  })

  test("a fade that does not follow an end view is ignored, so a late fade cannot hide the next run", () => {
    // Run A ends, run B reuses the windows and sends its first views, then A's fade timer fires.
    load(ComputerOverlayPage.bannerPage())
    send(banner({ phase: "done" }))
    send(banner({ lease: 2 }))
    send({ type: "fade" })
    expect(root().dataset.out).toBeUndefined()
    expect(root().dataset.tone).toBe("working")

    load(ComputerOverlayPage.glowStripPage("top"))
    send(ComputerOverlayPage.glowView(state({ phase: "stopped" }))!)
    send(ComputerOverlayPage.glowView(state({ lease: 2 }))!)
    send({ type: "fade" })
    expect(root().dataset.out).toBeUndefined()

    load(ComputerOverlayPage.cursorPage())
    send({ type: "cursor", kind: "hide", x: 0, y: 0, reduceMotion: false })
    send({ type: "cursor", kind: "ghost", x: 40, y: 40, reduceMotion: false })
    send({ type: "fade" })
    expect(root().dataset.out).toBeUndefined()
    expect(root().dataset.ghost).toBe("")

    // A fade with no view at all is ignored too; after an end view it applies.
    load(ComputerOverlayPage.glowStripPage("left"))
    send({ type: "fade" })
    expect(root().dataset.out).toBeUndefined()
    send(ComputerOverlayPage.glowView(state({ phase: "done" }))!)
    send({ type: "fade" })
    expect(root().dataset.out).toBe("")
  })

  test("a refused or failed answer lets the same ask be answered again", async () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ phase: "handoff", ask: ask("handoff", { requestID: "perm_h" }) }))
    answer = () => Promise.resolve(false)
    click(button("Continue"))
    expect(button("Continue").disabled).toBe(true)
    await flush()
    expect(button("Continue").disabled).toBe(false)
    answer = () => Promise.reject(new Error("main is gone"))
    click(button("Continue"))
    await flush()
    expect(button("Continue").disabled).toBe(false)
    answer = () => Promise.resolve(true)
    click(button("Continue"))
    await flush()
    expect(button("Continue").disabled).toBe(true)
    expect(acts).toEqual([
      { action: "continue", requestID: "perm_h" },
      { action: "continue", requestID: "perm_h" },
      { action: "continue", requestID: "perm_h" },
    ])
    // Without the preload nothing is sent, and the ask stays answerable.
    Reflect.deleteProperty(window, "computerOverlay")
    send(banner({ phase: "asking", ask: ask("check_in", { requestID: "perm_c" }) }))
    click(button("Keep going"))
    await flush()
    expect(button("Keep going").disabled).toBe(false)
  })

  test("a sensitive ask ignores keyboard-generated clicks", async () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ phase: "asking", ask: ask("sensitive", { requestID: "perm_s", shownAt: Date.now() }) }))
    vi.advanceTimersByTime(700)
    click(button("Allow once"), 0)
    click(button("Deny"), 0)
    await flush()
    expect(acts).toEqual([])
    click(button("Allow once"), 1)
    await flush()
    expect(acts).toEqual([{ action: "allow", requestID: "perm_s" }])
    // Stop answers the keyboard too.
    click(button("Stop"), 0)
    await flush()
    expect(acts.at(-1)).toEqual({ action: "stop" })
  })

  test("pointer, take-over and resume buttons send their actions; hover is reported", async () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ phase: "paused", pause: "pointer", ask: ask("pointer", { requestID: "perm_p" }) }))
    click(button("Not now"))
    send(banner({}))
    click(button("Take over"))
    send(banner({ phase: "paused", pause: "away" }))
    click(button("Keep going"))
    await flush()
    expect(acts).toEqual([{ action: "not-now", requestID: "perm_p" }, { action: "takeover" }, { action: "resume" }])
    root().dispatchEvent(new PointerEvent("pointerenter"))
    root().dispatchEvent(new PointerEvent("pointerleave"))
    expect(hovers).toEqual([true, false])
  })

  test("the end flash hides the fixed sentence; fade hides the page until the next state", () => {
    load(ComputerOverlayPage.bannerPage())
    send(banner({ phase: "stopped" }))
    expect(root().dataset.tone).toBe("end")
    expect(document.querySelector(".line")!.textContent).toBe("Stopped — your computer is yours again")
    expect(labels()).toEqual([])
    expect(document.querySelector<HTMLElement>(".key")!.hidden).toBe(true)
    expect(getComputedStyle(document.querySelector(".title")!).display).toBe("none")
    send({ type: "fade" })
    expect(root().dataset.out).toBe("")
    expect(getComputedStyle(document.body).opacity).toBe("0")
    // A new run that reuses the window shows it again.
    send(banner({}))
    expect(root().dataset.out).toBeUndefined()
    expect(root().dataset.tone).toBe("working")
    // happy-dom keeps computed styles after an ancestor's attribute changes, so the cascade is read from fresh pages.
    load(ComputerOverlayPage.bannerPage(), { "data-tone": "working" })
    expect(getComputedStyle(document.querySelector(".title")!).display).not.toBe("none")
    expect(getComputedStyle(document.body).opacity).not.toBe("0")
  })

  test("glow variants, dim over reduced motion, and fade", () => {
    load(ComputerOverlayPage.glowStripPage("top"))
    send(ComputerOverlayPage.glowView(state())!)
    expect(root().dataset.variant).toBe("working")
    expect(root().dataset.reduceMotion).toBeUndefined()
    send(ComputerOverlayPage.glowView(state({ reduceMotion: true }))!)
    expect(root().dataset.reduceMotion).toBe("")
    send(ComputerOverlayPage.glowView(state({ phase: "paused", reduceMotion: true }))!)
    expect(root().dataset.variant).toBe("dim")
    send(ComputerOverlayPage.glowView(state({ mode: "background" }))!)
    expect(root().dataset.variant).toBe("background")
    expect(root().dataset.reduceMotion).toBeUndefined()
    send({ type: "glow", variant: "hidden", reduceMotion: false })
    expect(root().dataset.variant).toBe("background")
    // A banner message is not for a glow page.
    send(banner({ phase: "paused" }))
    expect(root().dataset.variant).toBe("background")
    send(ComputerOverlayPage.glowView(state({ phase: "done", mode: "background" }))!)
    send({ type: "fade" })
    expect(root().dataset.out).toBe("")
    send(ComputerOverlayPage.glowView(state())!)
    expect(root().dataset.out).toBeUndefined()
  })

  test("the glow cascade: 90% still with reduced motion, and dim wins over reduced motion", () => {
    const opacity = (attributes: Record<string, string>) => {
      load(ComputerOverlayPage.glowStripPage("left"), attributes)
      const read = (selector: string) => Number(getComputedStyle(document.querySelector(selector)!).opacity)
      return [read(".glow"), read(".breathe")]
    }
    const reduce = { "data-reduce-motion": "" }
    // While it breathes the inner opacity is the animation's (Playwright checks it in Chromium); here only the variant.
    expect(opacity({ "data-variant": "working" })[0]).toBe(1)
    expect(opacity({ "data-variant": "working", ...reduce })).toEqual([1, 0.9])
    expect(opacity({ "data-variant": "background" })[0]).toBe(0.6)
    expect(opacity({ "data-variant": "background", ...reduce })).toEqual([0.6, 0.9])
    expect(opacity({ "data-variant": "dim" })).toEqual([0.38, 1])
    expect(opacity({ "data-variant": "dim", ...reduce })).toEqual([0.38, 1])
    expect(opacity({ "data-variant": "dim", "data-out": "" })[0]).toBe(0.38)
    expect(Number(getComputedStyle(document.body).opacity)).toBe(0)
  })

  test("cursor coordinates set the custom properties; non-finite ones are ignored", () => {
    load(ComputerOverlayPage.cursorPage())
    send({ type: "cursor", kind: "ring", x: 120.5, y: 40, reduceMotion: false })
    expect(root().style.getPropertyValue("--x")).toBe("120.5px")
    expect(root().style.getPropertyValue("--y")).toBe("40px")
    expect(root().dataset.ring).toBe("")
    vi.advanceTimersByTime(700)
    expect(root().dataset.ring).toBeUndefined()
    send({ type: "cursor", kind: "ghost", x: Number.NaN, y: 10, reduceMotion: false })
    send({ type: "cursor", kind: "ghost", x: "300px", y: 10, reduceMotion: false })
    send({ type: "cursor", kind: "ghost", x: Number.POSITIVE_INFINITY, y: 10, reduceMotion: false })
    expect(root().dataset.ghost).toBeUndefined()
    expect(root().style.getPropertyValue("--x")).toBe("120.5px")
    send({ type: "cursor", kind: "ghost", x: 300, y: 10, reduceMotion: true })
    expect(root().dataset.ghost).toBe("")
    expect(root().dataset.reduceMotion).toBe("")
    expect(root().style.getPropertyValue("--x")).toBe("300px")
    send({ type: "cursor", kind: "hide", x: 0, y: 0, reduceMotion: true })
    expect(root().dataset.ghost).toBeUndefined()
    expect(root().style.getPropertyValue("--x")).toBe("300px")
  })

  test("messageScript delivers the message intact; pageUrl round-trips", () => {
    const message = {
      ...banner({ step: "Typing “</script><script>alert(1)</script>” \u2028\u2029 in Numbers" }),
      line: "a</script>b\u2028c",
    }
    const script = ComputerOverlayPage.messageScript(message)
    expect(script).not.toContain("</")
    expect(script).not.toContain("\u2028")
    expect(script).not.toContain("\u2029")
    const posted: unknown[][] = []
    new Function("window", script)({ postMessage: (...args: unknown[]) => posted.push(args) })
    expect(posted).toEqual([[message, "*"]])

    for (const [, html] of PAGES) {
      const url = ComputerOverlayPage.pageUrl(html)
      expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true)
      const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0))
      expect(new TextDecoder().decode(bytes)).toBe(html)
    }
    const sample = "<p>#b892ff — ⌘⇧Esc “Save”</p>"
    const url = ComputerOverlayPage.pageUrl(sample)
    expect(url).not.toContain("#")
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(sample)
  })
})
