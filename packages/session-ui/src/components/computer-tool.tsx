import { createMemo, createSignal, Index, Show, type JSX } from "solid-js"
import type { FilePart, Part as PartType, ToolPart } from "@vectordevai/sdk/v2"
import { Hands } from "@vectordevai/core/computer/hands"
import { Collapsible } from "@vectordevai/ui/collapsible"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useI18n } from "@vectordevai/ui/context/i18n"
import { Icon } from "@vectordevai/ui/icon"
import { ImagePreview } from "@vectordevai/ui/image-preview"
import { TextShimmer } from "@vectordevai/ui/text-shimmer"
import { useData } from "../context"
import {
  agentNote,
  computerRing,
  computerRunTitle,
  computerShot,
  computerStepStatus,
  computerSteps,
  type Translate,
} from "./computer-labels"
import { isComputerTool } from "./message-part-group"
import { readPartText } from "./message-part-text"

// The collapsed card's thumbnail box. Fixed, so the row's height never waits for an image to decode, and a zoomed
// crop fits it as well as a full frame.
const THUMB = { width: 160, height: 100 }

/**
 * One run of Hands work in the timeline: consecutive computer calls with the agent's notes between them.
 * Collapsed, it shows the latest screenshot and the last step; expanded, every step with its Vector-built label and
 * the model's words only under a step, as "The agent: …". Only one image decodes at a time: the thumbnail, or the
 * preview a step's button opens.
 */
export function ComputerRunCard(props: {
  parts: PartType[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  /** The turn's copy button, details and reply footer, when the turn's copy target is a note in this run. */
  footer?: JSX.Element
}) {
  const i18n = useI18n()
  const data = useData()
  const dialog = useDialog()
  const t: Translate = (key, params) => i18n.t(key, { name: Hands.NAME, ...params })
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const tools = createMemo(() => props.parts.filter(isComputerTool))
  const title = createMemo(() => computerRunTitle(tools(), t))
  const active = createMemo(
    () => !!props.busy || tools().some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const last = createMemo(() => {
    const part = tools().at(-1)
    return part && computerSteps(part.state, t).at(-1)
  })
  const latest = createMemo(() => {
    const part = tools().findLast((item) => computerShot(item))
    const shot = part && computerShot(part)
    return part && shot && { part, shot }
  })
  const handleOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
    props.onSizeChange?.()
  }
  const preview = (part: ToolPart, image: FilePart) => {
    const ring = computerRing(part)
    const alt = computerSteps(part.state, t)[0]?.label
    dialog.show(() => (
      <ImagePreview src={image.url} alt={alt}>
        {ring && (
          <svg
            data-slot="computer-ring"
            data-x={ring.x}
            data-y={ring.y}
            viewBox={`0 0 ${ring.width} ${ring.height}`}
            aria-hidden="true"
          >
            <circle cx={ring.x} cy={ring.y} r={Math.max(ring.width, ring.height) * 0.015} />
          </svg>
        )}
      </ImagePreview>
    ))
  }

  return (
    <div data-component="computer-run" data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}>
      <Collapsible open={open()} onOpenChange={handleOpenChange} variant="ghost" class="tool-collapsible">
        <Collapsible.Trigger>
          <div data-slot="computer-run-trigger">
            <Icon name="hands" size="small" />
            <span data-slot="computer-run-title" class="text-14-medium text-text-strong">
              <Show when={active()} fallback={title()}>
                <TextShimmer text={title()} active />
              </Show>
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Show when={!open()}>
          <div data-slot="computer-run-peek">
            <Show when={latest()}>
              {(item) => (
                <Show
                  when={item().shot.image}
                  fallback={<span data-slot="computer-run-removed">{t("ui.tool.computer.screenshotRemoved")}</span>}
                >
                  {(image) => (
                    <button
                      type="button"
                      data-slot="computer-run-thumb"
                      aria-label={t("ui.tool.computer.viewScreenshot")}
                      onClick={() => preview(item().part, image())}
                    >
                      <img src={image().url} alt="" width={THUMB.width} height={THUMB.height} decoding="async" />
                    </button>
                  )}
                </Show>
              )}
            </Show>
            <Show when={last()}>
              {(step) => (
                <span data-slot="computer-run-last" data-state={step().state} class="text-13-regular">
                  {step().label}
                  <Show when={computerStepStatus(step().state, t)}>
                    {(status) => <span data-slot="computer-run-step-status">{status()}</span>}
                  </Show>
                </span>
              )}
            </Show>
          </div>
        </Show>
        <Collapsible.Content>
          <ol data-slot="computer-run-steps">
            <Index each={props.parts}>
              {(part) => (
                <Show
                  when={isComputerTool(part()) ? (part() as ToolPart) : undefined}
                  fallback={
                    <li data-slot="computer-run-step">
                      <Note
                        text={readPartText(data.store.part_text_accum_delta, part() as { id: string; text?: string })}
                        t={t}
                      />
                    </li>
                  }
                >
                  {(tool) => <Step part={tool()} t={t} preview={preview} />}
                </Show>
              )}
            </Index>
          </ol>
        </Collapsible.Content>
      </Collapsible>
      {props.footer}
    </div>
  )
}

function Step(props: { part: ToolPart; t: Translate; preview: (part: ToolPart, image: FilePart) => void }) {
  const steps = createMemo(() => computerSteps(props.part.state, props.t))
  const shot = createMemo(() => computerShot(props.part))
  const intent = createMemo(() => {
    const state = props.part.state
    return state.status === "completed" || state.status === "running" ? agentNote(state.metadata?.intent) : ""
  })

  return (
    <li data-slot="computer-run-step" data-timeline-part-id={props.part.id}>
      <Index each={steps()}>
        {(step) => (
          <div data-slot="computer-run-step-label" data-state={step().state}>
            <Show when={step().state === "running"} fallback={<span>{step().label}</span>}>
              <TextShimmer text={step().label} active />
            </Show>
            <Show when={computerStepStatus(step().state, props.t)}>
              {(status) => <span data-slot="computer-run-step-status">{status()}</span>}
            </Show>
          </div>
        )}
      </Index>
      <Show when={shot()}>
        {(value) => (
          <Show
            when={value().image}
            fallback={<span data-slot="computer-run-removed">{props.t("ui.tool.computer.screenshotRemoved")}</span>}
          >
            {(image) => (
              <button type="button" data-slot="computer-run-view" onClick={() => props.preview(props.part, image())}>
                {props.t("ui.tool.computer.viewScreenshot")}
              </button>
            )}
          </Show>
        )}
      </Show>
      <Show when={intent()}>{(text) => <Note text={text()} t={props.t} />}</Show>
    </li>
  )
}

/** The model's words, attributed and plain: never markdown, never inside a label. */
function Note(props: { text: string; t: Translate }) {
  const text = createMemo(() => agentNote(props.text))
  return (
    <Show when={text()}>
      <p data-slot="computer-run-note" class="text-13-regular text-text-weak">
        {props.t("ui.tool.computer.agent", { text: text() })}
      </p>
    </Show>
  )
}
