import { Everywhere } from "@vectordevai/schema/everywhere"

/*
 * The signed-in account's Vector everywhere controls on vectordev.ai (VE-42, contract 3.8 and 3.12): installations
 * with disconnect, links with unlink, link codes, the Jira connect code, the start of the Slack and Linear installs and
 * of the Linear sign-in link, the repositories set for each place, the OAuth landing that finishes an install or a
 * link, and (with `activity`) the account's jobs and audit log. It talks only to the account routes
 * (api/everywhere/{installs,links,link,repos,oauth-finish,history,audit}) with the session's bearer token, never a
 * cookie.
 *
 * No framework, Supabase or DOM import: the React views only render `state()`. Answers from another account's session,
 * or sent with a token the server has since refused, are dropped by `generation`, so a code or a list is only ever
 * shown to the account that asked for it, and a late 401 cannot undo a renewed sign-in. Codes, the Jira connect code
 * and an OAuth return's code travel only in JSON bodies; the only query parameter is `installation` on GET repos, a
 * workspace id the account connected. An OAuth return is held in memory only, never in a state the page renders, and
 * sent at most once.
 */

/** Every route the page calls. oauth-finish takes an OAuth return's `{code, state}`; history and audit are reads. */
export const EVERYWHERE_ROUTES = {
  installs: "/api/everywhere/installs",
  links: "/api/everywhere/links",
  link: "/api/everywhere/link",
  repos: "/api/everywhere/repos",
  oauthFinish: "/api/everywhere/oauth-finish",
  history: "/api/everywhere/history",
  audit: "/api/everywhere/audit",
} as const

/** The only places a Connect or Link button navigates to (identity.ts `OAUTH`). */
export const EVERYWHERE_AUTHORIZE = {
  slack: "https://slack.com/oauth/v2/authorize",
  linear: "https://linear.app/oauth/authorize",
} as const

/** A link code as the route shows it: 8 letters of identity.ts `CODE_ALPHABET`, in two groups of four. */
export const LINK_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
/** How long a link code works (keys.ts `KEEP_MS.linkCode`). The page clears it this long after it arrived. */
export const LINK_CODE_MS = 600_000

export const EVERYWHERE_PLATFORMS = ["slack", "linear", "jira"] as const
export type EverywherePlatform = (typeof EVERYWHERE_PLATFORMS)[number]

/** Platform user ids as the server checks them (keys.ts `USER_ID_PATTERNS`). */
export const LINK_USER_ID_PATTERNS: Readonly<Record<EverywherePlatform, RegExp>> = {
  slack: /^[A-Z0-9]{2,32}$/,
  linear: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  jira: /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64})?$/,
}
/** GitHub user ids, for audit entries (keys.ts `USER_ID_PATTERNS.github`). */
export const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,15}$/
/** A Slack channel, a Linear team id or a Jira key (identity.ts `PLACE_PATTERN`). */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** An OAuth state id (keys.ts `STATE_ID`) and a platform's OAuth code (identity.ts `OAUTH_CODE`). */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
export const OAUTH_CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/
/** The most jobs and audit entries the routes answer (account-api.ts `HISTORY_LIMIT`, `AUDIT_PAGE`). */
export const JOBS_LIMIT = 100
export const AUDIT_LIMIT = 100
/** How a job ended without a result (everywhere-policy.ts `ENDINGS`). */
export const JOB_ENDINGS = ["lost", "expired", "not-started", "jira-running", "jira-waiting"] as const
/** The audit log's events (audit.ts `AUDIT_EVENTS`). */
export const EVERYWHERE_AUDIT_EVENTS = [
  "install",
  "uninstall",
  "connect",
  "disconnect",
  "connector-change",
  "link",
  "unlink",
  "job-accepted",
  "job-refused",
  "route",
  "offer",
  "claim",
  "decline",
  "settle",
  "post",
  "erase",
] as const
/** Audit codes beyond the job words: why something was erased, and an admin's re-install (audit.ts `AUDIT_CODES`). */
export const AUDIT_EXTRA_CODES = [
  "uninstalled",
  "tokens-revoked",
  "revoked",
  "disconnected",
  "account-deleted",
  "unlinked",
  "admin",
] as const
const JOB_ROUTES = ["laptop", "actions", "queue"] as const
const JOB_CODES: readonly string[] = [...Everywhere.REFUSAL_CODES, ...Everywhere.DECLINE_CODES]
/** Every code an audit entry may carry (audit.ts `AUDIT_CODES`). */
export const EVERYWHERE_AUDIT_CODES: ReadonlySet<string> = new Set<string>([
  ...JOB_CODES,
  ...Everywhere.OUTCOMES,
  ...Everywhere.ROUTES,
  ...Everywhere.JOB_STATES,
  ...JOB_ENDINGS,
  ...AUDIT_EXTRA_CODES,
])
const AUDIT_ENTRY_ID = /^[0-9a-z]{26}$/
/** A masked email (identity.ts `maskEmail`): its first letter, then the domain. */
const HINT_PATTERN = /^\S•••@[^\s@]+\.[^\s@]+$/u
const JOB_FIELDS = new Set([
  "jid",
  "platform",
  "installation",
  "state",
  "route",
  "outcome",
  "code",
  "ending",
  "repository",
  "issue",
  "shared",
  "receivedAt",
  "endedAt",
  "prUrl",
  "summary",
])
const AUDIT_FIELDS = new Set(["id", "at", "event", "platform", "installation", "jid", "code", "userId", "byOther"])
const SCOPE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_INSTALLS = 200
const MAX_LINKS = 500
const MAX_MAPPINGS = 500

export const PLATFORM_NAMES: Readonly<Record<Everywhere.PlatformId, string>> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  jira: "Jira",
}

type JobRoute = (typeof JOB_ROUTES)[number]
type AuditEvent = (typeof EVERYWHERE_AUDIT_EVENTS)[number]
type OAuthPlatform = "slack" | "linear"

/** Every text the page shows: facts only, and never a server's own message. */
export const EVERYWHERE_COPY = {
  loading: "Loading…",
  signIn: "Sign in to see your Vector everywhere connections and links.",
  signInButton: "Sign in",
  expired: "Your session expired. Sign in again to continue.",
  expiredButton: "Sign in again",
  accountsUnavailable: "Vector accounts are unavailable right now. Try again later.",
  off: "Vector everywhere is off.",
  retry: "Try again",
  partial: "Some entries could not be shown.",
  installsHeading: "Connections",
  installsEmpty: "No workspace or site is connected from this account.",
  connectSlack: "Connect Slack",
  connectLinear: "Connect Linear",
  jiraLabel: "Jira connect code",
  jiraHint: "Paste the connect code Vector gave a site admin in Jira.",
  connectJira: "Connect Jira",
  disconnect: "Disconnect",
  disconnectConfirm:
    "Disconnecting removes this installation, its links and repository mappings, and the text of its live jobs.",
  keep: "Keep",
  retryDisconnect: "Disconnecting did not finish. Disconnect again to finish it.",
  reviewRevocation:
    "Vector could not confirm that the platform removed its access. Check the app in that workspace or site, and remove it there if it is still installed.",
  linksHeading: "Links",
  linksEmpty: "No platform account is linked to this Vector account.",
  unlink: "Unlink",
  slackCode: "Get a Slack link code",
  jiraCode: "Get a Jira link code",
  linearLink: "Link with Linear sign-in",
  codeSend: "Send this message:",
  codeNote: {
    slack: "Send this only to the Vector bot in a direct message. Never give it to a person.",
    jira: "Send this only to Vector in Rovo chat. Never give it to a person.",
  },
  codeExpiry: "The code works once and expires in 10 minutes.",
  copy: "Copy",
  hide: "Hide code",
  mappingsHeading: "Repositories",
  mappingsEmpty: "No place has a repository yet.",
  mappingsUnread: "The repositories set for this connection could not be read.",
  noRepositories: "No repository is set for this place.",
  slackMappingHint: "In a Slack channel, send @Vector repo owner/name to set its repository.",
  trackerMappingHint: "Linear teams and Jira keys cannot be given repositories from this page yet.",
  unknownId: "(not verified yet)",
  removeRepository: "Remove",
  removeMapping: "Remove mapping",
  removeMappingConfirm: "Remove every repository set for this place?",
  dropRepositoryConfirm: "Remove this repository from this place?",
  remove: "Remove",
  markedPrivate: "Marked private.",
  notPrivate: "Not marked private.",
  privateNote: "Vector does not use this mark yet. It treats every Linear team and Jira key as a shared place.",
  jobsHeading: "Jobs",
  jobsNote: "Jobs from the last 30 days, newest first.",
  jobsEmpty: "No job in the last 30 days.",
  jobsCapped: "Only the 100 newest are shown.",
  jobsUnread: "Your jobs could not be read.",
  sharedSummary: "This page does not show summaries of jobs in shared places.",
  pullRequest: "Pull request",
  focusMissing: "That job is not among your jobs of the last 30 days.",
  received: "Received",
  endedAt: "Ended",
  reason: "Reason:",
  ending: "Ending:",
  /** Route-neutral where a state can be on either route; only `offered`, `claimed` and `lost` are laptop states. */
  jobState: {
    received: "Received",
    offered: "Offered to your computers",
    claimed: "Taken by your computer",
    running: "Running",
    dispatched: "Sent to GitHub Actions",
    waiting: "Waiting in the queue",
    settled: "Finished",
    refused: "Refused",
    expired: "Expired",
    failed: "Failed",
    lost: "Lost",
    cancelled: "Cancelled",
  },
  jobRoute: {
    laptop: "Route: your computer",
    actions: "Route: GitHub Actions",
    queue: "Route: waiting for your computer",
  },
  jobOutcome: {
    changes: "Outcome: changes made",
    "no-changes": "Outcome: no changes",
    failed: "Outcome: failed",
    refused: "Outcome: refused",
    "needs-approval": "Outcome: needs approval",
    "over-budget": "Outcome: over budget",
    cancelled: "Outcome: cancelled",
    interrupted: "Outcome: interrupted",
    held: "Outcome: held back",
    expired: "Outcome: expired",
  },
  auditHeading: "Audit log",
  auditNote: "Entries from the last 90 days, newest first, at most 100. Each holds ids and fixed codes only.",
  auditEmpty: "No entry in the last 90 days.",
  auditUnread: "The audit log could not be read.",
  auditEvent: {
    install: "Installed",
    uninstall: "Uninstalled",
    connect: "Connected",
    disconnect: "Disconnected",
    "connector-change": "Connector changed",
    link: "Linked",
    unlink: "Unlinked",
    "job-accepted": "Job accepted",
    "job-refused": "Job refused",
    route: "Job routed",
    offer: "Job offered",
    claim: "Job taken by a computer",
    decline: "Job declined by a computer",
    settle: "Job ended",
    post: "Result posted",
    erase: "Erased",
  },
  code: "Code:",
  byOther: "by another Vector account",
  landing: {
    finishing: (platform: OAuthPlatform) => `Finishing with ${PLATFORM_NAMES[platform]}…`,
    held: "Vector could not finish this yet. If you sign in again, start again from Connect or Link afterwards.",
    installed: (label: string) => `Connected ${label}.`,
    renewed: (label: string) => `Connected ${label} again.`,
    replaced: (label: string) => `Connected ${label}, in place of the Vector account that connected it before.`,
    linked: (userId: string, label: string, hint?: string) =>
      `Linked Linear user ${userId} in ${label}${hint ? ` to the Vector account ${hint}` : ""}.`,
    already: (userId: string, label: string) => `Linear user ${userId} in ${label} was already linked to this account.`,
    problem: {
      "invalid-return": "This page was opened with an incomplete or changed sign-in. Start again from Connect or Link.",
      "signed-out": "Sign in to Vector first, then start again from Connect or Link.",
      session: "Your session ended before this finished. Start again from Connect or Link.",
      "expired-state": "This sign-in expired or was already used. Start again from Connect or Link.",
      "other-account":
        "Another Vector account started this sign-in. Start again while signed in to the account that should own it.",
      "not-verified": "The platform did not confirm this account or workspace. Start again from Connect or Link.",
      "not-connected": "That Linear workspace is not connected to Vector everywhere. Connect Linear first, then link.",
      "link-refused": "This Linear account cannot be linked.",
      "installed-elsewhere": "Another Vector account connected this workspace.",
      "wrong-place":
        "Vector was installed in a different workspace than the one this started for. Start again from Connect.",
      "not-found": "This platform is not available on Vector everywhere right now.",
      interrupted: "This page lost the answer. Check your connections and links below.",
      unavailable: "Vector could not finish this. Start again from Connect or Link.",
    },
  },
  linkPage: {
    heading: "Link your Linear account",
    intro: "Linear has no private message to an app, so you link by signing in to Linear.",
    connectedFirst: "The Linear workspace must be connected to Vector everywhere first.",
    back: "After Linear, you come back to the Vector everywhere page, where the link finishes.",
    button: "Sign in with Linear",
    listHeading: "Linked Linear accounts",
    empty: "No Linear account is linked to this Vector account.",
    signIn: "Sign in to link your Linear account.",
  },
  notice: {
    disconnected: "Disconnected. Its links, repository mappings and live job text are erased.",
    closing: "Disconnect started, but it is not finished. See the note on the connection.",
    unlinked: "Unlinked.",
    connected: "Connected.",
    saved: "Saved.",
    removed: "Removed.",
  },
  problem: {
    "not-found": "Vector could not find that, or it is not available to this account.",
    "code-invalid": "That connect code is not valid or has expired.",
    "installed-elsewhere": "Another Vector account connected this site.",
    changed: "That changed while this page was open. The page has been reloaded.",
    "not-allowed": "This account cannot do that.",
    "too-many": "Too many requests. Wait a moment and try again.",
    invalid: "Vector could not accept that. Check it and try again.",
    unavailable: "Vector everywhere could not be reached. Try again.",
  },
} as const

export type EverywhereSession = { readonly account: string; readonly token: string }
export type EverywhereInstall = {
  readonly installation: string
  readonly platform: EverywherePlatform
  readonly installedAt: number
  readonly scopes: readonly string[]
  readonly status?: "closing"
  readonly nextAction?: "retry-disconnect" | "review-native-revocation"
}
export type EverywhereLink = {
  readonly installation: string
  readonly platform: EverywherePlatform
  readonly userId: string
  readonly linkedAt: number
}
export type EverywhereRepository = { readonly fullName: string; readonly id?: number }
export type EverywhereMapping = {
  readonly place: string
  readonly repositories: readonly EverywhereRepository[]
  readonly private: boolean
  readonly setAt: number
  readonly setByYou: boolean
}
export type EverywhereLinkCode = { readonly platform: "slack" | "jira"; readonly code: string }
export type EverywhereProblem = keyof typeof EVERYWHERE_COPY.problem
export type EverywhereNotice = keyof typeof EVERYWHERE_COPY.notice
export type EverywhereConfirm =
  | { readonly action: "disconnect"; readonly installation: string }
  | { readonly action: "remove-mapping"; readonly installation: string; readonly place: string }
  | {
      readonly action: "drop-repository"
      readonly installation: string
      readonly place: string
      readonly fullName: string
    }
export type EverywhereReady = {
  readonly kind: "ready"
  /** The lists below came from the routes; until then only a problem, if any, is shown. */
  readonly loaded: boolean
  readonly installs: readonly EverywhereInstall[]
  readonly links: readonly EverywhereLink[]
  readonly mappings: Readonly<Record<string, readonly EverywhereMapping[]>>
  /** Open installations whose repositories could not be read: the page says so instead of listing none. */
  readonly unread: readonly string[]
  /** Some entries in an answer were malformed and left out; the rest keep their controls. */
  readonly partial: boolean
  readonly code?: EverywhereLinkCode | undefined
  readonly confirm?: EverywhereConfirm | undefined
  readonly busy: boolean
  readonly notice?: EverywhereNotice | undefined
  readonly problem?: EverywhereProblem | undefined
  /** The account's jobs, once GET history answered (only with `activity`). */
  readonly jobs?: readonly EverywhereJob[] | undefined
  /** The account's audit log, once GET audit answered (only with `activity`). */
  readonly audit?: readonly EverywhereAuditEntry[] | undefined
  /** Activity reads that did not answer: the page says so instead of listing none. */
  readonly activityUnread: readonly ("jobs" | "audit")[]
  /** The route had more jobs in the 30 days than it answered. */
  readonly jobsCapped: boolean
}
export type EverywhereState = (
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "session-expired" }
  | { readonly kind: "accounts-unavailable" }
  | { readonly kind: "off" }
  | EverywhereReady
) & {
  /** What became of an OAuth return this page was opened with (PUB-8); it outlives the state it started in. */
  readonly landing?: EverywhereLanding | undefined
}

/** What a Slack or Linear callback put in /everywhere's fragment (slack/install.ts, linear/install.ts). */
export type EverywhereOAuthReturn = { readonly platform: OAuthPlatform; readonly code: string; readonly state: string }
export type EverywhereLandingProblem = keyof typeof EVERYWHERE_COPY.landing.problem
export type EverywhereLanding =
  | { readonly kind: "finishing"; readonly platform: OAuthPlatform }
  | {
      readonly kind: "installed"
      readonly platform: OAuthPlatform
      readonly installation: string
      readonly change: "new" | "renewed" | "connector-change"
    }
  | {
      readonly kind: "linked"
      readonly installation: string
      readonly userId: string
      readonly already: boolean
      readonly hint?: string
    }
  | { readonly kind: "failed"; readonly problem: EverywhereLandingProblem }
export type EverywhereJob = {
  readonly jid: string
  readonly platform: Everywhere.PlatformId
  readonly installation: string
  readonly state: Everywhere.JobState
  readonly route?: JobRoute
  readonly outcome?: Everywhere.Outcome
  readonly code?: string
  readonly ending?: (typeof JOB_ENDINGS)[number]
  readonly repository: string
  readonly issue?: string
  readonly shared: boolean
  readonly receivedAt: number
  readonly endedAt?: number
  readonly prUrl?: string
  /** Only for a job in a private place: a summary on a shared job is dropped. */
  readonly summary?: string
}
export type EverywhereAuditEntry = {
  readonly id: string
  readonly at: number
  readonly event: AuditEvent
  readonly platform?: Everywhere.PlatformId
  readonly installation?: string
  readonly jid?: string
  readonly code?: string
  readonly userId?: string
  readonly byOther: boolean
}
/** The parts of `window` an OAuth return is taken from, passed in so a test can stand in for them. */
export type OAuthPlace = {
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string }
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url: string): void }
}

export type EverywhereDeps = {
  readonly request?: (path: string, init: RequestInit) => Promise<Response>
  readonly navigate?: (url: string) => void
  readonly schedule?: (ms: number, run: () => void) => () => void
  /** Ends the browser's own session (Supabase `signOut({scope: "local"})`) before a fresh sign-in. */
  readonly signOut?: () => Promise<unknown>
  /** Loads the jobs and the audit log with the lists: the /everywhere page does, the link page does not. */
  readonly activity?: boolean
}

type Answer = { readonly status: number; readonly code?: string; readonly reason?: string; readonly body?: unknown }
type Outcome = { readonly notice?: EverywhereNotice; readonly problem?: EverywhereProblem }

export type EverywhereAccountModel = ReturnType<typeof createEverywhereAccountModel>

export function createEverywhereAccountModel(deps: EverywhereDeps = {}) {
  const request = deps.request ?? ((path: string, init: RequestInit) => fetch(path, init))
  const navigate = deps.navigate ?? ((url: string) => globalThis.location.assign(url))
  const schedule =
    deps.schedule ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    })
  const listeners = new Set<() => void>()
  let current: EverywhereState = { kind: "loading" }
  let session: EverywhereSession | undefined
  // Bumped whenever the signed-in account changes or the page closes: an answer for an older generation is dropped.
  let generation = 0
  let controller = new AbortController()
  // Orders link-code requests within one account: a newer request ends the older code on the server.
  let codeSeq = 0
  let refreshSeq = 0
  let cancelExpiry: (() => void) | undefined
  let landing: EverywhereLanding | undefined
  // An OAuth return not sent yet. Never put in a state, so never rendered; taken before it is sent, so sent once.
  let pending: EverywhereOAuthReturn | undefined
  // Set when a 401 kept the return: only that account, signed in again with a new token, sends it.
  let pendingFor: string | undefined
  // A landing set before the browser's session was known (a malformed return at page open) stays for that session.
  let landingAtOpen = false

  function set(next: EverywhereState) {
    current = { ...next, landing }
    for (const listener of [...listeners]) listener()
  }

  function setLanding(next: EverywhereLanding | undefined) {
    landing = next
    landingAtOpen = false
    set(current)
  }

  /** A finished or failed landing goes when the person does something else; one still finishing stays. */
  function clearLanding() {
    if (landing && landing.kind !== "finishing") landing = undefined
    landingAtOpen = false
  }

  function patch(change: Partial<Omit<EverywhereReady, "kind">>) {
    if (current.kind === "ready") set({ ...current, ...change })
  }

  function stopExpiry() {
    cancelExpiry?.()
    cancelExpiry = undefined
  }

  function empty(): EverywhereReady {
    return {
      kind: "ready",
      loaded: false,
      installs: [],
      links: [],
      mappings: {},
      unread: [],
      partial: false,
      busy: false,
      activityUnread: [],
      jobsCapped: false,
    }
  }

  function leave(next: EverywhereState) {
    stopExpiry()
    set(next)
  }

  function send(method: string, path: string, body?: Record<string, unknown>): Promise<Answer | undefined> {
    const live = session
    if (!live) return Promise.resolve(undefined)
    const asked = generation
    const signal = controller.signal
    // Built inside the chain: a synchronous throw (a browser missing an API) ends as `status: 0`, not a stuck page.
    return Promise.resolve()
      .then(() =>
        request(path, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${live.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          // Without AbortSignal.any (older browsers) only the page's own abort applies, not the 10-second limit.
          signal:
            typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : signal,
        }),
      )
      .then((response) =>
        response
          .json()
          .catch(() => undefined)
          .then(
            (payload: unknown): Answer => ({
              status: response.status,
              code: errorCode(payload),
              reason: errorReason(payload),
              body: payload,
            }),
          ),
      )
      .catch((): Answer => ({ status: 0 }))
      .then((answer) => (asked === generation ? answer : undefined))
  }

  function refresh(): Promise<void> {
    const live = session
    if (!live) return Promise.resolve()
    const seq = ++refreshSeq
    const activity = deps.activity === true
    return Promise.all([
      send("GET", EVERYWHERE_ROUTES.installs),
      send("GET", EVERYWHERE_ROUTES.links),
      activity ? send("GET", EVERYWHERE_ROUTES.history) : Promise.resolve(undefined),
      activity ? send("GET", EVERYWHERE_ROUTES.audit) : Promise.resolve(undefined),
    ]).then(([installs, links, history, audit]) => {
      if (!installs || !links || seq !== refreshSeq) return
      if (activity && (!history || !audit)) return
      const failed = [installs, links].find((answer) => answer.status !== 200)
      // A 404 before any store read is the feature off (account-api.ts `begin`).
      if (failed?.status === 404) return leave({ kind: "off" })
      if (failed?.status === 401) return leave({ kind: "session-expired" })
      if (history?.status === 401 || audit?.status === 401) return leave({ kind: "session-expired" })
      if (failed) return patch({ problem: problemOf(failed.status, failed.code) })
      const listedInstalls = readInstalls(installs.body)
      const listedLinks = readLinks(links.body)
      if (!listedInstalls || !listedLinks) return patch({ problem: "unavailable" })
      // Either activity read may fail on its own: the lists still show, and the page names what is missing.
      const jobs = history?.status === 200 ? readJobs(history.body) : undefined
      const entries = audit?.status === 200 ? readAuditEntries(audit.body) : undefined
      const activityUnread = activity
        ? [...(jobs ? [] : ["jobs" as const]), ...(entries ? [] : ["audit" as const])]
        : []
      const open = listedInstalls.items.filter((install) => install.status === undefined)
      return Promise.all(
        open.map((install) =>
          send("GET", `${EVERYWHERE_ROUTES.repos}?${new URLSearchParams({ installation: install.installation })}`),
        ),
      ).then((answers) => {
        if (seq !== refreshSeq || answers.some((answer) => answer === undefined) || current.kind !== "ready") return
        if (answers.some((answer) => answer?.status === 401)) return leave({ kind: "session-expired" })
        const read = open.map((install, index) => {
          const answer = answers[index]!
          // 404: the installation went, or is no longer this account's, between the two reads.
          if (answer.status === 404) return { installation: install.installation, items: [], skipped: 0, unread: false }
          const mappings =
            answer.status === 200 ? readMappings(answer.body, install.installation, live.account) : undefined
          return {
            installation: install.installation,
            items: mappings?.items ?? [],
            skipped: mappings?.skipped ?? 0,
            unread: !mappings,
          }
        })
        const listed = new Set(listedInstalls.items.map((install) => install.installation))
        const confirm = current.confirm && listed.has(current.confirm.installation) ? current.confirm : undefined
        set({
          ...current,
          loaded: true,
          installs: listedInstalls.items,
          links: listedLinks.items,
          mappings: Object.fromEntries(read.map((entry) => [entry.installation, entry.items])),
          unread: read.filter((entry) => entry.unread).map((entry) => entry.installation),
          jobs: jobs?.items,
          audit: entries?.items,
          activityUnread,
          jobsCapped: jobs?.capped ?? false,
          partial:
            listedInstalls.skipped +
              listedLinks.skipped +
              read.reduce((sum, entry) => sum + entry.skipped, 0) +
              (jobs?.skipped ?? 0) +
              (entries?.skipped ?? 0) >
            0,
          // A write's problem stays beside the reloaded lists; one from a failed first load is over once they load.
          problem: current.loaded ? current.problem : undefined,
          confirm,
        })
      })
    })
  }

  /** One write at a time: the view disables every button while `busy`. */
  function act(
    run: () => Promise<Answer | undefined>,
    done: (answer: Answer) => Outcome,
    reload = true,
  ): Promise<void> {
    if (current.kind !== "ready" || current.busy) return Promise.resolve()
    clearLanding()
    patch({ busy: true, notice: undefined, problem: undefined })
    return run().then((answer) => {
      if (!answer) return
      if (answer.status === 401) return leave({ kind: "session-expired" })
      if (answer.status >= 200 && answer.status < 300) {
        const outcome = done(answer)
        patch({ busy: false, confirm: undefined, notice: outcome.notice, problem: outcome.problem })
        if (reload && !outcome.problem) return refresh()
        return
      }
      patch({ busy: false, confirm: undefined, problem: problemOf(answer.status, answer.code) })
      // Whatever was refused (gone, changed, or a disconnect that stopped part way), the lists are read again.
      if (reload) return refresh()
    })
  }

  function start(route: string, platform: "slack" | "linear") {
    return act(
      () => send("POST", route, { platform }),
      (answer) => {
        const url = readAuthorize(answer.body, platform)
        if (!url) return { problem: "unavailable" }
        navigate(url)
        return {}
      },
      false,
    )
  }

  /**
   * Sends the held OAuth return once, while every control is disabled (`busy`): the server uses its state up first,
   * so the page must not navigate away mid-POST. A 401 comes before the state is read (account-api.ts `begin`), so
   * the return is kept for the same account's renewed session; every other answer ends it.
   */
  function finish(): Promise<void> {
    const back = pending
    const live = session
    if (!back || !live || current.kind !== "ready") return Promise.resolve()
    pending = undefined
    pendingFor = undefined
    const mine: EverywhereLanding = { kind: "finishing", platform: back.platform }
    landing = mine
    patch({ busy: true, notice: undefined, problem: undefined })
    return send("POST", EVERYWHERE_ROUTES.oauthFinish, { code: back.code, state: back.state }).then((answer) => {
      if (landing !== mine) return
      // Dropped: the session changed while this was on its way, so whether it finished is not known here.
      if (!answer) return void (session && finished({ kind: "failed", problem: "interrupted" }))
      if (answer.status === 401) {
        pending = back
        pendingFor = live.account.toLowerCase()
        return leave({ kind: "session-expired" })
      }
      if (answer.status === 200)
        return finished(readFinish(answer.body, back.platform) ?? { kind: "failed", problem: "unavailable" })
      finished({ kind: "failed", problem: landingProblemOf(answer.status, answer.code, answer.reason) })
    })
  }

  function finished(next: EverywhereLanding) {
    landing = next
    landingAtOpen = false
    set(current.kind === "ready" ? { ...current, busy: false } : current)
  }

  /** The lists are read after a finish, so a new connection or link is in them. */
  function finishThenRefresh(): Promise<void> {
    return finish().then(() => (current.kind === "ready" ? refresh() : undefined))
  }

  /** What a new account or a sign-out does to the landing: a held return waits for it, or says why it cannot go. */
  function changeAccount(next: EverywhereSession | undefined) {
    if (pending && !next) return dropReturn("signed-out")
    // A return a 401 kept is only ever sent for the account that was refused.
    if (pending && next && pendingFor !== undefined && pendingFor !== next.account.toLowerCase())
      return dropReturn("session")
    if (pending) return
    // One on its way when the account changed: whether it finished is not known to the new session.
    if (landing?.kind === "finishing") return dropReturn("session")
    // Kept while signed out too, so the sign-in prompt can show it; the first account to sign in sees it once.
    if (landingAtOpen) return void (landingAtOpen = next === undefined)
    // Another session's finished or failed landing is not this one's.
    landing = undefined
  }

  /** An OAuth return that cannot be sent: it is dropped, and the landing says why. */
  function dropReturn(problem: EverywhereLandingProblem) {
    pending = undefined
    pendingFor = undefined
    landing = { kind: "failed", problem }
    landingAtOpen = false
  }

  function mappingOf(installation: string, place: string) {
    if (current.kind !== "ready") return undefined
    return current.mappings[installation]?.find((mapping) => mapping.place === place)
  }

  function run(confirm: EverywhereConfirm): Promise<void> {
    if (confirm.action === "disconnect")
      return act(
        () => send("DELETE", EVERYWHERE_ROUTES.installs, { installation: confirm.installation }),
        (answer) => ({ notice: answer.status === 202 ? "closing" : "disconnected" }),
      )
    if (confirm.action === "remove-mapping")
      return act(
        () => send("DELETE", EVERYWHERE_ROUTES.repos, { installation: confirm.installation, place: confirm.place }),
        () => ({ notice: "removed" }),
      )
    const mapping = mappingOf(confirm.installation, confirm.place)
    if (!mapping) return Promise.resolve()
    const remaining = mapping.repositories.filter((repository) => repository.fullName !== confirm.fullName)
    if (remaining.length === 0)
      return act(
        () => send("DELETE", EVERYWHERE_ROUTES.repos, { installation: confirm.installation, place: confirm.place }),
        () => ({ notice: "removed" }),
      )
    // setMapping refuses a repository without a verified id, so only a mapping whose other ids are known is narrowed.
    if (remaining.some((repository) => repository.id === undefined)) {
      patch({ confirm: undefined, problem: "invalid" })
      return Promise.resolve()
    }
    return act(
      () =>
        send("PUT", EVERYWHERE_ROUTES.repos, {
          installation: confirm.installation,
          place: confirm.place,
          repositories: remaining.map((repository) => ({ fullName: repository.fullName, id: repository.id })),
        }),
      () => ({ notice: "saved" }),
    )
  }

  return {
    state: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** The browser session changed. The same account with a new token keeps everything; anyone else starts over. */
    setSession(next: EverywhereSession | undefined): Promise<void> {
      if (next && session && next.account.toLowerCase() === session.account.toLowerCase()) {
        session = next
        if (current.kind !== "session-expired") return Promise.resolve()
        // Answers to requests sent with the refused token are dropped, so a late 401 cannot expire the renewed session.
        generation++
        controller.abort()
        controller = new AbortController()
        set(empty())
        return finishThenRefresh()
      }
      generation++
      controller.abort()
      controller = new AbortController()
      session = next
      changeAccount(next)
      if (!next) {
        leave({ kind: "signed-out" })
        return Promise.resolve()
      }
      leave(empty())
      return finishThenRefresh()
    },
    accountsUnavailable() {
      generation++
      controller.abort()
      controller = new AbortController()
      session = undefined
      if (pending || landing?.kind === "finishing") dropReturn("unavailable")
      leave({ kind: "accounts-unavailable" })
    },
    /**
     * The page was opened with an OAuth return (`takeOAuthReturn`). It is sent once there is a session; signed out,
     * refused or off, it is dropped and the landing says why.
     */
    finishOAuth(back: EverywhereOAuthReturn | "invalid"): Promise<void> {
      pending = undefined
      pendingFor = undefined
      if (back === "invalid") {
        setLanding({ kind: "failed", problem: "invalid-return" })
        landingAtOpen = current.kind === "loading"
        return Promise.resolve()
      }
      const refused: Partial<Record<EverywhereState["kind"], EverywhereLandingProblem>> = {
        "signed-out": "signed-out",
        "session-expired": "session",
        "accounts-unavailable": "unavailable",
        off: "not-found",
      }
      const problem = refused[current.kind]
      if (problem) {
        setLanding({ kind: "failed", problem })
        return Promise.resolve()
      }
      pending = back
      setLanding({ kind: "finishing", platform: back.platform })
      // Loading: `setSession` sends it once the browser's session is known.
      if (current.kind !== "ready") return Promise.resolve()
      return finishThenRefresh()
    },
    refresh,
    /** A Slack or Jira link code for the signed-in account (3.8). Asking again ends the older code. */
    issueCode(platform: "slack" | "jira"): Promise<void> {
      if (current.kind !== "ready") return Promise.resolve()
      clearLanding()
      stopExpiry()
      const seq = ++codeSeq
      patch({ code: undefined, notice: undefined, problem: undefined })
      return send("POST", EVERYWHERE_ROUTES.link, { platform }).then((answer) => {
        if (!answer || seq !== codeSeq) return
        if (answer.status === 401) return leave({ kind: "session-expired" })
        if (answer.status !== 200) return patch({ problem: problemOf(answer.status, answer.code) })
        const code = readLinkCode(answer.body, platform)
        if (!code) return patch({ problem: "unavailable" })
        // Timed from when the code arrived, on this computer's clock: the server's expiresAt is on its own clock.
        cancelExpiry = schedule(LINK_CODE_MS, () => {
          if (seq !== codeSeq) return
          cancelExpiry = undefined
          patch({ code: undefined })
        })
        patch({ code })
      })
    },
    forgetCode() {
      stopExpiry()
      codeSeq++
      patch({ code: undefined })
    },
    /** Linear has no private message to an app, so a link is a Linear sign-in (3.8). */
    startLink: () => start(EVERYWHERE_ROUTES.link, "linear"),
    startInstall: (platform: "slack" | "linear") => start(EVERYWHERE_ROUTES.installs, platform),
    /** Redeems a Jira site connect code. The code goes in the body only. */
    connectJira(code: string): Promise<void> {
      const typed = code.trim()
      if (!typed) {
        patch({ problem: "invalid" })
        return Promise.resolve()
      }
      return act(
        () => send("POST", EVERYWHERE_ROUTES.installs, { platform: "jira", code: typed }),
        () => ({ notice: "connected" }),
      )
    },
    unlink(installation: string, userId: string) {
      return act(
        () => send("DELETE", EVERYWHERE_ROUTES.links, { installation, userId }),
        () => ({ notice: "unlinked" }),
      )
    },
    ask(confirm: EverywhereConfirm) {
      patch({ confirm, notice: undefined, problem: undefined })
    },
    cancel() {
      patch({ confirm: undefined })
    },
    confirm(): Promise<void> {
      if (current.kind !== "ready" || !current.confirm) return Promise.resolve()
      return run(current.confirm)
    },
    /** After a 401: end the browser's session first, so the sign-in page does not send the person straight back. */
    signInAgain(pathname: string, focus?: string): Promise<void> {
      const signOut = deps.signOut ?? (() => Promise.resolve())
      return signOut()
        .catch(() => undefined)
        .then(() => navigate(signInPath(pathname, focus)))
    },
    /**
     * The page is going away: drop every answer still on its way and the code. A return not sent yet stays, so React's
     * development double mount still sends it once.
     */
    close() {
      generation++
      controller.abort()
      controller = new AbortController()
      session = undefined
      leave({ kind: "loading" })
    },
  }
}

/** The account auth calls the root needs (Supabase's `client.auth`), passed in rather than imported. */
export type EverywhereAuthSession = { readonly user: { readonly id: string }; readonly access_token: string }
export type EverywhereAuth = {
  onAuthStateChange(callback: (event: string, session: EverywhereAuthSession | null) => void): {
    data: { subscription: { unsubscribe(): void } }
  }
  getSession(): Promise<{ data: { session: EverywhereAuthSession | null }; error: unknown }>
}

/**
 * Follows the browser's sign-in. Every auth event wins over `getSession()`, whose answer is used only if no event came
 * first, so a late answer cannot put back an older token after a refresh. Answers the disconnect.
 */
export function connectAccountSession(model: EverywhereAccountModel, auth: Promise<EverywhereAuth>): () => void {
  const toSession = (session: EverywhereAuthSession | null) =>
    session ? { account: session.user.id, token: session.access_token } : undefined
  const progress = { closed: false, heard: false, unsubscribe: () => {} }
  auth
    .then((client) => {
      if (progress.closed) return
      const listener = client.onAuthStateChange((_event, session) => {
        if (progress.closed) return
        progress.heard = true
        void model.setSession(toSession(session))
      })
      progress.unsubscribe = () => listener.data.subscription.unsubscribe()
      return client.getSession().then((answer) => {
        if (progress.closed || progress.heard) return
        if (answer.error) return model.accountsUnavailable()
        void model.setSession(toSession(answer.data.session))
      })
    })
    .catch(() => {
      if (!progress.closed && !progress.heard) model.accountsUnavailable()
    })
  return () => {
    progress.closed = true
    progress.unsubscribe()
  }
}

/** The installations the account connected. GitHub's are not managed here and are left out; a malformed entry is skipped. */
export function readInstalls(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.installs)) return undefined
  const seen = new Set<string>()
  const entries = value.installs.slice(0, MAX_INSTALLS).flatMap((item): (EverywhereInstall | typeof skip)[] => {
    if (isRecord(item) && item.platform === "github") return []
    if (!isRecord(item) || typeof item.installation !== "string" || seen.has(item.installation)) return [skip]
    const platform = platformOf(item.installation)
    if (!platform || item.platform !== platform || !isTime(item.installedAt) || !isScopes(item.scopes)) return [skip]
    if (item.status !== undefined && item.status !== "closing") return [skip]
    const nextAction =
      item.nextAction === "retry-disconnect" || item.nextAction === "review-native-revocation"
        ? item.nextAction
        : undefined
    if (item.nextAction !== undefined && !nextAction) return [skip]
    seen.add(item.installation)
    return [
      {
        installation: item.installation,
        platform,
        installedAt: item.installedAt,
        scopes: item.scopes,
        ...(item.status === "closing" ? { status: "closing" as const } : {}),
        ...(nextAction ? { nextAction } : {}),
      },
    ]
  })
  return kept(entries, value.installs.length - MAX_INSTALLS)
}

/** The account's links. Each user id must have its platform's shape. */
export function readLinks(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.links)) return undefined
  const entries = value.links.slice(0, MAX_LINKS).flatMap((item): (EverywhereLink | typeof skip)[] => {
    if (!isRecord(item) || typeof item.installation !== "string" || typeof item.userId !== "string") return [skip]
    const platform = platformOf(item.installation)
    if (!platform || item.platform !== platform || !isTime(item.linkedAt)) return [skip]
    if (!LINK_USER_ID_PATTERNS[platform].test(item.userId)) return [skip]
    return [{ installation: item.installation, platform, userId: item.userId, linkedAt: item.linkedAt }]
  })
  return kept(entries, value.links.length - MAX_LINKS)
}

/**
 * An installation's mappings, for the account that asked. The answer must be for the installation asked about. A
 * repository whose id is not known yet is kept (identity.ts stores `null` for it), so its mapping can still be removed.
 */
export function readMappings(value: unknown, installation: string, account: string) {
  if (!isRecord(value) || value.installation !== installation || !Array.isArray(value.mappings)) return undefined
  const entries = value.mappings.slice(0, MAX_MAPPINGS).flatMap((item): (EverywhereMapping | typeof skip)[] => {
    if (!isRecord(item) || typeof item.place !== "string" || !PLACE_ID_PATTERN.test(item.place)) return [skip]
    // An empty list is kept: the repos PUT accepts one, and the page must still offer to remove it.
    if (!Array.isArray(item.repositories) || item.repositories.length > 20) return [skip]
    if (typeof item.private !== "boolean" || !isTime(item.setAt) || typeof item.setBy !== "string") return [skip]
    const repositories = item.repositories.flatMap((repository): EverywhereRepository[] => {
      if (!isRecord(repository) || !Everywhere.isRepositoryName(repository.fullName)) return []
      if (repository.id === undefined) return [{ fullName: repository.fullName }]
      return isTime(repository.id) ? [{ fullName: repository.fullName, id: repository.id }] : []
    })
    if (repositories.length !== item.repositories.length) return [skip]
    return [
      {
        place: item.place,
        repositories,
        private: item.private,
        setAt: item.setAt,
        // The server keeps account ids lowercased; the session's may not be.
        setByYou: item.setBy.toLowerCase() === account.toLowerCase(),
      },
    ]
  })
  return kept(entries, value.mappings.length - MAX_MAPPINGS)
}

/** A link code answer for the platform asked about. Its expiresAt is the server's clock, so only its shape is checked. */
export function readLinkCode(value: unknown, platform: "slack" | "jira"): EverywhereLinkCode | undefined {
  if (!isRecord(value) || value.platform !== platform || !isTime(value.expiresAt)) return undefined
  if (typeof value.code !== "string" || !LINK_CODE_PATTERN.test(value.code)) return undefined
  return { platform, code: value.code }
}

/** The authorize URL of an install or link start, only when it is the platform's own endpoint with the answer's state. */
export function readAuthorize(value: unknown, platform: "slack" | "linear"): string | undefined {
  if (!isRecord(value) || value.platform !== platform || typeof value.url !== "string") return undefined
  if (typeof value.state !== "string" || !STATE_PATTERN.test(value.state) || !parses(value.url)) return undefined
  const url = new URL(value.url)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined
  if (url.origin + url.pathname !== EVERYWHERE_AUTHORIZE[platform]) return undefined
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== value.state) return undefined
  return url.href
}

/** The fixed problem for a refused write. Only the status and the error code are read, never the message. */
export function problemOf(status: number, code?: string): EverywhereProblem {
  if (code === "EVERYWHERE_CODE_INVALID") return "code-invalid"
  if (code === "EVERYWHERE_INSTALLED_ELSEWHERE") return "installed-elsewhere"
  if (status === 404) return "not-found"
  if (status === 409) return "changed"
  if (status === 403) return "not-allowed"
  if (status === 429) return "too-many"
  if (status === 400) return "invalid"
  return "unavailable"
}

/** The sign-in link keeps only the page path and a selected job. OAuth query parameters and fragments stay out. */
export function signInPath(pathname: string, focus?: string) {
  const base = "https://vectordev.ai"
  const parsed = pathname.startsWith("/") && parses(pathname, base) ? new URL(pathname, base) : undefined
  const path = parsed?.origin === base ? parsed.pathname : undefined
  const canFocus = path === "/everywhere" || path === "/everywhere/"
  const returnTo =
    canFocus && focus && Everywhere.JOB_ID_PATTERN.test(focus) ? `${path}?job=${focus}` : (path ?? "/everywhere")
  return `/login?returnTo=${encodeURIComponent(returnTo)}`
}

/**
 * The OAuth return in /everywhere's fragment: exactly `platform`, `code` and `state`, each once, with Slack or Linear,
 * a code identity.ts would take and a state of the stored shape. Anything else is undefined.
 */
export function readOAuthReturn(hash: string): EverywhereOAuthReturn | undefined {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
  const keys = [...params.keys()]
  if (keys.length !== 3 || !["platform", "code", "state"].every((key) => params.getAll(key).length === 1))
    return undefined
  const platform = params.get("platform")
  const code = params.get("code") ?? ""
  const state = params.get("state") ?? ""
  if (platform !== "slack" && platform !== "linear") return undefined
  if (!OAUTH_CODE_PATTERN.test(code) || !STATE_PATTERN.test(state)) return undefined
  return { platform, code, state }
}

/**
 * Takes an OAuth return out of the address bar. A fragment that names any of its keys is removed from this history
 * entry first, before anything reads or sends the code, so it is never in a later URL, a reload or the back button;
 * the path and query stay. Answers the return, "invalid" for a malformed one, or undefined when there is none (and
 * then the address is left alone).
 */
export function takeOAuthReturn(place: OAuthPlace): EverywhereOAuthReturn | "invalid" | undefined {
  const hash = place.location.hash
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
  if (!["platform", "code", "state"].some((key) => params.has(key))) return undefined
  place.history.replaceState(place.history.state, "", place.location.pathname + place.location.search)
  return readOAuthReturn(hash) ?? "invalid"
}

/** The oauth-finish answer (identity.ts `OAuthFinish`), only for the platform the return named and its own ids. */
export function readFinish(value: unknown, platform: OAuthPlatform): EverywhereLanding | undefined {
  if (!isRecord(value) || value.platform !== platform || typeof value.installation !== "string") return undefined
  if (Everywhere.installationPlatform(value.installation) !== platform) return undefined
  if (value.purpose === "install") {
    if (value.change !== "new" && value.change !== "renewed" && value.change !== "connector-change") return undefined
    return { kind: "installed", platform, installation: value.installation, change: value.change }
  }
  if (value.purpose !== "link" || platform !== "linear" || typeof value.already !== "boolean") return undefined
  if (typeof value.userId !== "string" || !LINK_USER_ID_PATTERNS.linear.test(value.userId)) return undefined
  if (value.hint !== undefined && (typeof value.hint !== "string" || !HINT_PATTERN.test(value.hint))) return undefined
  return {
    kind: "linked",
    installation: value.installation,
    userId: value.userId,
    already: value.already,
    ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
  }
}

/**
 * The fixed problem for a refused finish. Only the status, the code and a link refusal's reason are read. Every one
 * but a 401 (handled before this) comes after the server used up the state, so each says to start again.
 */
export function landingProblemOf(status: number, code?: string, reason?: string): EverywhereLandingProblem {
  if (code === "EVERYWHERE_STATE_INVALID") return "expired-state"
  if (code === "EVERYWHERE_STATE_ACCOUNT") return "other-account"
  if (code === "EVERYWHERE_LINK_REFUSED") return reason === "not-connected" ? "not-connected" : "link-refused"
  if (code === "EVERYWHERE_INSTALLED_ELSEWHERE") return "installed-elsewhere"
  if (code === "EVERYWHERE_WRONG_PLACE") return "wrong-place"
  // The platform answered, but not for a person or a workspace Vector takes (a Linear guest or app, a Slack guest).
  if (code === "SLACK_GRANT_INVALID" || code === "LINEAR_GRANT_INVALID") return "not-verified"
  if (status === 404) return "not-found"
  return "unavailable"
}

/**
 * The account's jobs (GET history), each entry decoded on its own: a malformed one is skipped and counted. A summary
 * is kept only on a job in a private place; on a shared one it is dropped and the job kept. `skipped` adds the records
 * the server could not read.
 */
export function readJobs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.jobs) || typeof value.capped !== "boolean") return undefined
  if (!isCount(value.skipped)) return undefined
  const seen = new Set<string>()
  const entries = value.jobs.slice(0, JOBS_LIMIT).flatMap((item): (EverywhereJob | typeof skip)[] => {
    const job = readJob(item)
    if (!job || seen.has(job.jid)) return [skip]
    seen.add(job.jid)
    return [job]
  })
  const read = kept(entries, value.jobs.length - JOBS_LIMIT)
  return { items: read.items, skipped: read.skipped + value.skipped, capped: value.capped }
}

function readJob(item: unknown): EverywhereJob | undefined {
  if (!isRecord(item) || Object.keys(item).some((field) => !JOB_FIELDS.has(field))) return undefined
  if (typeof item.jid !== "string" || !Everywhere.JOB_ID_PATTERN.test(item.jid)) return undefined
  if (
    !oneOf(Everywhere.PLATFORMS, item.platform) ||
    Everywhere.installationPlatform(item.installation) !== item.platform
  )
    return undefined
  if (!oneOf(Everywhere.JOB_STATES, item.state) || !Everywhere.isRepositoryName(item.repository)) return undefined
  if (!optional(item.route, (route) => oneOf(JOB_ROUTES, route))) return undefined
  if (!optional(item.outcome, (outcome) => oneOf(Everywhere.OUTCOMES, outcome))) return undefined
  if (!optional(item.code, (code) => oneOf(JOB_CODES, code))) return undefined
  if (!optional(item.ending, (ending) => oneOf(JOB_ENDINGS, ending))) return undefined
  if (!optional(item.issue, Everywhere.isIssueKey) || typeof item.shared !== "boolean") return undefined
  if (!isTime(item.receivedAt) || !optional(item.endedAt, isTime)) return undefined
  const repository = item.repository
  // A pull request link into the job's own repository only (jobs.ts settleJob checks the same).
  const pullRequest = (url: unknown) =>
    typeof url === "string" &&
    (Everywhere.PR_URL_PATTERN.exec(url)?.[1] ?? "").toLowerCase() === repository.toLowerCase()
  if (!optional(item.prUrl, pullRequest)) return undefined
  const summary = (text: unknown) =>
    typeof text === "string" && text.length > 0 && text.length <= Everywhere.LIMITS.summaryChars
  if (!optional(item.summary, summary)) return undefined
  return {
    jid: item.jid,
    platform: item.platform,
    installation: item.installation as string,
    state: item.state,
    ...(item.route !== undefined ? { route: item.route as JobRoute } : {}),
    ...(item.outcome !== undefined ? { outcome: item.outcome as Everywhere.Outcome } : {}),
    ...(typeof item.code === "string" ? { code: item.code } : {}),
    ...(item.ending !== undefined ? { ending: item.ending as (typeof JOB_ENDINGS)[number] } : {}),
    repository,
    ...(typeof item.issue === "string" ? { issue: item.issue } : {}),
    shared: item.shared,
    receivedAt: item.receivedAt,
    ...(typeof item.endedAt === "number" ? { endedAt: item.endedAt } : {}),
    ...(typeof item.prUrl === "string" ? { prUrl: item.prUrl } : {}),
    // A shared place's summary is never shown here, whatever an answer holds.
    ...(typeof item.summary === "string" && !item.shared ? { summary: item.summary } : {}),
  }
}

/** The account's audit log (GET audit): ids and fixed codes only; an entry with any other field is skipped. */
export function readAuditEntries(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined
  const seen = new Set<string>()
  const entries = value.entries.slice(0, AUDIT_LIMIT).flatMap((item): (EverywhereAuditEntry | typeof skip)[] => {
    const entry = readAuditEntry(item)
    if (!entry || seen.has(entry.id)) return [skip]
    seen.add(entry.id)
    return [entry]
  })
  return kept(entries, value.entries.length - AUDIT_LIMIT)
}

function readAuditEntry(item: unknown): EverywhereAuditEntry | undefined {
  if (!isRecord(item) || Object.keys(item).some((field) => !AUDIT_FIELDS.has(field))) return undefined
  if (typeof item.id !== "string" || !AUDIT_ENTRY_ID.test(item.id) || !isTime(item.at)) return undefined
  if (!oneOf(EVERYWHERE_AUDIT_EVENTS, item.event)) return undefined
  if (!optional(item.platform, (platform) => oneOf(Everywhere.PLATFORMS, platform))) return undefined
  const owner = item.installation === undefined ? item.platform : Everywhere.installationPlatform(item.installation)
  if (item.installation !== undefined && (!owner || (item.platform !== undefined && item.platform !== owner)))
    return undefined
  if (!optional(item.jid, (jid) => typeof jid === "string" && Everywhere.JOB_ID_PATTERN.test(jid))) return undefined
  if (!optional(item.code, (code) => typeof code === "string" && EVERYWHERE_AUDIT_CODES.has(code))) return undefined
  const userIdValid = (userId: unknown) =>
    typeof userId === "string" && oneOf(Everywhere.PLATFORMS, owner) && auditUserIdPattern(owner).test(userId)
  if (!optional(item.userId, userIdValid) || !optional(item.byOther, (byOther) => byOther === true)) return undefined
  return {
    id: item.id,
    at: item.at,
    event: item.event,
    ...(oneOf(Everywhere.PLATFORMS, owner) ? { platform: owner } : {}),
    ...(typeof item.installation === "string" ? { installation: item.installation } : {}),
    ...(typeof item.jid === "string" ? { jid: item.jid } : {}),
    ...(typeof item.code === "string" ? { code: item.code } : {}),
    ...(typeof item.userId === "string" ? { userId: item.userId } : {}),
    byOther: item.byOther === true,
  }
}

function auditUserIdPattern(platform: Everywhere.PlatformId) {
  return platform === "github" ? GITHUB_USER_ID_PATTERN : LINK_USER_ID_PATTERNS[platform]
}

/** The job a vectordev.ai job link marks (`?job=vej_…`): exactly one, of the job id's shape. */
export function focusJob(search: string | undefined) {
  if (search === undefined) return undefined
  const jobs = new URLSearchParams(search).getAll("job")
  return jobs.length === 1 && Everywhere.JOB_ID_PATTERN.test(jobs[0]!) ? jobs[0] : undefined
}

/** A time in UTC, to the minute, the same on every computer. */
export function formatTime(ms: number) {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} (UTC)`
}

/** Ids only, never display names (3.8). */
export function installationLabel(installation: string) {
  const platform = Everywhere.installationPlatform(installation)
  const id = installation.slice(installation.indexOf(":") + 1)
  if (platform === "slack") {
    const [first, second] = id.split(":")
    if (second) return `Slack workspace ${second} (organization ${first})`
    return first!.startsWith("E") ? `Slack organization ${first}` : `Slack workspace ${first}`
  }
  if (platform === "linear") return `Linear workspace ${id}`
  if (platform === "jira") return `Jira site ${id}`
  if (platform === "github") return `GitHub installation ${id}`
  return installation
}

export function placeLabel(platform: EverywherePlatform, place: string) {
  if (platform === "slack") return `Channel ${place}`
  if (platform === "linear") return `Team ${place}`
  return `Key ${place}`
}

/** A day in UTC, the same on every computer. */
export function formatDay(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 10)} (UTC)`
}

const skip = Symbol("skip")

function kept<T>(entries: readonly (T | typeof skip)[], overflow: number) {
  const items = entries.filter((entry): entry is T => entry !== skip)
  return { items, skipped: entries.length - items.length + Math.max(0, overflow) }
}

function platformOf(installation: unknown): EverywherePlatform | undefined {
  const platform = Everywhere.installationPlatform(installation)
  return platform === "slack" || platform === "linear" || platform === "jira" ? platform : undefined
}

/** URL.canParse where the browser has it. Without it nothing parses, so a Connect refuses and sign-in uses /everywhere. */
function parses(value: string, base?: string) {
  return typeof URL.canParse === "function" && URL.canParse(value, base)
}

function errorCode(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.code !== "string") return undefined
  return payload.error.code
}

/** A link refusal's fixed reason (identity.ts `finishOAuth`, EVERYWHERE_LINK_REFUSED). */
function errorReason(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.reason !== "string") return undefined
  return payload.error.reason
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
}

function optional(value: unknown, check: (value: unknown) => boolean) {
  return value === undefined || check(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isScopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((scope) => typeof scope === "string" && SCOPE_PATTERN.test(scope))
  )
}
