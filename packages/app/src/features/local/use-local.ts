import { LocalMode } from "@vectordevai/schema/local-mode"
import { Schema } from "effect"
import type { LocalStatus, VectorClient } from "@vectordevai/sdk/v2/client"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { READ_TIMEOUT, createReadRetry, readFailure, type RetryState } from "./read-retry"

// Vector Local as the app reads it: GET /local, read again whenever the engine says the policy changed or a change waits
// for the owner (local.updated). The routes are the owner's, so an invited guest gets 401 or 403 and is told whose they
// are instead of seeing nothing. The policy is the engine process's, so the server's own client reads it. A read that
// fails says what failed (`failure`); with `retry`, as Settings > Vector Local asks, a failure that may pass is read
// again on its own after a growing wait, and `again` reads at once.

export function useLocalStatus(options: { retry?: boolean } = {}) {
  const global = useGlobal()
  const server = useServer()
  const sdk = createMemo(() => (server.current ? global.ensureServerCtx(server.current).sdk : undefined))
  const [version, setVersion] = createSignal(0)
  const refresh = () => setVersion((value) => value + 1)

  const [read, { mutate }] = createResource(
    () => {
      const current = sdk()
      return current ? { client: current.client, version: version() } : false
    },
    (input) =>
      input.client.local
        // Only the reader that tries again gives up on an engine that hangs, so the others keep what they read last.
        .get({}, { throwOnError: false, ...(options.retry ? { signal: AbortSignal.timeout(READ_TIMEOUT) } : {}) })
        // An engine from before the Local API answers 404, and a server that is not Vector's may answer anything:
        // only a status with a policy is Vector Local's.
        .then((result) => ({
          data: Schema.is(LocalMode.Policy)(result.data?.policy) ? result.data : undefined,
          status: result.response?.status,
          error: result.error as unknown,
        }))
        .catch((cause: unknown) => ({ data: undefined, status: undefined, error: cause })),
  )

  createEffect(() => {
    const current = sdk()
    if (!current) return
    const stop = current.event.on("global", (event) => {
      if (event.type === "local.updated") refresh()
    })
    onCleanup(stop)
  })

  const guest = () => read.latest?.status === 401 || read.latest?.status === 403
  const unsupported = () => read.latest?.status === 404 || (read.latest?.status === 200 && !read.latest.data)
  const failure = createMemo(() => {
    const latest = read.latest
    if (!latest || latest.data || guest() || unsupported()) return undefined
    return readFailure("status", latest)
  })

  const [retry, setRetry] = createSignal<RetryState>({ attempt: 0, wait: undefined })
  const retrier = createReadRetry({ run: refresh, onChange: setRetry })
  createEffect(() => {
    if (!options.retry) return
    // A read started some other way (local.updated, Try again) replaces the try that was waiting.
    if (read.loading) return retrier.stop()
    retrier.settled(failure())
  })
  onCleanup(retrier.dispose)

  return {
    status: () => read.latest?.data,
    loading: () => read.loading,
    guest,
    unsupported,
    /** What failed when the engine could not be read: no answer, an error, or an answer Vector did not understand. */
    failure,
    /** The automatic tries after a failure, when the reader was asked to retry. */
    retry,
    /** Reads again at once, as Try again does, and starts the automatic waits over. */
    again: retrier.now,
    refresh,
    /** Shows a status the engine answered a change with, without reading it again. */
    set: (status: LocalStatus) => mutate({ data: status, status: 200, error: undefined }),
    client: (): VectorClient | undefined => sdk()?.client,
    events: () => sdk()?.event,
    /** The name of the computer the engine runs on, when it is not this one: "Local on build-box". */
    remote: () => (server.isLocal() ? undefined : server.name),
  }
}

export type LocalStatusReader = ReturnType<typeof useLocalStatus>
