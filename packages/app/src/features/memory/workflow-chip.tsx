import { Show, createSignal } from "solid-js"
import type { AssistantMessage } from "@vectordevai/sdk/v2/client"
import { ReplyFooter } from "@vectordevai/session-ui/message-part"
import { Icon } from "@vectordevai/ui/icon"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { WORKFLOW_CHIP, changed, chipLabel, insightsPlace } from "./workflow"
import "./workflow-chip.css"

/** Draws "Learned default · Why" under a reply a learned workflow default shaped. */
export function registerWorkflowChip() {
  ReplyFooter.register(WorkflowChip)
}

/**
 * The learned default a request ran with, from the assistant message's `workflow`: Why opens the reason, a link to
 * Settings > Memory > Workflow insights, and "Stop using learned defaults", which keeps recording runs (Observe only).
 */
function WorkflowChip(props: { message: AssistantMessage }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  const [notice, setNotice] = createSignal("")

  const stop = async () => {
    const stopped = await sdk()
      .client.memory.settings.update({ workflow: "observe" })
      .then(
        () => true,
        () => false,
      )
    setNotice(stopped ? WORKFLOW_CHIP.stopped : WORKFLOW_CHIP.failed)
  }

  const insights = async () => {
    const { DialogSettings } = await import("@/components/settings-v2/dialog-settings-v2")
    const { requestMemoryTab } = await import("@/components/settings-v2/memory")
    requestMemoryTab("workflow")
    void dialog.show(() => <DialogSettings section="memory" {...insightsPlace(props.message)} />)
  }

  return (
    <Show when={props.message.workflow}>
      {(workflow) => (
        <div data-component="workflow-chip" data-open={open() ? "" : undefined}>
          <button
            type="button"
            data-slot="workflow-chip-trigger"
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="sliders" size="small" />
            <span>{chipLabel(workflow())}</span>
            <span data-slot="workflow-chip-why">· Why</span>
          </button>
          <Show when={open()}>
            <div data-slot="workflow-chip-popover">
              <p data-slot="workflow-chip-changed">{changed(workflow())}</p>
              <p data-slot="workflow-chip-reason">{workflow().reason}</p>
              <p data-slot="workflow-chip-meta">{WORKFLOW_CHIP.own}</p>
              <div data-slot="workflow-chip-actions">
                <ButtonV2 size="small" variant="ghost" onClick={() => void insights()}>
                  {WORKFLOW_CHIP.link}
                </ButtonV2>
                <ButtonV2 size="small" variant="ghost" onClick={() => void stop()}>
                  {WORKFLOW_CHIP.stop}
                </ButtonV2>
              </div>
              <Show when={notice()}>
                <p data-slot="workflow-chip-meta" role="status">
                  {notice()}
                </p>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
