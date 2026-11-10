import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { Dialog } from "@vectordevai/ui/dialog"
import { TextField } from "@vectordevai/ui/text-field"
import { showToast } from "@/utils/toast"
import { backgroundTasksPane } from "./background-tasks-state"
import {
  busyMessage,
  ceilingsLine,
  inputFields,
  parseInputs,
  savedEntries,
  savedRequest,
  stageLine,
  startRequest,
  validateRequest,
  workflowFailure,
  type Issue,
  type Plan,
  type Saved,
  type WorkflowClient,
} from "./workflow-model"

/*
 * The plan as the workflow permission dock and the /workflow form show it (5.I.4): title, every ceiling, one line per
 * stage. Plain text only: a model may have written every string in it (I13).
 */
export function WorkflowPlanView(props: { plan: Plan; delegated?: { usd?: number } }) {
  return (
    <div data-component="workflow-plan" class="flex min-w-0 flex-col gap-1">
      <div class="text-13-medium text-text-strong break-words">{props.plan.title}</div>
      <div data-slot="workflow-plan-ceilings" class="text-12-regular text-text-weak break-words">
        {ceilingsLine(props.plan, props.delegated)}
      </div>
      <ol class="flex min-w-0 flex-col gap-0.5 pl-4 list-decimal text-12-regular text-text-base">
        <For each={props.plan.stages}>{(stage) => <li class="break-words">{stageLine(stage)}</li>}</For>
      </ol>
    </div>
  )
}

function IssueList(props: { issues: readonly Issue[]; tone: "error" | "warning" }) {
  return (
    <Show when={props.issues.length > 0}>
      <ul
        class="flex flex-col gap-0.5 text-12-regular"
        classList={{ "text-text-critical-base": props.tone === "error", "text-text-weak": props.tone === "warning" }}
        role={props.tone === "error" ? "alert" : undefined}
      >
        <For each={props.issues}>
          {(issue) => (
            <li class="break-words">
              {issue.path ? `${issue.path}: ` : ""}
              {issue.message}
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * `/workflow` (5.I.4): lists the trusted saved workflows, opens a form for the chosen one's inputs, checks it with
 * route 8 and shows the plan above Run, then starts it with route 9 while the session is idle. While the session
 * works, or when the engine answers busy, it puts "Run the saved workflow …" into the composer instead, so the agent
 * runs it with the workflow tool (and its approval card) when it reads the message.
 */
export function DialogWorkflow(props: {
  client: WorkflowClient
  sessionID: string
  /** A saved workflow to open the form for, from `/workflow <name>`. */
  name?: string
  busy: () => boolean
  compose: (text: string) => void
}) {
  const dialog = useDialog()
  const [list] = createResource(async () => savedEntries(await savedRequest(props.client)))
  const [picked, setPicked] = createSignal<string | undefined>(props.name)
  const selected = createMemo(() => list()?.find((item) => item.name === picked()))
  const [values, setValues] = createStore<Record<string, string>>({})
  const [state, setState] = createStore<{
    checking: boolean
    starting: boolean
    plan?: Plan
    issues: readonly Issue[]
    warnings: readonly Issue[]
    error?: string
  }>({ checking: false, starting: false, issues: [], warnings: [] })

  const reset = () => setState({ plan: undefined, issues: [], warnings: [], error: undefined })
  const pick = (item: Saved) => {
    setPicked(item.name)
    setValues({})
    reset()
  }
  const back = () => {
    setPicked(undefined)
    reset()
  }
  const change = (name: string, value: string) => {
    setValues(name, value)
    // A plan checked for other values no longer describes what Run would start.
    setState({ plan: undefined, issues: [], warnings: [], error: undefined })
  }

  const inputs = () => {
    const item = selected()
    return item ? parseInputs(item, values) : undefined
  }

  const check = async () => {
    const item = selected()
    const parsed = inputs()
    if (!item || !parsed || state.checking) return
    if (!parsed.ok) return setState({ issues: parsed.issues, plan: undefined })
    setState({ checking: true, error: undefined })
    const result = await validateRequest({ client: props.client, name: item.name, inputs: parsed.inputs }).catch(
      (error: unknown) => {
        const failure = workflowFailure(error)
        setState({ error: failure.message, issues: failure.issues ?? [] })
        return undefined
      },
    )
    setState({
      checking: false,
      ...(result
        ? { plan: result.ok ? result.plan : undefined, issues: result.issues, warnings: result.warnings }
        : {}),
    })
  }

  const compose = (name: string, values: Record<string, unknown>) => {
    props.compose(busyMessage(name, values))
    dialog.close()
    showToast({
      title: "Vector is working",
      description: "The request to run this workflow is in the composer. Send it, and the agent runs it.",
    })
  }

  const run = async () => {
    const item = selected()
    const parsed = inputs()
    if (!item || !parsed?.ok || !state.plan || state.starting) return
    if (props.busy()) return compose(item.name, parsed.inputs as Record<string, unknown>)
    setState({ starting: true, error: undefined })
    const result = await startRequest({
      client: props.client,
      sessionID: props.sessionID,
      name: item.name,
      inputs: parsed.inputs,
    })
    setState("starting", false)
    if (result.ok) {
      dialog.close()
      showToast({
        title: `Workflow started: ${result.title}`,
        description: "Its stages show in Background tasks. Vector tells you when it ends.",
        actions: [{ label: "Show tasks", onClick: () => backgroundTasksPane.open() }],
      })
      return
    }
    if (result.kind === "busy") return compose(item.name, parsed.inputs as Record<string, unknown>)
    setState({ error: result.message, issues: result.issues ?? state.issues })
  }

  return (
    <Dialog
      title="Run a saved workflow"
      description="A workflow runs many subagents in stages. Check its plan and ceilings, then run it."
      size="large"
    >
      <div data-component="workflow-dialog" class="flex flex-col gap-4 px-6 pb-4">
        <Switch>
          <Match when={list.error}>
            <p class="text-13-regular text-text-critical-base" role="alert">
              {workflowFailure(list.error).message}
            </p>
          </Match>
          <Match when={list.loading}>
            <p class="text-13-regular text-text-weak">Loading saved workflows…</p>
          </Match>
          <Match when={!selected()}>
            <Show when={picked()}>
              <p class="text-13-regular text-text-weak">There is no saved workflow named {picked()}.</p>
            </Show>
            <Show
              when={(list() ?? []).length > 0}
              fallback={
                <p class="text-13-regular text-text-weak">
                  No saved workflows. Add one as workflows/&lt;name&gt;.json in your Vector config folder, or in a
                  trusted repository's .vector folder.
                </p>
              }
            >
              <ul class="flex flex-col gap-1" aria-label="Saved workflows">
                <For each={list()}>
                  {(item) => (
                    <li>
                      <button
                        type="button"
                        data-workflow-name={item.name}
                        class="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-raised-base-hover disabled:opacity-60"
                        disabled={!!item.issues?.length}
                        onClick={() => pick(item)}
                      >
                        <span class="text-14-medium text-text-strong break-words">{item.title}</span>
                        <span class="text-12-regular text-text-weak">
                          {item.name} · {item.source === "repository" ? "this repository" : "your config"}
                        </span>
                        <Show when={item.description}>
                          <span class="text-12-regular text-text-base break-words">{item.description}</span>
                        </Show>
                        <IssueList issues={item.issues ?? []} tone="error" />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Match>
          <Match when={selected()}>
            {(item) => (
              <form
                class="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void (state.plan ? run() : check())
                }}
              >
                <div class="flex flex-col gap-0.5">
                  <span class="text-14-medium text-text-strong break-words">{item().title}</span>
                  <span class="text-12-regular text-text-weak">{item().name}</span>
                </div>
                <For each={inputFields(item())}>
                  {(field) => (
                    <TextField
                      label={field.required ? `${field.name} (required)` : field.name}
                      description={field.description}
                      placeholder={field.placeholder}
                      value={values[field.name] ?? ""}
                      onChange={(value) => change(field.name, value)}
                    />
                  )}
                </For>
                <IssueList issues={state.issues} tone="error" />
                <Show when={state.error}>
                  <p class="text-12-regular text-text-critical-base break-words" role="alert">
                    {state.error}
                  </p>
                </Show>
                <Show when={state.plan}>
                  {(plan) => (
                    <div class="rounded-md border border-border-weak-base p-3">
                      <WorkflowPlanView plan={plan()} />
                    </div>
                  )}
                </Show>
                <IssueList issues={state.warnings} tone="warning" />
                <div class="flex justify-end gap-2">
                  <Show when={!props.name || (list() ?? []).length > 1}>
                    <Button type="button" variant="ghost" size="large" onClick={back}>
                      Back
                    </Button>
                  </Show>
                  <Show
                    when={state.plan}
                    fallback={
                      <Button type="submit" variant="primary" size="large" disabled={state.checking}>
                        {state.checking ? "Checking…" : "Check plan"}
                      </Button>
                    }
                  >
                    <Button type="submit" variant="primary" size="large" disabled={state.starting}>
                      {state.starting ? "Starting…" : props.busy() ? "Ask Vector to run it" : "Run"}
                    </Button>
                  </Show>
                </div>
              </form>
            )}
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
