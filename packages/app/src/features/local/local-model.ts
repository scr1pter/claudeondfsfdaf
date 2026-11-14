import { Hands } from "@vectordevai/schema/hands"
import type {
  Config,
  EgressEvent,
  EgressSummary,
  LocalAddedServer,
  LocalModelCheck,
  LocalServer,
  LocalServerModel,
  LocalSource,
  LocalStatus,
  LocalUpdate,
  ProviderListResponse,
} from "@vectordevai/sdk/v2/client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalRecommend } from "@vectordevai/core/local-mode/recommend"

// Vector Local in the app, as data: the composer's pill, the session popover's counters, the network log's rows, the
// "Off in Vector Local" labels and the Allow dialog's choices. Every view of Vector Local reads these, so the copy lives
// in one place (the plan's copy deck, section 17) and nothing here claims more than the engine enforces.

type Policy = LocalStatus["policy"]
type Web = Policy["web"]
type Unavailable = NonNullable<ProviderListResponse["unavailable"]>[number]
type Hosted = NonNullable<ProviderListResponse["hosted"]>[number]

export const NAME = "Vector Local"
export const SUBTITLE = "Run Vector's AI features on model servers you or your company host."
export const DEFINITION =
  "With Vector Local on, the agent, subagents, the judge, Vectorscope, Deep research, memory search and the helpers that write titles and summaries use only the model servers on your list. Vector blocks its own requests to vectordev.ai and to AI services that are not on your list, unless you allow one, and the network log shows the requests Vector's engine and windows make or block. Web pages and searches you approve still reach those sites unless you set Web access to None. Programs the agent runs, such as git or npm, make their own connections; with Web access None the shell sandbox blocks them on macOS and Linux."
export const LOCKED = "Set by your company. Ask your administrator to change it."
export const LOOSENING = "This change would loosen Vector Local. Apply it?"
export const AGENT =
  "An agent or Vector's own terminal started this Vector, so nothing here can loosen Vector Local. Change it yourself in a terminal, or with /local in the terminal UI."
export const GUEST = "Vector Local and its network log are visible to the owner of this Vector."
export const LOG_TITLE = "What Vector sent"
export const COVERS_TITLE = "What Vector Local covers"
export const NOT_ENCRYPTED = "Not encrypted: prompts to this server travel in plain text on your network."
export const FORWARDING =
  "This server may pass your prompts or queries on to services it is set up to use. Vector can't see past it."
export const SHARED_MACHINE = "Another user on this computer could run a server on this port."
export const COST =
  "Local models have no per-token price in Vector. Your hardware and power costs are not counted. Step and loop limits still apply."
export const PROGRAMS =
  "Commands the agent runs make their own connections. With Web access None, the shell sandbox blocks them on macOS and Linux. Windows has no such block."
export const ADMIN = "Vector Local is a policy inside Vector, not a firewall. Pair it with your network controls."
export const RESTART =
  "Vector Local was turned on after Vector started. Chromium keeps looking up the names pages link to, and keeps QUIC on, until you restart Vector."

export const WEB_ACCESS: readonly { id: Web; label: string; description: string; pill?: string }[] = [
  { id: "ask", label: "Ask", description: "Research and the browser can read the sites you approve." },
  {
    id: "network",
    label: "Your network only",
    description: "Only your network and sites your company lists.",
    pill: "your network",
  },
  {
    id: "none",
    label: "None",
    description: "Vector makes no internet requests. Deep research uses your brain and files.",
    pill: "no web",
  },
]

/** What Vector Local does not cover (section 1.1), for the pane, the popover's link and the docs. */
export const NOT_COVERED: readonly { title: string; body: string }[] = [
  { title: "Sites you approve", body: "They receive the requests you approved. That is the point of research." },
  {
    title: "Programs the agent starts",
    body: "Shell commands, stdio MCP servers and language servers make their own connections. With Web access None, the shell sandbox blocks the agent's shell commands on macOS and Linux; MCP servers and language servers run outside it, and Windows has no such block.",
  },
  {
    title: "Model servers that forward requests",
    body: "A LiteLLM proxy and Ollama's cloud models can pass your prompts on to a cloud service. Vector labels the ones it can recognise.",
  },
  {
    title: "Everything outside Vector",
    body: "The operating system, other apps, and the DNS resolver for names Vector is allowed to look up.",
  },
  {
    title: "It is a policy inside Vector, not a firewall",
    body: "A person with administrator rights on this computer can change it. Companies should pair it with network controls.",
  },
]

// Short names for the registry's sources, for labels and the log. A source the app does not know yet falls back to
// what the registry says Vector uses it for.
const NAMES: Record<string, string> = {
  "local-inference": "Model servers on your list",
  "local-server-check": "Checking other model servers",
  "cloud-inference": "Cloud AI services",
  "ollama-cloud-models": "Ollama cloud models",
  "vector-free-models": "Free models provided by Vector",
  "vector-codium": "Vector Codium",
  "chatgpt-signin": "ChatGPT sign-in",
  "model-catalog": "Model catalog refresh",
  "free-models-catalog": "Free models list",
  "plans-catalog": "Vector Codium plans",
  "provider-policy": "Sign-in options",
  "vector-account": "Vector account",
  teams: "Teams",
  "usage-checkin": "Usage counts",
  "crash-reports": "Crash reports",
  telemetry: "Your OpenTelemetry tracing",
  "support-report": "Support reports",
  "release-notes": "Release notes",
  "site-assets": "Release note pictures",
  updates: "Updates",
  "help-assistant": "Help assistant",
  share: "Share links",
  "embedding-model": "Memory-search model download",
  "dictation-model": "Dictation model download",
  "ripgrep-download": "ripgrep download",
  "lsp-install": "Language server installs",
  "npm-plugins": "Plugin installs",
  "remote-config": "Remote config",
  "mcp-remote": "Remote MCP servers",
  github: "GitHub pull requests",
  gitlab: "GitLab merge requests",
  "vector-cloud": "Vector Cloud",
  "git-remote": "Vector's own git fetches and pushes",
  webfetch: "Web reads",
  "computer-bridge": `${Hands.NAME} on this computer`,
  "agent-browser": "The agent's browser",
  "research-reader": "Deep research reads",
  "research-browser": "Research browsers",
  "external-agents": "External agents",
  unlabelled: "Unlabelled requests",
  "chromium-network": "Chromium's own traffic",
  "agent-programs": "Programs the agent runs",
}

// Sources Vector Local keeps off in this release without offering Allow…, each with why in its own words. External
// agents are programs that make their own connections, which no allow entry could cover, so Vector does not start them.
const KEPT_OFF: Record<string, string> = {
  "external-agents":
    "Claude Code, Codex and Cursor make their own connections, usually to their makers' cloud models, and Vector Local does not see them. Vector does not start them while Vector Local is on.",
  "help-assistant":
    "The help assistant sends your question to vectordev.ai, so it is off while Vector Local is on. The Vector docs answer most questions without it.",
}
// What Vector Local restricts; `allowed` follows Web access or the list, and `not-covered` is said plainly instead.
const RESTRICTED = new Set<LocalSource["local"]>(["blocked", "ask-once", "allow-with-reason", "not-allowable"])
// Downloads the engine makes itself, which POST /local/grant answers once.
const ONCE = new Set<LocalSource["purpose"]>(["model-download", "tool-download", "plugin", "lsp-install"])

export const SERVER_KINDS: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
  llamacpp: "llama.cpp",
  sglang: "SGLang",
  openai: "OpenAI-compatible server",
}

export function sourceName(id: string, sources: readonly LocalSource[] = []) {
  return NAMES[id] ?? sources.find((source) => source.id === id)?.why ?? id
}

/** The composer pill: "Local", "Local · your network" or "Local · no web", and "Local on build-box" for another computer. */
export function pillText(policy: Policy, server?: string) {
  const base = server ? `Local on ${server}` : "Local"
  const web = policy.pending ? "no web" : WEB_ACCESS.find((item) => item.id === policy.web)?.pill
  return web ? `${base} · ${web}` : base
}

export function pillTitle(policy: Policy) {
  const web = WEB_ACCESS.find((item) => item.id === (policy.pending ? "none" : policy.web))
  return [
    `${NAME} is on. Web access: ${web?.label ?? policy.web}.`,
    ...(policy.lock ? [LOCKED] : []),
    "Open it to see what this session sent.",
  ].join(" ")
}

/**
 * Where Find servers looks and what the hardware summary describes: the computer Vector's engine runs on, named when it
 * is not this one ("on build-box").
 */
export function enginePlace(remote?: string) {
  return remote ? `on ${remote}` : "on this computer"
}

/** host:port of an origin, or the text itself when it is not a URL. */
export function hostOf(origin: string) {
  if (!URL.canParse(origin)) return origin
  return new URL(origin).host
}

/** The kind of server an origin on the list answered as when it was added, such as Ollama. */
export function serverKind(origin: string, policy?: Policy) {
  const at = LocalPolicy.origin(origin)
  const pin = at ? policy?.pins?.[at] : undefined
  return pin ? (SERVER_KINDS[pin.kind] ?? pin.kind) : undefined
}

export type PopoverLine = { id: "models" | "web" | "memory" | "blocked" | "helpers"; text: string }

/** The session popover's counters (section 8.5), for one session including its subagents and helpers. */
export function popoverLines(
  summary: EgressSummary,
  input: { policy?: Policy; sources?: readonly LocalSource[] } = {},
) {
  const calls = Object.entries(summary.model_calls).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const models = calls.length
    ? calls
        .map(([origin, count]) => {
          const kind = serverKind(origin, input.policy)
          return `${count} to ${hostOf(origin)}${kind ? ` (${kind})` : ""}`
        })
        .join(", ")
    : "none yet"
  const web =
    summary.pages + summary.hosts + summary.searches === 0
      ? "nothing yet"
      : [
          count(summary.pages, "page"),
          `${count(summary.hosts, "other host", "other hosts")} they loaded`,
          count(summary.searches, "search", "searches"),
        ].join(", ")
  const carried = [
    summary.carried.personal ? count(summary.carried.personal, "personal card") : undefined,
    summary.carried.documents ? count(summary.carried.documents, "document passage") : undefined,
    summary.carried.repository ? count(summary.carried.repository, "repository excerpt") : undefined,
  ].filter((item): item is string => item !== undefined)
  // Memory rides only on model calls, and under Vector Local those go only to the servers on the list.
  const where =
    calls.length === 1
      ? `, all to ${hostOf(calls[0]![0])}`
      : calls.length > 1
        ? `, to ${calls.length} model servers`
        : ""
  const blocked = Object.entries(summary.blocked).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const total = blocked.reduce((sum, item) => sum + item[1], 0)
  return [
    { id: "models", text: `Model calls: ${models}` },
    { id: "web", text: `Web: ${web}` },
    { id: "memory", text: `Memory sent: ${carried.length ? `${list(carried)}${where}` : "none"}` },
    {
      id: "blocked",
      text: `Blocked: ${total}${total ? ` (${blocked.map(([id, n]) => `${sourceName(id, input.sources)} ${n}`).join(", ")})` : ""}`,
    },
    ...(summary.helper_requests
      ? [{ id: "helpers" as const, text: `Including ${count(summary.helper_requests, "helper request")}` }]
      : []),
  ] satisfies PopoverLine[]
}

/**
 * The toast for a block the engine says is worth telling (local.blocked: a request no part of Vector labelled, or a
 * block the user caused), at most once per source in ten minutes. Expected blocks are listed, not toasted.
 */
export function blockedNotice(
  event: { readonly source: string; readonly origin: string },
  sources: readonly LocalSource[] = [],
) {
  const source = sources.find((item) => item.id === event.source)
  const tried = `${sourceName(event.source, sources)} tried to reach ${hostOf(event.origin)}.`
  if (event.source === "unlabelled")
    return {
      title: "Vector Local blocked a request",
      description: `A request no part of Vector labelled tried to reach ${hostOf(event.origin)}, so Vector Local blocked it. The network log names the code that made it.`,
    }
  return {
    title: "Vector Local blocked a request",
    description:
      source && allowable(source)
        ? `${tried} It is outside the servers you listed. You can allow it in Settings > Vector Local.`
        : `${tried} It is outside the servers you listed, and Vector Local keeps it off.`,
  }
}

export type OffState = "allowed" | "asks" | "never" | "off"

export type OffItem = {
  readonly source: LocalSource
  readonly name: string
  readonly why: string
  readonly state: OffState
  readonly allowable: boolean
  /** The allow entry that lets it through, with the reason the user gave. */
  readonly allowed?: Policy["allow"][number]
}

/** Every source Vector Local restricts, from the registry, so nothing it turns off disappears without a word. */
export function offInLocal(status: LocalStatus): OffItem[] {
  return status.sources
    .filter((source) => RESTRICTED.has(source.local) && source.purpose !== "unknown")
    .map((source) => {
      const allowed = status.policy.allow.find((entry) => entry.source === source.id)
      return {
        source,
        name: sourceName(source.id),
        why: offWhy(source),
        state: offState(source, allowed !== undefined),
        allowable: allowable(source),
        ...(allowed ? { allowed } : {}),
      }
    })
}

/** What Vector Local says it does not reach, from the registry: Chromium's own traffic and the agent's programs. */
export function notCovered(status: LocalStatus) {
  return status.sources.filter((source) => source.local === "not-covered")
}

function offState(source: LocalSource, allowed: boolean): OffState {
  if (allowed) return "allowed"
  if (source.id in KEPT_OFF || source.local === "not-allowable") return "never"
  if (source.local === "ask-once") return "asks"
  return "off"
}

export const OFF_STATE: Record<OffState, string> = {
  allowed: "Allowed",
  asks: "Asks first",
  never: "Off in Vector Local",
  off: "Off in Vector Local",
}

/** The "Why" of an Off in Vector Local label. */
export function offWhy(source: LocalSource) {
  const kept = KEPT_OFF[source.id]
  if (kept) return kept
  const name = sourceName(source.id)
  const where = source.hosts.length
    ? list(source.hosts.slice(0, 3), source.hosts.length - 3)
    : "the addresses set for it"
  const sends = `${name} sends ${lowerFirst(source.sends)} to ${where}.`
  if (source.local === "ask-once") return `${sends} Vector Local asks before each one.`
  const blocked = `${sends} Vector Local blocks it because it is outside the servers you listed.`
  if (source.local === "not-allowable") return `${blocked} It cannot be allowed while Vector Local is on.`
  return blocked
}

/** Whether the user may allow a source under Vector Local: Allow… is offered only for these. */
export function allowable(source: LocalSource) {
  if (source.id in KEPT_OFF || source.purpose === "unknown") return false
  return source.local === "blocked" || source.local === "allow-with-reason" || source.local === "ask-once"
}

export type AllowChoices = {
  /** Allow once: a grant for the engine's next download of this kind, never saved. */
  readonly once: boolean
  /** Always allow: an allow entry with the reason, in the user's config. */
  readonly always: boolean
  /** Why a choice is missing, when one is. */
  readonly note?: string
}

/**
 * The Allow dialog's buttons. Allow once answers only the engine's own downloads, which POST /local/grant lets through
 * once. Always allow writes an allow entry; under a company lock it appears only when the company left `allow` to the
 * user, and a Vector the agent started can loosen nothing.
 */
export function allowChoices(source: LocalSource, status: Pick<LocalStatus, "agent" | "locked" | "policy">) {
  if (status.agent || !allowable(source)) return { once: false, always: false, note: status.agent ? AGENT : undefined }
  const once = source.local === "ask-once" && ONCE.has(source.purpose) && source.where.includes("engine")
  const always = !status.locked.includes("allow")
  return { once, always, ...(always ? {} : { note: LOCKED }) } satisfies AllowChoices
}

/** The update Always allow sends, with the reason the user kept or wrote. */
export function allowUpdate(source: LocalSource, reason: string): LocalUpdate {
  return { allow: { add: [{ source: source.id, reason: reason.trim() }] }, confirm: true, by: "app" }
}

/** A reason to start the Allow dialog's field with: what Vector uses the source for. */
export function defaultReason(source: LocalSource) {
  return source.why
}

export type Refusal =
  | { readonly type: "confirm"; readonly changes: readonly string[]; readonly identity?: readonly string[] }
  | { readonly type: "refused"; readonly code: string; readonly message: string }
  | { readonly type: "error"; readonly message: string }

/** What a Local API error says: a change to confirm, a refusal with its reason, or a failure. */
export function refusal(error: unknown): Refusal {
  const value = error as {
    name?: unknown
    data?: { message?: unknown; changes?: unknown; code?: unknown; identity?: unknown }
  }
  const message = typeof value?.data?.message === "string" ? value.data.message : undefined
  if (value?.name === "LocalConfirmError")
    return {
      type: "confirm",
      changes: strings(value.data?.changes),
      ...(Array.isArray(value.data?.identity) ? { identity: strings(value.data.identity) } : {}),
    }
  if (value?.name === "LocalError" && message)
    return { type: "refused", code: typeof value.data?.code === "string" ? value.data.code : "invalid", message }
  if (message) return { type: "error", message }
  if (error instanceof Error && error.message) return { type: "error", message: error.message }
  return { type: "error", message: "Vector could not reach its engine. Try again in a moment." }
}

/** "It turns Vector Local off and allows github for any host." */
export function changesText(changes: readonly string[]) {
  return changes.length ? `It ${list(changes)}.` : ""
}

const IDENTITY: Record<string, string> = {
  kind: "the kind of server",
  version: "its version",
  models: "its models",
  spki: "its https key",
}

/** "gpu-box now answers as a different server. Check it before sending prompts." with what changed. */
export function identityChanged(server: string, identity: readonly string[]) {
  const what = identity.map((item) => IDENTITY[item] ?? item)
  return `${server} now answers as a different server. Check it before sending prompts.${what.length ? ` Changed: ${list(what)}.` : ""}`
}

/**
 * The model server the engine says a model's requests go to, when someone hosts it: this computer, the user's network or
 * the model server list. The engine reads where it sends them; a server added in Vector sets the provider's base URL
 * and leaves the model's own address empty, so the app does not work it out again. Undefined for a cloud API, or from
 * an engine that does not say.
 */
export function hostedServer(
  hosted: readonly Hosted[] | undefined,
  model: { readonly providerID: string; readonly modelID: string },
) {
  return hosted?.find((item) => item.providerID === model.providerID && item.modelID === model.modelID)
}

/** The models a role may use under Vector Local: each connected model the engine says runs on a server someone hosts. */
export function roleModels(input: {
  readonly providers: Iterable<{
    readonly id: string
    readonly name: string
    readonly models: Readonly<Record<string, { readonly id: string; readonly name: string }>>
  }>
  readonly connected: readonly string[]
  readonly hosted?: readonly Hosted[]
}) {
  const connected = new Set(input.connected)
  return [...input.providers]
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models)
        .filter((model) => hostedServer(input.hosted, { providerID: provider.id, modelID: model.id }))
        .map((model) => ({
          key: `${provider.id}/${model.id}`,
          label: `${model.name || model.id} (${provider.name || provider.id})`,
        })),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label))
}

/** The composer's refusal when an image is attached and no model on the list reads images. */
export const NO_VISION = {
  title: "No model on your servers reads images",
  description:
    "With Vector Local on, images go only to models on the servers you listed, and none of them accepts images. Remove the image, or add a vision model on a server you host, then send again.",
}

export type OffModel = { readonly id: string; readonly why: string }

/**
 * The model picker's collapsed "Off in Vector Local" group: each provider Vector Local keeps off, with why, so a
 * provider never vanishes from the picker without a word.
 */
export function offInLocalProviders(unavailable: readonly Unavailable[] | undefined): OffModel[] {
  return (unavailable ?? [])
    .filter((item) => item.reason === "off-in-local")
    .map((item) => ({ id: item.id, why: item.message.replace(/^[^:]+: off in Vector Local\.\s*/, "") }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

// ---- The network log ---------------------------------------------------------------------------------------------

export type LogFilter = {
  readonly result: "all" | "allowed" | "blocked"
  readonly session?: string
  readonly text: string
}

export const RESULTS: Record<EgressEvent["decision"], string> = { allow: "Allowed", ask: "Asked", block: "Blocked" }

const CLASSES: Record<EgressEvent["class"], string> = {
  "this-computer": "This computer",
  "your-network": "Your network",
  listed: "On your list",
  internet: "Internet",
}

export function classLabel(cls: EgressEvent["class"]) {
  return CLASSES[cls]
}

export type LogRow = {
  readonly id: string
  readonly time: string
  readonly what: string
  readonly host: string
  readonly where: string
  readonly session?: string
  readonly sent: string
  readonly received: string
  readonly result: string
  readonly decision: EgressEvent["decision"]
  readonly rule: string
  readonly reason: string
  readonly carried?: string
  /** For a blocked request no part of Vector labelled: the code that made it, as the backstop saw it. */
  readonly code?: string
}

/** The network log's rows, newest first, as the table shows them. */
export function logRows(
  events: readonly EgressEvent[],
  input: { filter: LogFilter; sources?: readonly LocalSource[] },
) {
  const text = input.filter.text.trim().toLowerCase()
  return events
    .filter((event) => {
      if (input.filter.result === "allowed" && event.decision !== "allow") return false
      if (input.filter.result === "blocked" && event.decision === "allow") return false
      if (input.filter.session && (event.root_session_id ?? event.session_id) !== input.filter.session) return false
      if (!text) return true
      return [event.origin, event.source, sourceName(event.source, input.sources), event.purpose, event.reason].some(
        (value) => value.toLowerCase().includes(text),
      )
    })
    .toSorted((a, b) => b.time - a.time || b.id.localeCompare(a.id))
    .map(
      (event): LogRow => ({
        id: event.id,
        time: timeText(event.time),
        what: `${sourceName(event.source, input.sources)}${event.resource === "subresource" ? " (loaded by a page)" : ""}`,
        host: hostOf(event.origin),
        where: classLabel(event.class),
        ...(event.root_session_id || event.session_id ? { session: event.root_session_id ?? event.session_id } : {}),
        sent: bytes(event.bytes_out),
        received: bytes(event.bytes_in),
        result: RESULTS[event.decision],
        decision: event.decision,
        rule: event.rule,
        reason: event.reason,
        ...carriedText(event.carried),
        ...(event.frame ? { code: `Made by ${event.frame}` } : {}),
      }),
    )
}

function carriedText(carried: EgressEvent["carried"]) {
  const parts = [
    carried.personal ? count(carried.personal, "personal card") : undefined,
    carried.documents ? count(carried.documents, "document passage") : undefined,
    carried.repository ? count(carried.repository, "repository excerpt") : undefined,
  ].filter((item): item is string => item !== undefined)
  return parts.length ? { carried: `Carried ${list(parts)}` } : {}
}

export function timeText(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function bytes(value: number | undefined) {
  if (value === undefined) return "–"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

// How many requests GET /local/egress answers with: the engine's in-memory ring (EgressLogStore.RING_SIZE, which reads
// files, so the app does not import it). Older requests are only in the files on disk and in an export.
export const LOG_HELD = 2_000

/** What the network log view shows: the requests the engine holds in memory, which Export goes beyond. */
export function logDescription(days: number) {
  return `The latest ${LOG_HELD.toLocaleString("en-US")} requests Vector decided while Vector Local was on: where each went, never what it said. Export includes every request kept on this computer. ${retention(days)}`
}

/** The file an export of the network log is saved as. */
export function exportName(format: "csv" | "jsonl", now = Date.now()) {
  return `vector-network-log-${new Date(now).toISOString().slice(0, 10)}.${format}`
}

export function retention(days: number) {
  return `Kept for ${count(days, "day")} on this computer.`
}

// ---- Model servers -----------------------------------------------------------------------------------------------

/** The labels a model server carries: where it is, whether its prompts are encrypted, whether it forwards them. */
export function serverLabels(server: Pick<LocalServer, "class" | "encrypted" | "forwards" | "origin">) {
  return [
    server.class === "this-computer" ? "This computer" : server.class === "your-network" ? "Your network" : "Internet",
    ...(!server.encrypted && server.class !== "this-computer" ? [NOT_ENCRYPTED] : []),
    ...(server.forwards ? [FORWARDING] : []),
    ...(server.class === "this-computer" ? [SHARED_MACHINE] : []),
  ]
}

// ---- Roles and the setup wizard ----------------------------------------------------------------------------------

export type Role = LocalRecommend.Role

/** The roles a model fills, as Settings > Vector Local and the setup wizard list them, with the config key each sets. */
export const ROLES: readonly {
  id: Role
  label: string
  description: string
  check?: "agent" | "subagent" | "judge" | "review" | "research"
}[] = [
  { id: "agent", label: "Main agent", description: "The agent you talk to.", check: "agent" },
  { id: "subagent", label: "Subagents", description: "The agents it starts for parts of the work.", check: "subagent" },
  { id: "judge", label: "Judge", description: "Checks finished work and Deep research's citations.", check: "judge" },
  { id: "review", label: "Vectorscope", description: "Reviews changes you run in Vector.", check: "review" },
  {
    id: "small",
    label: "Titles and summaries",
    description: "Short helper requests, sent with a small reply limit.",
  },
  { id: "research", label: "Deep research", description: "Researches and writes cited reports.", check: "research" },
]

// Which agent's model each role sets. The main agent is the default model; the others are the agents that do the work.
const ROLE_AGENTS: Partial<Record<Role, string>> = {
  subagent: "general",
  judge: "judge",
  review: "review",
  research: "research",
}

// The config key that sets each role's model, as a company's `locked_keys` names it.
const ROLE_KEYS: Record<Role, string> = {
  agent: "model",
  small: "small_model",
  subagent: "agent",
  judge: "agent",
  review: "agent",
  research: "agent",
}

/** Whether a company lock keeps a role's model from the user: its config key is in the lock's `locked_keys`. */
export function roleLocked(role: Role, policy: Pick<Policy, "lock" | "locked_keys">) {
  return policy.lock && policy.locked_keys.includes(ROLE_KEYS[role])
}

/** Each role's model in a config, as provider/model, or undefined when the config leaves it to the session's model. */
export function configRoles(config: Pick<Config, "model" | "small_model" | "agent"> | undefined) {
  return Object.fromEntries(
    ROLES.map((role) => {
      if (role.id === "agent") return [role.id, config?.model]
      if (role.id === "small") return [role.id, config?.small_model]
      return [role.id, config?.agent?.[ROLE_AGENTS[role.id]!]?.model]
    }),
  ) as Partial<Record<Role, string>>
}

/** The global config change that gives each role its model. A role left out is not changed. */
export function rolesPatch(roles: Partial<Record<Role, string>>): Config {
  const agents = Object.fromEntries(
    ROLES.flatMap((role) => {
      const model = roles[role.id]
      const agent = ROLE_AGENTS[role.id]
      return model && agent ? [[agent, { model }]] : []
    }),
  )
  return {
    ...(roles.agent ? { model: roles.agent } : {}),
    ...(roles.small ? { small_model: roles.small } : {}),
    ...(Object.keys(agents).length ? { agent: agents } : {}),
  }
}

/** A server as the Local API sends it, with its numbers as numbers, for views written against the engine's shape. */
export function probeServer(server: LocalServer): LocalProbe.Server {
  return {
    ...server,
    concurrency: finite(server.concurrency),
    models: server.models.map((model) => ({
      ...model,
      context: finite(model.context),
      trained: finite(model.trained),
      output: finite(model.output),
      size: finite(model.size),
    })),
  }
}

/** The Local API change that puts a server Vector read on the list, pinned as it answered. */
export function listServer(server: { readonly origin: string; readonly pin: LocalProbe.Pin }): LocalUpdate {
  return {
    endpoints: { add: [server.origin] },
    pins: {
      [server.origin]: {
        kind: server.pin.kind,
        ...(server.pin.version === undefined ? {} : { version: server.pin.version }),
        ...(server.pin.models === undefined ? {} : { models: server.pin.models }),
        ...(server.pin.spki ? { spki: server.pin.spki } : {}),
      },
    },
  }
}

/** A number the engine sent, or undefined for a missing or non-finite one. */
export function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** What the wizard says about one model a server runs: its context, tools, images, whether it is loaded and its size. */
export function modelFacts(model: LocalServerModel) {
  const context = finite(model.context)
  const size = finite(model.size)
  return {
    context: context ? `${context.toLocaleString("en-US")}-token context` : "Context unknown until checked",
    tools:
      model.tools === true ? "Calls tools" : model.tools === false ? "No tool calls" : "Tools unknown until checked",
    vision: model.vision ? "Reads images" : "Text only",
    ...(model.loaded ? { loaded: "Loaded" } : {}),
    ...(size ? { size: `${(size / 1024 ** 3).toFixed(1)} GB` } : {}),
    ...(model.cloud ? { cloud: "Ollama cloud model: off in Vector Local" } : {}),
  }
}

/**
 * Each role's model, pre-filled from the servers just added: the largest model that calls tools fills the agent's
 * roles, and titles and summaries take a smaller one only when both fit in `usable` bytes. Cloud models never do.
 */
export function suggestRoles(added: readonly LocalAddedServer[], usable?: number) {
  const candidates = added.flatMap((item) =>
    item.server.models
      .filter((model) => item.models.includes(model.id))
      .map((model) => ({
        provider: item.provider,
        model: {
          ...model,
          context: finite(model.context),
          trained: finite(model.trained),
          output: finite(model.output),
          size: finite(model.size),
        },
      })),
  )
  return LocalRecommend.assign({ candidates, usable })
}

/**
 * Each model a role list names, once for every role it fills, for Check models: the engine measures each role's needs
 * on its own (its agent's prompt and tools), so a model that works as the agent may still be too small for another.
 */
export function checksFor(roles: Partial<Record<Role, string>>) {
  return ROLES.flatMap((role) => {
    const model = roles[role.id]
    return model && role.check ? [{ model, role: role.check }] : []
  })
}

export const CHECK_RESULT: Record<LocalModelCheck["result"], string> = {
  works: "Works with Vector's tools",
  "no-tools": "Does not call tools",
  "schema-rejected": "Rejected Vector's tool definitions",
  "context-too-small": "Context too small",
  failed: "The check failed",
  ask: "Needs your answer first",
}

export function count(value: number, one: string, many = `${one}s`) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`
}

/** "a, b and c", or "a, b, c and 2 more" when `more` items are left out. */
export function list(items: readonly string[], more = 0) {
  const all = more > 0 ? [...items, `${more} more`] : [...items]
  if (all.length <= 1) return all.join("")
  return `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`
}

function lowerFirst(text: string) {
  return text ? text[0]!.toLowerCase() + text.slice(1) : text
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
