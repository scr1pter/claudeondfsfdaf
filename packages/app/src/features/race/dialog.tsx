import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import { Dialog } from "@vectordevai/ui/dialog"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { RaceSpec } from "@vectordevai/core/race/spec"
import { backgroundTasksPane } from "@/features/background-tasks/background-tasks-state"
import { WorkflowPlanView } from "@/features/background-tasks/workflow-dialog"
import { readPlan, workflowFailure, type Plan, type WorkflowClient } from "@/features/background-tasks/workflow-model"

export function DialogRace(props: { client: WorkflowClient; sessionID: string }) {
  const dialog = useDialog()
  const [state, setState] = createStore({ prompt: "", first: "", second: "", judge: "", checking: false, starting: false,
    spec: "", plan: undefined as Plan | undefined, error: "", warnings: [] as string[] })
  const edit = (field: "prompt" | "first" | "second" | "judge", value: string) => setState({ [field]: value, spec: "", plan: undefined, error: "", warnings: [] })
  const preview = async () => {
    setState({ checking: true, error: "", plan: undefined, spec: "" })
    try {
      const spec = JSON.stringify(RaceSpec.build({ prompt: state.prompt, lanes: [{ ref: state.first.trim() }, { ref: state.second.trim() }], judge: { ref: state.judge.trim() } }))
      const result = await props.client.experimental.workflow.validate({ workflowValidateInput: { spec } }, { throwOnError: true })
      if (!result.data?.ok) throw new Error(result.data?.issues.map((issue) => issue.message).join("\n") || "The race could not be checked.")
      const plan = readPlan(result.data.plan)
      if (!plan) throw new Error("The engine did not return a race plan.")
      setState({ plan, spec, warnings: result.data.warnings.map((warning) => warning.message) })
    } catch (error) { setState("error", workflowFailure(error).message) }
    finally { setState("checking", false) }
  }
  const start = async () => {
    if (!state.spec || state.starting) return
    const spec = state.spec
    setState({ starting: true, error: "" })
    try {
      const result = await props.client.experimental.workflow.start({ sessionID: props.sessionID, workflowStartInput: { spec, quiet: false } }, { throwOnError: true })
      if (!result.data) throw new Error("The race could not start.")
      backgroundTasksPane.open()
      dialog.close()
    } catch (error) { setState("error", workflowFailure(error).message) }
    finally { setState("starting", false) }
  }
  return <Dialog title="Race models">
    <div class="flex min-w-0 flex-col gap-3 p-4">
      <p>Two labs implement the same request in separate worktrees. A third lab compares their reports. Review each lane's changes in Tasks before merging.</p>
      <label>Request<textarea class="settings-v2-textarea" rows={4} value={state.prompt} disabled={state.checking || state.starting} onInput={(event) => edit("prompt", event.currentTarget.value)} /></label>
      <For each={[{ key: "first" as const, label: "First lane" }, { key: "second" as const, label: "Second lane" }, { key: "judge" as const, label: "Judge from a third lab" }]}>{(field) =>
        <label>{field.label}<input class="settings-v2-textarea" value={state[field.key]} placeholder="provider/model" disabled={state.checking || state.starting} onInput={(event) => edit(field.key, event.currentTarget.value)} /></label>
      }</For>
      <p class="text-12-regular text-text-weak">Use your configured models. Existing model permissions, spend limits and workflow approvals apply.</p>
      <Show when={state.plan}>{(plan) => <WorkflowPlanView plan={plan()} />}</Show>
      <For each={state.warnings}>{(warning) => <p class="text-12-regular text-text-weak">{warning}</p>}</For>
      <Show when={state.error}><p role="alert" class="text-text-critical-base">{state.error}</p></Show>
      <div class="flex justify-end gap-2"><Button variant="secondary" disabled={state.checking || state.starting} onClick={() => void preview()}>Preview race</Button><Button disabled={!state.plan || state.checking || state.starting} onClick={() => void start()}>Run race</Button></div>
    </div>
  </Dialog>
}
