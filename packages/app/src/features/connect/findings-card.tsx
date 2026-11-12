import { For, Show, Suspense, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { ToolRegistry, type ToolComponent, type ToolProps } from "@vectordevai/session-ui/message-part"
import { GenericTool } from "@vectordevai/session-ui/basic-tool"
import { Button } from "@vectordevai/ui/button"
import { useSDK } from "@/context/sdk"
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
  const params = useParams()
  const client = createMemo(() => createConnectClient(sdk().client))
  const [state, setState] = createStore({ busy: false, error: "" })
  const [data, { refetch }] = createResource(
    () => {
      const id = metadataRunID(props.metadata, props.sessionID)
      if (props.status !== "completed" || !id || !props.sessionID) return false
      return { client: client(), run: id, sessionID: props.sessionID }
    },
    async (input) => ({
      client: input.client,
      run: await input.client.get(input.run, input.sessionID, AbortSignal.timeout(30_000)),
    }),
  )
  const run = () => {
    if (data.error) return
    const loaded = data.latest
    if (
      loaded?.client !== client() ||
      loaded.run.id !== metadataRunID(props.metadata, props.sessionID) ||
      loaded.run.request.requester.sessionID !== props.sessionID
    )
      return
    return loaded.run
  }
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
    if (state.busy || !sessionID || !runID) return
    setState({ busy: true, error: "" })
    const active = client()
    const current = () =>
      active === client() &&
      props.sessionID === sessionID &&
      params.id === sessionID &&
      metadataRunID(props.metadata, sessionID) === runID
    await actOnFindings(
      { run: runID, sessionID, action },
      {
        load: (id, sessionID) => active.get(id, sessionID, AbortSignal.timeout(30_000)),
        dismiss: (id, input) => {
          if (!current()) throw new Error("The connected conversation changed. Try again in the current conversation.")
          return active.dismiss(id, input)
        },
        send: (text) => current() && requestComposerPrompt({ text, send: true }),
      },
    )
      .then(() => refetch())
      .catch((error: unknown) => {
        if (current())
          setState("error", error instanceof Error ? error.message : "Could not complete this review action.")
      })
      .finally(() => setState("busy", false))
  }
  return (
    <Show when={run()?.result} fallback={props.plain ? <Dynamic component={props.plain} {...props} /> : undefined}>
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
