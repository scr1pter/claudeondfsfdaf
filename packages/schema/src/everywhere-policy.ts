export * as EverywherePolicy from "./everywhere-policy.js"

import {
  ACCOUNT_ID_PATTERN,
  BRANCH_PATTERN,
  LASTING_DECLINES,
  LIMITS,
  PERMISSION_ID_PATTERN,
  PR_URL_PATTERN,
  REPLY_FORMAT,
  SERVER_CAPS,
  TIMING,
  isRepositoryName,
  looksLikeCode,
  sanitizeLabel,
  type DeclineCode,
  type Milestone,
  type Outcome,
  type PlatformId,
  type RefusalCode,
  type ReplyFormat,
} from "./everywhere.js"

/*
 * Vector everywhere's pure policy: where a job runs (`decideRoute`, contract 3.4), who may start one (`mayTrigger`,
 * 3.9), how text from a run is made safe to post (`sanitizeReply`, `secretLike`, 3.7) and every fixed text the bot
 * posts (`renderResult`, `renderMilestone`, `renderRefusal`, `renderHelp`, `renderEnd`), written per platform: Slack
 * mrkdwn, Markdown for GitHub and Linear, plain text for Jira.
 *
 * It imports only ./everywhere and uses no runtime-specific API (only `URL`), so api/, core and the desktop can all
 * load it. Nothing here performs I/O: the intake gathers the facts through its ports and acts on the answer.
 *
 * Text a model or a platform user wrote is only ever passed through `sanitizeReply` before it is rendered. Every other
 * word the renderers write is fixed here.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

/** How each platform is named in text people read. */
export const PLATFORM_NAMES: Readonly<Record<PlatformId, string>> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  jira: "Jira",
}

/** Where people link accounts and connect places. */
export const EVERYWHERE_PAGE = "vectordev.ai/everywhere"

/** A computer that has not called in for this long is not waited for (3.4 step 7). */
export const COMPUTER_SEEN_MS = 30 * 24 * 60 * 60_000

/** What a summary becomes when it cannot be posted as written (3.5 step 8, 3.7). */
export const WITHHELD = {
  posting: "Summary withheld by your posting check. The changes are on the branch.",
  secret: "Summary withheld: it looked like it held a secret.",
  code: "Summary withheld: it held code or a diff.",
} as const

function isAccount(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value)
}

function sameAccount(a: unknown, b: unknown) {
  return isAccount(a) && isAccount(b) && a.toLowerCase() === b.toLowerCase()
}

// ---------------------------------------------------------------------------------------------------------------------
// Who may trigger spend (3.9)
// ---------------------------------------------------------------------------------------------------------------------

/** What the intake knows about the person behind a trigger. */
export type RequesterFacts = {
  /** The Vector account this platform user linked; absent when there is no link. */
  readonly account?: string
  readonly bot: boolean
  /** A Jira automation or a Linear app user: no person is behind the request. */
  readonly automation?: boolean
  /** A Slack Connect user from another organisation. */
  readonly external: boolean
  /** A Slack guest. */
  readonly guest: boolean
}

/**
 * The owner's answers that would widen who may spend (section 10). Both are "no" until the owner says otherwise, so
 * at launch only the sponsor's own linked identity starts runs.
 */
export type OwnerDecisions = {
  /** Q2: a binder may allow linked teammates to spend their Actions hours. */
  readonly teammatesOnActions: boolean
  /** Q3: a computer's owner may allow named teammates to run on their computer. */
  readonly teammatesOnComputer: boolean
}

export const OWNER_DECISIONS: OwnerDecisions = { teammatesOnActions: false, teammatesOnComputer: false }

/** Accounts a sponsor allowed. Nothing stores these until Q2 (and Q3) are yes; only the table row exists. */
export type Allowlists = {
  /** Q2: accounts the binder allows to spend their Actions hours from this installation. */
  readonly actions?: readonly string[]
  /** Q3: accounts the computer's owner allows to run on their computer. */
  readonly computer?: readonly string[]
}

/** One row of the spend table (3.9). */
export type TriggerCheck =
  | {
      /** A run on the sponsor's computer, or in the binder's own GitHub Actions. */
      readonly route: "laptop" | "actions"
      readonly requester: RequesterFacts
      readonly sponsor: string
      readonly allow?: Allowlists
    }
  | {
      /** A GitHub mention through @vector, unchanged: any writer of the repository (@vector's rule O5). */
      readonly route: "github-mention"
      readonly requester: { readonly bot: boolean; readonly writer: boolean }
    }
  | {
      /** GitHub laptop-first: only the binder's own mentions, compared by GitHub id (4.1). */
      readonly route: "github-laptop-first"
      readonly requester: { readonly bot: boolean; readonly githubId: number }
      readonly binderGithubId: number
    }

export type TriggerRefusal = "bot" | "automation" | "external" | "guest" | "not-linked" | "not-allowed"
export type TriggerVerdict = { readonly ok: true } | { readonly ok: false; readonly code: TriggerRefusal }

/** Why a platform user can start no run at all, before anyone's allowlist is read (3.8). */
function identityRefusal(requester: RequesterFacts): TriggerRefusal | undefined {
  if (requester.bot) return "bot"
  if (requester.automation) return "automation"
  if (requester.external) return "external"
  if (requester.guest) return "guest"
  if (!isAccount(requester.account)) return "not-linked"
  return undefined
}

function isGithubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/**
 * Whether this person may start this kind of run (3.9, E2, E14). At launch a run happens only for the sponsor's own
 * linked identity; a teammate needs both the owner's answer (Q2 for Actions, Q3 for a computer) and the sponsor's
 * allowlist, so with the recommended answers nobody else ever runs on someone's computer or hours.
 */
export function mayTrigger(check: TriggerCheck, decisions: OwnerDecisions = OWNER_DECISIONS): TriggerVerdict {
  const refuse = (code: TriggerRefusal): TriggerVerdict => ({ ok: false, code })
  switch (check.route) {
    case "github-mention":
      if (check.requester.bot) return refuse("bot")
      return check.requester.writer ? { ok: true } : refuse("not-allowed")
    case "github-laptop-first":
      if (check.requester.bot) return refuse("bot")
      return isGithubId(check.requester.githubId) && check.requester.githubId === check.binderGithubId
        ? { ok: true }
        : refuse("not-allowed")
    case "laptop":
    case "actions": {
      const identity = identityRefusal(check.requester)
      if (identity) return refuse(identity)
      const account = check.requester.account
      if (sameAccount(account, check.sponsor)) return { ok: true }
      if (!isAccount(check.sponsor)) return refuse("not-allowed")
      const widened = check.route === "laptop" ? decisions.teammatesOnComputer : decisions.teammatesOnActions
      const list = check.route === "laptop" ? check.allow?.computer : check.allow?.actions
      if (widened && list?.some((entry) => sameAccount(entry, account))) return { ok: true }
      return refuse("not-allowed")
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Routing (3.4)
// ---------------------------------------------------------------------------------------------------------------------

/** A switch as the ports read it: Codium's values once R-C6 lands, env until then (missing env reads "stop"). */
export type SwitchState = "on" | "no-new" | "stop"

/** The server cap counters before this job (3.9). */
export type CapCounts = {
  readonly sponsorToday: number
  readonly sponsorLive: number
  readonly requesterHour: number
  readonly installationToday: number
}

/** What came back in the 20-second offer window (3.4 step 5a). */
export type OfferOutcome = {
  readonly claimed: boolean
  /** One entry per computer that declined. */
  readonly declines: readonly DeclineCode[]
  /** Computers that neither claimed nor declined. */
  readonly unanswered: number
}

/** What the cloud-agents and binding ports report (6.1). Absent when the cloud-agents port is absent. */
export type ActionsFacts = {
  /** The platform is in @vector's and Codium's `ENABLED_SOURCES` (R-C8, R-A8). */
  readonly sourceEnabled: boolean
  /** The job body goes by reference (R-A4). Before it there is no Actions route for platform jobs (E11). */
  readonly bodyByReference: boolean
  /** @vector records the workflow mode on the binding (R-A9). Before it there is no Actions route. */
  readonly modeRecorded: boolean
  readonly binding?: { readonly account: string; readonly appInstalled: boolean; readonly codiumMode?: boolean }
  /** Live visibility read with the App's token just before dispatch; absent (a failed read) counts as public. */
  readonly visibility?: "public" | "private" | "internal"
}

export type RouteInput = {
  readonly platform: PlatformId
  readonly switches: {
    readonly everywhere: SwitchState
    /** The platform is in VECTOR_EVERYWHERE_PLATFORMS. */
    readonly platform: boolean
    /** Codium's `remote` switch: relay presence ignores it, so the router reads it itself (E10). */
    readonly remote: SwitchState
  }
  readonly requester: RequesterFacts
  /** GitHub laptop-first only: the trigger comment's author and the binder, by GitHub id (4.1). */
  readonly github?: { readonly actorId: number; readonly binderId: number }
  /** Who pays: the requester's own linked account at launch, the binder for a GitHub handoff. */
  readonly sponsor: string
  readonly allow?: Allowlists
  /** The sponsor has the `everywhere` perk, or, before it exists, is listed in VECTOR_EVERYWHERE_ALLOW_ACCOUNTS. */
  readonly inPlan: boolean
  readonly counts: CapCounts
  /** The repository the job is for; absent while it is unclear. */
  readonly repository?: { readonly id: number; readonly fullName: string }
  readonly laptop: {
    /** `remoteConfigured()`: the relay is set up on the server. */
    readonly configured: boolean
    /** The sponsor has the `remote` perk. */
    readonly perk: boolean
    /** Relay presence: a computer socket with a heartbeat in the last 75 s. */
    readonly online: boolean
    /** When one of the sponsor's computers last called `pending`, `claim` or `decline`. */
    readonly lastSeen?: number
    /** "Wait for my computer" (default on), from the computer's last readiness booleans. */
    readonly waitForComputer: boolean
  }
  /** Absent until the job was offered; then what came back in the window. */
  readonly offer?: OfferOutcome
  readonly actions?: ActionsFacts
  readonly receivedAt: number
  readonly now: number
}

/** Why no place could take a job (3.4 step 7), so the refusal names the real reason. */
export type NoPlace = {
  readonly computer: "not-seen" | "wait-off" | "not-allowed" | "no-remote"
  /** `bind`: the Actions route exists but this repository is not bound for it; `public`: it is not private. */
  readonly actions: "none" | "bind" | "public"
}

export type RouteDecision =
  /** No job: say why with `renderRefusal` (`not-linked` is the private link prompt). */
  | { readonly action: "refuse"; readonly code: RefusalCode; readonly why?: NoPlace }
  /** Ask the requester which repository (Slack reply, Linear `select` elicitation, Jira `INPUT_REQUIRED`). */
  | { readonly action: "ask-repository" }
  /** Offer to every live computer of the sponsor, wait up to 20 s, then decide again with `offer` filled in. */
  | { readonly action: "offer" }
  /** A computer claimed it. */
  | { readonly action: "laptop" }
  /** Dispatch to the binder's own GitHub Actions. */
  | { readonly action: "actions" }
  /** Wait for the computer until `until`, which is before the job body expires. */
  | { readonly action: "queue"; readonly until: number }
  /** GitHub handoff only: answer `handled: false`, so the repository's own Actions run continues as today (4.1). */
  | { readonly action: "hand-back"; readonly code: RefusalCode | DeclineCode }

/** Whether a server cap is full: the job would be one too many (3.9). */
export function overLimit(counts: CapCounts) {
  return (
    !(counts.sponsorToday < SERVER_CAPS.sponsorPerDay) ||
    !(counts.sponsorLive < SERVER_CAPS.sponsorLive) ||
    !(counts.requesterHour < SERVER_CAPS.requesterPerHour) ||
    !(counts.installationToday < SERVER_CAPS.installationPerDay)
  )
}

/** The latest a job may wait for a computer: 1 h 55 min from intake, 10 minutes for Jira (4.4). */
export function queueDeadline(platform: PlatformId, receivedAt: number) {
  return receivedAt + (platform === "jira" ? TIMING.jiraQueueMs : TIMING.queueMs)
}

/** When every computer turned the job down for different lasting reasons, the one closest to working is named. */
const LASTING_ORDER: readonly DeclineCode[] = ["not-mapped", "model-not-allowed", "local-mode", "off"]

/** The lasting reason to refuse with, when every computer that was offered the job gave one (3.4 step 5a). */
function everyDeclineLasting(offer: OfferOutcome): DeclineCode | undefined {
  if (offer.claimed || offer.unanswered > 0 || offer.declines.length === 0) return undefined
  if (!offer.declines.every((code) => LASTING_DECLINES.has(code))) return undefined
  return LASTING_ORDER.find((code) => offer.declines.includes(code))
}

function actionsState(input: RouteInput, allowed: boolean): NoPlace["actions"] | "eligible" {
  const facts = input.actions
  if (!facts || !facts.sourceEnabled || !facts.bodyByReference || !facts.modeRecorded || !allowed) return "none"
  const binding = facts.binding
  if (!binding || !sameAccount(binding.account, input.sponsor) || !binding.appInstalled || binding.codiumMode !== true)
    return "bind"
  // Public repositories never take platform jobs on Actions (E11); "internal" and a failed read are not private.
  if (facts.visibility !== "private") return "public"
  return "eligible"
}

function queueBlock(input: RouteInput, allowed: boolean): NoPlace["computer"] | undefined {
  // A queued job ends up running on the computer, so it needs what the laptop route needs, except being online now.
  if (!allowed) return "not-allowed"
  if (!input.laptop.perk || !input.laptop.configured) return "no-remote"
  const seen = input.laptop.lastSeen
  if (seen === undefined || !Number.isFinite(seen) || input.now - seen > COMPUTER_SEEN_MS) return "not-seen"
  if (!input.laptop.waitForComputer) return "wait-off"
  return undefined
}

function validRepository(repository: RouteInput["repository"]) {
  return (
    repository !== undefined &&
    Number.isSafeInteger(repository.id) &&
    repository.id > 0 &&
    isRepositoryName(repository.fullName)
  )
}

/**
 * Where a job goes (3.4), as one pure decision over the facts the intake gathered through its ports. The intake calls
 * it once, and when the answer is `offer`, offers the job, waits up to 20 seconds and calls it again with the same
 * facts and `offer` filled in. A claim means the laptop. A `busy` or `trigger-changed` decline, or a computer that did
 * not answer, moves on to Actions and then the queue. Lasting declines from every computer refuse at once with that
 * reason's own text.
 *
 * For a GitHub handoff (4.1) the repository's own Actions run is the fallback, so every outcome but a claim is
 * `hand-back` (`handled: false`).
 */
export function decideRoute(input: RouteInput, decisions: OwnerDecisions = OWNER_DECISIONS): RouteDecision {
  const github = input.platform === "github"
  const stop = (code: RefusalCode | DeclineCode, why?: NoPlace): RouteDecision => {
    if (github) return { action: "hand-back", code }
    return why ? { action: "refuse", code: code as RefusalCode, why } : { action: "refuse", code: code as RefusalCode }
  }

  // 1. Switches: "no-new" takes no new job, and "stop" stops everything.
  if (input.switches.everywhere !== "on" || !input.switches.platform) return stop("switched-off")

  // 2. Identity. GitHub has no links: the trigger comment's author must be the binder, by id.
  if (github) {
    const verdict = input.github
      ? mayTrigger(
          {
            route: "github-laptop-first",
            requester: { bot: input.requester.bot, githubId: input.github.actorId },
            binderGithubId: input.github.binderId,
          },
          decisions,
        )
      : ({ ok: false, code: "not-allowed" } as const)
    if (!verdict.ok) return stop(verdict.code)
  } else {
    const identity = identityRefusal(input.requester)
    if (identity) return stop(identity)
  }

  // 3. Plan, the sponsor's allowance and the server caps.
  if (!input.inPlan) return stop("not-in-plan")
  const base = { requester: input.requester, sponsor: input.sponsor, allow: input.allow }
  const onComputer = github || mayTrigger({ route: "laptop", ...base }, decisions).ok
  const onActions = !github && mayTrigger({ route: "actions", ...base }, decisions).ok
  if (!onComputer && !onActions) return stop("not-allowed")
  if (overLimit(input.counts)) return stop("over-limit")

  // 4. The repository.
  if (!validRepository(input.repository)) return github ? stop("unsupported") : { action: "ask-repository" }

  // 5. The laptop, then 5a. the offer window.
  const laptop =
    onComputer &&
    input.switches.remote === "on" &&
    input.laptop.configured &&
    input.laptop.perk &&
    input.laptop.online
  if (laptop) {
    if (!input.offer) return { action: "offer" }
    if (input.offer.claimed) return { action: "laptop" }
    const lasting = everyDeclineLasting(input.offer)
    if (lasting) return stop(lasting)
  }

  if (github) {
    if (!laptop) return stop("no-place")
    return stop(input.offer?.declines.includes("trigger-changed") ? "trigger-changed" : "busy")
  }

  // 6. Actions.
  const actions = actionsState(input, onActions)
  if (actions === "eligible") return { action: "actions" }

  // 7. The queue, then the refusal that names the reason.
  const until = queueDeadline(input.platform, input.receivedAt)
  const computer = queueBlock(input, onComputer)
  if (!computer) return { action: "queue", until }
  return stop("no-place", { computer, actions })
}

// ---------------------------------------------------------------------------------------------------------------------
// Text: secrets
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Token prefixes and private-key headers (3.7, 3.5 step 8). A summary that matches one is withheld whole, and the
 * desktop's staged-diff scan uses the same list. None of them has the `g` flag, so `test` holds no state.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[0-9]+-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  // Provider keys ("sk-…", "sk-ant-…", "sk-proj-…"): at least 20 characters with a digit, so "sk-learn-…" is no key.
  /\bsk-(?=[A-Za-z0-9_-]{20,})(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}/,
  /\bATATT[A-Za-z0-9_=-]{20,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  // Vector's own tokens: CLI, desktop, run, hosted and ticket.
  /\bv(?:ct|dg|rt|ht|tk)_[A-Za-z0-9._-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // Incoming webhooks: the URL is the credential.
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/i,
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/i,
  // A password inside an address ("postgres://app:S3cret@db").
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s:/@]+:[^\s/@]{3,}@[^\s]+/i,
]

/** Whether `text` holds something that looks like a credential, even when it is hidden with entities or zero widths. */
export function secretLike(text: string): boolean {
  const clean = normalizeText(text)
  return SECRET_PATTERNS.some((pattern) => pattern.test(clean) || pattern.test(text))
}

// ---------------------------------------------------------------------------------------------------------------------
// Text: making a reply safe to post (3.7)
// ---------------------------------------------------------------------------------------------------------------------

/** Where a reply is going and how long it may be. */
export type ReplyContext = {
  readonly platform: PlatformId
  /** The job's repository: github.com links stay only when they point into it. */
  readonly repository?: string
  /** Defaults to the summary limit, 1,500 characters. */
  readonly maxChars?: number
}

export type SanitizedReply = {
  /** Plain Markdown, not yet written for a platform: pass it to `formatText` (the renderers do). */
  readonly text: string
  readonly withheld?: "secret" | "code"
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  colon: ":",
  sol: "/",
  bsol: "\\",
  period: ".",
  num: "#",
  excl: "!",
  grave: "`",
  lsqb: "[",
  rsqb: "]",
  lbrack: "[",
  rbrack: "]",
  lpar: "(",
  rpar: ")",
  ast: "*",
  lowbar: "_",
  vert: "|",
  verbar: "|",
  tilde: "~",
  hyphen: "-",
}

function decodeEntity(match: string, body: string) {
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ""
    return String.fromCodePoint(code)
  }
  return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match
}

/**
 * The text as a reader sees it: entities decoded (until none is left, so `&amp;lt;` cannot come back later), line
 * ends unified, and control, zero-width, soft-hyphen and direction characters removed, so nothing can hide a mention,
 * a link or a token from the checks below.
 */
function normalizeText(text: string) {
  let out = text
  for (let round = 0; round < 8; round++) {
    const next = out.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,7});/g, decodeEntity)
    if (next === out) break
    out = next
  }
  return out
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u0084\u0086-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, "")
    .normalize("NFC")
}

const PROFILE_PATH = /^\/[^/]+\/profiles?\//i

function repositoryPage(pathname: string, repository: string | undefined) {
  if (!isRepositoryName(repository)) return false
  const prefix = `/${repository.toLowerCase()}`
  const path = pathname.toLowerCase()
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * The link as it may be posted, or undefined when its host is not allowed: https only, with no user, password or
 * port, on github.com pages of the job's own repository, the platform's own host or vectordev.ai (3.7). Linear profile
 * links are mentions, so they never stay.
 */
function allowedLink(raw: string, context: ReplyContext): string | undefined {
  if (raw.length > LIMITS.urlChars) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return undefined
  const host = url.hostname.toLowerCase()
  const allowed = (() => {
    if (host === "vectordev.ai" || host === "www.vectordev.ai") return true
    if (host === "github.com") return repositoryPage(url.pathname, context.repository)
    switch (context.platform) {
      case "slack":
        return host === "slack.com" || host.endsWith(".slack.com")
      case "linear":
        return host === "linear.app" && !PROFILE_PATH.test(url.pathname)
      case "jira":
        return host.endsWith(".atlassian.net") && host.length > ".atlassian.net".length
      case "github":
        return false
    }
  })()
  // Markdown and Slack links end at these characters, so a link that holds one is never kept.
  if (!allowed || /[\s<>()|[\]`"']/.test(url.href)) return undefined
  return url.href
}

/** Source-file extensions: a name like `README.md` or `setup.py` is a file, not a site, so it is kept as code. */
const FILE_EXTENSIONS = new Set(
  (
    "md mdx txt rst adoc ts tsx mts cts js jsx mjs cjs json jsonc json5 yml yaml toml lock ini cfg conf env " +
    "py pyi rb rs go java kt kts scala swift m mm c h cc cpp cxx hpp hh cs fs php pl pm lua r jl dart ex exs erl " +
    "hs ml mli clj zig nim sh bash zsh fish ps1 bat cmd sql graphql gql proto prisma html htm css scss sass less " +
    "vue svelte astro xml svg png jpg jpeg gif webp ico pdf csv tsv log patch diff snap map wasm gradle sum mod " +
    "tf tfvars hcl nix dockerfile makefile gitignore editorconfig"
  ).split(" "),
)

const SCHEME_URL = String.raw`\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'\x60]+`
const WWW_URL = String.raw`(?<![\w.-])www\.[^\s<>"'\x60]+`
const EMAIL = String.raw`(?<![\w.+-])[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+`
const DOMAIN =
  String.raw`(?<![\w@./:-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[0-9]{1,5})?` +
  String.raw`(?:\/[^\s<>"'\x60]*)?(?![\w-])`
const MENTION = String.raw`(?<![\w\x60@./+-])@[a-z0-9][a-z0-9-]{0,38}(?:\/(?:[a-z0-9_.-]{0,99}[a-z0-9_-]))?(?![\w-])`

/** Links, addresses, domains and mentions in plain text: one pass, so nothing is matched twice. */
const PLAIN = new RegExp(`(${SCHEME_URL})|(${WWW_URL})|(${EMAIL})|(${DOMAIN})|(${MENTION})`, "gi")
const URLS = new RegExp(`(${SCHEME_URL})|(${WWW_URL})`, "gi")
const TRAILING = /[.,;:!?'")\]}*_~]+$/

/** Splits trailing sentence punctuation off a link, as Markdown autolinks do, so it stays in the text. */
function splitTrailing(value: string): [string, string] {
  const trailing = TRAILING.exec(value)?.[0] ?? ""
  return [value.slice(0, value.length - trailing.length), trailing]
}

function cleanUrl(match: string, www: boolean, context: ReplyContext) {
  const [link, trailing] = splitTrailing(match)
  const kept = allowedLink(www ? `https://${link}` : link, context)
  if (!kept) return trailing
  return (www ? link : kept) + trailing
}

function cleanDomain(match: string, context: ReplyContext, call: boolean) {
  const [token, trailing] = splitTrailing(match)
  if (allowedLink(`https://${token}`, context)) return token + trailing
  const label = token.slice(token.lastIndexOf(".") + 1).toLowerCase()
  // A file name ("README.md") or a method call ("config.load()") is code, not a site.
  if (!/[/:]/.test(token) && (FILE_EXTENSIONS.has(label) || (call && trailing === ""))) return `\`${token}\`${trailing}`
  return trailing
}

/** Plain text, outside code and links: foreign links, addresses and domains go, files become code, mentions code. */
function cleanPlain(value: string, context: ReplyContext) {
  return value.replace(PLAIN, (match, scheme, www, email, domain, mention, offset: number) => {
    if (scheme) return cleanUrl(match, false, context)
    if (www) return cleanUrl(match, true, context)
    if (email) return ""
    if (domain) return cleanDomain(match, context, value.charAt(offset + match.length) === "(")
    if (mention) return `\`${match}\``
    return match
  })
}

/** Inline code is never a link, but a foreign address inside it still goes. */
function cleanCode(value: string, context: ReplyContext) {
  const kept = value
    .replace(URLS, (match, scheme) => cleanUrl(match, !scheme, context))
    .replace(/`/g, "")
    .trim()
  return kept === "" ? "" : `\`${kept}\``
}

const MARKDOWN_LINK =
  /\[([^\]\n]*)\]\(\s*<?([^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const SLACK_LINK = /<((?:https?|mailto|ftp|[a-z][a-z0-9+.-]{1,15}):[^|>\s]*)(?:\|([^>\n]*))?>/gi
const JIRA_LINK = /\[([^\]|\n]+)\|([^\]\n]+)\]/g
const JIRA_IMAGE = /!(?:[a-z][a-z0-9+.-]*:\/\/[^\s!|]+|[^\s!|]+\.[A-Za-z0-9]{2,5})(?:\|[^!\n]*)?!/gi

function keepLink(url: string, label: string | undefined, context: ReplyContext) {
  const kept = allowedLink(url.trim(), context)
  const text = (label ?? "").replace(/[[\]|]/g, "").trim()
  if (!kept) return text
  return `[${text === "" ? kept : text}](${kept})`
}

/** Markup that can reach a reader's screen or another host: mentions, images, foreign links and HTML. */
function stripMarkup(text: string, context: ReplyContext) {
  return (
    text
      // HTML comments, a forged `<!-- vector:job … -->` marker among them.
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      // Slack user and group mentions, channel links and broadcasts: <@U…>, <!here>, <!channel>, <!subteam^…>, <#C…>.
      .replace(/<[@#!][^>\n]*>/g, "")
      // Jira mentions: [~accountid:…] and [~name].
      .replace(/\[~[^\]\n]*\]/g, "")
      // Images: Markdown, reference-style and Jira.
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
      .replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, "")
      .replace(JIRA_IMAGE, "")
      // Reference link definitions.
      .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, "")
      // Autolinks and Slack links: <https://…> and <https://…|label>.
      .replace(SLACK_LINK, (_match, url: string, label: string | undefined) => keepLink(url, label, context))
      // Every other HTML tag, its text kept; an unclosed tag runs to the end.
      .replace(/<\/?[A-Za-z][^>]*(?:>|$)/g, "")
      .replace(MARKDOWN_LINK, (_match, label: string, url: string) => keepLink(url, label, context))
      .replace(JIRA_LINK, (_match, label: string, url: string) => keepLink(url, label, context))
  )
}

/** Inline code and kept links; everything between them is plain text. */
const SEGMENTS = /`[^`\n]+`|\[([^\]\n]*)\]\((https:\/\/[^\s()<>]+)\)/g

type SegmentMap = {
  readonly text: (value: string) => string
  readonly code: (value: string) => string
  readonly link: (label: string, url: string) => string
}

function mapSegments(text: string, map: SegmentMap) {
  let out = ""
  let last = 0
  for (const match of text.matchAll(SEGMENTS)) {
    const index = match.index ?? 0
    out += map.text(text.slice(last, index))
    out += match[0].startsWith("`") ? map.code(match[0].slice(1, -1)) : map.link(match[1] ?? "", match[2] ?? "")
    last = index + match[0].length
  }
  return out + map.text(text.slice(last))
}

/** Applies `change` to the text outside inline code spans only. */
export function outsideCode(text: string, change: (plain: string) => string) {
  let out = ""
  let last = 0
  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    const index = match.index ?? 0
    out += change(text.slice(last, index)) + match[0]
    last = index + match[0].length
  }
  return out + change(text.slice(last))
}

/** GitHub `@name` and `@org/team` mentions (and Slack's `@here` words) wrapped in code, so they notify nobody. */
export function wrapMentions(text: string) {
  return outsideCode(text, (plain) => plain.replace(new RegExp(MENTION, "gi"), (match) => `\`${match}\``))
}

/** Punctuation a removed link or address left behind, in plain text only (code and links keep theirs). */
function tidyPunctuation(value: string) {
  return value
    .replace(/[ ]+([,.;:!?)\]])/g, "$1")
    .replace(/([(\[])[ ]+/g, "$1")
    .replace(/([,;:])(?=[.!?])/g, "")
    .replace(/([.!?]),+/g, "$1")
    .replace(/([.!?])\.+/g, "$1")
}

function tidy(text: string) {
  return mapSegments(text, {
    text: tidyPunctuation,
    code: (value) => `\`${value}\``,
    link: (label, url) => `[${label}](${url})`,
  })
    .replace(/(^|\s)\(\s*\)/g, "$1")
    .replace(/(^|\s)\[\s*\]/g, "$1")
    .replace(/(\S)[ ]{2,}/g, "$1 ")
    .replace(/[ ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Whole code spans, kept links, runs of space and words: a cut never splits one, so it never leaves half a link. */
const CUT_TOKENS = /`[^`\n]+`|\[[^\]\n]*\]\(https:\/\/[^\s()<>]+\)|\s+|[^\s`[]+|[`[]/g

function cut(text: string, max: number) {
  if (text.length <= max) return text
  let out = ""
  for (const match of text.matchAll(CUT_TOKENS)) {
    if (out.length + match[0].length > max - 1) break
    out += match[0]
  }
  return `${out.trimEnd()}…`
}

/**
 * Makes model or platform text safe to post (3.7). The whole summary is withheld, with a fixed text, when it looks
 * like a secret or holds code (a fence or a diff). Otherwise every mention and broadcast form is removed or wrapped in
 * code (Slack `<@…>`, `<!here>`, `<!channel>`, `<!subteam…>`; Jira `[~…]`; Linear profile links; GitHub `@name`), as
 * are images (Markdown, HTML, Jira), HTML, autolinks, bare URLs, e-mail addresses and bare domains outside the allowed
 * hosts, so no image proxy or unfurl reaches another host. A name like `README.md` stays, as code. The result is cut
 * to `maxChars` on a word, link or code boundary.
 *
 * The answer is plain Markdown for `formatText`. Sanitizing it again changes nothing, so the computer and the server
 * can both run it.
 */
export function sanitizeReply(text: string, context: ReplyContext): SanitizedReply {
  const max = Math.max(1, Math.min(Math.floor(context.maxChars ?? LIMITS.summaryChars), LIMITS.replyChars))
  const clean = normalizeText(text)
  if (secretLike(clean)) return { text: WITHHELD.secret, withheld: "secret" }
  if (looksLikeCode(clean)) return { text: WITHHELD.code, withheld: "code" }
  const stripped = stripMarkup(clean, context)
  const out = mapSegments(stripped, {
    text: (value) => cleanPlain(value, context),
    code: (value) => cleanCode(value, context),
    link: (label, url) => {
      const kept = allowedLink(url, context)
      const words = cleanPlain(label, context).trim()
      if (!kept) return words
      return `[${words === "" ? "link" : words}](${kept})`
    },
  })
  return { text: cut(tidy(out), max) }
}

/** The words of a title: no link, address, mention, reference or markup survives, only letters, digits and `._'’,-`. */
export function titleWords(text: string, max = 60) {
  const words = normalizeText(text)
    .replace(PLAIN, (match, scheme, www, email, domain) => {
      if (scheme || www || email) return " "
      if (domain) {
        const token = splitTrailing(match)[0]
        const label = token.slice(token.lastIndexOf(".") + 1).toLowerCase()
        return !/[/:]/.test(token) && FILE_EXTENSIONS.has(label) ? match : " "
      }
      return match
    })
    .replace(/[^\p{L}\p{M}\p{N}\s._'’,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (words.length <= max) return words
  const space = words.lastIndexOf(" ", max)
  if (space > 0) return words.slice(0, space).trim()
  let out = ""
  for (const character of words) {
    if (out.length + character.length > max) break
    out += character
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Text: writing for each platform
// ---------------------------------------------------------------------------------------------------------------------

/** Slack's own escaping for mrkdwn text: `&`, `<` and `>`, and nothing else. */
export function escapeSlack(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** The inverse of `escapeSlack`, in one pass, so `unescapeSlack(escapeSlack(text)) === text` for every text. */
export function unescapeSlack(text: string) {
  return text.replace(/&(amp|lt|gt);/g, (_match, name: string) => (name === "amp" ? "&" : name === "lt" ? "<" : ">"))
}

/**
 * Writes Markdown from this module (a sanitized reply or a fixed text) for a platform: unchanged for GitHub and Linear,
 * Slack mrkdwn (escaped, `<url|label>` links, `*bold*`), or Jira plain text (`label (url)`, no emphasis marks).
 */
export function formatText(text: string, format: ReplyFormat) {
  if (format === "markdown") return text
  const slack = format === "slack"
  return mapSegments(text, {
    text: (value) =>
      slack
        ? escapeSlack(value)
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/__([^_\n]+)__/g, "_$1_")
            .replace(/^#{1,6} +(.+)$/gm, "*$1*")
        : value
            .replace(/\*\*([^*\n]+)\*\*/g, "$1")
            .replace(/__([^_\n]+)__/g, "$1")
            .replace(/^#{1,6} +/gm, ""),
    code: (value) => `\`${slack ? escapeSlack(value) : value}\``,
    link: (label, url) => {
      if (slack) return `<${escapeSlack(url)}|${escapeSlack(label).replace(/\|/g, "/")}>`
      return label === "" || label === url ? url : `${label} (${url})`
    },
  })
}

function format(platform: PlatformId) {
  return REPLY_FORMAT[platform]
}

// ---------------------------------------------------------------------------------------------------------------------
// Progress (3.10)
// ---------------------------------------------------------------------------------------------------------------------

/** Route steps the server reports before any milestone (3.10). */
export const ROUTE_NOTES = ["received", "finding", "laptop", "actions", "waiting"] as const
export type RouteNote = (typeof ROUTE_NOTES)[number]

const STEP_TEXT: Readonly<Record<Milestone | RouteNote, string>> = {
  received: "On it.",
  finding: "Finding your computer",
  laptop: "Running on your computer",
  actions: "Running in GitHub Actions",
  waiting: "Waiting for your computer",
  started: "Started",
  reading: "Reading the code",
  editing: "Editing files",
  testing: "Running checks",
  pushing: "Pushing the branch",
  heartbeat: "Still working",
}

/** The fixed text of a milestone or route step, with a file count at most: no model text appears before the result. */
export function renderMilestone(
  step: Milestone | RouteNote,
  options: { readonly platform: PlatformId; readonly files?: number },
) {
  if (!Object.prototype.hasOwnProperty.call(STEP_TEXT, step)) throw new RangeError("Unknown milestone.")
  let text = STEP_TEXT[step]
  const files = options.files
  if (step === "editing" && typeof files === "number" && Number.isSafeInteger(files) && files > 0)
    text += ` (${files} ${files === 1 ? "file" : "files"})`
  return formatText(text, format(options.platform))
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusals and help
// ---------------------------------------------------------------------------------------------------------------------

export type RefusalOptions = {
  readonly platform: PlatformId
  /** The job's repository; named only in a private place. */
  readonly repository?: string
  /** The reply goes to a shared place, so no repository name is written. */
  readonly shared?: boolean
  /** For `no-place`: what blocked each route. */
  readonly why?: NoPlace
}

const SETTINGS = "Settings → Vector everywhere"

function repositoryRef(options: { readonly repository?: string; readonly shared?: boolean }) {
  if (options.shared || !isRepositoryName(options.repository)) return "this repository"
  return `\`${options.repository}\``
}

const NO_PLACE_COMPUTER: Readonly<Record<NoPlace["computer"], string>> = {
  "not-seen": "Your computer has not connected in 30 days.",
  "wait-off": 'Your computer is offline, and "Wait for my computer" is off.',
  "not-allowed": "Requests from teammates never run on someone else's computer.",
  "no-remote": "Vector Remote is not set up for this account, so no computer can take jobs.",
}

const NO_PLACE_ACTIONS: Readonly<Record<NoPlace["actions"], string>> = {
  none: "",
  bind: " Turn your computer on, or bind this repository for GitHub Actions.",
  public: " This repository is not private, so it cannot run in GitHub Actions.",
}

/** One fixed text per refusal and decline code (3.4, 3.8, 4.1). */
export function renderRefusal(code: RefusalCode | DeclineCode, options: RefusalOptions): string {
  const repository = repositoryRef(options)
  const texts: Readonly<Record<RefusalCode | DeclineCode, () => string>> = {
    "switched-off": () => "Vector is paused here.",
    "not-linked": () => `Link your account at ${EVERYWHERE_PAGE}.`,
    external: () => "Vector takes requests only from members of this workspace.",
    guest: () => "Vector does not take requests from guests.",
    bot: () => "Vector does not take requests from bots.",
    automation: () => "Vector takes requests only from people, not automations.",
    "not-connected": () =>
      options.platform === "jira"
        ? `A Jira admin connects this site at ${EVERYWHERE_PAGE}.`
        : `Vector is not connected here yet. Connect it at ${EVERYWHERE_PAGE}.`,
    "shared-place": () =>
      `Link codes work only in a direct message to Vector. That code no longer works; get a new one at ${EVERYWHERE_PAGE}.`,
    "link-invalid": () => `That link code is not valid or has expired. Get a new one at ${EVERYWHERE_PAGE}.`,
    "not-in-plan": () => "Vector everywhere is not part of your plan.",
    "not-allowed": () => "Vector runs here only for the account owner's own requests.",
    "over-limit": () => "You have reached the limit for Vector everywhere jobs for now. Try again later.",
    "no-place": () => {
      const why = options.why ?? { computer: "not-seen", actions: "none" }
      return `${NO_PLACE_COMPUTER[why.computer] ?? NO_PLACE_COMPUTER["not-seen"]}${NO_PLACE_ACTIONS[why.actions] ?? ""}`
    },
    "public-repository": () => "This repository is not private, so its requests never run in GitHub Actions.",
    "not-mapped": () => `Your computer is online, but ${repository} is not an allowed project (${SETTINGS}).`,
    "local-mode": () => "Your computer is online, but Vector Local is on, so it takes no jobs.",
    off: () => `Your computer is online, but "This computer takes jobs" is off (${SETTINGS}).`,
    "model-not-allowed": () =>
      `Your computer is online, but its model for jobs is a free model that may train on what it reads. Choose another model in ${SETTINGS}.`,
    unsupported: () => "Vector does not take this kind of request here.",
    busy: () => "Your computer is busy with other jobs.",
    "trigger-changed": () => "The comment changed after it asked for the run, so your computer did not take it.",
  }
  const text = Object.prototype.hasOwnProperty.call(texts, code) ? texts[code]() : texts.unsupported()
  return formatText(text, format(options.platform))
}

const HELP: Readonly<Record<PlatformId, readonly string[]>> = {
  slack: [
    "Mention Vector with what to change. It runs on your computer (or in GitHub Actions) and opens a draft pull request.",
    "Words after the mention:",
    "- `help`: this text",
    "- `link <code>`: link your Vector account (only in a direct message to Vector)",
    "- `unlink`: remove the link",
    "- `status`: check that your computer is ready",
    "- `stop`: stop the job running here",
    "- `repo <owner/name>`: set the repository for this channel",
  ],
  linear: [
    "Delegate an issue to Vector, or mention it, to have it work on the issue. It runs on your computer (or in GitHub Actions) and opens a draft pull request.",
    "Words after the mention:",
    "- `help`: this text",
    "- `unlink`: remove the link",
    "- `status`: check that your computer is ready",
    "- `stop`: stop the job",
    "Repositories for each team are set on vectordev.ai/everywhere.",
  ],
  jira: [
    "Assign a work item to Vector, or mention it in a comment, to have it work on the item. It runs on your computer and opens a draft pull request.",
    "Words after the mention:",
    "- `help`: this text",
    "- `link <code>`: link your Vector account (only in Rovo chat with Vector)",
    "- `unlink`: remove the link",
    "- `status`: check that your computer is ready",
    "- `stop`: stop the job",
    "Repositories for each project are set on vectordev.ai/everywhere.",
  ],
  github: [
    "Mention Vector in an issue or pull request comment. Mentions from the person who bound this repository can run on their computer; everyone else's run in this repository's GitHub Actions.",
  ],
}

/** The fixed usage text `help` answers privately (3.1). */
export function renderHelp(platform: PlatformId) {
  const lines = [...HELP[platform], `Link your account at ${EVERYWHERE_PAGE}.`]
  return formatText(lines.join("\n"), format(platform))
}

// ---------------------------------------------------------------------------------------------------------------------
// Results (3.7)
// ---------------------------------------------------------------------------------------------------------------------

export type ResultInput = {
  readonly platform: PlatformId
  readonly route: "laptop" | "actions"
  readonly outcome: Outcome
  /** The destination is a shared place: only the outcome and the PR link are posted there (E17). */
  readonly shared: boolean
  /** The job's repository: the PR link must point into it. Never written as a name. */
  readonly repository: string
  readonly summary?: string
  readonly prUrl?: string
  readonly branch?: string
  /** Files held back under `.github/`, `.husky/`, `.githooks/`, `.gitattributes` or `.gitmodules`. */
  readonly held?: number
  /** "skipped": the commit carries `[skip ci]`. Actions runs never start checks on their PRs (INV-S18). */
  readonly checks?: "skipped"
  /** Permission ids a `needs-approval` run asked for. */
  readonly needs?: readonly string[]
  /** The computer's name; written in private replies only. */
  readonly computer?: string
  readonly maxChars?: number
}

export type RenderedResult = {
  /** What goes to the place the request came from. */
  readonly text: string
  /** In a shared place: the full result, sent privately (Slack ephemeral, the agent DM or the job page). */
  readonly privateText?: string
}

const CHECKS_LINE = "Checks have not run on this pull request yet: push a commit to the branch to start them."

const OUTCOME_LINE: Readonly<Record<Outcome, (where: string) => string>> = {
  changes: (where) => `Done ${where}.`,
  "no-changes": (where) => `Finished ${where} with no changes.`,
  failed: (where) => `The run ${where} failed.`,
  refused: (where) => `The run ${where} ended without doing the task.`,
  "needs-approval": (where) =>
    `The run ${where} stopped: it needed an approval, and nobody can approve during these runs.`,
  "over-budget": (where) => `The run ${where} stopped at its spending cap.`,
  cancelled: (where) => `The run ${where} was cancelled.`,
  interrupted: (where) => `The run ${where} was interrupted when the app restarted. Ask again to retry.`,
  held: (where) => `Finished ${where}. The changes were kept on the computer for review.`,
  expired: () => "This request expired before a computer took it.",
}

function prLink(input: ResultInput) {
  const url = input.prUrl
  if (url === undefined || !PR_URL_PATTERN.test(url)) return undefined
  const repository = PR_URL_PATTERN.exec(url)?.[1] ?? ""
  if (!isRepositoryName(input.repository) || repository.toLowerCase() !== input.repository.toLowerCase())
    return undefined
  return `[Draft pull request](${url})`
}

/**
 * The result message (3.7): the outcome in plain words, where it ran, and the draft PR link. A private reply adds the
 * computer's name, the summary (sanitized again), the branch when there is no PR, the held-back count, that checks
 * have not run, and the permissions a `needs-approval` run needed. No costs or token counts. In a shared place `text`
 * carries only the outcome and the link, says "on your computer", and the rest is `privateText`.
 */
export function renderResult(input: ResultInput): RenderedResult {
  const kind = format(input.platform)
  const link = prLink(input)
  const lineFor = OUTCOME_LINE[input.outcome] ?? OUTCOME_LINE.failed
  const place = input.route === "actions" ? "in GitHub Actions" : "on your computer"

  const shared = [lineFor(place), ...(link ? [link] : [])].join("\n")

  const name = input.computer === undefined ? "" : sanitizeLabel(input.computer)
  const privatePlace = input.route === "laptop" && name !== "" && name !== "Requester" ? `${place} (${name})` : place
  const lines = [lineFor(privatePlace)]
  if (input.summary !== undefined && input.summary.trim() !== "") {
    const summary = sanitizeReply(input.summary, {
      platform: input.platform,
      repository: input.repository,
      maxChars: Math.min(input.maxChars ?? LIMITS.summaryChars, LIMITS.summaryChars),
    })
    if (summary.text !== "") lines.push("", summary.text)
  }
  const details: string[] = []
  if (link) details.push(link)
  else if (input.branch !== undefined && BRANCH_PATTERN.test(input.branch))
    details.push(`The changes are on the branch \`${input.branch}\`.`)
  const held = input.held
  if (typeof held === "number" && Number.isSafeInteger(held) && held > 0)
    details.push(
      `${held} ${held === 1 ? "file" : "files"} under .github/, .husky/, .githooks/, .gitattributes or .gitmodules ${held === 1 ? "was" : "were"} held back and not committed.`,
    )
  const reviewable = link !== undefined || (input.branch !== undefined && BRANCH_PATTERN.test(input.branch))
  if (reviewable && (input.route === "actions" || input.checks === "skipped")) details.push(CHECKS_LINE)
  if (input.outcome === "needs-approval") {
    const needs = (input.needs ?? []).filter((id) => PERMISSION_ID_PATTERN.test(id)).slice(0, LIMITS.needs)
    if (needs.length > 0) details.push(`It needed: ${needs.map((id) => `\`${id}\``).join(", ")}.`)
  }
  if (details.length > 0) lines.push("", ...details)
  const full = lines.join("\n")

  if (input.shared) return { text: formatText(shared, kind), privateText: formatText(full, kind) }
  return { text: formatText(full, kind) }
}

/** How a job ended without a result from its computer or run (3.4, 4.4). */
export const ENDINGS = ["lost", "expired", "not-started", "jira-running", "jira-waiting"] as const
export type Ending = (typeof ENDINGS)[number]

const ENDING_TEXT: Readonly<Record<Ending, string>> = {
  lost: "Your computer stopped answering during this job, so it was ended. Ask again to retry.",
  expired: "Your computer did not pick this up in time. Ask again when it is on.",
  "not-started": "GitHub Actions did not start; check the workflow uses Codium.",
  "jira-running": "Still running on your computer; the draft pull request will appear on GitHub.",
  "jira-waiting": "Your computer did not pick this up in time; assign it again when it is on.",
}

/** The fixed reply for a job that ended without a result. */
export function renderEnd(ending: Ending, platform: PlatformId) {
  if (!Object.prototype.hasOwnProperty.call(ENDING_TEXT, ending)) throw new RangeError("Unknown ending.")
  return formatText(ENDING_TEXT[ending], format(platform))
}
