export * as ResearchBrowser from "./research-browser"

import { GithubAgents } from "@vectordevai/core/github-agents"
import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import type { ResearchSearch } from "@vectordevai/core/research/search"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Effect, Schema, Scope, Stream } from "effect"
import type { Provider } from "@/provider/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { ResearchRun } from "./research-run"
import { ResearchSource } from "./research-source"
import { Tool } from "./tool"
import { webAccess } from "./webfetch"
import DESCRIPTION from "./research-browser.txt"

// research_browser (section 5.6a): every research agent, the lead and each researcher, drives a research browser of its
// own in the desktop app, through the bridge's POST /research. The desktop holds the browsers and decides each
// navigation (research-navigation.ts there); the engine holds the run's record, so here:
// - open takes an address only from the run's provenance (search results, links a read or `links` offered, addresses
//   the user typed), and it passes the outbound check as research_read's addresses do. The run's first page asks once.
// - Each command carries the run's provenance the desktop does not have yet. Links a browser followed come back and
//   join the run's provenance through this call's metadata ("via S#"), so the engine's set stays the record.
// - read saves the page as a source (S#) through the same store as research_read, with dedupe and the page budget.
// - type's text passes the outbound check with the whole run's private context, and only the root user's typed words
//   exempt anything: a sub-question is written by the lead, not typed. A page cannot make a private number public
//   either: a public source clears no number here, since a hostile page could list every 5-digit number.
// - A screenshot is taken only for a model that reads images, and images load only for one.
// - With Vector Local on, Web access as it is now decides each address an agent opens, before the desktop does: the
//   desktop's research proxy follows Web access as it was when the app started, so the stricter of the two applies.
// The run and the agent's session come from the tool context, never from the model's input. A browser closes when its
// agent's session finishes, as well as on the desktop's own idle timeout. Outside the desktop app (the CLI, WSL, a
// remote server, a headless run) there is no research browser, and the tool says so. research_search searches in the
// same browser (research.search, research-search.ts), so each agent's searches load in its own browser too.

export const NEEDS_DESKTOP =
  "Research browsers need the desktop browser, which this Vector does not have (the CLI, WSL, a remote server or a headless run). Read pages with research_read instead; a page built by script is reported as skipped."
export const TYPED =
  "That text would send words from your private context to a web page. Type public terms only, or ask the user to type the words they want searched."
export const NO_IMAGES = "This model does not read images, so research browsers take no screenshots for it."
export const BROWSER_DOWN = "The desktop browser did not answer."
const MAX_ADDRESSES = 5_000
const MAX_URL = 8_192
const MAX_BROWSERS = 9
const RUNS = 32

const Action = Schema.Literals([
  "open",
  "read",
  "links",
  "find",
  "observe",
  "click",
  "type",
  "press",
  "scroll",
  "back",
  "screenshot",
  "close",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "What to do in your research browser" }),
  url: Schema.optional(Schema.String).annotate({
    description: "open: an address from a search result, a link a read or links offered, or the user's message",
  }),
  ref: Schema.optional(Schema.String).annotate({ description: "click, type: a ref_N handle from observe" }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "type: the text to type; find: the phrase to find on the page",
  }),
  key: Schema.optional(
    Schema.Literals(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
  ).annotate({ description: "press: the key" }),
  chunk: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "read: which chunk to show (1 by default); the first read shows the outline",
  }),
  scope: Schema.optional(Schema.Literals(["main", "all"])).annotate({
    description: "links: the page's main content (default) or all of its links",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = ResearchSource.Metadata & {
  action?: Params["action"]
  browser?: string
}

/** What the desktop answers a research command with (desktop/src/main/research-browser.ts, `Report`). */
export type Report = {
  readonly ok: boolean
  readonly error?: string
  readonly resync?: boolean
  readonly generation: string
  readonly label: string
  readonly url: string
  readonly address: string
  readonly title: string
  readonly status?: number
  readonly joined: readonly string[]
  readonly refused: readonly { readonly url: string; readonly reason: string }[]
  readonly read?: {
    readonly html: string
    readonly title: string
    readonly url: string
    readonly links: readonly { readonly url: string; readonly text: string; readonly main: boolean }[]
    readonly forms: readonly string[]
    readonly truncated: boolean
  }
  readonly observed?: {
    readonly title: string
    readonly url: string
    readonly text: string
    readonly elements: readonly {
      readonly ref: string
      readonly role: string
      readonly name: string
      readonly tag: string
      readonly type?: string
      readonly href?: string
      readonly disabled?: boolean
    }[]
  }
  readonly screenshot?: string
  readonly pdf?: { readonly url: string; readonly base64: string; readonly contentType: string }
  readonly value?: string
  readonly search?: {
    readonly engine?: ResearchSearch.Engine
    readonly results: readonly { readonly url: string; readonly title?: string; readonly snippet?: string }[]
    readonly tried: readonly { readonly engine: ResearchSearch.Engine; readonly reason: string }[]
  }
}

const EMPTY: Report = { ok: false, generation: "", label: "", url: "", address: "", title: "", joined: [], refused: [] }

/**
 * Whether this engine runs inside the desktop app, which holds the research browsers. Never on GitHub Actions, whatever
 * bridge variables are set (INV-S13): research_search and research_read's rendering drive the same desktop browser.
 */
export function available() {
  return (
    !GithubAgents.onActionsRunner(process.env) &&
    Boolean(process.env.VECTOR_BROWSER_BRIDGE_URL && process.env.VECTOR_BROWSER_BRIDGE_TOKEN)
  )
}

type Synced = { readonly generation: string; readonly sent: ReadonlySet<string> }
// The copy of each run's provenance the desktop holds, by the generation it named, and what was sent to it.
const synced = new Map<string, Synced>()
// Each open browser, by run and session, for closing it when its agent's session finishes.
const opened = new Map<
  string,
  { readonly runID: string; readonly sessionID: string; readonly agent: string; readonly max: number }
>()
// The source each browser's page was saved as, so a link followed from it reads as "via S#".
const pages = new Map<string, { readonly url: string; readonly source: string }>()

/** Sends one command to the calling agent's research browser, with the run's provenance the desktop lacks. */
export const send = Effect.fnUntraced(function* (input: {
  readonly research: ResearchRun.Interface
  readonly ctx: Tool.Context
  readonly found: ResearchRun.Found
  readonly body: Record<string, unknown>
}) {
  const runID = input.found.run.id
  const set = yield* input.research.provenance(input.ctx, input.found)
  // The desktop takes addresses of 8,192 characters at most; a longer one could not be read anyway.
  const all = [...set.values()]
    .flatMap((entry) => [...entry.urls].map((url) => ({ url, typed: entry.from === "typed" })))
    .filter((item) => item.url.length <= MAX_URL)
  const limits = yield* input.research.limits(input.found.plan.depth)
  const model = input.ctx.extra?.model as Provider.Model | undefined
  const common = {
    runID,
    sessionID: input.ctx.sessionID,
    rootID: input.found.lead.id,
    agent: input.ctx.agent === ResearchRun.LEAD ? "research" : "researcher",
    max: Math.min(MAX_BROWSERS, 1 + limits.researchers),
    images: model?.capabilities.input.image === true,
  }
  const message = (known: Synced | undefined) => {
    const fresh = (known ? all.filter((item) => !known.sent.has(item.url)) : all).slice(-MAX_ADDRESSES)
    return {
      sent: new Set([...(known?.sent ?? []), ...fresh.map((item) => item.url)]),
      body: {
        ...common,
        ...input.body,
        ...(known ? { generation: known.generation } : {}),
        provenance: fresh.filter((item) => !item.typed).map((item) => item.url),
        typed: fresh.filter((item) => item.typed).map((item) => item.url),
      },
    }
  }
  const before = message(synced.get(runID))
  const first = yield* post(before.body, input.ctx.abort)
  // The desktop's copy is another one (its browsers all closed since), so it gets the whole set.
  const again = first.resync ? message(undefined) : undefined
  const report = again ? yield* post(again.body, input.ctx.abort) : first
  if (report.generation) {
    synced.delete(runID)
    synced.set(runID, { generation: report.generation, sent: (again ?? before).sent })
    if (synced.size > RUNS) synced.delete(synced.keys().next().value!)
  }
  const key = `${runID}:${input.ctx.sessionID}`
  if (input.body.command === "research.close") {
    opened.delete(key)
    pages.delete(key)
  }
  if (input.body.command !== "research.close" && report.generation)
    opened.set(key, { runID, sessionID: input.ctx.sessionID, agent: common.agent, max: common.max })
  return report
})

const post = (body: Record<string, unknown>, signal: AbortSignal) =>
  Effect.promise(() =>
    fetch(`${process.env.VECTOR_BROWSER_BRIDGE_URL}/research`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.VECTOR_BROWSER_BRIDGE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    })
      .then(async (response) => {
        const report = (await response.json()) as Partial<Report>
        return { ...EMPTY, ...report, ok: report.ok === true } satisfies Report
      })
      .catch((): Report => ({ ...EMPTY, error: BROWSER_DOWN })),
  )

/**
 * Reads a page research_read's fetch found built by script, in the calling agent's own research browser: open it, then
 * read what it rendered. Undefined when there is no desktop browser.
 */
export const render = Effect.fnUntraced(function* (input: {
  readonly research: ResearchRun.Interface
  readonly ctx: Tool.Context
  readonly found: ResearchRun.Found
  readonly url: string
  readonly chunkTokens: number
}) {
  if (!available()) return undefined
  // Vector Local's Web access as it is now, which the desktop's proxy may not have yet.
  const refused = yield* Effect.try({
    try: () => webAccess("research-browser", input.url),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      onSuccess: () => undefined,
    }),
  )
  if (refused) return { error: refused } as const
  const opened = yield* send({ ...input, body: { command: "research.open", url: input.url } })
  if (!opened.ok) return { error: opened.error ?? BROWSER_DOWN } as const
  if (opened.pdf) return yield* parsePdf(opened.pdf, input.chunkTokens)
  const read = yield* send({ ...input, body: { command: "research.read" } })
  if (!read.ok || !read.read) return { error: read.error ?? BROWSER_DOWN } as const
  return yield* parseHtml(read, input.chunkTokens)
})

const parseHtml = (report: Report, chunkTokens: number) =>
  ResearchReader.parse({
    url: report.url || report.read!.url,
    contentType: "text/html; charset=utf-8",
    body: new TextEncoder().encode(report.read!.html),
    ...(report.status !== undefined ? { status: report.status } : {}),
    chunkTokens,
  })

const parsePdf = (pdf: NonNullable<Report["pdf"]>, chunkTokens: number) =>
  ResearchReader.parse({
    url: pdf.url,
    contentType: pdf.contentType || "application/pdf",
    // A plain copy: a small Buffer is a view into a larger pooled one, which the PDF reader would read whole.
    body: new Uint8Array(Buffer.from(pdf.base64, "base64")),
    chunkTokens,
  })

export const ResearchBrowserTool = Tool.define<
  typeof Parameters,
  Metadata,
  ResearchRun.Service | ResearchStore.Service | EventV2Bridge.Service | Scope.Scope
>(
  "research_browser",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const events = yield* EventV2Bridge.Service
    // A browser closes once its agent's session finishes: the researcher returned, the lead finished its turn, or the
    // user stopped the run.
    yield* events.subscribe(SessionStatus.Event.Status).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.data.status.type !== "idle" || !available()) return
          const closing = [...opened.entries()].filter(([, item]) => item.sessionID === event.data.sessionID)
          yield* Effect.forEach(closing, ([key, item]) =>
            Effect.gen(function* () {
              opened.delete(key)
              pages.delete(key)
              yield* post({ command: "research.close", ...item }, AbortSignal.timeout(5_000))
            }),
          )
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Whether the run's page budget is used.
    const spent = (found: ResearchRun.Found) =>
      research.limits(found.plan.depth).pipe(Effect.map((limits) => found.run.pages >= limits.pages))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not done", output: found.refused, metadata: { action } }
          const runID = found.run.id
          if (found.plan.scope === "brain")
            return {
              title: "Not done",
              output: ResearchSource.SCOPE,
              metadata: { runID, action, refused: "scope" as const },
            }
          // Not offered with Vector Local's Web access None; a run that began before it was set reaches no more pages,
          // though its browser may still be closed.
          if (action !== "close" && ResearchRun.offline())
            return {
              title: "Not done",
              output: ResearchRun.OFFLINE,
              metadata: { runID, action, refused: "offline" as const },
            }
          if (!available())
            return { title: "Needs the desktop browser", output: NEEDS_DESKTOP, metadata: { runID, action } }
          const model = ctx.extra?.model as Provider.Model | undefined
          const chunkTokens =
            (model?.limit.context ?? Infinity) < 32_000 ? ResearchReader.COMPACT_TOKENS : ResearchReader.CHUNK_TOKENS
          const key = `${runID}:${ctx.sessionID}`
          const fail = (output: string, extra: Partial<Metadata> = {}): Result => ({
            title: "Not done",
            output,
            metadata: { runID, action, ...extra },
          })
          const run = (body: Record<string, unknown>) =>
            send({ research, ctx, found, body: { command: `research.${action}`, ...body } })
          // A page read in the browser is a source of the run, as research_read's pages are.
          const keep = (parsed: ResearchReader.Page, view: ResearchSource.View) =>
            ResearchSource.keep({
              research,
              store,
              found,
              page: parsed,
              view,
              lead: ctx.agent === ResearchRun.LEAD,
              tool: "research_browser",
            }).pipe(Effect.map((kept): Result => ({ ...kept, metadata: { ...kept.metadata, action } })))
          // What every command reports besides its own answer: links a navigation followed, which join the run's
          // provenance as links of the source the browser last read ("via S#"), and navigations the rule refused.
          const done = (report: Report, result: Result): Result => {
            if (result.metadata.source && result.metadata.url)
              pages.set(key, { url: result.metadata.url, source: result.metadata.source })
            const from = pages.get(key)?.source
            const joined = report.joined.length
              ? [
                  `Followed a link${from ? ` on ${from}` : ""}; the page it reached is now an address this research may read:\n${WebFence.fenceWebPage({ tool: "research_browser", title: "Links followed" }, report.joined.join("\n"))}`,
                ]
              : []
            const refused = report.refused.length
              ? [
                  `The research browser stayed on the page and did not follow:\n${WebFence.fenceWebPage(
                    { tool: "research_browser", title: "Refused" },
                    report.refused.map((item) => `${item.url}: ${item.reason}`).join("\n"),
                  )}`,
                ]
              : []
            return {
              ...result,
              output: [result.output, ...joined, ...refused].join("\n\n"),
              metadata: {
                ...result.metadata,
                ...(report.label ? { browser: report.label } : {}),
                ...(report.joined.length
                  ? { links: [...new Set([...(result.metadata.links ?? []), ...report.joined])] }
                  : {}),
              },
            }
          }

          if (action === "open") {
            if (!params.url) return fail("Give the address to open.")
            const checked = ResearchProvenance.check(yield* research.provenance(ctx, found), params.url)
            if (!checked.ok) return fail(checked.message, { url: params.url, refused: "provenance" })
            const outbound = ResearchOutbound.address(
              checked.url,
              ResearchOutbound.strict(yield* research.context(ctx, found)),
            )
            if (!outbound.ok) return fail(ResearchSource.OUTBOUND, { url: checked.url, refused: "outbound" })
            webAccess("research-browser", checked.url)
            yield* research.approve(ctx, found, checked.url)
            yield* ctx.metadata({ title: `Opening ${checked.url}`, metadata: { runID, action, url: checked.url } })
            const report = yield* run({ url: checked.url })
            if (!report.ok) return done(report, fail(report.error ?? BROWSER_DOWN, { url: checked.url }))
            if (!report.pdf)
              return done(report, {
                title: `Opened ${report.title || report.url}`,
                output: page(report, "The page is open. Read it with read, or observe it to use its controls."),
                metadata: { runID, action, url: report.url },
              })
            // A PDF is read into memory, not downloaded: it is a source as soon as it opens.
            if (yield* spent(found)) return done(report, fail(ResearchStore.PAGES, { refused: "budget" }))
            return done(report, yield* keep(yield* parsePdf(report.pdf, chunkTokens), { chunk: params.chunk }))
          }

          if (action === "type") {
            if (!params.ref) return fail("Give the ref of the field to type into, from observe.")
            const text = params.text ?? ""
            if (!ResearchOutbound.check(text, ResearchOutbound.strict(yield* research.context(ctx, found))).ok)
              return fail(TYPED, { refused: "outbound" })
            const report = yield* run({ ref: params.ref, text })
            if (!report.ok) return done(report, fail(report.error ?? BROWSER_DOWN))
            const changed =
              report.value === undefined ? "" : " The field now shows something else: the page may have changed it."
            return done(report, {
              title: `Typed into ${params.ref}`,
              output: `Typed into ${params.ref}.${changed} Press Enter to submit a search, or observe the page.`,
              metadata: { runID, action },
            })
          }

          if (action === "screenshot") {
            if (model?.capabilities.input.image !== true) return fail(NO_IMAGES)
            const report = yield* run({})
            if (!report.ok || !report.screenshot) return done(report, fail(report.error ?? BROWSER_DOWN))
            return done(report, {
              title: `Screenshot of ${report.title || report.url}`,
              output: page(report, "A screenshot of the page is attached."),
              metadata: { runID, action, url: report.url },
              attachments: [
                { type: "file" as const, mime: "image/png", url: report.screenshot, filename: "research-browser.png" },
              ],
            })
          }

          if (action === "read" && (yield* spent(found))) return fail(ResearchStore.PAGES, { refused: "budget" })
          if (action === "find" && !(params.text ?? "").trim()) return fail("Give the text to find on the page.")
          if (action === "click" && !params.ref) return fail("Give the ref of what to click, from observe.")
          if (action === "press" && !params.key) return fail("Give the key to press.")

          const report = yield* run({
            ...(params.ref ? { ref: params.ref } : {}),
            ...(params.key ? { key: params.key } : {}),
          })
          if (!report.ok) return done(report, fail(report.error ?? BROWSER_DOWN))
          // A PDF that a click, a key or going back reached is read into memory as open's is: a source as it opens.
          if (report.pdf && (action === "click" || action === "press" || action === "back")) {
            if (yield* spent(found)) return done(report, fail(ResearchStore.PAGES, { refused: "budget" }))
            return done(report, yield* keep(yield* parsePdf(report.pdf, chunkTokens), {}))
          }

          if (action === "read") {
            if (!report.read) return done(report, fail(BROWSER_DOWN))
            const kept = yield* keep(yield* parseHtml(report, chunkTokens), { chunk: params.chunk })
            // The source is the address the rule decided, not one the page put in the address bar later.
            const moved =
              report.address && report.address !== report.url
                ? [
                    `The page changed its own address after it loaded; ${kept.metadata.source ?? "the source"} is saved at the address the research browser opened.`,
                  ]
                : []
            return done(report, { ...kept, output: [kept.output, ...moved].join("\n\n") })
          }
          if (action === "links") {
            const all = ResearchProvenance.offered(report.read?.links ?? [])
            const main = all.filter((link) => link.main)
            const shown = (params.scope === "all" || main.length === 0 ? all : main).slice(0, ResearchSource.MAX_LINKS)
            return done(report, {
              title: `${shown.length} link${shown.length === 1 ? "" : "s"} on ${report.title || report.url}`,
              output: shown.length
                ? `Links on this page (each may be opened):\n${WebFence.fenceWebPage(
                    { url: report.url, title: "Links", tool: "research_browser" },
                    shown.map((link) => `${link.url}${link.text ? ` — ${link.text}` : ""}`).join("\n"),
                  )}`
                : "This page has no links research may follow.",
              metadata: { runID, action, url: report.url, links: shown.map((link) => link.url) },
            })
          }
          if (action === "find") {
            if (!report.read) return done(report, fail(BROWSER_DOWN))
            const matches = ResearchReader.find((yield* parseHtml(report, chunkTokens)).chunks, params.text!)
            return done(report, {
              title: `Found ${matches.length} on ${report.title || report.url}`,
              output: WebFence.fenceWebPage(
                { url: report.url, title: report.title, tool: "research_browser" },
                matches.length
                  ? matches.map((item) => `[chunk ${item.chunk}] ${item.snippet}`).join("\n\n")
                  : "Nothing on this page matches.",
              ),
              metadata: { runID, action, url: report.url },
            })
          }
          if (action === "observe") {
            const controls = (report.observed?.elements ?? []).map(
              (element) =>
                `${element.ref} ${element.role}${element.type ? ` (${element.type})` : ""} "${element.name}"${element.href ? ` → ${element.href}` : ""}${element.disabled ? " (disabled)" : ""}`,
            )
            return done(report, {
              title: `Observed ${report.title || report.url}`,
              output: WebFence.fenceWebPage(
                { url: report.url, title: report.title, tool: "research_browser" },
                [
                  `Page text:\n${report.observed?.text ?? ""}`,
                  controls.length ? `Controls:\n${controls.join("\n")}` : "No controls.",
                ].join("\n\n"),
              ),
              metadata: { runID, action, url: report.url },
            })
          }
          if (action === "close")
            return {
              title: "Closed the research browser",
              output: "Your research browser is closed.",
              metadata: { runID, action },
            }
          return done(report, {
            title: `${action} — ${report.title || report.url || "research browser"}`,
            output: page(report, action === "scroll" ? "Scrolled." : `Done: ${action}.`),
            metadata: { runID, action, url: report.url },
          })
        }).pipe(Effect.orDie),
    }
  }),
)

type Result = {
  title: string
  output: string
  metadata: Metadata
  attachments?: { type: "file"; mime: string; url: string; filename: string }[]
}

// The page a command left the browser on, fenced: its title and address are the page's.
function page(report: Report, note: string) {
  return `${note}\n${WebFence.fenceWebPage({ url: report.url, title: report.title, tool: "research_browser" }, `${report.title || "Untitled"}\n${report.url}`)}`
}
