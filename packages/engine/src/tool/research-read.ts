import { ResearchCanonical } from "@vectordevai/core/research/canonical"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import type { Provider } from "@/provider/provider"
import { ResearchBrowser } from "./research-browser"
import { ResearchRun } from "./research-run"
import { ResearchSource } from "./research-source"
import { Tool } from "./tool"
import DESCRIPTION from "./research-read.txt"

// research_read (section 5.4). An address must be in the run's provenance (a search result, a link a read offered, or
// one the user typed): research cannot write an address of its own, so a hostile page cannot steer it into putting
// private text in a URL, and the address also passes the outbound check. The run's first new page asks once ("Read
// public pages for this research"), for this run only. The page goes through the research reader (every redirect hop
// authorised, names pinned, an address on the user's own network asked about per origin), is saved in the run as S#,
// and comes back fenced. Reading a saved source again is free and makes no network call. A page built by script is read
// in the agent's own research browser in the desktop app (mode auto or render); without one it is saved as skipped.

export const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description: "An address from a search result, a link research_read offered, or the user's message",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: 'A source this run saved, such as "S3", to read again',
  }),
  chunk: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Which chunk to show (1 by default); the first read shows the outline with each section's chunk",
  }),
  focus: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "Show the 3 passages that best match these words instead of a chunk",
  }),
  find: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Show short snippets around each place this text appears",
  }),
  links: Schema.optional(Schema.Boolean).annotate({
    description: "Also list the page's links, which then may be read",
  }),
  mode: Schema.optional(Schema.Literals(["auto", "fetch", "render"])).annotate({
    description:
      "auto (default) reads the page directly and renders it in your research browser only when script builds it; fetch never renders; render always does (desktop app only)",
  }),
})

type Metadata = ResearchSource.Metadata

export const OUTBOUND = ResearchSource.OUTBOUND
export const RENDER =
  "Rendering a page needs the desktop browser, which this Vector does not have. Read it with mode fetch, or report it as needing the browser."

export const ResearchReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  ResearchRun.Service | ResearchStore.Service | HttpClient.HttpClient
>(
  "research_read",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    // Each hop of a read is decided and logged as research-reader while Vector Local is on (Web access, the site lists).
    const http = EgressHttpClient.make(yield* HttpClient.HttpClient)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not read", output: found.refused, metadata: {} }
          const runID = found.run.id
          const show = (saved: ResearchStore.Saved) => ResearchSource.shown(runID, saved, params)
          // A researcher is shown no private source of the run and nothing read signed in; only the lead holds those.
          const lead = ctx.agent === ResearchRun.LEAD

          if (params.source) {
            const saved = yield* store.source(found.place, runID, params.source)
            if (!saved)
              return { title: "Not read", output: `There is no ${params.source} in this run.`, metadata: { runID } }
            if (ResearchSource.hidden(saved, lead))
              return { title: "Not read", output: ResearchSource.HIDDEN, metadata: { runID } }
            return show(saved)
          }
          if (!params.url)
            return {
              title: "Not read",
              output: 'Give the address to read, or a saved source such as "S3".',
              metadata: { runID },
            }
          // Not offered with Vector Local's Web access None; a run that began before it was set reads no more pages, though
          // a saved source (above) is still read again, with no network call.
          if (ResearchRun.offline())
            return {
              title: "Not read",
              output: ResearchRun.OFFLINE,
              metadata: { runID, refused: "offline" as const },
            }
          if (found.plan.scope === "brain")
            return { title: "Not read", output: ResearchSource.SCOPE, metadata: { runID, refused: "scope" as const } }

          const checked = ResearchProvenance.check(yield* research.provenance(ctx, found), params.url)
          if (!checked.ok)
            return {
              title: "Not read",
              output: checked.message,
              metadata: { runID, url: params.url, refused: "provenance" as const },
            }
          const outbound = ResearchOutbound.address(checked.url, yield* research.context(ctx, found))
          if (!outbound.ok)
            return {
              title: "Not read",
              output: OUTBOUND,
              metadata: { runID, url: checked.url, refused: "outbound" as const },
            }

          // A page the run read is read again from what it saved, unless what it saved is not this agent's to see: a
          // researcher then reads the page itself, and its public read is a source of its own.
          const known = found.detail.sources.find(
            (source) =>
              (source.canonical_url === checked.canonical ||
                ResearchCanonical.canonical(source.url) === checked.canonical) &&
              (source.status === "read" || source.status === "paywalled") &&
              (lead || source.signals?.signed_in !== true),
          )
          if (known) {
            const saved = yield* store.source(found.place, runID, known.id)
            // A page on the user's own computer or network stays the lead's: a researcher's own read of the same
            // address would be private too, so it is not fetched again.
            if (saved && ResearchSource.hidden(saved, lead))
              return { title: "Not read", output: ResearchSource.HIDDEN, metadata: { runID, url: checked.url } }
            if (saved && !saved.forgotten) {
              const shown = show(saved)
              return params.links
                ? {
                    ...shown,
                    output: `${shown.output}\n\nThis run read ${saved.source.id} before, so its links were offered then.`,
                  }
                : shown
            }
          }
          if (params.mode === "render" && !ResearchBrowser.available())
            return { title: "Not read", output: RENDER, metadata: { runID, url: checked.url } }
          // The store refuses a page past the budget too; asking it first spares the site a request.
          if (found.run.pages >= (yield* research.limits(found.plan.depth)).pages)
            return {
              title: "Page budget used",
              output: ResearchStore.PAGES,
              metadata: { runID, url: checked.url, refused: "budget" as const },
            }

          yield* research.approve(ctx, found, checked.url)
          yield* ctx.metadata({ title: `Reading ${checked.url}`, metadata: { runID, url: checked.url } })
          const model = ctx.extra?.model as Provider.Model | undefined
          const chunkTokens =
            (model?.limit.context ?? Infinity) < 32_000 ? ResearchReader.COMPACT_TOKENS : ResearchReader.CHUNK_TOKENS
          const fetched =
            params.mode === "render"
              ? undefined
              : yield* ResearchReader.read(
                  { url: checked.url, typed: checked.from === "typed", chunkTokens },
                  {
                    http,
                    // Vector Local's Web access decides each hop as it is sent (research-reader); the reader itself
                    // refuses a private destination research found, and a metadata address whoever asks. Only the
                    // lead is asked about an address the user typed on their own computer or network: a researcher
                    // carries no private context (sections 6.4 and 6.4a), so without the question its read of one is
                    // refused before anything is sent.
                    authorize: () => Effect.void,
                    ...(lead
                      ? {
                          authorizePrivate: (url: string) =>
                            ctx.ask({
                              permission: "private_network",
                              patterns: [new URL(url).origin],
                              always: [new URL(url).origin],
                              metadata: { url, tool: "research_read" },
                            }),
                        }
                      : {}),
                    limiter: research.limiter(runID),
                    ...(yield* research.robots().pipe(Effect.map((robots) => (robots ? { robots } : {})))),
                    ...(research.network.resolver ? { resolver: research.network.resolver } : {}),
                    ...(research.network.publicNames ? { publicNames: research.network.publicNames } : {}),
                  },
                ).pipe(EgressHttpClient.labelled("research-reader"))
          if (!lead && fetched?.reason === ResearchReader.PRIVATE_ASK)
            return { title: "Not read", output: ResearchSource.LEAD_ONLY, metadata: { runID, url: checked.url } }
          // A page built by script is read in the agent's own research browser, when the desktop app has one. A
          // private page is never rendered there: research browsers reach the public web only.
          const rendered =
            params.mode !== "fetch" && (!fetched || (fetched.status === "needs-render" && !fetched.private))
              ? yield* ResearchBrowser.render({ research, ctx, found, url: checked.url, chunkTokens })
              : undefined
          const failed = rendered && "error" in rendered ? rendered.error : undefined
          // A failed render keeps the fetched page as skipped but says why the desktop browser did not read it, so a
          // broken bridge call never reads as "no desktop browser".
          const page =
            failed && fetched
              ? {
                  ...fetched,
                  reason: `${(fetched.reason ?? ResearchReader.NEEDS_RENDER).replace(/\.+$/, "")}. The desktop browser could not render it: ${failed}`,
                }
              : rendered && !("error" in rendered)
                ? rendered
                : fetched
          if (!page)
            return {
              title: "Not read",
              output: `${checked.url} could not be rendered: ${failed ?? RENDER}`,
              metadata: { runID, url: checked.url },
            }
          return yield* ResearchSource.keep({ research, store, found, page, view: params, lead })
        }).pipe(Effect.orDie),
    }
  }),
)
