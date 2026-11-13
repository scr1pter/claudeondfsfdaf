import { createComputed, createMemo, onCleanup, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { Button } from "@vectordevai/ui/button"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { readEngineCapabilities } from "@/features/background-tasks/engine-capabilities"
import { ReviewMemoryPanel } from "./review-memory-panel"
import type { ReviewMemorySelection } from "./review-memory"
import { reviewMemoryTransport } from "./review-memory-transport"

export interface ReviewMemoryConnectionSource {
  identity: object
  connection: object | undefined
  sdkConnection: object
  client: Pick<VectorClient, "reviewMemory" | "global" | "experimental">
  server: string
  directory: string
  enabled: boolean
  capability: boolean
  healthy: boolean
  listen: (callback: (type: string) => void) => () => void
}
const eligible = (source: ReviewMemoryConnectionSource) =>
  source.connection !== undefined &&
  source.connection === source.sdkConnection &&
  source.enabled === true &&
  source.capability === true &&
  source.healthy === true &&
  !!source.server &&
  !!source.directory &&
  !source.directory.includes("\0")
const same = (a: ReviewMemoryConnectionSource, b: ReviewMemoryConnectionSource) =>
  a.identity === b.identity &&
  a.connection === b.connection &&
  a.sdkConnection === b.sdkConnection &&
  a.client === b.client &&
  a.server === b.server &&
  a.directory === b.directory &&
  a.enabled === b.enabled &&
  a.capability === b.capability &&
  a.healthy === b.healthy

/** Pure lifecycle coordinator used by the real connected view. A flag/health/config result never grants ownership. */
export function reviewMemoryConnection(input: {
  source: () => ReviewMemoryConnectionSource
  changed: (selection: ReviewMemorySelection | undefined, message: string) => void
}) {
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposed = false
  let selected: ReviewMemoryConnectionSource | undefined
  let pending: AbortController | undefined
  let unlisten: (() => void) | undefined
  const retire = (message = "Verify current owner access to this repository before managing review memory.") => {
    epoch++
    pending?.abort()
    pending = undefined
    for (const listener of [...listeners]) listener()
    input.changed(undefined, message)
  }
  const update = async (next: ReviewMemoryConnectionSource, force = false) => {
    if (disposed || (!force && selected && same(selected, next))) return
    retire()
    unlisten?.()
    const captured = Object.freeze({ ...next })
    selected = captured
    unlisten = captured.listen((type) => {
      if (!["server.connected", "global.disposed", "server.instance.disposed"].includes(type)) return
      // Retire private text and abort old reads synchronously, before fresh owner verification starts.
      void update(input.source(), true)
    })
    if (!eligible(captured)) {
      input.changed(
        undefined,
        "Review-memory controls require a current engine connection, the owner’s global VectorScope opt-in, software support and a healthy selected repository.",
      )
      return
    }
    const controller = new AbortController()
    pending = controller
    const capturedEpoch = epoch
    const current = () => {
      const fresh = input.source()
      return (
        !disposed && capturedEpoch === epoch && !controller.signal.aborted && same(captured, fresh) && eligible(fresh)
      )
    }
    const api = reviewMemoryTransport({
      client: captured.client,
      directory: captured.directory,
      current,
      denied: () => retire("Current owner access could not be verified. Private text and approvals were cleared."),
    })
    try {
      // A lifecycle event may have invalidated cached global config/capabilities. Refresh both through this exact SDK.
      // Global config is guest-readable bootstrap data and is deliberately NOT the owner proof.
      const config = await captured.client.global.config.get({ signal: controller.signal, throwOnError: false })
      if (!current()) return
      if (config.response.status !== 200 || config.data?.experimental?.vectorscope !== true)
        throw new Error("Unavailable")
      const capabilities = await readEngineCapabilities(captured.client, controller.signal)
      if (!current()) return
      if (!capabilities.vectorscopeReviewMemoryControls) throw new Error("Unavailable")
      await api.inspect({ offset: 0, limit: 1 }, controller.signal)
      if (!current()) return
      // Only a strict successful owner-only inspect grants this ephemeral proof. Its private data is not retained.
      input.changed(
        {
          identity: captured.identity,
          server: captured.server,
          directory: captured.directory,
          epoch: capturedEpoch,
          owner: "owner",
          connected: true,
          capability: true,
          api,
        },
        "",
      )
    } catch {
      if (current()) input.changed(undefined, "Current owner access or repository review memory could not be verified.")
    }
  }
  return {
    update,
    recheck: () => update(input.source(), true),
    eligible: () => !disposed && eligible(input.source()),
    events: {
      listen: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      retire("")
      unlisten?.()
      unlisten = undefined
      listeners.clear()
    },
  }
}

/** Real connected lifecycle/owner-probe/view composition; source is an engine binding, never an owner-positive grant. */
export function ReviewMemoryConnection(props: { source: Accessor<ReviewMemoryConnectionSource> }) {
  const [state, setState] = createStore({ revision: 0, message: "Verify current owner access to this repository." })
  let selection: ReviewMemorySelection | undefined
  const connection = reviewMemoryConnection({
    source: props.source,
    changed: (next, message) => {
      selection = next
      setState("revision", (revision) => revision + 1)
      setState("message", message)
    },
  })
  createComputed(() => {
    void connection.update(props.source())
  })
  onCleanup(connection.dispose)
  const current = () => {
    void state.revision
    return selection
  }
  return (
    <Show
      when={current()}
      fallback={
        <section aria-label="Repository review-memory connection" class="space-y-3 p-6">
          <p role="status">{state.message}</p>
          <Button disabled={!connection.eligible()} onClick={() => void connection.recheck()}>
            Verify owner access
          </Button>
        </section>
      }
    >
      {(verified) => <ReviewMemoryPanel selection={verified()} events={connection.events} />}
    </Show>
  )
}

/** Context adapter for the single selected-directory mount. It never reads or copies credentials. */
export function ReviewMemoryConnectedPanel(props: { directory?: string }) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const global = useGlobal()
  const source = createMemo<ReviewMemoryConnectionSource>(() => {
    const current = sdk()
    const key = ServerConnection.key(current.server)
    const connection = global.servers.list().find((server) => ServerConnection.key(server) === key)
    return {
      identity: current,
      connection: connection?.http,
      sdkConnection: current.server.http,
      client: current.client,
      server: current.scope,
      directory: props.directory ?? "",
      enabled: sync().globalConfig()?.experimental?.vectorscope === true,
      capability: sync().capabilities().vectorscopeReviewMemoryControls === true,
      healthy: global.servers.health[key]?.healthy === true,
      listen: (listener) => current.event.listen((event) => listener(event.details.type)),
    }
  })
  return <ReviewMemoryConnection source={source} />
}
