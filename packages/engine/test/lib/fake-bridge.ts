export * as FakeBridge from "./fake-bridge"

import { Effect } from "effect"

// A stand-in for the desktop's browser bridge on 127.0.0.1, for the browser and research_browser tools: POST /command
// for the user's visible browser, POST /research for research browsers, each with the bridge's bearer token. A test
// answers each command with its own handler and reads back every command the engine sent. The engine finds the bridge
// the way it finds the desktop's, by VECTOR_BROWSER_BRIDGE_URL and VECTOR_BROWSER_BRIDGE_TOKEN, which `use` sets.

export type Call = { readonly path: "/command" | "/research"; readonly body: Record<string, unknown> }
export type Handler = (call: Call) => unknown

export type Bridge = {
  readonly url: string
  readonly token: string
  readonly calls: () => readonly Call[]
  /** The commands of one path, in order. */
  readonly commands: (path: Call["path"]) => readonly string[]
  readonly answer: (handler: Handler) => void
  readonly close: () => Promise<void>
}

export function start(handler: Handler = () => ({})): Bridge {
  const token = `bridge-${crypto.randomUUID()}`
  const calls: Call[] = []
  const state = { handler }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method !== "POST" || (path !== "/command" && path !== "/research"))
        return Response.json({ error: "Not found" }, { status: 404 })
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      const call: Call = { path, body: (await request.json()) as Record<string, unknown> }
      calls.push(call)
      const answer = (await state.handler(call)) as { ok?: boolean } | undefined
      return Response.json(answer ?? {}, { status: answer?.ok === false ? 409 : 200 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    calls: () => [...calls],
    commands: (path) => calls.filter((call) => call.path === path).map((call) => String(call.body.command)),
    answer: (next) => {
      state.handler = next
    },
    close: () => server.stop(true),
  }
}

/** What the engine sent the visible browser from call `from` on: each command's body, in order. */
export function sent(bridge: Bridge, from = 0) {
  return bridge
    .calls()
    .slice(from)
    .filter((call) => call.path === "/command")
    .map((call) => call.body)
}

/** Points the engine at this bridge, as the desktop app does, until `off`. */
export function use(bridge: Bridge) {
  process.env.VECTOR_BROWSER_BRIDGE_URL = bridge.url
  process.env.VECTOR_BROWSER_BRIDGE_TOKEN = bridge.token
  return {
    off: () => {
      delete process.env.VECTOR_BROWSER_BRIDGE_URL
      delete process.env.VECTOR_BROWSER_BRIDGE_TOKEN
    },
  }
}

/** Runs `effect` with the engine pointed at this bridge, as the desktop app points it at its own, and no longer after. */
export function within<A, E, R>(bridge: Bridge, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => use(bridge)),
    () => effect,
    (pointed) => Effect.sync(() => pointed.off()),
  )
}

/** A visible-browser report as the desktop's runBrowserAgent gives one. */
export function visible(input: { readonly url?: string; readonly title?: string } & Record<string, unknown> = {}) {
  const url = input.url ?? ""
  return {
    url,
    finalUrl: url,
    status: 200,
    ok: true,
    title: input.title ?? "",
    description: "",
    htmlBytes: 0,
    links: 0,
    scripts: 0,
    stylesheets: 0,
    checkedAt: new Date(0).toISOString(),
    viewport: { x: 0, y: 0, width: 0, height: 0 },
    screenshotDataUrl: "",
    console: [],
    pageErrors: [],
    networkErrors: [],
    actions: [],
    interactives: [],
    inputs: [],
    browserStatus: "running",
    ...input,
  }
}

/** A research browser report as the desktop's runResearchBrowser gives one. */
export function research(input: Record<string, unknown> = {}) {
  return {
    ok: true,
    generation: "desktop-copy-1",
    label: "Research lead",
    url: "",
    address: "",
    title: "",
    joined: [],
    refused: [],
    ...input,
  }
}

/**
 * A research browser's answer to research.search, as the desktop gives one once it read a results page: the fake
 * web's heat pump pages, from Google unless `engine` says otherwise.
 */
export function searched(
  web: { readonly url: (site: string, path: string) => string },
  input: { readonly engine?: "google" | "duckduckgo"; readonly tried?: readonly unknown[] } = {},
) {
  return research({
    search: {
      engine: input.engine ?? "google",
      results: [
        {
          url: web.url("article", "/"),
          title: "How heat pumps cut heating bills in cold climates",
          snippet: "A field study of air-source heat pumps in 412 homes.",
        },
        {
          url: web.url("copy", "/heat-pumps"),
          title: "How heat pumps cut heating bills in cold climates (syndicated)",
          snippet: "The study followed 412 homes through two winters.",
        },
        {
          url: web.url("docs", "/report.pdf"),
          title: "Heat pump field study (PDF)",
          snippet: "Delivered heating energy fell by 61 percent.",
        },
      ],
      tried: input.tried ?? [],
    },
  })
}

/**
 * A desktop whose research browsers answer research.search with `searched` and every other command as an open,
 * empty research browser does; the user's visible browser answers too.
 */
export function searching(web: Parameters<typeof searched>[0]): Handler {
  return (call) => {
    if (call.path !== "/research") return visible()
    return call.body.command === "research.search" ? searched(web) : research()
  }
}

/** The research.search commands the engine sent. */
export function searches(bridge: Bridge) {
  return bridge.calls().filter((call) => call.path === "/research" && call.body.command === "research.search")
}
