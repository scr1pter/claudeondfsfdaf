import { useNavigate } from "@solidjs/router"
import { createSimpleContext } from "@vectordevai/ui/context"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"
import { useGlobal } from "@/context/global"
import { directoryKey } from "@/context/global-sync/utils"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync, type ServerSync } from "@/context/server-sync"
import type { DirectorySync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { Identifier } from "@/utils/id"
import { formatServerError, isLocalSessionNotFoundError, isSessionNotFoundError } from "@/utils/server-errors"
import { sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import {
  adopt,
  claim,
  enqueue,
  lastRunEnded,
  legacyQueues,
  markFailed,
  nextToSend,
  pause,
  release,
  remove,
  resume,
  retry,
  SERVER_LIMIT,
  SESSION_LIMIT,
  serversWithItems,
  type FollowupGate,
  type FollowupItem,
  type FollowupQueue,
  type PauseReason,
  type Refusal,
} from "./followup-model"
import {
  broadcastChannel,
  createFollowupStore,
  drainsSession,
  followupBackend,
  KEEP,
  navigatorLocks,
  type FollowupLocks,
  type FollowupStore,
} from "./followup-store"

/*
 * The follow-up queue's drainer (5.I.1). One drainer per server and window. With Web Locks, the window holding
 * `vector.followup.drain:<server>` sends every session's queue, so a queued message goes out when its turn ends even
 * with the session's page closed, while one Vector window is open. Each send runs under
 * `vector.followup.send:<server>:<session>`, so a send the user starts from another window never doubles one in flight.
 */

/** What a drainer needs from the server it drains; the app wires it to the server sync, the tests to fakes. */
export type DrainEnv = {
  /** The directory bootstrap (agents, commands, config, session statuses) has loaded and the server answers health. */
  ready(item: FollowupItem): boolean
  /** Loads the session (`serverSync.session.sync`); rejects with a not-found error when the session is gone. */
  sync(sessionID: string): Promise<void>
  gate(item: FollowupItem): Omit<FollowupGate, "sending">
  /** sendFollowupDraft with this message ID. */
  send(item: FollowupItem, messageID: string): Promise<boolean>
  /** Whether the engine already has the message a claim named. */
  delivered(item: FollowupItem, messageID: string): Promise<boolean>
  notFound(error: unknown, sessionID: string): boolean
  failed(item: FollowupItem, error: unknown): void
  paused(sessionID: string, reason: PauseReason, lastRunID: string | undefined): void
  messageID(): string
  now(): number
}

export type DrainResult = "sent" | "delivered" | "dropped" | "failed" | "held" | "waiting" | "busy" | "empty"

export type FollowupDrain = ReturnType<typeof createFollowupDrain>

export const drainLock = (server: string) => `vector.followup.drain:${server}`
export const sendLock = (server: string, session: string) => `vector.followup.send:${server}:${session}`

/**
 * Holds a Web Lock until released, telling `held` when it is granted and when it ends. A release before the grant gives
 * the lock straight back.
 */
export function holdLock(locks: FollowupLocks, name: string, held: (value: boolean) => void) {
  let disposed = false
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  void locks
    .request(name, async () => {
      if (disposed) return
      held(true)
      await released
      held(false)
    })
    .catch(() => held(false))
  return () => {
    disposed = true
    release()
  }
}

/** The drainer itself, free of Solid so the tests drive it directly. */
export function createFollowupDrain(input: {
  server: string
  store: FollowupStore
  locks?: FollowupLocks
  env: DrainEnv
  /** Sessions this window shows; without Web Locks only these drain. */
  showing?: () => ReadonlySet<string>
  onHolding?: (holding: boolean) => void
  onSending?: (session: string, id: string | undefined) => void
}) {
  const { server, store, env } = input
  const running = new Set<string>()
  const again = new Set<string>()
  let holding = false
  let disposed = false
  let releaseDrain: (() => void) | undefined

  const update = store.update.bind(store, server)

  const exclusive = async <T,>(session: string, run: () => Promise<T>): Promise<T | undefined> => {
    if (!input.locks) return run()
    let result: T | undefined
    await input.locks.request(sendLock(server, session), { ifAvailable: true }, async (lock) => {
      if (lock) result = await run()
    })
    return result
  }

  const fail = async (item: FollowupItem, error: unknown): Promise<DrainResult> => {
    if (env.notFound(error, item.sessionID)) {
      await update(item.sessionID, () => undefined)
      return "dropped"
    }
    await update(item.sessionID, (current) => markFailed(current, item.id) ?? KEEP)
    env.failed(item, error)
    return "failed"
  }

  const deliver = async (head: FollowupItem): Promise<DrainResult> => {
    const session = head.sessionID
    let messageID: string
    if (head.claim) {
      // We hold this session's send lock, so the claim is from a send that never finished (a reload, a crash, a failure).
      const delivered = await env.delivered(head, head.claim.messageID).catch((error: unknown) => error)
      if (delivered instanceof Error || typeof delivered !== "boolean") return fail(head, delivered)
      if (delivered) {
        await update(session, (current) => remove(current, head.id))
        return "delivered"
      }
      messageID = head.claim.messageID
    } else {
      const fresh = env.messageID()
      let claimed = false
      await update(session, (current) => {
        const item = current?.items.find((entry) => entry.id === head.id)
        if (!current || !item || item.claim) return KEEP
        claimed = true
        return claim(current, head.id, fresh, env.now()) ?? KEEP
      })
      if (!claimed) return "held"
      messageID = fresh
    }

    input.onSending?.(session, head.id)
    try {
      const sent = await env.send(head, messageID)
      if (!sent) {
        await update(session, (current) => release(current, head.id) ?? KEEP)
        return "held"
      }
      await update(session, (current) => remove(current, head.id))
      return "sent"
    } catch (error) {
      return fail(head, error)
    } finally {
      input.onSending?.(session, undefined)
    }
  }

  const step = async (session: string, manual: string | undefined): Promise<DrainResult> => {
    const queue = await store.read(server, session)
    const head = manual === undefined ? queue?.items[0] : queue?.items.find((item) => item.id === manual)
    if (!queue || !head) return "empty"
    if (!env.ready(head)) return "waiting"
    try {
      await env.sync(session)
    } catch (error) {
      if (!env.notFound(error, session)) return "waiting"
      await update(session, () => undefined)
      return "dropped"
    }
    const gate = { ...env.gate(head), sending: false }
    if (manual !== undefined) {
      if (gate.child) return "held"
      // Send now and Retry are the user resuming the queue: the pause, the failure and the last run's ending go.
      await update(session, (current) => retry(current, gate.lastRun.id) ?? KEEP)
      return deliver(head)
    }
    const next = nextToSend(queue, gate)
    if ("send" in next) return deliver(next.send)
    if (next.hold === "ended") {
      const reason = next.reason
      await update(session, (current) => pause(current, reason, env.now()) ?? KEEP)
      env.paused(session, reason, gate.lastRun.id)
    }
    return "held"
  }

  const attempt = async (session: string, manual?: string): Promise<DrainResult> => {
    if (disposed) return "held"
    if (
      manual === undefined &&
      !drainsSession({ locked: !!input.locks, holding, showing: input.showing?.() ?? new Set() }, session)
    )
      return "held"
    if (running.has(session)) {
      if (manual === undefined) again.add(session)
      return "busy"
    }
    running.add(session)
    try {
      return (await exclusive(session, () => step(session, manual))) ?? "busy"
    } catch {
      return "failed"
    } finally {
      running.delete(session)
      if (again.delete(session)) void attempt(session)
    }
  }

  return {
    /** Takes the server's drain lock (a no-op without Web Locks, where the pages shown drain). */
    start() {
      if (!input.locks || releaseDrain || disposed) return
      releaseDrain = holdLock(input.locks, drainLock(server), (value) => {
        holding = value && !disposed
        input.onHolding?.(holding)
      })
    },
    dispose() {
      disposed = true
      releaseDrain?.()
      releaseDrain = undefined
      if (holding) {
        holding = false
        input.onHolding?.(false)
      }
    },
    holding: () => holding,
    /** Sends a session's head when its gate opens. Safe to call often: a held queue returns without writing. */
    attempt: (session: string) => attempt(session),
    /** Send now or Retry: sends that item even while the session works, which steers the running turn. */
    async send(session: string, id: string) {
      const result = await attempt(session, id)
      return result === "sent" || result === "delivered"
    },
  }
}

/**
 * sendFollowupDraft as the drainer sends an item. From an idle session the session reads busy until the engine says
 * otherwise, so the next item waits for this turn to end. Send now and Retry while the session works steer the running
 * turn instead: that send marks nothing busy, and when it fails it never shows the running session idle (5.I.1).
 */
export function sendQueued(input: {
  client: Parameters<typeof sendFollowupDraft>[0]["client"]
  sync: DirectorySync
  serverSync: ServerSync
  item: FollowupItem
  messageID: string
}) {
  const steering = input.serverSync.session.data.session_working(input.item.sessionID)
  return sendFollowupDraft({
    client: input.client,
    sync: input.sync,
    serverSync: input.serverSync,
    draft: input.item,
    messageID: input.messageID,
    optimisticBusy: !steering,
  })
}

/** The item a draft becomes when it is queued: always mid-session, so it is marked replied (no repository file map). */
export function queuedItem(draft: FollowupDraft, id = Identifier.ascending("message")): FollowupItem {
  return { ...draft, replied: true, id }
}

/** A refused enqueue's toast. */
function refusalToast(
  refusal: Refusal | "failed",
  t: (key: string, params?: Record<string, string | number>) => string,
  error?: unknown,
) {
  if (refusal === "failed")
    return showToast({
      variant: "error",
      title: t("followup.toast.saveFailed.title"),
      description: formatServerError(error, t),
    })
  if (refusal === "attachments")
    return showToast({
      variant: "error",
      title: t("followup.toast.attachments.title"),
      description: t("followup.toast.attachments.description"),
    })
  showToast({
    variant: "error",
    title: t("followup.toast.full.title"),
    description:
      refusal === "session"
        ? t("followup.toast.full.session", { count: SESSION_LIMIT })
        : t("followup.toast.full.server", { count: SERVER_LIMIT }),
  })
}

function createFollowups() {
  const platform = usePlatform()
  const language = useLanguage()
  const store = createFollowupStore({
    backend: followupBackend(platform),
    locks: navigatorLocks(),
    channel: broadcastChannel(),
  })
  onCleanup(store.close)

  const [state, setState] = createStore({
    queues: {} as Record<string, Record<string, FollowupQueue | undefined> | undefined>,
    loaded: false,
    showing: {} as Record<string, Record<string, number | undefined> | undefined>,
    sending: {} as Record<string, Record<string, string | undefined> | undefined>,
  })

  const put = (server: string, session: string, queue: FollowupQueue | undefined) =>
    setState(
      "queues",
      produce((draft) => {
        draft[server] ??= {}
        const sessions = draft[server]!
        if (queue) sessions[session] = queue
        else delete sessions[session]
        if (Object.keys(sessions).length === 0) delete draft[server]
      }),
    )

  // A queue another window (or this one) changed is read again; only the newest read of a queue lands.
  const reads = new Map<string, number>()
  const touched = new Set<string>()
  const reload = (server: string, session: string) => {
    const key = `${server}\0${session}`
    const seq = (reads.get(key) ?? 0) + 1
    reads.set(key, seq)
    touched.add(key)
    void store
      .read(server, session)
      .then((queue) => {
        if (reads.get(key) === seq) put(server, session, queue)
      })
      .catch(() => undefined)
  }
  onCleanup(store.subscribe((change) => reload(change.server, change.session)))

  void store
    .load()
    .then((all) => {
      for (const [server, sessions] of Object.entries(all))
        for (const [session, queue] of Object.entries(sessions))
          if (!touched.has(`${server}\0${session}`)) put(server, session, queue)
    })
    .catch(() => undefined)
    .finally(() => setState("loaded", true))

  const drains = new Map<string, FollowupDrain>()
  const queueOf = (server: string, session: string) => state.queues[server]?.[session]
  const total = (server: string) =>
    Object.values(state.queues[server] ?? {}).reduce((sum, queue) => sum + (queue?.items.length ?? 0), 0)

  return {
    store,
    /** False until the stored queues have been read. */
    loaded: () => state.loaded,
    /** Whether queues drain with their page closed (Web Locks); otherwise only the page showing a session drains. */
    locked: store.locked,
    queue: queueOf,
    items: (server: string, session: string) => queueOf(server, session)?.items ?? [],
    /** Sessions of a server that have queued items. */
    sessions: (server: string) =>
      Object.entries(state.queues[server] ?? {})
        .filter(([, queue]) => (queue?.items.length ?? 0) > 0)
        .map(([session]) => session),
    servers: () => serversWithItems(state.queues),
    sending: (server: string, session: string) => state.sending[server]?.[session],
    setSending: (server: string, session: string, id: string | undefined) =>
      setState("sending", server, (current) => ({ ...(current ?? {}), [session]: id })),
    /**
     * Queues a draft behind the session's others, marked replied (it is always queued mid-session). Refusals and
     * storage errors show a toast; the answer is undefined when it was queued.
     */
    async enqueue(server: string, draft: FollowupDraft): Promise<Refusal | "failed" | undefined> {
      const item = queuedItem(draft)
      let refused: Refusal | undefined
      const error = await store
        .update(server, draft.sessionID, (current, context) => {
          const result = enqueue(current, item, context.total)
          if ("refused" in result) {
            refused = result.refused
            return KEEP
          }
          return result.queue
        })
        .then(
          () => undefined,
          (cause: unknown) => cause ?? new Error("storage"),
        )
      if (error) {
        refusalToast("failed", language.t, error)
        return "failed"
      }
      if (refused) refusalToast(refused, language.t)
      return refused
    },
    /** What enqueue would refuse, from this window's copy, so the composer can keep the text it would lose. */
    refusal(server: string, draft: FollowupDraft): Refusal | undefined {
      const result = enqueue(queueOf(server, draft.sessionID), { ...draft, id: "" }, total(server))
      if (!("refused" in result)) return
      refusalToast(result.refused, language.t)
      return result.refused
    },
    remove: (server: string, session: string, id: string) =>
      store.update(server, session, (current) => remove(current, id)).catch(() => undefined),
    pause: (server: string, session: string, reason: PauseReason) =>
      store.update(server, session, (current) => pause(current, reason, Date.now()) ?? KEEP).catch(() => undefined),
    resume: (server: string, session: string, lastRunID?: string) =>
      store.update(server, session, (current) => resume(current, lastRunID) ?? KEEP).catch(() => undefined),
    /** Send now or Retry from the dock. False when nothing went out (no drainer, the item gone, another send). */
    send(server: string, session: string, id: string) {
      const drain = drains.get(server)
      if (!drain) return Promise.resolve(false)
      return drain.send(session, id)
    },
    /** Moves an older page's `followup.v1` queues into this store; how many sessions it moved. */
    async adoptLegacy(server: string, legacy: unknown) {
      const queues = legacyQueues(legacy)
      for (const [session, queue] of Object.entries(queues))
        await store.update(server, session, (current, context) => adopt(current, queue, context.total) ?? KEEP)
      return Object.keys(queues).length
    },
    /** A page shows this session: without Web Locks, only shown sessions drain. */
    showing(server: string, session: string) {
      setState("showing", server, (current) => ({ ...(current ?? {}), [session]: (current?.[session] ?? 0) + 1 }))
      return () =>
        setState("showing", server, (current) => ({ ...(current ?? {}), [session]: (current?.[session] ?? 1) - 1 }))
    },
    shown: (server: string) =>
      new Set(
        Object.entries(state.showing[server] ?? {})
          .filter(([, count]) => (count ?? 0) > 0)
          .map(([session]) => session),
      ),
    registerDrain(server: string, drain: FollowupDrain) {
      drains.set(server, drain)
      return () => {
        if (drains.get(server) === drain) drains.delete(server)
      }
    },
  }
}

export type Followups = ReturnType<typeof createFollowups>

export const { use: useFollowups, provider: FollowupProvider } = createSimpleContext({
  name: "Followups",
  gate: false,
  init: createFollowups,
})

/** Why a queue paused, as the toast and the dock say it. */
export function pausedText(reason: PauseReason, t: (key: string) => string) {
  return t(`followup.paused.${reason}`)
}

/** One server's drainer, mounted under that server's SDK and sync providers. */
function ServerDrain() {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const global = useGlobal()
  const followups = useFollowups()
  const language = useLanguage()
  const navigate = useNavigate()
  const server = untrack(() => ServerConnection.key(serverSDK().server))

  const [holding, setHolding] = createSignal(false)
  // The directory syncs this drainer holds. A map, not a store: a store would wrap their proxies.
  const directories = new Map<string, DirectorySync>()
  const [held, setHeld] = createSignal(0)
  const directoryOf = (path: string) => {
    held()
    return directories.get(directoryKey(path))
  }

  const env: DrainEnv = {
    ready(item) {
      if (!global.servers.health[server as ServerConnection.Key]?.healthy) return false
      return directoryOf(item.sessionDirectory)?.status === "complete"
    },
    sync: (sessionID) => serverSync().session.sync(sessionID),
    gate(item) {
      const sync = serverSync()
      const info = sync.session.get(item.sessionID)
      const sessions = directoryOf(info?.directory ?? item.sessionDirectory)?.data.session ?? []
      return {
        busy: sync.session.data.session_working(item.sessionID),
        blocked:
          !!sessionPermissionRequest(sessions, sync.session.data.permission, item.sessionID) ||
          !!sessionQuestionRequest(sessions, sync.session.data.question, item.sessionID),
        child: !!info?.parentID,
        lastRun: lastRunEnded(sync.session.data.message[item.sessionID]),
      }
    },
    send(item, messageID) {
      const sync = directoryOf(item.sessionDirectory)
      if (!sync) return Promise.reject(new Error("The session's folder is not loaded"))
      return sendQueued({
        client: serverSDK().createClient({ directory: item.sessionDirectory, throwOnError: true }),
        sync,
        serverSync: serverSync(),
        item,
        messageID,
      })
    },
    async delivered(item, messageID) {
      if ((serverSync().session.data.message[item.sessionID] ?? []).some((message) => message.id === messageID))
        return true
      const result = await serverSDK()
        .createClient({ directory: item.sessionDirectory, throwOnError: false })
        .session.message({ sessionID: item.sessionID, messageID }, { throwOnError: false })
      if (result.data) return true
      if (result.response?.status === 404) return false
      throw result.error instanceof Error ? result.error : new Error(language.t("common.requestFailed"))
    },
    notFound: (error, sessionID) =>
      isSessionNotFoundError(error, sessionID) || isLocalSessionNotFoundError(error, sessionID),
    failed(item, error) {
      showToast({
        variant: "error",
        title: language.t("followup.toast.failed.title"),
        description: formatServerError(error, language.t),
        actions: [
          {
            label: language.t("followup.toast.openSession"),
            onClick: () => navigate(sessionHref(server as ServerConnection.Key, item.sessionID)),
          },
        ],
      })
    },
    paused(sessionID, reason, lastRunID) {
      showToast({
        title: language.t("followup.toast.paused.title", { reason: pausedText(reason, language.t) }),
        actions: [
          {
            label: language.t("followup.toast.resume"),
            onClick: () => void followups.resume(server, sessionID, lastRunID),
          },
          {
            label: language.t("followup.toast.openSession"),
            onClick: () => navigate(sessionHref(server as ServerConnection.Key, sessionID)),
          },
        ],
      })
    },
    messageID: () => Identifier.ascending("message"),
    now: () => Date.now(),
  }

  const drain = createFollowupDrain({
    server,
    store: followups.store,
    locks: navigatorLocks(),
    env,
    showing: () => untrack(() => followups.shown(server)),
    onHolding: setHolding,
    onSending: (session, id) => followups.setSending(server, session, id),
  })
  onCleanup(followups.registerDrain(server, drain))
  drain.start()
  onCleanup(drain.dispose)

  const sessions = createMemo(() => followups.sessions(server), [], {
    equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]),
  })
  const paths = createMemo(
    () => [
      ...new Set(
        sessions().flatMap((session) => followups.items(server, session).map((item) => item.sessionDirectory)),
      ),
    ],
    [],
    { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) },
  )

  // Sessions with queued items keep their messages loaded, so their last run's ending stays readable.
  createEffect(
    on(sessions, (list) => {
      const sync = untrack(serverSync)
      for (const session of list) {
        sync.session.pin(session)
        onCleanup(() => sync.session.unpin(session))
      }
    }),
  )

  // Wakes the drainer whenever a queue's gate may have opened; a held queue costs no storage read.
  createEffect(() => {
    const shown = followups.locked ? undefined : followups.shown(server)
    if (followups.locked && !holding()) return
    for (const session of sessions()) {
      if (shown && !shown.has(session)) continue
      const queue = followups.queue(server, session)
      const head = queue?.items[0]
      if (!head || !env.ready(head)) continue
      const next = nextToSend(queue, { ...env.gate(head), sending: !!followups.sending(server, session) })
      if ("send" in next || next.hold === "ended") untrack(() => void drain.attempt(session))
    }
  })

  return (
    <For each={paths()}>
      {(path) => {
        // Holding the directory's sync keeps its bootstrap (agents, commands, config, statuses) loaded and current.
        const sync = serverSync().ensureDirSyncContext(path)
        const key = directoryKey(path)
        directories.set(key, sync)
        setHeld((count) => count + 1)
        onCleanup(() => {
          if (directories.get(key) === sync) directories.delete(key)
          setHeld((count) => count + 1)
        })
        return null
      }}
    </For>
  )
}

function DrainFor(props: { conn: ServerConnection.Any }) {
  return (
    <ServerSDKProvider server={() => props.conn}>
      <ServerSyncProvider server={() => props.conn}>
        <ServerDrain />
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

/** Drainers for the servers that are not selected, mounted only while they have queued items. */
export function FollowupBackgroundDrains() {
  const global = useGlobal()
  const server = useServer()
  const followups = useFollowups()
  const keys = createMemo(
    () => {
      const queued = new Set(followups.servers())
      return global.servers
        .list()
        .map((conn) => ServerConnection.key(conn))
        .filter((key) => key !== server.key && queued.has(key))
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) },
  )
  return (
    <For each={keys()}>
      {(key) => (
        <Show when={global.servers.list().find((conn) => ServerConnection.key(conn) === key)} keyed>
          {(conn) => <DrainFor conn={conn} />}
        </Show>
      )}
    </For>
  )
}

/** The selected server's drainer and the background ones. Mounted once, in the router root. */
export function FollowupDrains(): JSX.Element {
  const server = useServer()
  return (
    <>
      <Show when={server.current} keyed>
        {(conn) => <DrainFor conn={conn} />}
      </Show>
      <FollowupBackgroundDrains />
    </>
  )
}

/** The queue's store and drainers for the whole app. */
export function FollowupQueueProvider(props: ParentProps) {
  return (
    <FollowupProvider>
      {props.children}
      <FollowupDrains />
    </FollowupProvider>
  )
}
