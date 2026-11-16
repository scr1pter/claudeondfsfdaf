import { FreeModelsLimit } from "@/components/free-models-limit"
import { CodiumError } from "@/components/codium-error"
import { BudgetStop } from "@/components/budget-stop"
import { publicShareError } from "@vectordevai/schema/public-share"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
import { Accordion } from "@vectordevai/ui/accordion"
import { Button } from "@vectordevai/ui/button"
import { Card } from "@vectordevai/ui/card"
import { ComputerRunCard } from "@vectordevai/session-ui/computer-tool"
import {
  ContextToolGroup,
  copyPartID,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  ReplyActions,
  type UserActions,
} from "@vectordevai/session-ui/message-part"
import { FileIcon } from "@vectordevai/ui/file-icon"
import { Icon } from "@vectordevai/ui/icon"
import { IconButton } from "@vectordevai/ui/icon-button"
import { Icon as IconV2 } from "@vectordevai/ui/v2/icon"
import { IconButtonV2 } from "@vectordevai/ui/v2/icon-button-v2"
import { DropdownMenu } from "@vectordevai/ui/dropdown-menu"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { Dialog } from "@vectordevai/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { InlineInput } from "@vectordevai/ui/inline-input"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { SessionRetry } from "@vectordevai/session-ui/session-retry"
import { KnowledgeFooter } from "@vectordevai/session-ui/knowledge-footer"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner, ScrollView } from "@vectordevai/ui/scroll-view"
import { StickyAccordionHeader } from "@vectordevai/ui/sticky-accordion-header"
import { TextReveal } from "@vectordevai/ui/text-reveal"
import { TextShimmer } from "@vectordevai/ui/text-shimmer"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@vectordevai/sdk/v2"
import { showToast } from "@/utils/toast"
import { getDirectory, getFilename } from "@vectordevai/core/util/path"
import { normalize } from "@vectordevai/session-ui/session-diff"
import { useFileComponent } from "@vectordevai/ui/context/file"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionCostReadout } from "@/components/session-cost-readout"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { sessionTitle } from "@/utils/session-title"
import { scheduleConnectedMeasure } from "./measure"
import { createTimelineProjection } from "./projection"
import { MessageComment, SummaryDiff, TimelineRow, TimelineRowMap } from "./rows"
import { filterVirtualIndexes } from "./virtual-items"
import { SubagentTaskChip } from "@/features/background-tasks/subagent-task-chip"
import { useBackgroundTasks } from "@/features/background-tasks/use-background-tasks"
import { taskBatchEntries } from "@vectordevai/ui/task-batch"
import { isInternalSession } from "@/utils/internal-sessions"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
const timelineCache = new Map<string, { measurements: VirtualItem[]; toolOpen: Record<string, boolean | undefined> }>()

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  const item = taskBatchEntries(part.state.input, metadata)?.find((item) => item.metadata.sessionId === sessionID)
  if (item) {
    const title = item.metadata.title ?? item.input.description
    return typeof title === "string" && title ? title : undefined
  }
  if (metadata?.sessionId !== sessionID) return
  // The engine's lifecycle title, which also covers calls that gave no description.
  if (typeof metadata?.title === "string" && metadata.title) return metadata.title
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

function TimelineThinkingRow(props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <Show when={!props.showReasoningSummaries}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: {
  diffs: SummaryDiff[]
  onUndo?: () => Promise<void> | void
  onReview?: () => void
}) {
  const maxFiles = 3
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const additions = createMemo(() => props.diffs.reduce((total, diff) => total + (diff.additions ?? 0), 0))
  const deletions = createMemo(() => props.diffs.reduce((total, diff) => total + (diff.deletions ?? 0), 0))
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  return (
    <section
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
      class="relative overflow-hidden rounded-2xl border border-[#9374ec]/[0.18] bg-[#202024] shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
    >
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-[2px] bg-gradient-to-b from-[#9374ec]/70 via-[#9374ec]/25 to-transparent"
      />
      <header class="flex items-center gap-3.5 border-b border-[color:var(--vx-line)] px-4 py-3.5">
        <div class="grid size-9 shrink-0 place-items-center rounded-xl border border-[#9374ec]/25 bg-[#9374ec]/[0.13] text-[#c4a6ff]">
          <svg viewBox="0 0 24 24" class="size-[18px]" aria-hidden="true">
            <path
              d="M8 3.75h7.5l3 3v12.5A1.75 1.75 0 0 1 16.75 21h-9.5a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 7.25 3.75H8Zm7 0v3.5h3.5M9 12h6m-3-3v6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-white/90">
            Edited {props.diffs.length} {props.diffs.length === 1 ? "file" : "files"}
          </div>
          <div class="mt-1.5 flex items-center gap-1.5">
            <span class="rounded-md border border-[#65c78e]/25 bg-[#65c78e]/10 px-1.5 py-px font-mono text-[11.5px] font-semibold text-[#7dd8a2]">
              +{additions().toLocaleString()}
            </span>
            <span class="rounded-md border border-[#e6787d]/25 bg-[#e6787d]/10 px-1.5 py-px font-mono text-[11.5px] font-semibold text-[#f2989e]">
              -{deletions().toLocaleString()}
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={props.onUndo}>
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white"
              onClick={() => void props.onUndo?.()}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                <path
                  d="M6.25 4 2.5 7.5 6.25 11M3 7.5h6.25a4 4 0 0 1 0 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Rewind
            </button>
          </Show>
          <Show when={props.onReview}>
            <button
              type="button"
              class="h-8 rounded-lg border border-[#9374ec]/35 bg-[#9374ec]/[0.14] px-3.5 text-[12.5px] font-semibold text-[#d9cbff] transition hover:border-[#9374ec]/60 hover:bg-[#9374ec]/[0.22] hover:text-white"
              onClick={() => props.onReview?.()}
            >
              Review
            </button>
          </Show>
        </div>
      </header>
      <div data-component="session-turn-diffs-content" class="bg-[#1b1b1e]">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div
                        data-slot="session-turn-diff-trigger"
                        class="min-h-12 px-4 transition-colors hover:bg-white/[0.04]"
                      >
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes" class="flex items-center gap-1.5">
                            <span class="font-mono text-[11.5px] font-medium text-[#7dd8a2]">
                              +{diff.additions ?? 0}
                            </span>
                            <span class="font-mono text-[11.5px] font-medium text-[#f2989e]">
                              -{diff.deletions ?? 0}
                            </span>
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={overflow() > 0 || showAll()}>
          <button
            type="button"
            data-slot="session-turn-diffs-more"
            class="flex h-12 w-full items-center gap-2 border-t border-[color:var(--vx-line)] px-5 text-left text-sm font-medium text-white/82 transition hover:bg-white/[0.045] hover:text-white"
            onClick={() => setState("showAll", !showAll())}
          >
            {showAll() ? "Show fewer files" : `Show ${overflow()} more ${overflow() === 1 ? "file" : "files"}`}
            <svg
              viewBox="0 0 16 16"
              class="size-4 transition"
              classList={{ "rotate-180": showAll() }}
              aria-hidden="true"
            >
              <path
                d="m4 6 4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </Show>
      </div>
    </section>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view.fileDiff} />
    </div>
  )
}

export function MessageTimeline(props: {
  actions?: UserActions
  onReviewChanges?: () => void
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: (done: boolean) => void }) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const tabs = useTabs()
  const dialog = useDialog()
  const shareSession = async (sessionID: string) => {
    const owner = shareOwnership.capture()
    const { DialogShareSession } = await import("@/components/dialog-share-session")
    owner.run(() => dialog.show(() => <DialogShareSession sessionID={sessionID} />))
  }
  const language = useLanguage()
  const backgroundTasks = useBackgroundTasks()
  // Task parts render as Background tasks chips: one per phase, drawn at its
  // first task part, so the phase's other task parts render nothing. Running,
  // completed and errored calls alike; parts outside the model fall back.
  const taskChip = (part: PartType | undefined) => {
    if (!backgroundTasks || part?.type !== "tool" || part.tool !== "task") return
    return backgroundTasks.locate(part.id)
  }
  const { params, sessionKey } = useSessionKey()
  const shareOwnership = createSessionOwnership(sessionKey)
  const ownerSessionKey = sessionKey()
  const cached = timelineCache.get(ownerSessionKey)
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && props.shouldAnchorBottom()

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => params.id)
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync().data.session_status[id] ?? idle
  })
  const sessionMessages = createMemo(() => (sessionID() ? (sync().data.message[sessionID()!] ?? []) : []))
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync().session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync().session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync().data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const getMsgParts = (msgId: string) => sync().data.part[msgId] ?? emptyParts
  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => getMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() =>
    settings.general.newLayoutDesigns() ? !!sessionID() : !!(titleValue() || parentID()),
  )
  const projection = createTimelineProjection({
    messages: sessionMessages,
    userMessages: () => props.userMessages,
    parts: getMsgParts,
    status: sessionStatus,
    showReasoningSummaries: settings.general.showReasoningSummaries,
  })
  const activeMessageID = projection.activeMessageID
  const assistantMessagesByParent = projection.assistantMessagesByParent
  const lastAssistantGroupKey = projection.lastAssistantGroupKey
  const runParts = projection.runParts
  const messageByID = projection.messageByID
  const messageLastRowIndex = projection.messageLastRowIndex
  const messageRowIndex = projection.messageRowIndex
  const timelineRowByKey = projection.rowByKey
  const timelineRows = projection.rows

  let prependAnchor: { key: string; offset: number } | undefined
  let prependAnchorFrame: number | undefined
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    if (prependAnchorFrame === undefined) return
    cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    updatePrependAnchor()
  }
  const updatePrependAnchor = () => {
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!anchor) return
    if (!anchor.element.dataset.timelineKey) return
    prependAnchor = { key: anchor.element.dataset.timelineKey, offset: anchor.rect.top - view.top }
  }
  const restorePrependAnchor = (done: boolean) => {
    if (done) prependLoading = false
    applyPrependAnchor()
  }
  const applyPrependAnchor = () => {
    const root = listRoot()
    if (!root || !prependAnchor) return
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const apply = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) return
      const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
      const delta = element
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
        : undefined
      if (delta !== undefined && Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        if (!prependLoading) prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(apply)
    }
    prependAnchorFrame = requestAnimationFrame(apply)
  }

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length || coldBottomMount ? 6 : 20)
  let resizePinnedIndexes: number[] = []
  let resizePinFrame: number | undefined
  let virtualContent: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) => {
        const row = rows[index]
        // ResizeObserver can report a removed element after its row has left the projection.
        if (!row) return `removed:${index}`
        return TimelineRow.key(row)
      }
    },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    get scrollMargin() {
      return showHeader() ? 64 : 0
    },
    overscan: 50,
    paddingEnd: 64,
    rangeExtractor: (range) => {
      const id = activeMessageID()
      const active = id ? (messageLastRowIndex().get(id) ?? -1) : -1
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return filterVirtualIndexes(
        [...new Set([...resizePinnedIndexes, ...indexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
        range.count,
      )
    },
  })
  const resizeItem = virtualizer.resizeItem
  let resizeAnchorScheduled = false
  const anchorResizedBottom = () => {
    if (resizeAnchorScheduled || props.hasScrollGesture()) return
    resizeAnchorScheduled = true
    queueMicrotask(() => {
      resizeAnchorScheduled = false
      if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
      virtualizer.scrollToEnd()
    })
  }
  virtualizer.resizeItem = (index, size) => {
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight) {
      const view = root.getBoundingClientRect()
      resizePinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > view.top && rect.top < view.bottom
        })
        .map((element) => Number(element.dataset.index))
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
    if (root && props.shouldAnchorBottom()) anchorResizedBottom()
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    if (props.shouldAnchorBottom()) return false
    const first = virtualizer.range?.startIndex
    return first !== undefined && item.index < first
  }
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  let overscanFrame: number | undefined
  onMount(() => {
    overscanFrame = requestAnimationFrame(() => {
      if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      overscanFrame = requestAnimationFrame(() => {
        overscanFrame = undefined
        if (renderOverscan() < 20) setRenderOverscan(20)
        if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      })
    })
  })

  const maybeAnchorBottom = () => {
    if (timelineRows().length === 0) return
    if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    clearPrependAnchor()
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    virtualizer.scrollToEnd()
  }

  let measuredSessionKey = sessionKey()
  createEffect(() => {
    const key = sessionKey()
    timelineRows().length
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
    maybeAnchorBottom()
  })

  onCleanup(() => {
    clearPrependAnchor()
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    if (overscanFrame !== undefined) cancelAnimationFrame(overscanFrame)
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
  })
  let titleRef: HTMLInputElement | undefined

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    markBoundaryGesture({ root, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchStart = (event: TouchEvent) => {
    if (!prependLoading) clearPrependAnchor()
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    if (event.target !== event.currentTarget) return
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const key = scrollKey(event)
    if (!key) return
    if (!isScrollKeyTarget(event.target, key)) return
    if (scrollKeyOwner(event.currentTarget, event.target, key) !== event.currentTarget) return
    if (!prependLoading) clearPrependAnchor()
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (prependLoading) updatePrependAnchor()
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk().client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync().set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync().data.message[id] !== undefined) return
        void sync().session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      if (!titleRef) return
      titleRef.focus()
      titleRef.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    const href = (id: string) =>
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id)
    if (parentID) {
      navigate(href(parentID))
      return
    }
    if (nextSessionID) {
      navigate(href(nextSessionID))
      return
    }
    if (params.serverKey) {
      tabs.newDraft({ server: requireServerKey(params.serverKey), directory: sdk().directory })
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const deleteSession = async (sessionID: string, acknowledgePublicShares = false) => {
    const session = sync().session.get(sessionID)
    if (!session) return false

    const sessions = (sync().data.session ?? []).filter(
      (s) => !s.parentID && !s.time?.archived && !isInternalSession(s),
    )
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk()
      .client.session.delete(
        { sessionID, acknowledgePublicShares: acknowledgePublicShares ? "true" : undefined },
        { throwOnError: false },
      )
      .then((result) => {
        if (result.error) throw result.error
        return true
      })
      .catch((err) => {
        const warning = publicShareError(err)
        if (warning) return warning
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false
    if (result !== true) return result

    const removed = new Set<string>([sessionID])
    const byParent = new Map<string, string[]>()
    for (const item of sync().data.session) {
      const parentID = item.parentID
      if (!parentID) continue
      const existing = byParent.get(parentID)
      if (existing) {
        existing.push(item.id)
        continue
      }
      byParent.set(parentID, [item.id])
    }

    const stack = [sessionID]
    while (stack.length) {
      const parentID = stack.pop()
      if (!parentID) continue

      const children = byParent.get(parentID)
      if (!children) continue

      for (const child of children) {
        if (removed.has(child)) continue
        removed.add(child)
        stack.push(child)
      }
    }

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)

    sync().set(
      produce((draft) => {
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    for (const id of removed) {
      sync().session.evict(id)
    }
    notifySessionTabsRemoved({ directory: sdk().directory, sessionIDs: [...removed] })
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id),
    )
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync().session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const [warning, setWarning] = createStore({ links: [] as string[] })
    const handleDelete = async () => {
      const result = await deleteSession(props.sessionID, warning.links.length > 0)
      if (result && result !== true) {
        setWarning("links", [...result.links])
        return
      }
      if (result) dialog.close()
    }
    const description = () =>
      warning.links.length
        ? language.t("session.delete.publicShare.warning")
        : language.t("session.delete.confirm", { name: name() })
    const label = () =>
      warning.links.length ? language.t("session.delete.publicShare.confirm") : language.t("session.delete.button")

    if (settings.general.newLayoutDesigns())
      return (
        <DialogV2 fit>
          <DialogHeader hideClose>
            <DialogTitleGroup title={language.t("session.delete.title")} description={description()} />
            <For each={warning.links}>
              {(url) => <code class="block break-all text-12-regular select-text">{url}</code>}
            </For>
          </DialogHeader>
          <DialogFooter>
            <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 variant="danger" onClick={handleDelete}>
              {label()}
            </ButtonV2>
          </DialogFooter>
        </DialogV2>
      )

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">{description()}</span>
            <For each={warning.links}>
              {(url) => <code class="block break-all text-12-regular select-text">{url}</code>}
            </For>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {label()}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogRenameSession(props: { sessionID: string }) {
    const current = sessionTitle(sync().session.get(props.sessionID)?.title) ?? language.t("command.session.new")
    const [value, setValue] = createSignal(current)
    let input: HTMLInputElement | undefined

    onMount(() => {
      input?.focus()
      input?.select()
    })

    const submit = async (event?: Event) => {
      event?.preventDefault()
      const next = value().trim()
      if (!next || next === current) {
        dialog.close()
        return
      }
      try {
        await titleMutation.mutateAsync({ id: props.sessionID, title: next })
        dialog.close()
      } catch {
        // The mutation reports the actionable error through the shared toast.
      }
    }

    return (
      <DialogV2 fit>
        <DialogHeader>
          <DialogTitleGroup title={language.t("common.rename")} description="Give this session a clear name." />
        </DialogHeader>
        <form class="flex min-w-[360px] flex-col gap-4 self-stretch px-5 pb-2" onSubmit={submit}>
          <input
            ref={input}
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            class="vector-dialog-field h-10 w-full px-3 text-sm text-[color:var(--vx-text)] outline-none"
            aria-label={language.t("common.rename")}
          />
        </form>
        <DialogFooter>
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={!value().trim() || titleMutation.isPending}
            onClick={() => void submit()}
          >
            {language.t("common.rename")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  // The last text with a row of its own, or, when every text is a note inside Hands run cards, the last note, whose
  // card then carries the turn's footer (see copyPartID).
  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
    return copyPartID(
      messages.map((message) => getMsgParts(message.id)),
      runParts(),
    )
  }

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    // This runs inside the insert effect of the row's JSX, so a tracked read of the row would remount the whole group
    // (a run card losing its DOM as its run grows) whenever the row object changes. The row key carries the group
    // type, so a mounted row never changes type, and only the memos below follow the row.
    const type = untrack(() => row().group.type)
    if (type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      const contextOpenKey = () => `context:${row().group.key}`
      const open = createMemo(() => {
        return toolOpen[contextOpenKey()] === true
      })

      return (
        <ContextToolGroup
          parts={parts()}
          open={open()}
          onOpenChange={(value) => setToolOpen(contextOpenKey(), value)}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
      )
    }

    if (type === "computer") {
      // Tool calls and the agent's notes between them, in order; the open state lives with the other tool rows so
      // it survives virtualization and the session cache.
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "computer") return emptyParts
        // A long run holds hundreds of refs, so each message's parts are indexed once instead of searched per ref.
        const byMessage = new Map<string, Map<string, PartType>>()
        return group.refs.flatMap((ref) => {
          const index =
            byMessage.get(ref.messageID) ?? new Map(getMsgParts(ref.messageID).map((part) => [part.id, part] as const))
          byMessage.set(ref.messageID, index)
          return index.get(ref.partID) ?? []
        })
      })
      const openKey = () => `computer:${row().group.key}`
      // When every text of the turn is a note in a run card, the card holding the last one carries the turn's footer.
      const footer = createMemo(() => {
        const id = assistantCopyPartID(row().userMessageID)
        const item = parts().find((part) => part.id === id)
        const message = item && messageByID().get(item.messageID)
        return item?.type === "text" && message ? { item, message } : undefined
      })
      return (
        <ComputerRunCard
          parts={parts()}
          open={toolOpen[openKey()] === true}
          onOpenChange={(value) => setToolOpen(openKey(), value)}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
          footer={
            <Show when={footer()}>
              {(value) => (
                <ReplyActions
                  message={value().message}
                  part={value().item}
                  turnDurationMs={turnDurationMs(row().userMessageID)}
                  useV2Actions={settings.general.newLayoutDesigns()}
                />
              )}
            </Show>
          }
        />
      )
    }

    const message = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return messageByID().get(group.ref.messageID)
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return getMsgPart(group.ref.messageID, group.ref.partID)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(item, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())
    })
    const chip = createMemo(() => taskChip(part()))

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <Show
                when={chip()}
                fallback={
                  <MessagePart
                    part={part()}
                    message={message()}
                    showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                    turnDurationMs={turnDurationMs(row().userMessageID)}
                    useV2Actions={settings.general.newLayoutDesigns()}
                    defaultOpen={defaultOpen()}
                    toolOpen={toolOpen[part().id] ?? defaultOpen()}
                    onToolOpenChange={(open) => setToolOpen(part().id, open)}
                    deferToolContent
                    virtualizeDiff={false}
                    onContentRendered={onSizeChange}
                  />
                }
              >
                {(location) => (
                  <Show when={location().first}>
                    <SubagentTaskChip location={location} onSizeChange={onSizeChange} />
                  </Show>
                )}
              </Show>
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    const previousAssistantPart = () => {
      const row = input.row()
      return row._tag === "AssistantPart" && row.previousAssistantPart
    }
    // A task part folded into its phase's chip renders nothing, so it must not add a gap either.
    const absorbedTask = () => {
      const row = input.row()
      if (row._tag !== "AssistantPart" || row.group.type !== "part") return false
      const location = backgroundTasks?.locate(row.group.ref.partID)
      return !!location && !location.first
    }
    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-3": previousAssistantPart() && !absorbedTask(),
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    switch (row()._tag) {
      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div
                        classList={{
                          "shrink-0 max-w-[260px] rounded-[6px] border-border-weak-base bg-background-stronger px-2.5 py-2": true,
                          "border-[0.5px]": settings.general.newLayoutDesigns(),
                          border: !settings.general.newLayoutDesigns(),
                        }}
                      >
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      actions={props.actions}
                      useV2Actions={settings.general.newLayoutDesigns()}
                    />
                  </div>
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(
                    turnDividerRow().label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted",
                  )}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary": {
        const diffSummaryRow = row as Accessor<TimelineRowByTag<"DiffSummary">>
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow
                diffs={diffSummaryRow().diffs}
                onUndo={
                  props.actions?.revert
                    ? () => {
                        const id = sessionID()
                        if (!id) return
                        return props.actions?.revert?.({ sessionID: id, messageID: diffSummaryRow().userMessageID })
                      }
                    : undefined
                }
                onReview={props.onReviewChanges}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "MemoryUsed": {
        const memoryUsedRow = row as Accessor<TimelineRowByTag<"MemoryUsed">>
        return (
          <TimelineRowFrame row={memoryUsedRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <KnowledgeFooter parts={getMsgParts(memoryUsedRow().userMessageID)} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = row as Accessor<TimelineRowByTag<"Error">>
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Switch
                fallback={
                  <Show
                    when={errorRow().codium}
                    fallback={
                      <Card variant="error" class="error-card">
                        {errorRow().text}
                      </Card>
                    }
                  >
                    {(action) => <CodiumError text={errorRow().text} action={action()} />}
                  </Show>
                }
              >
                <Match when={errorRow().freeLimit && sessionID()}>
                  <FreeModelsLimit sessionID={sessionID()!} limit={errorRow().freeLimit!} />
                </Match>
                <Match when={errorRow().budgetStop && sessionID()}>
                  <BudgetStop
                    sessionID={sessionID()!}
                    stop={errorRow().budgetStop!}
                    openParent={parentID() ? navigateParent : undefined}
                  />
                </Match>
              </Switch>
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }

  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement
    const initialItem = virtualItemByKey().get(props.rowKey)!
    const initialRow = timelineRowByKey().get(props.rowKey)!
    const item = createMemo(() => virtualItemByKey().get(props.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(props.rowKey) ?? initialRow)
    const asyncFile = () => {
      const value = row()
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return false
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
      return part?.type === "tool" && ["edit", "write", "apply_patch"].includes(part.tool)
    }
    const [ready, setReady] = createSignal(initialItem.size <= timelineFallbackItemSize || !asyncFile())
    let contentMeasureFrame: number | undefined

    onMount(() => virtualizer.measureElement(element))

    createEffect(
      on(
        () => item().index,
        () => {
          virtualizer.measureElement(element)
        },
        { defer: true },
      ),
    )

    onCleanup(() => {
      if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
    })

    return (
      <div
        data-timeline-key={props.rowKey}
        style={{
          position: "absolute",
          top: `${item().start - (showHeader() ? 64 : 0)}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          overflow: "clip",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
        >
          <TimelineRowView
            row={row()}
            onSizeChange={() => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = scheduleConnectedMeasure(element, virtualizer.measureElement)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div class="relative w-full h-full min-w-0">
      <div
        class="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "bottom-8": settings.general.newLayoutDesigns(),
          "bottom-6": !settings.general.newLayoutDesigns(),
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          "scale-[0.8]": (!props.scroll.overflow || !props.scroll.jump) && settings.general.newLayoutDesigns(),
          "scale-95": (!props.scroll.overflow || !props.scroll.jump) && !settings.general.newLayoutDesigns(),
        }}
      >
        <Show
          when={settings.general.newLayoutDesigns()}
          fallback={
            <button
              type="button"
              aria-label={language.t("session.messages.jumpToLatest")}
              class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
              onClick={props.onResumeScroll}
            >
              <div
                class="flex items-center justify-center w-8 h-6 rounded-[6px] border border-border-weaker-base bg-[color-mix(in_srgb,var(--surface-raised-stronger-non-alpha)_80%,transparent)] backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
                style={{
                  "box-shadow":
                    "0 51px 60px 0 rgba(0,0,0,0.10), 0 15px 18px 0 rgba(0,0,0,0.12), 0 6.386px 7.513px 0 rgba(0,0,0,0.12), 0 2.31px 2.717px 0 rgba(0,0,0,0.20)",
                }}
              >
                <Icon name="arrow-down-to-line" size="small" />
              </div>
            </button>
          }
        >
          <button
            type="button"
            aria-label={language.t("session.messages.jumpToLatest")}
            class="pointer-events-auto flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-lg border-none cursor-pointer text-v2-text-text-base backdrop-blur-[2px]"
            style={{
              background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
              "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
            }}
            onClick={props.onResumeScroll}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                stroke="currentColor"
                stroke-linecap="square"
              />
            </svg>
          </button>
        </Show>
      </div>
      <ScrollView
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onKeyDown={handleListKeyDown}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
        }}
      >
        <Show when={settings.general.newLayoutDesigns() && timelineRows().length === 0}>
          <div
            data-vector-session-empty
            class="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 pb-36"
          >
            <div class="flex flex-col items-center text-center">
              <img
                src="/vector-logo.png"
                alt="Vector"
                class="size-14 rounded-2xl object-cover shadow-[0_22px_60px_rgba(155,108,255,0.2)]"
                draggable={false}
              />
              <h1 class="mt-5 text-[30px] font-medium leading-tight tracking-normal text-text-strong">
                What can I do for you?
              </h1>
            </div>
          </div>
        </Show>
        <Show when={showHeader()}>
          <div
            data-session-title
            classList={{
              "sticky top-0 z-30": true,
              "bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_48px,transparent)]":
                settings.general.newLayoutDesigns(),
              "bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]":
                !settings.general.newLayoutDesigns(),
              "w-full": true,
              "pb-4": true,
              "pr-3": true,
              "pl-2": settings.general.newLayoutDesigns(),
              "pl-2 md:pl-4": !settings.general.newLayoutDesigns(),
              "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered && !settings.general.newLayoutDesigns(),
            }}
          >
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div
                classList={{
                  "flex items-center gap-1 min-w-0 flex-1": true,
                  "pr-3": !settings.general.newLayoutDesigns(),
                }}
              >
                <div class="flex items-center min-w-0 flex-1 w-full">
                  <Show when={parentID()}>
                    <button
                      type="button"
                      data-slot="session-title-parent"
                      class="min-w-0 max-w-[40%] truncate px-2 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
                      onClick={navigateParent}
                    >
                      {parentTitle()}
                    </button>
                    <span
                      data-slot="session-title-separator"
                      class="-translate-y-[0.5px] px-1 text-[11px] font-medium text-v2-text-text-faint"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  </Show>
                  <Show when={childTitle() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          classList={{
                            "truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                            "w-fit rounded-[6px] px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover":
                              settings.general.newLayoutDesigns(),
                            "grow-1 min-w-0": !settings.general.newLayoutDesigns(),
                          }}
                          onClick={openTitleEditor}
                        >
                          {childTitle()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        classList={{
                          "block text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                          "w-full flex-1 grow-1 min-w-0 pl-1 -ml-1 rounded-[6px]": !settings.general.newLayoutDesigns(),
                          "field-sizing-content self-start rounded-[6px] px-2 py-1 ":
                            settings.general.newLayoutDesigns(),
                        }}
                        style={{
                          "--inline-input-shadow": settings.general.newLayoutDesigns()
                            ? "none"
                            : "var(--shadow-xs-border-select)",
                        }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={() => void saveTitleEditor()}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div
                    classList={{
                      "shrink-0 flex items-center": true,
                      "gap-2": settings.general.newLayoutDesigns(),
                      "gap-3": !settings.general.newLayoutDesigns(),
                    }}
                  >
                    <SessionCostReadout />
                    <SessionContextUsage
                      placement="bottom"
                      buttonAppearance={settings.general.newLayoutDesigns() ? "v2" : "default"}
                    />
                    <Show when={!parentID()}>
                      <Show
                        when={settings.general.newLayoutDesigns()}
                        fallback={
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content style={{ "min-width": "104px" }}>
                                <DropdownMenu.Item onSelect={() => void shareSession(id)}>
                                  <DropdownMenu.ItemLabel>Share publicly…</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogRenameSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>
                        }
                      >
                        <MenuV2
                          gutter={6}
                          placement="bottom-end"
                          open={title.menuOpen}
                          onOpenChange={(open) => {
                            setTitle("menuOpen", open)
                            if (open) return
                          }}
                        >
                          <MenuV2.Trigger
                            as={IconButtonV2}
                            icon={<IconV2 name="outline-dots" />}
                            variant="ghost-muted"
                            size="large"
                            aria-label={language.t("common.moreOptions")}
                            aria-expanded={title.menuOpen}
                          />
                          <MenuV2.Portal>
                            <MenuV2.Content style={{ width: "200px", "min-width": "200px" }}>
                              <MenuV2.Item onSelect={() => void shareSession(id)}>Share publicly…</MenuV2.Item>
                              <MenuV2.Item onSelect={() => dialog.show(() => <DialogRenameSession sessionID={id} />)}>
                                {language.t("common.rename")}
                              </MenuV2.Item>
                              <MenuV2.Item onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}>
                                {language.t("common.delete")}...
                              </MenuV2.Item>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
        <div
          data-timeline-virtual-content
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
          }}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
          <Show when={timelineRows().length > 0}>
            <div
              data-timeline-row="bottom-spacer"
              aria-hidden="true"
              class="h-[64px] absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
