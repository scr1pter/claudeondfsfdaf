import { For, Show, Suspense, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { ToolRegistry, type ToolComponent, type ToolProps } from "@vectordevai/session-ui/message-part"
import { GenericTool } from "@vectordevai/session-ui/basic-tool"
import { Button } from "@vectordevai/ui/button"
import type { Connect } from "@vectordevai/schema/connect"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { requestComposerPrompt } from "@/utils/composer-handoff"
import { createConnectClient } from "./client"
import {
  actionableFindings,
  costLabel,
  destinationLabel,
  metadataRunID,
  taskReviewFixGuidance,
  verdictLabel,
} from "./connect-model"
import { actOnFindings } from "./findings-card-model"

let registered = false
export function registerConnectFindingsCard() {
  if (registered) return
  registered = true
  const plain = ToolRegistry.render("connect") ?? GenericTool
  ToolRegistry.register({
    name: "connect",
    render: (props) => (
      <Suspense fallback={plain ? <Dynamic component={plain} {...props} /> : undefined}>
        <FindingsCard {...props} plain={plain} />
      </Suspense>
    ),
  })
}

function FindingsCard(props: ToolProps & { plain?: ToolComponent }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const params = useParams()
  const client = createMemo(() => createConnectClient(sdk().client))
  const [state, setState] = createStore({ busy: false, error: "", epoch: Symbol(), wasOwned: false })
  let pending: AbortController | undefined
  let blocked: ReturnType<typeof createConnectClient> | undefined
  let disposed = false
  let actionRead: AbortController | undefined
  const [data, { refetch, mutate }] = createResource(
    () => {
      const epoch = state.epoch
      const id = metadataRunID(props.metadata, props.sessionID)
      if (disposed || props.status !== "completed" || !id || !props.sessionID || client() === blocked) return false
      return { client: client(), run: id, sessionID: props.sessionID, epoch }
    },
    async (input): Promise<{ client: ReturnType<typeof createConnectClient>; run: Connect.Run; epoch: symbol }> => {
      pending?.abort()
      const abort = new AbortController()
      pending = abort
      const run = await input.client
        .get(input.run, input.sessionID, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]))
        .catch(() => {
          if (input.epoch === state.epoch && input.client === client()) retire(input.client)
          throw new Error("Connected review access could not be verified.")
        })
      if (disposed || abort.signal.aborted || input.epoch !== state.epoch || input.client !== client())
        throw new Error("The connected conversation changed.")
      setState("wasOwned", true)
      return { client: input.client, run, epoch: input.epoch }
    },
  )
  const retire = (denied?: ReturnType<typeof createConnectClient>) => {
    blocked = denied
    pending?.abort()
    actionRead?.abort()
    mutate(undefined)
    setState({ epoch: Symbol(), busy: false, error: "" })
  }
  onCleanup(() => {
    disposed = true
    retire()
  })
  const run = () => {
    if (disposed || data.error) return
    const loaded = data.latest
    if (
      loaded?.client !== client() ||
      loaded.epoch !== state.epoch ||
      loaded.run.id !== metadataRunID(props.metadata, props.sessionID) ||
      loaded.run.request.requester.sessionID !== props.sessionID
    )
      return
    return loaded.run
  }
  createEffect(() => {
    const server = serverSDK()
    const directory = sdk().directory
    const stop = server.event.listen((event) => {
      if (server !== serverSDK()) return
      if (
        (event.name === "global" &&
          (event.details.type === "server.connected" || event.details.type === "global.disposed")) ||
        (event.name === directory && event.details.type === "server.instance.disposed")
      ) {
        retire()
      }
    })
    onCleanup(stop)
  })
  createEffect(() => {
    const active = sdk()
    const id = metadataRunID(props.metadata, props.sessionID)
    const sessionID = props.sessionID
    if (!id || !sessionID) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = active.event.on("connect.run.updated", (event) => {
      if (event.properties.sessionID !== sessionID || event.properties.run.id !== id || timer) return
      // Events invalidate the owner read; their payload never grants access to a result.
      timer = setTimeout(() => {
        timer = undefined
        void refetch()
      }, 250)
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  })
  const findings = () => run()?.result?.findings ?? []
  const actionable = () => (run() ? actionableFindings(run()!, props.sessionID, true) : [])
  const fixGuidance = () => (run() ? taskReviewFixGuidance(run()!) : undefined)
  const act = async (action: "fix" | "worktree" | "dismiss") => {
    const sessionID = props.sessionID
    const runID = run()?.id
    const epoch = state.epoch
    if (disposed || state.busy || !sessionID || !runID) return
    setState({ busy: true, error: "" })
    const active = client()
    const abort = new AbortController()
    actionRead?.abort()
    actionRead = abort
    const current = () =>
      !disposed &&
      !abort.signal.aborted &&
      active === client() &&
      props.sessionID === sessionID &&
      params.id === sessionID &&
      metadataRunID(props.metadata, sessionID) === runID &&
      epoch === state.epoch
    await actOnFindings(
      { run: runID, sessionID, action },
      {
        load: (id, sessionID) =>
          active.get(id, sessionID, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])).catch(() => {
            if (current()) retire(active)
            throw new Error("Connected review access could not be verified.")
          }),
        dismiss: (id, input) => {
          if (!current()) throw new Error("The connected conversation changed. Try again in the current conversation.")
          return active.dismiss(id, input)
        },
        send: (text) => current() && requestComposerPrompt({ text, send: true }),
      },
    )
      .then(() => {
        if (current()) return refetch()
      })
      .catch((error: unknown) => {
        if (current())
          setState("error", error instanceof Error ? error.message : "Could not complete this review action.")
      })
      .finally(() => {
        if (actionRead === abort) actionRead = undefined
        if (current()) setState("busy", false)
      })
  }
  return (
    <Show
      when={run()?.result}
      fallback={!state.wasOwned && props.plain ? <Dynamic component={props.plain} {...props} /> : undefined}
    >
      {(result) => (
        <section
          class="rounded-lg border p-3 flex flex-col gap-3"
          data-component="connect-findings-card"
          aria-label="Connected review findings"
        >
          <strong>{verdictLabel(result())}</strong>
          <p>{result().summary}</p>
          <p class="text-sm">
            Code sent to: {destinationLabel(result().sendsTo)}. {costLabel(result())}.
          </p>
          <Show when={result().cached}>
            <p class="text-sm">Saved result for this revision.</p>
          </Show>
          <For each={findings()}>
            {(finding) => (
              <article class="border-t pt-2">
                <strong>{finding.title}</strong>
                <p class="text-sm">
                  <code>
                    {finding.path}
                    {finding.line ? `:${finding.line}` : ""}
                  </code>{" "}
                  · {finding.severity} · {finding.status}
                </p>
                <p class="whitespace-pre-wrap">{finding.body}</p>
              </article>
            )}
          </For>
          <For each={result().notes}>{(note) => <p class="text-sm">{note}</p>}</For>
          <Show when={actionable().length > 0}>
            <p class="text-sm">Findings are claims to check. Applying a fix still asks for approval.</p>
            <Show when={fixGuidance()}>
              {(guidance) => (
                <p class="text-sm" role="status">
                  {guidance()}
                </p>
              )}
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={state.busy || !!fixGuidance()}
                title={fixGuidance()}
                onClick={() => void act("fix")}
              >
                Fix
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={state.busy || !!fixGuidance()}
                title={fixGuidance()}
                onClick={() => void act("worktree")}
              >
                Fix in a worktree
              </Button>
              <Button variant="ghost" size="small" disabled={state.busy} onClick={() => void act("dismiss")}>
                Dismiss
              </Button>
            </div>
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </section>
      )}
    </Show>
  )
}
