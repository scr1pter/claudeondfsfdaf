import { For, Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { directoryReviewTarget } from "@/features/agents/agent-dashboard-model"
import { createConnectClient } from "./client"
import { connectConsentDetails } from "./consent"
import { destinationLabel, verdictLabel } from "./connect-model"
import {
  createDirectoryReviewController,
  type DirectoryReviewState,
  type DirectoryReviewTarget,
} from "./directory-review-controller"

export function DirectoryReview(props: DirectoryReviewTarget) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const scope = createMemo(() =>
    sync().capabilities().connections ? sdk().ensureDirSdkContext(props.directory) : undefined,
  )
  const binding = createMemo(() => ({
    scope: scope(),
    target: { workspaceID: props.workspaceID, directory: props.directory, base: props.base },
    epoch: Symbol(),
  }))
  const [state, setState] = createStore<DirectoryReviewState & { epoch?: symbol }>({
    phase: "loading",
    busy: false,
    error: "",
  })
  let controller: ReturnType<typeof createDirectoryReviewController> | undefined
  createEffect(() => {
    const identity = binding()
    const active = identity.scope
    const target = identity.target
    if (!active) {
      controller = undefined
      setState({
        phase: "unavailable",
        busy: false,
        run: undefined,
        permission: undefined,
        error: "",
        epoch: identity.epoch,
      })
      return
    }
    const client = createConnectClient(active.client)
    const current = () => identity === binding()
    const selected = createDirectoryReviewController({
      target,
      enabled: true,
      current,
      changed: (value) => setState({ ...value, run: value.run, permission: value.permission, epoch: identity.epoch }),
      transport: {
        runs: (signal) => client.runs(undefined, signal),
        get: (id, signal) => client.get(id, undefined, signal),
        start: () => client.directoryReview({ target: { kind: "branch", base: target.base }, background: true }),
        pending: async (signal) => {
          const result = await active.client.permission.list(undefined, { throwOnError: true, signal })
          if (!Array.isArray(result.data)) throw new Error("The engine returned invalid review approvals.")
          return result.data
        },
        reply: (id, reply) => active.client.permission.reply({ requestID: id, reply }, { throwOnError: true }),
        cancel: (id) => client.cancel(id),
      },
      subscribe: (invalidate) => {
        const stops = [
          active.event.on("connect.run.updated", invalidate),
          active.event.on("permission.asked", invalidate),
          active.event.on("permission.replied", invalidate),
        ]
        return () => stops.forEach((stop) => stop())
      },
    })
    controller = selected
    // Events are advisory; periodic owner reads also recover a missed notification.
    const timer = setInterval(() => {
      if (selected.state.phase === "ready" && selected.state.run && selected.state.run.status !== "done")
        void selected.refresh()
    }, 5_000)
    onCleanup(() => {
      clearInterval(timer)
      selected.dispose()
      if (controller === selected) controller = undefined
    })
  })

  const available = () => state.epoch === binding().epoch && scope() && (state.phase !== "unavailable" || state.run)
  return (
    <Show when={available()}>
      <section
        data-component="directory-review"
        data-workspace-id={props.workspaceID}
        aria-label="VectorScope workspace review"
        class="mt-2 rounded-[10px] border border-[color:var(--vx-line)] p-3 text-[11.5px] text-[color:var(--vx-text-subtle)]"
      >
        <Show when={state.run}>
          {(run) => (
            <>
              <p class="font-medium" role="status">
                {run().result
                  ? verdictLabel(run().result!)
                  : state.permission
                    ? "Approval required"
                    : "Review in progress"}
              </p>
              <p>{run().result?.summary ?? run().progress?.message ?? "Queued for VectorScope"}</p>
              <Show when={run().result}>
                {(result) => (
                  <>
                    <p>Sends code: {destinationLabel(result().sendsTo)}.</p>
                    <For each={result().notes}>{(note) => <p>{note}</p>}</For>
                    <For each={result().findings}>
                      {(finding) => (
                        <div class="mt-2 border-t border-[color:var(--vx-line)] pt-2">
                          <p>
                            {finding.severity}: {finding.title}
                          </p>
                          <p class="font-mono">
                            {finding.path}
                            {finding.line ? `:${finding.line}` : ""}
                          </p>
                          <p class="whitespace-pre-wrap">{finding.body}</p>
                        </div>
                      )}
                    </For>
                    <Show when={result().findings.length}>
                      <p class="mt-2">
                        Review these findings in this workspace. Automatic fixes require a supported launching
                        conversation.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={state.permission}>
          {(request) => (
            <div class="mt-2" role="group" aria-label="Workspace review approval">
              <p>{connectConsentDetails(request()) ?? "Allow VectorScope to review this workspace?"}</p>
              <div class="mt-2 flex gap-3">
                <button
                  type="button"
                  disabled={state.busy || state.phase !== "ready"}
                  onClick={() => void controller?.reply(request().id, "once")}
                >
                  Allow once
                </button>
                <button
                  type="button"
                  disabled={state.busy || state.phase !== "ready"}
                  onClick={() => void controller?.reply(request().id, "reject")}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <div class="mt-2 flex gap-3">
          <Show
            when={!state.run || state.run.status === "done"}
            fallback={
              <button
                type="button"
                disabled={state.busy || state.phase !== "ready"}
                onClick={() => void controller?.cancel()}
              >
                Cancel review
              </button>
            }
          >
            <button
              type="button"
              disabled={state.busy || state.phase !== "ready"}
              onClick={() => void controller?.start()}
            >
              {state.busy ? "Starting review…" : "Review with VectorScope"}
            </button>
          </Show>
          <button type="button" disabled={state.busy} onClick={() => void controller?.refresh()}>
            Refresh review
          </button>
        </div>
      </section>
    </Show>
  )
}

/** External details already know their ID and directory; resolve only that exact native record. */
export function NativeDirectoryReview(props: { workspaceID: string; directory: string; running: boolean }) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const selected = createMemo(() =>
    sync().capabilities().connections && !props.running
      ? { sdk: sdk(), id: props.workspaceID, directory: props.directory }
      : undefined,
  )
  const [record] = createResource(selected, async (scope) => {
    const records = await globalThis.window?.api?.parallelWorkspaces?.list()
    if (scope !== selected()) return
    const record = records?.find((record) => record.id === scope.id && record.isolatedPath === scope.directory)
    return { scope, target: record ? directoryReviewTarget(record) : undefined }
  })
  const target = () => {
    const value = record()
    return value && value.scope === selected() ? value.target : undefined
  }
  return <Show when={!record.error && target()}>{(target) => <DirectoryReview {...target()} />}</Show>
}
