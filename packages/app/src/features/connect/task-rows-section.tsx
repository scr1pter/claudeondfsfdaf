import "./task-rows.css"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Connect } from "@vectordevai/schema/connect"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { createConnectClient } from "./client"
import { cancelTaskRow, readTaskRows, type TaskRow } from "./task-rows"

/** Progress lines each publish `connect.run.updated`; one owner read per window keeps the runs list current. */
const REFRESH_MS = 500

type Key = {
  client: ReturnType<typeof createConnectClient>
  rootID: string
  reconnect: number
  epoch: symbol
}

/**
 * The conversation's own connected runs in the Background tasks pane. Rows come only from a successful owner read
 * for the current client, root, stream and authority epoch, and a later read that fails without a refusal keeps them;
 * anything else shows nothing. A click can only cancel. `onRows` hears how many rows are shown whenever that changes
 * (0 while hidden, refused or off, and when the section unmounts), so the pane's empty state can step aside (CN-12).
 */
export function ConnectTaskRows(props: {
  rootID: string | undefined
  connections: boolean
  onRows?: (count: number) => void
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const sync = useSync()
  const client = createMemo(() => createConnectClient(sdk().client))
  const [epoch, setEpoch] = createSignal(Symbol())
  const [blocked, setBlocked] = createSignal<Key>()
  const [cancelling, setCancelling] = createSignal<string>()
  const [notice, setNotice] = createSignal<{ id: TaskRow["id"]; outcome: "ended" | "failed" }>()
  let pending: AbortController | undefined
  // The last successful read's members and rows, for its key only.
  let last: { key: Key; members: readonly Connect.Member[]; rows: readonly TaskRow[] } | undefined
  let disposed = false
  // A pending revert makes the engine refuse the read, so none is made until it is settled.
  const key = createMemo<Key | undefined>(
    () => {
      const rootID = props.rootID
      if (!props.connections || !rootID || sync().session.get(rootID)?.revert) return undefined
      return { client: client(), rootID, reconnect: serverSync().reconnects(), epoch: epoch() }
    },
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (!!a &&
          !!b &&
          a.client === b.client &&
          a.rootID === b.rootID &&
          a.reconnect === b.reconnect &&
          a.epoch === b.epoch),
    },
  )
  // After a refusal this client makes no more owner reads until the key changes; a failure without one blocks nothing.
  const source = createMemo(() => {
    const current = key()
    return current && current !== blocked() ? current : undefined
  })
  const [data, { refetch }] = createResource(source, async (input) => {
    pending?.abort()
    const abort = new AbortController()
    pending = abort
    const read = await readTaskRows({
      client: input.client,
      sessionID: input.rootID,
      connections: props.connections,
      members: last?.key === input ? last.members : undefined,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    })
    if (disposed || abort.signal.aborted || input !== key()) return { key: input, rows: [] as readonly TaskRow[] }
    // A dropped or timed-out read keeps this key's last rows; the next connect.run.updated event reads again.
    if (read === "failed") return { key: input, rows: last?.key === input ? last.rows : [] }
    if (!read || read === "refused") {
      setBlocked(input)
      return { key: input, rows: [] as readonly TaskRow[] }
    }
    last = { key: input, members: read.members, rows: read.rows }
    return { key: input, rows: read.rows }
  })
  const retire = () => {
    pending?.abort()
    last = undefined
    setCancelling(undefined)
    setNotice(undefined)
    setEpoch(Symbol())
  }
  onCleanup(() => {
    disposed = true
    pending?.abort()
  })
  // `latest` suspends before the first answer, so it is read only once one has landed.
  const rows = createMemo((): readonly TaskRow[] => {
    if (data.state !== "ready" && data.state !== "refreshing") return []
    const loaded = data.latest
    return loaded && loaded.key === source() ? loaded.rows : []
  })
  createEffect(() => props.onRows?.(rows().length))
  onCleanup(() => props.onRows?.(0))
  // A notice lasts only while its run is listed; "could not cancel" also ends with the run.
  const noticeText = createMemo(() => {
    const current = notice()
    const row = current && rows().find((shown) => shown.id === current.id)
    if (!current || !row) return ""
    if (current.outcome === "ended") return "This run had already ended."
    return row.cancellable ? "Could not cancel this run." : ""
  })
  createEffect(() => {
    const server = serverSDK()
    const directory = sdk().directory
    const stop = server.event.listen((event) => {
      if (server !== serverSDK()) return
      if (
        (event.name === "global" &&
          (event.details.type === "server.connected" || event.details.type === "global.disposed")) ||
        (event.name === directory && event.details.type === "server.instance.disposed")
      )
        retire()
    })
    onCleanup(stop)
  })
  createEffect(() => {
    const current = source()
    if (!current) return
    const active = sdk()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = active.event.on("connect.run.updated", (event) => {
      if (event.properties.sessionID !== current.rootID || timer) return
      // Events only invalidate the owner read; their payload never becomes a row.
      timer = setTimeout(() => {
        timer = undefined
        if (source() === current) void refetch()
      }, REFRESH_MS)
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  })
  const cancel = async (row: TaskRow) => {
    const current = source()
    if (disposed || !current || cancelling() || !rows().some((shown) => shown.id === row.id)) return
    setCancelling(row.id)
    setNotice(undefined)
    // A hung cancel times out as "failed", so the Cancel buttons never stay disabled.
    const outcome = await cancelTaskRow({
      client: current.client,
      sessionID: current.rootID,
      row,
      signal: AbortSignal.timeout(30_000),
    })
    if (cancelling() === row.id) setCancelling(undefined)
    if (disposed || source() !== current) return
    if (outcome !== "cancelled") setNotice({ id: row.id, outcome })
    void refetch()
  }
  return (
    <Show when={rows().length > 0}>
      <section
        class="vector-bg-tasks-section vector-connect-task-rows"
        data-component="connect-task-rows"
        aria-labelledby="vector-bg-tasks-connect-label"
      >
        <div class="vector-bg-tasks-section-head">
          <h3 id="vector-bg-tasks-connect-label" class="vector-bg-tasks-section-label">
            Connected tools
          </h3>
        </div>
        <ul class="vector-bg-tasks-shell-list" aria-label="Connected tool runs">
          {/* Keyed by run id, so a refresh keeps each row's DOM and focus with its own run. */}
          <For each={rows().map((row) => row.id)}>
            {(id) => (
              <Show when={rows().find((row) => row.id === id)}>
                {(row) => (
                  <li class="vector-bg-tasks-shell" data-status={row().tone}>
                    <p class="vector-connect-task-title">
                      {row().title} · {row().action}
                    </p>
                    <p class="vector-bg-tasks-meta">
                      <span class="vector-bg-tasks-card-status" data-status={row().tone}>
                        {row().status}
                      </span>
                      <Show when={row().verdict}>{(verdict) => <span>{verdict()}</span>}</Show>
                      <Show when={row().spend}>{(spend) => <span>{spend()}</span>}</Show>
                    </p>
                    <p class="vector-connect-task-line">{row().sendsTo}</p>
                    <Show when={row().detail}>{(detail) => <p class="vector-connect-task-line">{detail()}</p>}</Show>
                    <Show when={row().cancellable}>
                      <div class="vector-bg-tasks-actions">
                        <button type="button" disabled={!!cancelling()} onClick={() => void cancel(row())}>
                          {cancelling() === id ? "Cancelling…" : "Cancel"}
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </Show>
            )}
          </For>
        </ul>
        <Show when={noticeText()}>
          <p class="vector-bg-tasks-notice" role="status">
            {noticeText()}
          </p>
        </Show>
      </section>
    </Show>
  )
}
