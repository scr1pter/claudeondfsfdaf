import { lookup } from "node:dns/promises"
import { Effect, Option, Schema } from "effect"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import type { SessionV1 } from "@vectordevai/core/v1/session"

import { Tool } from "./tool"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import type { Provider } from "@/provider/provider"
import { Question } from "../question"
import { MessageID } from "../session/schema"
import { ResearchRun } from "./research-run"
import { ResearchSource } from "./research-source"
import { newAddress, webAccess } from "./webfetch"
import DESCRIPTION from "./browser.txt"

const Action = Schema.Literals([
  "observe",
  "read",
  "links",
  "find",
  "handoff",
  "open_url",
  "open_tab",
  "list_tabs",
  "switch_tab",
  "close_tab",
  "click",
  "type",
  "press",
  "select_option",
  "hover",
  "scroll",
  "wait",
  "wait_for_selector",
  "wait_for_text",
  "screenshot",
  "reload",
  "back",
  "forward",
  "read_console",
  "read_network",
  "read_html",
  "inspect_styles",
  "current_url",
  "close",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The browser action to perform" }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL for open_url or open_tab, or the page to hand to the user",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector for click, type, hover, select_option or wait_for_selector",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "A ref_N handle from observe, for click, type, hover or select_option",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type, wait_for_text or find" }),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "handoff: what the user should do in the browser, such as sign in to read the article",
  }),
  chunk: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "read and read_html: which chunk to show (1 by default)",
  }),
  scope: Schema.optional(Schema.Literals(["main", "all"])).annotate({
    description: "links: the page's main content (default) or all of its links",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Keyboard key for press, alone or with modifiers joined by + (Control+Enter, Meta+a, Shift+Tab)",
  }),
  milliseconds: Schema.optional(Schema.Number).annotate({ description: "Wait duration, capped at 15 seconds" }),
  deltaY: Schema.optional(Schema.Number).annotate({ description: "Vertical scroll amount" }),
  values: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(32))).annotate({
    description: "select_option: the option values or visible labels to select",
  }),
  tab: Schema.optional(Schema.String).annotate({
    description: "switch_tab, close_tab: a tab id from list_tabs (tab_N)",
  }),
  level: Schema.optional(Schema.Literals(["debug", "log", "info", "warn", "error"])).annotate({
    description: "read_console: the lowest level to show (all by default)",
  }),
  filter: Schema.optional(Schema.String).annotate({
    description: "read_network: show only requests whose URL contains this text",
  }),
})

export type BrowserReport = {
  ok: boolean
  error?: string
  finalUrl: string
  title: string
  description: string
  screenshotDataUrl: string
  console: { level: string; message: string; location?: string }[]
  pageErrors: string[]
  networkErrors?: { url: string; status?: number; error?: string; method?: string }[]
  domSummary?: {
    textSample: string
    interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
    inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
  }
  /** The element an inspected selector matches, named as a click there would press it. */
  target?: { found: boolean; label: string }
  diagnostics?: {
    consoleCount: number
    runtimeErrorCount: number
    networkErrorCount: number
    interactiveCount: number
    inputCount: number
  }
  computedStyles?: {
    tag: string
    selector: string
    text: string
    display: string
    visibility: string
    color: string
    backgroundColor: string
    fontSize: string
  }[]
  pageHtml?: string
  /** readPage: the page as the research reader reads it. */
  page?: {
    html: string
    title: string
    url: string
    links: { url: string; text: string; main: boolean }[]
    forms: string[]
    truncated: boolean
  }
  observed?: {
    title: string
    url: string
    text: string
    elements: {
      ref: string
      role: string
      name: string
      tag: string
      type?: string
      href?: string
      disabled?: boolean
    }[]
  }
  tabs?: { id: string; url: string; title: string; active: boolean; loading: boolean }[]
  activeTab?: string
  /** JavaScript dialogs the page opened since the last report, all answered automatically (dismissed). */
  dialogs?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; url: string; at: string }[]
  /** readLogs: the active tab's request log, oldest first, at most 200. */
  network?: {
    method: string
    url: string
    status?: number
    type: string
    error?: string
    at: string
    durationMs?: number
  }[]
  /** inspectPageHtml: the length of the whole document's HTML, of which pageHtml is the start. */
  pageHtmlTotal?: number
  /** Driving commands: how the page settled afterwards. */
  settled?: { navigated: boolean; idle: boolean; waitedMs: number }
}

type Metadata = {
  url: string
  action: Schema.Schema.Type<typeof Action>
  diagnostics?: BrowserReport["diagnostics"]
  /** handoff: whether the user pressed Continue, and the page they reached. */
  handoff?: "continued" | "cancelled"
  /** A research run's source, for a page the research lead read after a handoff. */
  runID?: string
  source?: string
  private?: boolean
}

const COMMANDS: Record<Schema.Schema.Type<typeof Action>, string> = {
  observe: "observePage",
  read: "readPage",
  links: "readPage",
  find: "readPage",
  handoff: "inspectDom",
  open_url: "openUrl",
  open_tab: "openTab",
  list_tabs: "listTabs",
  switch_tab: "switchTab",
  close_tab: "closeTab",
  click: "click",
  type: "type",
  press: "press",
  select_option: "selectOption",
  hover: "hover",
  scroll: "scroll",
  wait: "wait",
  wait_for_selector: "waitForSelector",
  wait_for_text: "waitForText",
  screenshot: "takeScreenshot",
  reload: "reload",
  back: "goBack",
  forward: "goForward",
  read_console: "readLogs",
  read_network: "readLogs",
  read_html: "inspectPageHtml",
  inspect_styles: "inspectComputedStyles",
  current_url: "inspectDom",
  close: "closeBrowser",
}

// Actions that do not look at the page first: they open a page, close the browser or pick a tab. open_tab's address is
// judged as open_url's is.
const UNCHECKED = new Set<Params["action"]>(["open_url", "open_tab", "close", "list_tabs", "switch_tab", "close_tab"])
// Actions on one element, named by a ref or a selector.
const TARGETED = new Set<Params["action"]>(["click", "type", "hover", "select_option"])
// Actions that act on the page, so they run only while it is still the page the asks judged (B17).
const DRIVING = new Set<Params["action"]>(["click", "type", "press", "select_option", "hover", "scroll"])
const TAB_ACTIONS = new Set<Params["action"]>(["list_tabs", "open_tab", "switch_tab", "close_tab"])
const CONSOLE_LEVELS: Record<string, number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 }
const DIALOG_ANSWERS = {
  alert: "closed",
  confirm: "answered Cancel",
  prompt: "answered Cancel",
  beforeunload: "left the page",
}
const HTML_CHUNK = 8_000

export function isLocalUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    return (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
    )
  } catch {
    return false
  }
}

function bridgeRequest(input: Record<string, unknown>, signal: AbortSignal) {
  const url = process.env.VECTOR_BROWSER_BRIDGE_URL
  const token = process.env.VECTOR_BROWSER_BRIDGE_TOKEN
  if (!url || !token) throw new Error("The controlled browser is available in the Vector desktop app only.")
  return fetch(`${url}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(async (response) => {
    const report = (await response.json()) as BrowserReport
    // A command the page could not take comes back as its whole report with ok: false (409). Anything else that is
    // not a report never reached a page: a refused request, a bad token, a desktop that is gone.
    if (typeof report.ok === "boolean" && (response.ok || response.status === 409)) return report
    throw new Error(report.error || `Browser command failed (${response.status})`)
  })
}

// Everything in a report comes from the page, its scripts or its requests, so all of it is fenced as web text. `view` is
// the call that asked for it, for the console, requests, HTML chunk and tabs it shows.
export function formatReport(
  report: BrowserReport,
  view: Partial<Pick<Params, "action" | "level" | "filter" | "chunk">> = {},
) {
  const consoleErrors = report.console.filter((entry) => entry.level === "error").slice(-8)
  const networkErrors = report.networkErrors?.slice(-8) ?? []
  const tabs = report.tabs ?? []
  const text = [
    `Page: ${report.title || "Untitled"}`,
    `URL: ${safeReportUrl(report.finalUrl) || "No page open"}`,
    report.settled
      ? `Page settled after ${report.settled.waitedMs} ms${report.settled.navigated ? ", on a new page" : ""}${report.settled.idle ? "" : ", with requests still running"}`
      : undefined,
    report.description ? `Description: ${report.description}` : undefined,
    report.domSummary?.textSample ? `Visible page text:\n${report.domSummary.textSample.slice(0, 2_400)}` : undefined,
    report.domSummary?.interactives.length
      ? `Interactive elements:\n${report.domSummary.interactives
          .slice(0, 20)
          .map((item) => `- ${item.selector} — ${item.text || item.role || item.tag}`)
          .join("\n")}`
      : undefined,
    report.domSummary?.inputs.length
      ? `Inputs:\n${report.domSummary.inputs
          .slice(0, 16)
          .map((item) => `- ${item.selector} — ${item.type || item.placeholder || item.name || item.tag}`)
          .join("\n")}`
      : undefined,
    report.computedStyles?.length
      ? `Computed styles:\n${report.computedStyles
          .slice(0, 20)
          .map(
            (item) =>
              `- ${item.selector}: display=${item.display}; color=${item.color}; background=${item.backgroundColor}; font-size=${item.fontSize}`,
          )
          .join("\n")}`
      : undefined,
    report.pageHtml !== undefined || view.action === "read_html" ? htmlChunk(report, view.chunk) : undefined,
    view.action === "read_console" ? consoleEntries(report, view.level) : undefined,
    view.action === "read_network" ? requests(report, view.filter) : undefined,
    answered(report),
    tabs.length > 1 || (view.action && TAB_ACTIONS.has(view.action))
      ? `Tabs:\n${
          tabs
            .map(
              (tab) =>
                `- ${tab.id}${tab.active ? " (active)" : ""}${tab.loading ? " (loading)" : ""} ${tab.title || "Untitled"} — ${safeReportUrl(tab.url) || "no page"}`,
            )
            .join("\n") || "No tabs open."
        }`
      : undefined,
    report.pageErrors.length
      ? `Runtime errors:\n${report.pageErrors
          .slice(-8)
          .map((item) => `- ${item}`)
          .join("\n")}`
      : undefined,
    view.action !== "read_console" && consoleErrors.length
      ? `Console errors:\n${consoleErrors.map((item) => `- ${item.message}${item.location ? ` (${item.location})` : ""}`).join("\n")}`
      : undefined,
    view.action !== "read_network" && networkErrors.length
      ? `Failed requests:\n${networkErrors.map((item) => `- ${item.method ?? "GET"} ${safeReportUrl(item.url)}: ${item.status ?? item.error ?? "failed"}`).join("\n")}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n")
  return WebFence.fenceWebPage({ url: safeReportUrl(report.finalUrl) || undefined, tool: "browser" }, text)
}

// The dialogs the page opened and Vector answered, which the desktop reports once, in the first report after them.
function answered(report: BrowserReport) {
  if (!report.dialogs?.length) return
  return `Dialogs answered:\n${report.dialogs.map((dialog) => `- ${dialog.type}: ${dialog.message} (${DIALOG_ANSWERS[dialog.type] ?? "dismissed"})`).join("\n")}`
}

// read_html: the page's HTML in chunks a model reads one at a time, saying when the desktop cut the document short.
function htmlChunk(report: BrowserReport, chunk: number | undefined) {
  const html = report.pageHtml ?? ""
  if (!html) return "HTML: the page returned none."
  const total = Math.ceil(html.length / HTML_CHUNK)
  const index = Math.min(Math.max(chunk ?? 1, 1), total)
  const cut =
    report.pageHtmlTotal !== undefined && report.pageHtmlTotal > html.length
      ? ` (the first ${html.length} of the page's ${report.pageHtmlTotal} characters)`
      : ""
  return `HTML chunk ${index} of ${total}${cut}:\n${html.slice((index - 1) * HTML_CHUNK, index * HTML_CHUNK)}`
}

// read_console: every entry at or above `level`, oldest first.
function consoleEntries(report: BrowserReport, level: Params["level"]) {
  const lowest = CONSOLE_LEVELS[level ?? "debug"] ?? 0
  const shown = report.console.filter((entry) => (CONSOLE_LEVELS[entry.level] ?? 1) >= lowest)
  const heading = level ? `Console (${level} and above)` : "Console"
  if (!shown.length) return `${heading}: nothing logged.`
  return `${heading}:\n${shown.map((entry) => `[${entry.level}] ${entry.message}${entry.location ? ` (${entry.location})` : ""}`).join("\n")}`
}

// read_network: the request log, the last 100 whose address contains `filter`.
function requests(report: BrowserReport, filter: string | undefined) {
  const shown = (report.network ?? []).filter((request) => !filter || request.url.includes(filter)).slice(-100)
  const heading = filter ? `Requests whose URL contains ${JSON.stringify(filter)}` : "Requests"
  if (!shown.length) return `${heading}: none recorded.`
  return `${heading}:\n${shown
    .map(
      (request) =>
        `${request.method} ${request.error ? `failed (${request.error})` : (request.status ?? "pending")} ${request.type} ${safeReportUrl(request.url)}`,
    )
    .join("\n")}`
}

// A query or fragment key that holds a credential, by how it ends, so every kind of token is caught: access_token,
// id_token, provider_token and provider_refresh_token (Supabase's OAuth redirect), accessToken, client_secret, api_key
// and X-Amz-Signature. The short words count only as a whole word (code, auth_code), so token_type, expires_in and
// zipcode stay readable.
const SECRET_PARAM = /(token|secret|password|passwd|apikey|signature|jwt)$|(^|[-_.])(key|sig|code|auth|authorization)$/i

function safeReportUrl(value: string) {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  for (const key of Array.from(url.searchParams.keys())) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, "[REDACTED]")
  }
  // Implicit OAuth and magic-link redirects put the same tokens in the fragment (#access_token=…), behind a hash route
  // (#/callback?code=…) in some apps. A fragment with nothing to redact stays as it was.
  const fragment = url.hash.slice(1)
  if (fragment.includes("=")) {
    const query = fragment.indexOf("?")
    const route = query >= 0 && !fragment.slice(0, query).includes("=") ? fragment.slice(0, query + 1) : ""
    const params = new URLSearchParams(fragment.slice(route.length))
    const secret = Array.from(params.keys()).filter((key) => SECRET_PARAM.test(key))
    for (const key of secret) params.set(key, "[REDACTED]")
    if (secret.length) url.hash = `${route}${params.toString()}`
  }
  if (url.username) url.username = "[REDACTED]"
  if (url.password) url.password = "[REDACTED]"
  return url.toString()
}

// Includes what the Vercel and Supabase dashboards call the actions vector_cloud
// asks for every time (Promote, Instant Rollback, Run in the SQL editor, Save on
// a variable), so the browser is not a way around those prompts.
const SENSITIVE_ACTION =
  /\b(add|approve|authorize|book|buy|checkout|confirm|create|delete|deploy|disconnect|discard|invite|merge|message|pause|pay|promote|publish|purchase|redeploy|remove|reserve|reset|restore|revoke|roll ?back|rotate|run|save|send|submit|transfer|uninstall|upgrade)\b/i

// Keys that press the focused button or submit the active form, alone or with
// a modifier (`Control+Enter` runs a query in the Supabase SQL editor). A line
// break sent as a key is Enter too: Electron sends "\r" as the Return key.
const ACTIVATING_KEYS = new Set(["enter", "return", "numpadenter", "space", "spacebar", " ", "\r", "\n", "\r\n"])

export function describeSensitiveBrowserAction(
  params: Pick<Params, "action" | "key" | "selector" | "text" | "ref" | "values">,
  report: BrowserReport | undefined,
) {
  const dashboard = cloudDashboard(report?.finalUrl)
  if (params.action === "press" && params.key) {
    const key = params.key.replace(/\r\n|\r|\n/g, "Enter").trim() || "Space"
    // The key comes last: `Control+Enter`, or `Control++` for the plus key itself.
    if (
      ACTIVATING_KEYS.has(
        params.key
          .toLowerCase()
          .split(/\+(?!$)/)
          .at(-1) ?? "",
      )
    ) {
      return `Press ${key} on an external page, which may submit the active form or press the focused button`
    }
    if (dashboard)
      return `Press ${key} on the ${dashboard} dashboard, where a key can confirm a release or settings action`
    return
  }
  // Typing a line break presses Enter (sendInputEvent), which submits a form like a press does. A tab presses Tab, which
  // moves focus to the next control, where a space after it presses a button.
  if (params.action === "type" && /[\r\n]/.test(params.text ?? "")) {
    return "Type text with a line break on an external page, which presses Enter and may submit the active form"
  }
  if (params.action === "type" && params.text?.includes("\t")) {
    return "Type text with a tab on an external page, which moves to the next control, where the text after it may press a button"
  }
  // One target per call, as the action itself picks it: a ref wins over a selector, and "" is neither.
  const ref = params.ref || undefined
  const selector = ref ? undefined : params.selector || undefined
  const chosen = ref ?? selector
  // The page's own name for the element the selector or ref matches, so a positional
  // selector (`div[role=dialog] button:last-child`) or a ref_N is judged by what it presses.
  const resolved = report?.target?.found ? report.target.label : undefined
  // A choice in a dashboard's select can pick the branch, region or plan a release or setting goes to.
  if (params.action === "select_option" && dashboard) {
    const choice = params.values?.length ? params.values.join(", ") : "an option"
    return `Select ${choice}${resolved ? ` in ${resolved.slice(0, 80)}` : ""} on the ${dashboard} dashboard, where a choice can change the ${dashboard} project`
  }
  if (params.action !== "click" || !chosen) return
  const target = selector
    ? report?.domSummary?.interactives.find((item) => item.selector === selector || item.selector.includes(selector))
    : undefined
  const label = [target?.text, target?.role, target?.type, resolved, selector].filter(Boolean).join(" ")
  const name = target?.text?.trim() || resolved?.slice(0, 80) || chosen
  if (SENSITIVE_ACTION.test(label)) return `Click ${name} on an external page`
  // On the Vercel and Supabase dashboards almost any button can change the
  // account the vector_cloud prompts protect, so every click there asks.
  if (dashboard) {
    return `Click ${name} on the ${dashboard} dashboard, where a click can deploy, promote, roll back or change the ${dashboard} project`
  }
}

// The Vercel and Supabase dashboards, not their docs or marketing pages.
const VERCEL_PUBLIC_PATHS =
  /^\/(docs|guides|blog|changelog|templates|pricing|legal|kb|contact|customers|enterprise|home|solutions|products)(\/|$)/

function cloudDashboard(url?: string) {
  if (!url || !URL.canParse(url)) return
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  if (host === "app.supabase.com" || (host === "supabase.com" && parsed.pathname.startsWith("/dashboard"))) {
    return "Supabase"
  }
  if ((host === "vercel.com" || host === "www.vercel.com") && !VERCEL_PUBLIC_PATHS.test(parsed.pathname)) {
    return "Vercel"
  }
}

// What the research lead may do in the user's own signed-in browser (section 5.6a): hand a sign-in or a paywall to the
// user, then read the page they reached. No open_url, click, type or press, so a page in the user's browser cannot
// steer the lead into acting on their accounts.
const RESEARCH_ACTIONS = new Set<Schema.Schema.Type<typeof Action>>(["handoff", "read", "links", "find", "observe"])
const READING = new Set<Schema.Schema.Type<typeof Action>>(["read", "links", "find", "observe"])

const NO_RUN = "Vector cannot check that address against this research here, so it hands no page over."
export const RESEARCH_ONLY =
  "In Deep research the browser only hands a page to the user (handoff) and then reads the page they reached. Use research_browser to browse."
export const AFTER_HANDOFF =
  "In Deep research the browser reads only the page the user reached after a handoff, and this is not that page. Use handoff first."
export const INSIDE =
  "In Deep research the browser hands over only public pages: that address is on this computer or the user's network, and the user did not type it. If they want it opened, they can type it in their message."
export const HANDOFF_QUESTION = "Sign in or get past the paywall yourself in Preview, then press Continue."
export const CONTINUE = "Continue"
export const NO_IMAGES = "This model does not read images, so no screenshot was taken."

export const BrowserTool = Tool.define<typeof Parameters, Metadata, never>(
  "browser",
  Effect.gen(function* () {
    // Present wherever the engine runs sessions; a test of the browser alone may leave them out, and then handoff
    // cannot ask and research has no run to save a page in.
    const question = Option.getOrUndefined(yield* Effect.serviceOption(Question.Service))
    const research = Option.getOrUndefined(yield* Effect.serviceOption(ResearchRun.Service))
    const store = Option.getOrUndefined(yield* Effect.serviceOption(ResearchStore.Service))
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const params = normalize(input)
          const lead = ctx.agent === ResearchRun.LEAD
          if (lead && !RESEARCH_ACTIONS.has(params.action))
            return { title: "Not done", output: RESEARCH_ONLY, metadata: { url: "", action: params.action } }
          const model = ctx.extra?.model as Provider.Model | undefined
          if (params.action === "screenshot" && model?.capabilities.input.image !== true)
            return { title: "No screenshot", output: NO_IMAGES, metadata: { url: "", action: params.action } }
          if (params.action === "handoff") return yield* handoff(params, ctx, lead)
          // The lead reads the page the user reached after a handoff, and no other; without one it does not touch the
          // user's browser at all.
          const handed = lead && READING.has(params.action) ? reached(ctx.messages) : undefined
          if (lead && READING.has(params.action) && !handed)
            return { title: "Not done", output: AFTER_HANDOFF, metadata: { url: "", action: params.action } }
          // A click, a hover and a selection also ask for the name of the element they would act on.
          const named = params.action === "click" || params.action === "hover" || params.action === "select_option"
          const current = UNCHECKED.has(params.action)
            ? undefined
            : yield* Effect.promise(() =>
                bridgeRequest(
                  {
                    contextId: ctx.sessionID,
                    command: "inspectDom",
                    selector: named ? params.selector : undefined,
                    ref: named ? params.ref : undefined,
                  },
                  ctx.abort,
                ),
              )
          if (handed && (!current || comparable(handed) !== comparable(current.finalUrl)))
            return { title: "Not done", output: AFTER_HANDOFF, metadata: { url: "", action: params.action } }
          if (current && !current.ok) return notDone(params, current)
          const targetUrl =
            params.action === "open_url" || params.action === "open_tab" ? params.url : current?.finalUrl
          // Reading a page the user handed over asks nothing more: they chose it and pressed Continue.
          const external = Boolean(targetUrl && !isLocalUrl(targetUrl)) && !(lead && READING.has(params.action))
          if (external) yield* approve(params, ctx, targetUrl!, current)

          const done = yield* Effect.promise(() =>
            bridgeRequest(
              {
                contextId: ctx.sessionID,
                command:
                  params.ref && params.action === "click"
                    ? "clickRef"
                    : params.ref && params.action === "type"
                      ? "typeRef"
                      : COMMANDS[params.action],
                url: params.url,
                allowExternal: external,
                selector: params.selector,
                ref: params.ref,
                text: params.text,
                key: params.key,
                milliseconds: params.milliseconds,
                deltaY: params.deltaY,
                tabId: params.tab,
                values: params.values,
                // The page and the element the asks above judged: the desktop does nothing once either changed, so
                // a navigation or another call in between cannot get an action past them (B17).
                // A tab with no page yet is held to having none (""), so a page another call opens in between cannot
                // take the action unasked.
                expectOrigin:
                  current && DRIVING.has(params.action)
                    ? URL.canParse(current.finalUrl)
                      ? new URL(current.finalUrl).origin
                      : ""
                    : undefined,
                expectLabel: params.action === "click" && current?.target?.found ? current.target.label : undefined,
              },
              ctx.abort,
            ),
          )
          // The page check before the action takes the dialogs the page answered since the last call, and the desktop
          // reports each once: they reach the model with this action's own.
          const report = current?.dialogs?.length
            ? { ...done, dialogs: [...current.dialogs, ...(done.dialogs ?? [])] }
            : done
          if (!report.ok) return notDone(params, report)
          if (READING.has(params.action)) return yield* reading(params, ctx, report, lead)
          // A capture of a view that has nothing painted yet is a data URL with no image in it.
          const shot = params.action === "screenshot" && /^data:[^,]*,./.test(report.screenshotDataUrl)
          return {
            title: `${params.action.replaceAll("_", " ")} — ${report.title || safeReportUrl(report.finalUrl) || "browser"}`,
            output:
              params.action === "screenshot" && !shot
                ? `The browser returned an empty screenshot.\n${formatReport(report, params)}`
                : formatReport(report, params),
            attachments: shot
              ? [
                  {
                    type: "file" as const,
                    mime: "image/png",
                    url: report.screenshotDataUrl,
                    filename: "vector-browser.png",
                  },
                ]
              : undefined,
            metadata: { url: safeReportUrl(report.finalUrl), action: params.action, diagnostics: report.diagnostics },
          }
        }),
    }

    // The asks before the browser reaches or acts on an external page: Web access under Vector Local, the origin (or
    // the exact address, once the conversation read the web), and a sensitive action on its own.
    function approve(params: Params, ctx: Tool.Context, targetUrl: string, current: BrowserReport | undefined) {
      return Effect.gen(function* () {
        const origin = new URL(targetUrl).origin
        const opening = params.action === "open_url" || params.action === "open_tab" || params.action === "handoff"
        // With Vector Local on, Web access applies to the browser's pages too, before anything is asked, and after the
        // web an address the agent chose that is new asks each time.
        webAccess("agent-browser", targetUrl)
        const after = opening && (yield* newAddress(targetUrl, ctx))
        yield* ctx.ask({
          permission: opening ? "browser_external" : "browser_interact",
          patterns: [after ? `${PermissionPolicy.AFTER_WEB}${targetUrl}` : origin],
          always: after ? [] : [origin],
          metadata: {
            action: params.action,
            url: targetUrl,
            ...(after ? { reason: PermissionPolicy.AFTER_WEB_REASON } : {}),
          },
        })
        const sensitive = describeSensitiveBrowserAction(params, current)
        if (sensitive) {
          yield* ctx.ask({
            permission: "browser_sensitive",
            patterns: [`${origin}:${params.action}:${params.ref ?? params.selector ?? params.key ?? ""}`],
            always: [],
            metadata: { action: params.action, url: targetUrl, description: sensitive },
          })
        }
      })
    }

    // handoff: shows the page in Preview (opening `url` first, when given) and waits until the user says they are
    // done. In Deep research the address must be one the run may hand over (`handed`), and it is asked about first.
    function handoff(params: Params, ctx: Tool.Context, lead: boolean) {
      return Effect.gen(function* () {
        const metadata = (extra: Partial<Metadata> = {}): Metadata => ({ url: "", action: "handoff", ...extra })
        if (!question)
          return { title: "Not handed off", output: "Vector cannot ask the user here.", metadata: metadata() }
        const checked = lead ? yield* handed(params, ctx) : undefined
        if (checked && !checked.ok) return { title: "Not handed off", output: checked.message, metadata: metadata() }
        const address = checked?.url ?? params.url
        if (address) {
          // The lead is asked about every address it hands over, this computer's included: the user's own browser holds
          // their sign-ins, local ones too. For the build agent a page on this computer is its own work, such as a dev
          // server, and asks nothing.
          if (lead || !isLocalUrl(address)) yield* approve(params, ctx, address, undefined)
          const opened = yield* Effect.promise(() =>
            bridgeRequest(
              { contextId: ctx.sessionID, command: "openUrl", url: address, allowExternal: !isLocalUrl(address) },
              ctx.abort,
            ),
          )
          if (!opened.ok) return { ...notDone(params, opened), title: "Not handed off", metadata: metadata() }
        }
        const reason = params.reason?.trim()
        const answers = yield* question
          .ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                header: "Browser handoff",
                question: [reason, HANDOFF_QUESTION].filter(Boolean).join("\n\n"),
                options: [
                  { label: CONTINUE, description: "I am done in the browser; carry on from the page it shows" },
                  { label: "Cancel", description: "Carry on without this page" },
                ],
                custom: false,
              },
            ],
            ...(ctx.callID ? { tool: { messageID: MessageID.make(ctx.messageID), callID: ctx.callID } } : {}),
          })
          .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed(undefined)))
        if (answers?.[0]?.[0] !== CONTINUE)
          return {
            title: "Handoff cancelled",
            output: "The user did not continue in the browser. Carry on without that page.",
            metadata: metadata({ handoff: "cancelled" }),
          }
        const reached = yield* Effect.promise(() =>
          bridgeRequest({ contextId: ctx.sessionID, command: "inspectDom" }, ctx.abort),
        )
        if (!reached.ok) return { ...notDone(params, reached), metadata: metadata() }
        // Redacted for the transcript too: the page reached after a sign-in often carries its code or token (B18).
        const url = safeReportUrl(reached.finalUrl)
        return {
          title: `Handed off: ${reached.title || url}`,
          output: `The user finished in the browser. Read the page they reached with read.\n${WebFence.fenceWebPage(
            { url, title: reached.title, tool: "browser" },
            `${reached.title || "Untitled"}\n${url}`,
          )}`,
          metadata: metadata({ handoff: "continued", url }),
        }
      })
    }

    // The address the research lead may hand to the user (section 5.6a): one the run may read, through the outbound check
    // as research browsers apply it, and on the public web unless the user typed it. A page of the run can offer a link to
    // this computer or the user's network (an admin page on localhost, a router), and the user's own browser, with
    // their local sign-ins, would send that request for it.
    function handed(params: Params, ctx: Tool.Context) {
      return Effect.gen(function* () {
        if (!research) return { ok: false, message: NO_RUN } as const
        const found = yield* research.current(ctx)
        if ("refused" in found) return { ok: false, message: found.refused } as const
        if (!params.url)
          return {
            ok: false,
            message:
              "Give the address of the page to hand to the user: a search result, a page link or the user's own.",
          } as const
        const checked = ResearchProvenance.check(yield* research.provenance(ctx, found), params.url)
        if (!checked.ok) return checked
        if (!ResearchOutbound.address(checked.url, ResearchOutbound.strict(yield* research.context(ctx, found))).ok)
          return { ok: false, message: ResearchSource.OUTBOUND } as const
        if (checked.from !== "typed" && (yield* inside(checked.url, research.network)))
          return { ok: false, message: INSIDE } as const
        return { ok: true, url: checked.url } as const
      })
    }

    // read, links, find and observe: the page as the reader reads it, fenced. In Deep research a page read after a
    // handoff is saved as a private source of the run, read signed in.
    function reading(params: Params, ctx: Tool.Context, report: BrowserReport, lead: boolean) {
      return Effect.gen(function* () {
        const url = safeReportUrl(report.finalUrl)
        const metadata: Metadata = { url, action: params.action }
        // The page's dialogs come from the page, so they are fenced with what it shows.
        const dialogs = answered(report)
        const fence = (text: string) =>
          WebFence.fenceWebPage(
            { url, title: report.title, tool: "browser" },
            [text, dialogs].filter(Boolean).join("\n\n"),
          )
        if (params.action === "observe") {
          const controls = (report.observed?.elements ?? []).map(
            (element) =>
              `${element.ref} ${element.role}${element.type ? ` (${element.type})` : ""} "${element.name}"${element.href ? ` → ${safeReportUrl(element.href)}` : ""}${element.disabled ? " (disabled)" : ""}`,
          )
          // type takes a selector, so the fields are listed by theirs too.
          const fields = (report.domSummary?.inputs ?? [])
            .slice(0, 16)
            .map((item) => `- ${item.selector} — ${item.type || item.placeholder || item.name || item.tag}`)
          return {
            title: `observe — ${report.title || url}`,
            output: fence(
              [
                `Page text:\n${report.observed?.text ?? ""}`,
                controls.length ? `Controls (click takes the ref):\n${controls.join("\n")}` : "No controls.",
                ...(fields.length && !lead ? [`Fields (type takes the selector):\n${fields.join("\n")}`] : []),
              ].join("\n\n"),
            ),
            metadata,
          }
        }
        const page = report.page
        if (!page)
          return {
            title: "Not read",
            output: dialogs
              ? `The browser did not return the page.\n${fence("")}`
              : "The browser did not return the page.",
            metadata,
          }
        if (params.action === "links") {
          const main = page.links.filter((link) => link.main)
          const shown = (params.scope === "all" || main.length === 0 ? page.links : main).slice(0, 100)
          return {
            title: `${shown.length} links on ${report.title || url}`,
            output: shown.length
              ? fence(shown.map((link) => `${safeReportUrl(link.url)}${link.text ? ` — ${link.text}` : ""}`).join("\n"))
              : dialogs
                ? `This page has no links.\n${fence("")}`
                : "This page has no links.",
            metadata,
          }
        }
        const model = ctx.extra?.model as Provider.Model | undefined
        // The lead reads only the page the user reached after a handoff, which they signed in to or got past a paywall
        // on themselves: its paywall markers, which publishers keep for subscribers too, do not cut it to an excerpt.
        // By its redacted address: a saved source shows it, and a page reached after a sign-in can carry its token.
        const parsed = yield* ResearchReader.parse({
          url,
          contentType: "text/html; charset=utf-8",
          body: new TextEncoder().encode(page.html),
          chunkTokens:
            (model?.limit.context ?? Infinity) < 32_000 ? ResearchReader.COMPACT_TOKENS : ResearchReader.CHUNK_TOKENS,
          ...(lead ? { signedIn: true } : {}),
        })
        if (params.action === "find") {
          const matches = ResearchReader.find(parsed.chunks, params.text ?? "")
          return {
            title: `find — ${report.title || url}`,
            output: fence(
              matches.length
                ? matches.map((item) => `[chunk ${item.chunk}] ${item.snippet}`).join("\n\n")
                : "Nothing on this page matches.",
            ),
            metadata,
          }
        }
        const found = lead && research ? yield* research.current(ctx) : undefined
        if (found && !("refused" in found) && research && store) {
          const kept = yield* ResearchSource.keep({
            research,
            store,
            found,
            page: parsed,
            view: { ...(params.chunk ? { chunk: params.chunk } : {}) },
            lead: true,
            tool: "browser",
            signedIn: true,
          })
          return {
            ...kept,
            metadata: {
              ...metadata,
              runID: found.run.id,
              private: true,
              ...(kept.metadata.source ? { source: kept.metadata.source } : {}),
            },
          }
        }
        const total = parsed.chunks.length
        const index = Math.min(Math.max(params.chunk ?? 1, 1), Math.max(total, 1))
        const outline = params.chunk === undefined ? ResearchReader.outline(parsed) : []
        return {
          title: `read — ${report.title || url}`,
          output: total
            ? `chunk ${index} of ${total}\n${fence([...(outline.length ? [`Outline:\n${outline.join("\n")}`] : []), parsed.chunks[index - 1]!.text].join("\n\n"))}`
            : `The page has no readable text (${parsed.reason ?? parsed.status}).${dialogs ? `\n${fence("")}` : ""}`,
          metadata,
        }
      })
    }
  }),
)

type Params = Schema.Schema.Type<typeof Parameters>

// Models often send "" for every optional field they do not use, and those are absent (B15). A call acts on one
// element: a ref wins over a selector, so the page check, the asks and the action all judge the element that is
// pressed (B14).
function normalize(params: Params): Params {
  const ref = params.ref || undefined
  return {
    ...params,
    ref,
    selector: ref && TARGETED.has(params.action) ? undefined : params.selector || undefined,
    key: params.key || undefined,
    url: params.url || undefined,
    tab: params.tab || undefined,
    filter: params.filter || undefined,
  }
}

// A command the browser could not do: its error, then the report, so what the page logged and requested still reaches
// the model. The error can quote the page (its origin, a selector), so it cannot open a prompt tag either.
function notDone(params: Params, report: BrowserReport) {
  return {
    title: "Not done",
    output: `Not done: ${WebFence.escape(report.error || "The browser could not do that.")}\n${formatReport(report, params)}`,
    metadata: { url: safeReportUrl(report.finalUrl), action: params.action, diagnostics: report.diagnostics },
  }
}

// The page the user reached at this session's last handoff, when they pressed Continue.
function reached(messages: readonly SessionV1.WithParts[]) {
  const last = messages
    .flatMap((message) => message.parts)
    .findLast(
      (part): part is SessionV1.ToolPart =>
        part.type === "tool" &&
        part.tool === "browser" &&
        part.state.status === "completed" &&
        part.state.metadata?.handoff !== undefined,
    )
  if (!last || last.state.status !== "completed" || last.state.metadata?.handoff !== "continued") return undefined
  const url = last.state.metadata.url
  return typeof url === "string" && url ? url : undefined
}

// Whether an address reaches this computer or the user's network: by its name or address, or by what its name resolves
// to, so a public-looking name that points inside counts too. A name that does not resolve here is left to the ask.
function inside(url: string, network: ResearchRun.Network) {
  return Effect.gen(function* () {
    const host = new URL(url).hostname
    if (isLocalUrl(url) || LocalPolicy.hostClass(host) !== "internet") return true
    if (network.publicNames?.some((name) => LocalPolicy.domainMatches(host, name))) return false
    const resolve = network.resolver ?? ((name: string) => lookup(name, { all: true, verbatim: true }))
    const addresses = yield* Effect.promise(() => resolve(host).catch(() => []))
    return addresses.some((address) => WebFetchRequest.isPrivateAddress(address.address))
  })
}

// An address as the handed-page check compares it: redacted, as the handoff stored it, and without its fragment.
function comparable(url: string) {
  const safe = safeReportUrl(url)
  if (!URL.canParse(safe)) return safe
  const parsed = new URL(safe)
  parsed.hash = ""
  return parsed.toString()
}
