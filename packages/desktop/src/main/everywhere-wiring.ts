import { realpath } from "node:fs/promises"
import { Option, Schema } from "effect"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { ACCOUNT_ID_PATTERN } from "@vectordevai/schema/everywhere"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { createEverywhereEngine } from "./everywhere-engine"
import { createEverywhereGit } from "./everywhere-git"
import { createLedger, ledgerFile, type JobLedger } from "./everywhere-ledger"
import { createOfferVerifier, OFFER_KEYS } from "./everywhere-offer"
import {
  createEverywhereJobsClient,
  createEverywhereRunner,
  localAllows,
  type JobsClient,
  type RunnerDeps,
  type RunnerSettings,
  type SafeWorktree,
} from "./everywhere-runner"
import type { LinkDependencies, RemoteLink, RemoteState, RemoteStatus } from "./remote-link"
import { tokenClaims } from "./vector-account"

// Vector everywhere in the running app (VE-21, R-C2, R-C3): the jobs subscriber Vector Remote's link takes, and the
// runner behind it. Electron-free, so its tests run under Bun; remote-runtime.ts supplies the Electron pieces.
//
// - Settings come only from the engine's GET /global/config (the user's own files), read again whenever the engine
//   says its global config changed (`global.disposed`) or its event stream (re)connects. A company lock on the key, a
//   block that does not decode and an unreadable answer are all off.
// - "Takes jobs" (`want()`) is on only while the setting is on and Remote is on with an identity. Without an identity
//   the state is `needs-remote` and nothing is created: the settings page asks for consent and turns Remote on.
// - While on, waiting jobs are asked for (`pending`) when the link comes online, after every job the runner ran, after
//   the last run's leases are recovered, and every five minutes, but only while the link is online or connecting: a
//   Remote the service paused, revoked or refused takes no job over HTTP either. Off stops every timer.
// - Every offer, by relay or by `pending`, is verified against the pinned OFFER_KEYS (empty until the owner's key
//   handoff, so every offer is refused) and the ledger's replay record before anything is sent (E9).
// - The runner gets no safe worktree here (EV-18 supplies it), so a claimed job settles `held` before any session,
//   fetch, commit or push.

export type EverywhereJobsState = "off" | "needs-remote" | "on"
export type EverywhereLink = Pick<RemoteLink, "status" | "device" | "jobsChanged">
export type EverywhereSettings = RunnerSettings & { readonly waitForComputer: boolean; readonly stayAwake: boolean }
type Project = { readonly directory: string; readonly repository: string }
export type ProjectFolder = (
  project: Project,
) => Promise<{ readonly directory: string; readonly base: string } | undefined>

export type EverywhereJobsDeps = {
  /** The local engine over its authenticated loopback server, with the owner's credentials. */
  readonly engine: { readonly url: string; readonly password: string }
  /** The desktop sign-in (vectorAccount.token). One that cannot be read counts as none. */
  readonly token: () => Promise<string | undefined>
  /** The engine's GET /global/event stream; subscribed only while Remote is on. */
  readonly events: (signal: AbortSignal) => AsyncIterable<{ readonly payload: { readonly type: string } }>
  /** The runner's private ledger file, absolute, under the app's user data. */
  readonly ledgerPath: string
  /** Fixed text only. */
  readonly log?: (message: string) => void
  // Test seams; remote-runtime.ts passes none of them.
  /** Default OFFER_KEYS. */
  readonly keys?: Readonly<Record<string, string>>
  /** Default: the ledger file at ledgerPath. */
  readonly ledger?: JobLedger
  /** The jobs service's address and fetcher. Default vectordev.ai through Egress. */
  readonly service?: { readonly url?: string; readonly fetcher?: typeof fetch }
  /** The fetcher for the engine's config route. */
  readonly fetcher?: typeof fetch
  readonly git?: RunnerDeps["git"]
  readonly runnerEngine?: RunnerDeps["engine"]
  /**
   * EV-18's slot. Absent, every claimed job settles `held` before any session. It must not be passed until EV-16's
   * three preconditions hold (formatters, LSP and config reloads off for an unattended session; the home folder's
   * other secrets; GIT_HARDENING on every git call EV-18 adds), and RunnerSettings.rules is filled. EV-14's mark
   * precondition is met: PATCH /session/:id refuses to drop `vector.unattended` (EV-16).
   */
  readonly safeWorktree?: SafeWorktree
  readonly localPolicy?: RunnerDeps["localPolicy"]
  readonly now?: () => number
}

const PENDING_EVERY_MS = 5 * 60_000
const RETRY_EVENTS_MS = 5_000
/** The runner's own base rule (everywhere-git.ts fetch). */
const BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
/** The settings' own cap; the merged config could list more (EV-10, Coordination). */
const MAX_PROJECTS = 64
const PENDING_SLOTS = 32
const PENDING_URL = "https://vectordev.ai/api/everywhere/jobs/pending"

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
  const ledger = deps.ledger ?? createLedger({ ...ledgerFile(deps.ledgerPath), now })
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
  }
  const offering = new Set<string>()
  const resolve = projectFolder(git, log)

  const fetchSettings = async () => {
    const global = await (deps.fetcher ?? fetch)(new URL("/global/config", deps.engine.url), {
      headers: { authorization, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .catch(() => undefined)
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
    state.settings = await everywhereSettings(global, (project) => {
      const key = `${project.directory}\0${project.repository}`
      const found = cache.get(key) ?? resolve(project)
      cache.set(key, found)
      return found
    })
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
      deps.runnerEngine ?? ((directory) => createEverywhereEngine({ url: deps.engine.url, directory, authorization })),
    safeWorktree: deps.safeWorktree,
    // Push-path stand-ins until the GitHub calls are wired: never private, so a committed branch stays held.
    privateRepository: async () => false,
    openPr: async () => undefined,
    now,
    localPolicy: deps.localPolicy,
    log,
  })

  const current = (): EverywhereJobsState => {
    if (state.stopped || !state.settings.enabled) return "off"
    return state.link?.status().enabled && state.link.device() ? "on" : "needs-remote"
  }

  // Acts only on a change of state. The link is told in a microtask, never inside its own status emission.
  const evaluate = () => {
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
      // EV-18 sets it from the engine's offline shell probe.
      sandbox: false,
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

  // The settings page writes through PATCH /global/config, which emits `global.disposed`. The stream carries every
  // session event, so it is kept open only while Remote is on: without Remote no job can run anyway.
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
    /** Reads the settings again now (the settings page, after it writes while Remote is off). */
    async refresh() {
      state.folders = new Map()
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
      runner.stop()
    },
  }
  return jobs
}

export type EverywhereJobs = ReturnType<typeof createEverywhereJobs>

/**
 * RunnerSettings from GET /global/config's answer (EV-10, Coordination for EV-17). Only the user's own files reach that
 * route. Locked, undecodable or absent is off, and an off block resolves no folder at all. Each listed folder goes
 * through `folder` (canonical path and default branch); one it cannot resolve is dropped, so its jobs decline
 * `not-mapped`. The same folder under two spellings is kept once.
 */
export async function everywhereSettings(global: unknown, folder: ProjectFolder): Promise<EverywhereSettings> {
  const answer = typeof global === "object" && global !== null ? (global as Record<string, unknown>) : {}
  // A company lock on the key turns it off; an answer without the list is read as locked.
  const locked = !Array.isArray(answer.locked) || answer.locked.includes("everywhere")
  const info = Option.getOrUndefined(Schema.decodeUnknownOption(ConfigEverywhereV1.Info)(answer.everywhere))
  const enabled = info?.enabled === true && !locked
  const defaults = ConfigEverywhereV1.Defaults
  const model = info?.model
  const slash = model?.indexOf("/") ?? -1
  return {
    ...offSettings(),
    enabled,
    maxUsd: info?.max_usd ?? defaults.max_usd,
    minutes: info?.minutes ?? defaults.minutes,
    atOnce: info?.at_once ?? defaults.at_once,
    perDay: info?.per_day ?? defaults.per_day,
    push: info?.push ?? defaults.push,
    waitForComputer: info?.wait_for_computer ?? defaults.wait_for_computer,
    stayAwake: info?.stay_awake ?? defaults.stay_awake,
    ...(model && slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
    projects: enabled ? await resolveProjects(info?.projects ?? [], folder) : [],
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
      log("Vector everywhere left out a project folder git does not map to its repository.")
      return undefined
    }
    const answer = await repository
      .run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      .catch(() => "")
    const ref = answer.trim()
    const base = ref.startsWith("origin/") ? ref.slice("origin/".length) : ""
    if (BASE.test(base) && !base.includes("..")) return { directory, base }
    log("Vector everywhere could not read a project's default branch.")
    return undefined
  }
}

// One folder at a time, so a long list never starts dozens of git processes at once.
async function resolveProjects(projects: readonly Project[], folder: ProjectFolder) {
  const kept: RunnerSettings["projects"][number][] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (kept.length >= MAX_PROJECTS) break
    const found = await folder(project).catch(() => undefined)
    if (!found) continue
    // realpath resolves links; a case-insensitive disk (the macOS and Windows default) still has two spellings.
    const key =
      process.platform === "win32" || process.platform === "darwin" ? found.directory.toLowerCase() : found.directory
    if (seen.has(key)) continue
    seen.add(key)
    kept.push({ directory: found.directory, repository: project.repository, base: found.base })
  }
  return kept
}

function offSettings(): EverywhereSettings {
  const defaults = ConfigEverywhereV1.Defaults
  return {
    enabled: false,
    // 2026-11-16 (EV-17): no up-front model check; a guest prompt to a model that may train is refused by the engine.
    modelAllowed: true,
    maxUsd: defaults.max_usd,
    minutes: defaults.minutes,
    atOnce: defaults.at_once,
    perDay: defaults.per_day,
    push: defaults.push,
    waitForComputer: defaults.wait_for_computer,
    stayAwake: defaults.stay_awake,
    projects: [],
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
