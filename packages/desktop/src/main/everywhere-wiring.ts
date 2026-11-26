import { realpath } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { ACCOUNT_ID_PATTERN } from "@vectordevai/schema/everywhere"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { createEverywhereAwake } from "./everywhere-awake"
import {
  createEverywhereEngine,
  localEngineOrigin,
  responseText,
  unattendedCapabilities,
  type UnattendedCapabilities,
  type UnattendedShellPolicy,
} from "./everywhere-engine"
import { createEverywhereGit } from "./everywhere-git"
import { createLedger, ledgerFile, type JobLedger } from "./everywhere-ledger"
import { createOfferVerifier, OFFER_KEYS } from "./everywhere-offer"
import {
  createEverywhereJobsClient,
  createEverywhereRunner,
  localAllows,
  type JobsClient,
  type RunnerDeps,
  type SafeWorktree,
  WorktreeUnavailable,
} from "./everywhere-runner"
import {
  everywhereSettings,
  offSettings,
  unlocked,
  type EverywhereSettings,
  type ProjectFolder,
} from "./everywhere-settings"
import type { LinkDependencies, RemoteLink, RemoteState, RemoteStatus } from "./remote-link"
import { tokenClaims } from "./vector-account"

// Vector everywhere in the running app (VE-21, R-C2, R-C3): the jobs subscriber Vector Remote's link takes, and the
// runner behind it. Electron-free, so its tests run under Bun; remote-runtime.ts supplies the Electron pieces.
//
// - Settings come only from the engine's GET /global/config (the user's own files, everywhere-settings.ts), read again
//   whenever the engine says its global config changed (`global.disposed`) or its event stream (re)connects. A company
//   lock on the key, a block that does not decode and an unreadable answer are all off.
// - "Takes jobs" (`want()`) is on only while the setting is on and Remote is on with an identity. Without an identity
//   the state is `needs-remote` and nothing is created: the person must turn Remote on (the settings page's consent
//   step comes with the deferred write path; nothing in packages/app reads `needs-remote` yet).
// - While on, waiting jobs are asked for (`pending`) when the link comes online, after every job the runner ran, after
//   the last run's leases are recovered, and every five minutes, but only while the link is online or connecting: a
//   Remote the service paused, revoked or refused takes no job over HTTP either. Off stops every timer.
// - Every offer, by relay or by `pending`, is verified against the pinned OFFER_KEYS (empty until the owner's key
//   handoff, so every offer is refused) and the ledger's replay record before anything is sent (E9).
// - While the block is on, the engine is asked (as its owner, engine-wide) whether it creates unattended worktrees and
//   runs an unattended session's commands offline (EV-18). The runner gets the worktree adapter only while the engine
//   answers `unattended-v1`, otherwise a claimed job settles `held` before any session, commit or push. The session may
//   run commands (`bash`) only while it answers `offline-v1` and no company lock holds a key that can carry
//   permission rules (RULE_KEYS).
// - The session's ruleset copies the user's own permission rules, and the asks and denies of their default agent, for
//   the ids it allows (everywhere-engine.ts unattendedRules).
// - The stay-awake option holds the desktop's shared work blocker while jobs are on and the link can deliver offers
//   (online or connecting), the option is on and the computer is on AC power (everywhere-awake.ts, F6).

export type EverywhereJobsState = "off" | "needs-remote" | "on"
export type EverywhereLink = Pick<RemoteLink, "status" | "device" | "jobsChanged">

export type EverywhereJobsDeps = {
  /** The local engine over its authenticated loopback server, with the owner's credentials. */
  readonly engine: { readonly url: string; readonly password: string }
  /** Owner's versioned settings from the built-in engine's private sidecar channel. */
  readonly preferences?: () => Promise<EverywherePreferenceWire.Result>
  readonly createEverywhereSession?: Parameters<typeof createEverywhereEngine>[0]["createSession"]
  /** The desktop sign-in (vectorAccount.token). One that cannot be read counts as none. */
  readonly token: () => Promise<string | undefined>
  /** The engine's GET /global/event stream; subscribed only while Remote is on. */
  readonly events: (signal: AbortSignal) => AsyncIterable<{ readonly payload: { readonly type: string } }>
  /** The runner's private ledger file, absolute, under the app's user data. */
  readonly ledgerPath: string
  /** Fixed text only. */
  readonly log?: (message: string) => void
  /** Electron's powerMonitor, for the stay-awake option; absent, nothing is held. `changed` returns its unsubscribe. */
  readonly power?: { readonly onBattery: () => boolean; readonly changed: (listener: () => void) => () => void }
  // Test seams; remote-runtime.ts passes none of them.
  /** Default OFFER_KEYS. */
  readonly keys?: Readonly<Record<string, string>>
  /** Default: the ledger file at ledgerPath. */
  readonly ledger?: JobLedger
  /** The jobs service's address and fetcher. Default vectordev.ai through Egress. */
  readonly service?: { readonly url?: string; readonly fetcher?: typeof fetch }
  /** The fetcher for the engine's config route, its two capability probes and the unattended worktree adapter. */
  readonly fetcher?: typeof fetch
  readonly git?: RunnerDeps["git"]
  readonly runnerEngine?: RunnerDeps["engine"]
  /**
   * Replaces the probe-gated adapter (unattendedWorktree), which the runner otherwise gets only while the engine answers
   * `unattended-v1`. EV-16's preconditions: formatters, language servers and the checkout's config stay off because
   * the engine never trusts a job's checkout (the adapter refuses one it reports trusted); EV-18 adds no git call; the
   * home folder's other secrets matter for the push path, which is still stand-ins. EV-14's mark precondition is met
   * (PATCH /session/:id refuses to drop `vector.unattended`, EV-16), and RunnerSettings.rules is filled.
   */
  readonly safeWorktree?: SafeWorktree
  readonly localPolicy?: RunnerDeps["localPolicy"]
  readonly now?: () => number
}

const PENDING_EVERY_MS = 5 * 60_000
const RETRY_EVENTS_MS = 5_000
/** The runner's own base rule (everywhere-git.ts fetch). */
const BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
const PENDING_SLOTS = 32
const PENDING_URL = "https://vectordev.ai/api/everywhere/jobs/pending"
/** How soon a capability probe with no definite answer (a timeout, a 5xx) is asked again. */
const PROBE_RETRY_MS = 60_000
/**
 * The config keys that can carry permission rules. Under a company lock on any of them the company's values are not in
 * GET /global/config (it answers the user's own files), and the session's later `bash` allow would outrank their rules,
 * so the shell stays off. The engine's Config.lockedKeys locks `mode` with `agent` and `tools` with `permission`; a
 * company can also name either alone, or `default_agent`, which picks the agent whose rules apply.
 */
const RULE_KEYS = ["permission", "tools", "agent", "mode", "default_agent"]
/** The link states in which offers can reach this computer: the relay is connected, or being connected to. */
const DELIVERING: readonly RemoteState[] = ["online", "connecting"]

/** The engine's answers to its two capability probes for one cache; a field with no definite answer yet is absent. */
type Probes = {
  worktree?: boolean
  shell?: UnattendedShellPolicy
  asked: boolean
  probing?: Promise<void>
  retryAt: number
}
const freshProbes = (): Probes => ({ asked: false, retryAt: 0 })

/**
 * startRemote's composition (R-C3): the link's `jobs` subscriber, and its `changed` callback handing every status to
 * `changed` (the renderer's broadcast) and then to the jobs. remote-runtime.ts spreads it into createRemoteLink's
 * dependencies, so the tests compose the link exactly as the app does.
 */
export function jobsForLink(
  jobs: EverywhereJobs,
  changed?: (status: RemoteStatus) => void,
): Pick<LinkDependencies, "jobs" | "changed"> {
  return {
    jobs,
    changed: (status) => {
      changed?.(status)
      jobs.changed(status)
    },
  }
}

export function createEverywhereJobs(deps: EverywhereJobsDeps) {
  const now = deps.now ?? Date.now
  const log = (message: string) => deps.log?.(message)
  const authorization = `Basic ${Buffer.from(`vector:${deps.engine.password}`).toString("base64")}`
  const keys = deps.keys ?? OFFER_KEYS
  const ledger = deps.ledger ?? createLedger({
    ...ledgerFile(deps.ledgerPath),
    now,
    onPublicationExpired: deps.log
      ? () => log("Vector everywhere could not report a publication before its receipt expired.")
      : undefined,
  })
  const token = () => deps.token().catch(() => undefined)
  const git: RunnerDeps["git"] =
    deps.git ??
    // No identity and no authentication: a commit refuses and git sends no sign-in, until the push path is wired.
    ((directory, repository, signal) =>
      createEverywhereGit({ directory, repository, signal, identity: { name: "", email: "" } }))
  const state: {
    link?: EverywhereLink
    started: boolean
    stopped: boolean
    settings: EverywhereSettings
    previous: EverywhereJobsState
    online: boolean
    readFailed: boolean
    reading?: Promise<EverywhereSettings>
    rereading?: Promise<EverywhereSettings>
    asking?: Promise<void>
    askAgain: boolean
    interval?: ReturnType<typeof setInterval>
    subscription?: AbortController
    recovered?: Promise<void>
    client?: { readonly device: string; readonly jobs: JobsClient }
    listed: string
    folders: Map<string, ReturnType<ProjectFolder>>
    probes: Probes
  } = {
    started: false,
    stopped: false,
    settings: offSettings(),
    previous: "off",
    online: false,
    readFailed: false,
    askAgain: false,
    listed: "",
    folders: new Map(),
    probes: freshProbes(),
  }
  const offering = new Set<string>()
  const resolve = projectFolder(git, log)
  const worktree = unattendedWorktree({ url: deps.engine.url, authorization, fetcher: deps.fetcher, log })
  const awake = deps.power ? createEverywhereAwake(deps.power) : undefined
  // Called with every state evaluation, and so with every link status: a stay_awake change, a state change and a link
  // that can no longer deliver offers (signed out, paused, revoked, replaced, refused or Local-off) all apply at once.
  const keepAwake = () =>
    awake?.update(
      current() === "on" && DELIVERING.includes(state.link?.status().state ?? "off"),
      state.settings.stayAwake,
    )

  // EV-13's worktree and EV-16's shell, asked only while the block is on. A definite answer is kept until a new event
  // stream (`server.connected`: an engine that may have restarted) or refresh(); a field with no definite answer counts
  // as none and is asked again at most once a minute. Only a cache's first ask is waited for, so no later settings read
  // (the runner's one-second check among them) waits on a slow probe.
  const capabilities = async () => {
    const probes = state.probes
    const missing = probes.worktree === undefined || probes.shell === undefined
    if (missing && !probes.probing && now() >= probes.retryAt)
      probes.probing = unattendedCapabilities({ url: deps.engine.url, authorization, fetcher: deps.fetcher })
        // It throws only for an engine address that is not loopback, which never changes.
        .catch((): UnattendedCapabilities => ({ worktree: false, shell: "none" }))
        .then((answer) => {
          probes.worktree ??= answer.worktree
          probes.shell ??= answer.shell
          if (probes.worktree === undefined || probes.shell === undefined) probes.retryAt = now() + PROBE_RETRY_MS
        })
        .finally(() => {
          probes.probing = undefined
          probes.asked = true
        })
    if (!probes.asked) await probes.probing
    return probes
  }

  const fetchSettings = async () => {
    const legacy = await (deps.fetcher ?? fetch)(new URL("/global/config", deps.engine.url), {
      headers: { authorization, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .catch(() => undefined)
    const preference = await deps.preferences?.().catch(() => ({ kind: "unavailable" }) as const)
    const global = !preference || preference.kind === "unsupported"
      ? legacy
      : preference.kind === "ready" && typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
        ? { ...legacy, everywhere: preference.snapshot.everywhere, locked: preference.snapshot.locked }
        : undefined
    if (global === undefined && !state.readFailed) log("Vector everywhere could not read its settings.")
    state.readFailed = global === undefined
    const listed = JSON.stringify((global as { everywhere?: { projects?: unknown } } | undefined)?.everywhere?.projects)
    if (listed !== state.listed) state.folders = new Map()
    state.listed = listed
    // Each folder is resolved once per cache, so the runner's one-second check spawns no git. A changed list, a global
    // config change, a new event stream and refresh() start a new cache; a read keeps the one that was current when its
    // answer came in, so a resolution that began before a change is never kept after it (the read that every change
    // asks for resolves that folder again).
    const cache = state.folders
    const settings = await everywhereSettings(global, (project) => {
      const key = `${project.directory}\0${project.repository}`
      const found = cache.get(key) ?? resolve(project)
      cache.set(key, found)
      return found
    })
    const probes = settings.enabled ? await capabilities() : undefined
    const shell =
      probes?.shell === "offline-v1" && RULE_KEYS.every((key) => unlocked(global, key)) ? "offline-v1" : "none"
    state.settings = probes ? { ...settings, worktree: probes.worktree === true, shell } : settings
    evaluate()
    return state.settings
  }

  // One read in flight and at most one after it: a read asked for while one is in flight gets a fresh GET that starts
  // after it, so a change the engine announced is never answered with settings read before it.
  const read = (): Promise<EverywhereSettings> => {
    if (!state.reading) {
      state.reading = fetchSettings().finally(() => {
        state.reading = undefined
      })
      return state.reading
    }
    state.rereading ??= state.reading.then(
      () => {
        state.rereading = undefined
        return read()
      },
      () => {
        state.rereading = undefined
        return read()
      },
    )
    return state.rereading
  }

  const jobsFor = () => {
    const device = state.link?.device()
    if (!device) throw new Error("Vector everywhere has no Remote identity")
    if (state.client?.device !== device)
      state.client = {
        device,
        jobs: createEverywhereJobsClient({
          device,
          url: deps.service?.url,
          fetcher: deps.service?.fetcher,
          token: async () => {
            const value = await token()
            if (!value) throw new Error("Vector everywhere has no sign-in")
            return value
          },
        }),
      }
    return state.client.jobs
  }

  const runner = createEverywhereRunner({
    settings: async () => {
      const settings = await read()
      // Once jobs are on, nothing is reserved before the last run's leases are recovered.
      if (state.recovered) await state.recovered
      return settings
    },
    verify: async (offer) => {
      // The account the sign-in was minted for, read without verifying it (only vectordev.ai can): an offer for another
      // account is refused by the verifier's own signature check all the same.
      const account = tokenClaims(await token())?.sub
      if (!account || !ACCOUNT_ID_PATTERN.test(account)) return undefined
      return createOfferVerifier({ account, keys, now, useOnce: ledger.useOnce })(offer)
    },
    ledger,
    jobs: {
      claim: async (jid) => jobsFor().claim(jid),
      decline: async (jid, reason, lease) => jobsFor().decline(jid, reason, lease),
      report: async (job, seq, milestone, files) => jobsFor().report(job, seq, milestone, files),
      settle: async (result) => jobsFor().settle(result),
    },
    git,
    engine:
      deps.runnerEngine ??
      ((directory) =>
        createEverywhereEngine({
          url: deps.engine.url,
          directory,
          authorization,
          fetcher: deps.fetcher,
          createSession: deps.createEverywhereSession,
        })),
    // The probe-gated adapter, offered only while the engine's last definite answer is `unattended-v1`; the runner reads
    // it once per job.
    get safeWorktree() {
      return deps.safeWorktree ?? (state.settings.worktree ? worktree : undefined)
    },
    // Push-path stand-ins until the GitHub calls are wired: never private, so a committed branch stays held.
    privateRepository: async () => false,
    openPr: async () => undefined,
    now,
    localPolicy: deps.localPolicy,
    log: deps.log ? log : undefined,
  })

  const current = (): EverywhereJobsState => {
    if (state.stopped || !state.settings.enabled) return "off"
    return state.link?.status().enabled && state.link.device() ? "on" : "needs-remote"
  }

  // Acts only on a change of state. The link is told in a microtask, never inside its own status emission.
  const evaluate = () => {
    keepAwake()
    const next = current()
    const was = state.previous
    if (next === was) return
    state.previous = next
    const link = state.link
    if (next === "on") {
      state.interval = setInterval(() => void requestPending(), PENDING_EVERY_MS)
      // Once per process, at the first "on": a computer that takes no jobs sends nothing, a stored lease included.
      state.recovered ??= runner.recover().catch(() => log("Vector everywhere could not recover its last jobs."))
      queueMicrotask(() => {
        void link?.jobsChanged().catch(() => undefined)
        if (link?.status().state === "online") void requestPending()
      })
      return
    }
    if (was !== "on") return
    if (state.interval) clearInterval(state.interval)
    state.interval = undefined
    queueMicrotask(() => void link?.jobsChanged().catch(() => undefined))
  }

  // Room for more jobs: the ledger's caps, less the offers handed on and not yet reserved. Every reservation is one of
  // the offers in `offering` until its job ends, and the rest are still being verified or declined; counting them keeps
  // a back-to-back ask (a reconnect, two jobs that end together) from handing on offers the runner must decline `busy`.
  const room = async (settings: EverywhereSettings) => {
    const inspected = await ledger.inspect().catch(() => undefined)
    if (!inspected) return 0
    const unreserved = Math.max(0, offering.size - inspected.jobs.length)
    return Math.min(
      settings.atOnce - inspected.jobs.length - unreserved,
      settings.perDay - inspected.count - unreserved,
      PENDING_SLOTS - inspected.pending.length - unreserved,
    )
  }

  const askOnce = async () => {
    if (state.recovered) await state.recovered
    const settings = await read()
    const link = state.link
    if (current() !== "on" || !link) return
    // The ask follows the link's refusals (E10): a paused, revoked, replaced, over-limit, out-of-plan, signed-out,
    // unavailable or Local-off Remote takes no job over this route either, until the link connects again.
    const status = link.status()
    if (status.state !== "online" && status.state !== "connecting") return
    const policy = (deps.localPolicy ?? Egress.policy)()
    // A Vector Local that blocks the jobs service itself would refuse and log this every five minutes: skip quietly.
    if (!serviceAllowed(policy)) return
    if (!(await token())) return
    const answer = await jobsFor().pending({
      // With no pinned offer key every offer is refused here, so the service is told this computer takes none.
      takesJobs: settings.enabled && Object.keys(keys).length > 0,
      remote: status.enabled && status.state === "online",
      localMode: !localAllows(policy),
      // The engine's offline shell probe (EV-16), as the session's ruleset uses it.
      sandbox: settings.shell === "offline-v1",
      waitForComputer: settings.waitForComputer,
      capsRoom: (await room(settings)) > 0,
      projects: settings.projects.length > 0,
    })
    // Never more than there is room for, counted again now (a relay offer may have arrived meanwhile): the rest expire
    // back to waiting and come again at the next ask.
    const slots = await room(settings)
    for (const text of answer.offers.slice(0, Math.max(0, slots)))
      void jobs.offer(text).catch(() => log("Vector everywhere could not take a waiting job."))
  }

  // One request in flight and at most one after it. Offers are handed on, never awaited: a job runs for minutes.
  const requestPending = (): Promise<void> => {
    if (state.asking) {
      state.askAgain = true
      return state.asking
    }
    state.asking = (async () => {
      do {
        state.askAgain = false
        await askOnce().catch(() => log("Vector everywhere could not ask for waiting jobs."))
      } while (state.askAgain && !state.stopped)
    })().finally(() => {
      state.asking = undefined
    })
    return state.asking
  }

  const listen = async (signal: AbortSignal) => {
    const failed = { once: false }
    while (!signal.aborted) {
      await (async () => {
        for await (const event of deps.events(signal)) {
          if (event.payload.type !== "global.disposed" && event.payload.type !== "server.connected") continue
          state.folders = new Map()
          // A new stream may be a new engine; a config change does not change what the engine can do.
          if (event.payload.type === "server.connected") state.probes = freshProbes()
          void read()
        }
      })().catch(() => {
        if (!failed.once && !signal.aborted) log("Vector everywhere lost the engine's event stream.")
        failed.once = true
      })
      if (signal.aborted) return
      await new Promise<void>((done) => {
        const timer = setTimeout(done, RETRY_EVENTS_MS)
        signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true })
      })
    }
  }

  // Legacy hand edits can arrive on the engine event stream. Sidecar preference writes call refresh() directly,
  // since the stream is kept open only while Remote is on.
  const syncEvents = (enabled: boolean) => {
    if (enabled && !state.subscription && state.started && !state.stopped) {
      state.subscription = new AbortController()
      void listen(state.subscription.signal)
    }
    if (!enabled && state.subscription) {
      state.subscription.abort()
      state.subscription = undefined
    }
  }

  const jobs = {
    /** Whether this computer takes jobs now (R-C2): read on every connection decision, so it is synchronous. */
    want: () => current() === "on",
    state: current,
    /**
     * One offer from the relay or from `pending`. It reaches the runner whatever want() says, so a computer that takes
     * no jobs declines `off` at once. The same text twice at once is verified once.
     */
    async offer(text: unknown) {
      if (typeof text !== "string" || offering.has(text) || state.stopped) return false
      offering.add(text)
      const ran = await runner.offer(text).finally(() => offering.delete(text))
      // A job that ran has settled and released its reservation: ask for the next waiting one.
      if (ran) void requestPending()
      return ran
    },
    /** The link's status, through jobsForLink: an online edge asks for waiting jobs. */
    changed(status: RemoteStatus) {
      if (!state.started) return
      const edge = status.state === "online" && !state.online
      state.online = status.state === "online"
      syncEvents(status.enabled)
      const before = state.previous
      evaluate()
      if (edge && before === "on") void requestPending()
    },
    /** Reads settings, folders and probes after a save, even while Remote is off. */
    async refresh() {
      state.folders = new Map()
      state.probes = freshProbes()
      await read()
      return current()
    },
    start(link: EverywhereLink) {
      if (state.started || state.stopped) return
      state.link = link
      state.started = true
      void read()
      syncEvents(link.status().enabled)
    },
    stop() {
      state.stopped = true
      state.previous = "off"
      if (state.interval) clearInterval(state.interval)
      state.interval = undefined
      state.subscription?.abort()
      state.subscription = undefined
      awake?.dispose()
      runner.stop()
    },
  }
  return jobs
}

export type EverywhereJobs = ReturnType<typeof createEverywhereJobs>

const Created = Schema.fromJsonString(
  Schema.Struct({ directory: Schema.String, branch: Schema.String, base: Schema.String }),
)
const Trust = Schema.fromJsonString(Schema.Struct({ trusted: Schema.Boolean }))

/**
 * The runner's SafeWorktree (VE-21, EV-18) over the engine's owner-only POST /experimental/worktree/unattended (EV-13),
 * sent without a guest header or a `directory`, so no instance is loaded for the project. A 403 (the folder is not
 * listed, the project is not open in Vector or not trusted) is WorktreeUnavailable, which the runner settles `held`;
 * anything else that is not exactly `{directory, branch, base}` with an absolute directory fails the job. The new
 * checkout must then be one the engine does not trust (GET /config/trust): an untrusted folder loads none of its own
 * config, formatters or language servers, which a command in it could otherwise rewrite and the engine run outside the
 * sandbox. It never falls back to POST /experimental/worktree.
 */
export function unattendedWorktree(input: {
  readonly url: string
  readonly authorization: string
  readonly fetcher?: typeof fetch
  readonly log?: (message: string) => void
}): SafeWorktree {
  const fetcher = input.fetcher ?? fetch
  const log = (message: string) => input.log?.(message)
  const headers = { authorization: input.authorization, accept: "application/json" }
  return {
    policy: "unattended-v1",
    async create(job) {
      const origin = localEngineOrigin(input.url)
      const response = await fetcher(new URL("/experimental/worktree/unattended", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([job.signal, AbortSignal.timeout(180_000)]),
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ directory: job.directory, base: job.from, branch: job.branch, jid: job.jid }),
      })
      if (response.status === 403) {
        await response.body?.cancel().catch(() => undefined)
        log("Vector everywhere held a job: its repository must be listed, open in Vector and trusted on this computer.")
        throw new WorktreeUnavailable()
      }
      const text = response.ok ? await responseText(response, 64 * 1024) : undefined
      if (!response.ok) await response.body?.cancel().catch(() => undefined)
      const created = Option.getOrUndefined(Schema.decodeUnknownOption(Created)(text, { onExcessProperty: "error" }))
      if (!created || !path.isAbsolute(created.directory)) {
        log("Vector everywhere could not create a job's worktree.")
        throw new Error("The unattended worktree was not created")
      }
      // The scoped trust route loads the checkout into this listener. Private session creation only uses that context.
      const url = new URL("/config/trust", origin)
      url.searchParams.set("directory", created.directory)
      const answer = await fetcher(url, {
        redirect: "error",
        signal: AbortSignal.any([job.signal, AbortSignal.timeout(10_000)]),
        headers,
      })
      const status = answer.ok
        ? Option.getOrUndefined(Schema.decodeUnknownOption(Trust)(await responseText(answer, 64 * 1024)))
        : undefined
      if (!answer.ok) await answer.body?.cancel().catch(() => undefined)
      if (status?.trusted === false) return { directory: created.directory, from: created.base, branch: created.branch }
      log(
        status?.trusted
          ? "Vector everywhere did not use a job's worktree: Vector trusts it, so it would load the checkout's own settings."
          : "Vector everywhere could not check a job's worktree.",
      )
      throw new Error("The unattended worktree is trusted, or its trust could not be read")
    },
  }
}

/**
 * A listed folder's canonical path and default branch: realpath, then the runner's own hardened mapping check, and
 * only for a folder git maps to its repository, origin/HEAD's branch. Anything else is undefined.
 */
export function projectFolder(git: RunnerDeps["git"], log: (message: string) => void = () => {}): ProjectFolder {
  return async (project) => {
    const directory = await realpath(project.directory).catch(() => undefined)
    if (!directory) return undefined
    const repository = git(directory, project.repository, AbortSignal.timeout(10_000))
    if ((await repository.mapping()) !== "mapped") {
      log("Vector everywhere left out a listed folder git does not map to its repository.")
      return undefined
    }
    const answer = await repository
      .run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      .catch(() => "")
    const ref = answer.trim()
    const base = ref.startsWith("origin/") ? ref.slice("origin/".length) : ""
    if (BASE.test(base) && !base.includes("..")) return { directory, base }
    log("Vector everywhere could not read a listed repository's default branch.")
    return undefined
  }
}

/** Whether Vector Local lets the jobs service be reached at all, decided purely (nothing is logged). */
function serviceAllowed(policy: LocalMode.Policy) {
  const source = LocalSources.get("everywhere")
  return (
    source !== undefined &&
    LocalPolicy.decide(policy, { purpose: source.purpose, url: PENDING_URL, source: source.id }).decision === "allow"
  )
}
