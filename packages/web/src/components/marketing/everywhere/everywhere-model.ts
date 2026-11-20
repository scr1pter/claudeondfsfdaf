import { Everywhere } from "@vectordevai/schema/everywhere"

/*
 * The signed-in account's Vector everywhere controls on vectordev.ai (VE-42a, contract 3.8 and 3.12): installations
 * with disconnect, links with unlink, link codes, the Jira connect code, the start of the Slack and Linear installs and
 * of the Linear sign-in link, and the repositories set for each place. It talks only to the account routes
 * (api/everywhere/{installs,links,link,repos}) with the session's bearer token, never a cookie.
 *
 * No framework, Supabase or DOM import: the React views only render `state()`. Answers from another account's session,
 * or sent with a token the server has since refused, are dropped by `generation`, so a code or a list is only ever
 * shown to the account that asked for it, and a late 401 cannot undo a renewed sign-in. Codes and the Jira connect
 * code travel only in JSON bodies; the only query parameter is `installation` on GET repos, a workspace id the account
 * connected.
 */

export const EVERYWHERE_ROUTES = {
  installs: "/api/everywhere/installs",
  links: "/api/everywhere/links",
  link: "/api/everywhere/link",
  repos: "/api/everywhere/repos",
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
/** A Slack channel, a Linear team id or a Jira key (identity.ts `PLACE_PATTERN`). */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const SCOPE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_INSTALLS = 200
const MAX_LINKS = 500
const MAX_MAPPINGS = 500

export const PLATFORM_NAMES: Readonly<Record<EverywherePlatform, string>> = {
  slack: "Slack",
  linear: "Linear",
  jira: "Jira",
}

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
}
export type EverywhereState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "session-expired" }
  | { readonly kind: "accounts-unavailable" }
  | { readonly kind: "off" }
  | EverywhereReady

export type EverywhereDeps = {
  readonly request?: (path: string, init: RequestInit) => Promise<Response>
  readonly navigate?: (url: string) => void
  readonly schedule?: (ms: number, run: () => void) => () => void
  /** Ends the browser's own session (Supabase `signOut({scope: "local"})`) before a fresh sign-in. */
  readonly signOut?: () => Promise<unknown>
}

type Answer = { readonly status: number; readonly code?: string; readonly body?: unknown }
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

  function set(next: EverywhereState) {
    current = next
    for (const listener of [...listeners]) listener()
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
          .then((payload: unknown): Answer => ({ status: response.status, code: errorCode(payload), body: payload })),
      )
      .catch((): Answer => ({ status: 0 }))
      .then((answer) => (asked === generation ? answer : undefined))
  }

  function refresh(): Promise<void> {
    const live = session
    if (!live) return Promise.resolve()
    const seq = ++refreshSeq
    return Promise.all([send("GET", EVERYWHERE_ROUTES.installs), send("GET", EVERYWHERE_ROUTES.links)]).then(
      ([installs, links]) => {
        if (!installs || !links || seq !== refreshSeq) return
        const failed = [installs, links].find((answer) => answer.status !== 200)
        // A 404 before any store read is the feature off (account-api.ts `begin`).
        if (failed?.status === 404) return leave({ kind: "off" })
        if (failed?.status === 401) return leave({ kind: "session-expired" })
        if (failed) return patch({ problem: problemOf(failed.status, failed.code) })
        const listedInstalls = readInstalls(installs.body)
        const listedLinks = readLinks(links.body)
        if (!listedInstalls || !listedLinks) return patch({ problem: "unavailable" })
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
            if (answer.status === 404)
              return { installation: install.installation, items: [], skipped: 0, unread: false }
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
            partial:
              listedInstalls.skipped + listedLinks.skipped + read.reduce((sum, entry) => sum + entry.skipped, 0) > 0,
            // A write's problem stays beside the reloaded lists; one from a failed first load is over once they load.
            problem: current.loaded ? current.problem : undefined,
            confirm,
          })
        })
      },
    )
  }

  /** One write at a time: the view disables every button while `busy`. */
  function act(
    run: () => Promise<Answer | undefined>,
    done: (answer: Answer) => Outcome,
    reload = true,
  ): Promise<void> {
    if (current.kind !== "ready" || current.busy) return Promise.resolve()
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
        return refresh()
      }
      generation++
      controller.abort()
      controller = new AbortController()
      session = next
      if (!next) {
        leave({ kind: "signed-out" })
        return Promise.resolve()
      }
      leave(empty())
      return refresh()
    },
    accountsUnavailable() {
      generation++
      controller.abort()
      controller = new AbortController()
      session = undefined
      leave({ kind: "accounts-unavailable" })
    },
    refresh,
    /** A Slack or Jira link code for the signed-in account (3.8). Asking again ends the older code. */
    issueCode(platform: "slack" | "jira"): Promise<void> {
      if (current.kind !== "ready") return Promise.resolve()
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
    signInAgain(pathname: string): Promise<void> {
      const signOut = deps.signOut ?? (() => Promise.resolve())
      return signOut()
        .catch(() => undefined)
        .then(() => navigate(signInPath(pathname)))
    },
    /** The page is going away: drop every answer still on its way and the code. */
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

/** The sign-in link: this page's path only, so no query or fragment (an OAuth code included) reaches /login. */
export function signInPath(pathname: string) {
  const base = "https://vectordev.ai"
  const parsed = pathname.startsWith("/") && parses(pathname, base) ? new URL(pathname, base) : undefined
  const path = parsed?.origin === base ? parsed.pathname : "/everywhere"
  return `/login?returnTo=${encodeURIComponent(path)}`
}

/** Ids only, never display names (3.8). */
export function installationLabel(installation: string) {
  const platform = platformOf(installation)
  const id = installation.slice(installation.indexOf(":") + 1)
  if (platform === "slack") {
    const [first, second] = id.split(":")
    if (second) return `Slack workspace ${second} (organization ${first})`
    return first!.startsWith("E") ? `Slack organization ${first}` : `Slack workspace ${first}`
  }
  if (platform === "linear") return `Linear workspace ${id}`
  if (platform === "jira") return `Jira site ${id}`
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
