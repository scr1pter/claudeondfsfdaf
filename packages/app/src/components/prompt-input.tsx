import { useFilteredList } from "@vectordevai/ui/hooks"
import { useSpring } from "@vectordevai/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  Show,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  Switch,
  Match,
  untrack,
  type JSX,
} from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@vectordevai/ui/button"
import { DockShellForm, DockTray } from "@vectordevai/ui/dock-surface"
import { Icon } from "@vectordevai/ui/icon"
import { ProviderIcon } from "@vectordevai/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@vectordevai/ui/tooltip"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { KeybindV2 } from "@vectordevai/ui/v2/keybind-v2"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { IconButton } from "@vectordevai/ui/icon-button"
import { Select } from "@vectordevai/ui/select"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { usePlanMode } from "@/context/plan-mode"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createSessionTabs } from "@/pages/session/helpers"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES, pickAttachmentFiles } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, pastedIn, rememberPaste, restorePastes, type FollowupDraft } from "./prompt-input/submit"
import { watchLearned } from "@/features/memory/learned"
import { DialogFreeModelTraining } from "./dialog-free-model-training"
import { acceptFreeModelTraining, freeModelTrainingGate } from "@/utils/free-model-policy-notice"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptRemember } from "./prompt-input/remember-chips"
import { documentKind, pasteKept, pasteName } from "./prompt-input/remember"
import { refusal, refusalLabel } from "./settings-v2/memory-documents-model"
import { ServerConnection, useServer } from "@/context/server"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { FreeModelStart } from "./prompt-input/free-model-start"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { createPromptInputTransientState } from "./prompt-input/transient-state"
import { showToast } from "@/utils/toast"
import { dictationAvailable, startDictation, type DictationHandle } from "@/services/dictation"
import { DictationIndicator } from "@/components/dictation-indicator"
import { ImagePreview } from "@vectordevai/ui/image-preview"
import type { ReferenceInfo } from "@vectordevai/sdk/v2/client"
import { modelVariantDescription, modelVariantLabel, visibleModelVariants } from "@/context/model-variant"
import { pickerModelName } from "@/utils/provider-brand"
import { freeModelTrainingLabel } from "@vectordevai/core/free-model-choice"
import { detectParallelIntent } from "@/features/delegation/delegation"
import { holdsHandoff } from "@/utils/composer-handoff"
import { createOutcomes } from "@/features/economics/economics-repository"
import { recommendationAvailable, recommendModel } from "@/features/economics/economics-recommender"
import { categorizeTask } from "@/features/economics/task-categorizer"
import {
  DEPTHS,
  MODES,
  PLACEHOLDER as RESEARCH_PLACEHOLDER,
  PREVIEW,
  SCOPES,
  browserStorage,
  capLabel,
  modesFor,
  hasResearch,
  rememberMode,
  rememberedMode,
  scopeLabel,
  sendMode,
  stickyMode,
  type Depth,
  type Mode,
} from "@/features/research/research-model"
import type { Research } from "@vectordevai/schema/research"
import { LocalStatusPill } from "@/features/local/status-pill"
import { useLocalStatus } from "@/features/local/use-local"
import "@/features/research/research.css"

export type PromptInputState = ReturnType<typeof usePrompt>

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) => void
}

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

export type PromptInputControls = {
  agents: {
    available: { name: string; description?: string; hidden?: boolean; mode: string }[]
    options: string[]
    current: string
    loading: boolean
    visible: boolean
    select: (name: string | undefined) => void
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
  }
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
  newLayoutDesigns: boolean
}

export function createPromptInputHistory(): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ entries: [] })
  const [shell, setShell] = createStore<PromptHistoryState>({ entries: [] })
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

type PromptHistoryState = { entries: PromptHistoryStoredEntry[] }

function createPromptInputHistoryStore(
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  return {
    entries: (mode) => (mode === "shell" ? shell.entries : normal.entries),
    add(prompt, mode, comments) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      const next = prependHistoryEntry(current.entries, prompt, comments)
      if (next === current.entries) return
      setCurrent("entries", next)
    },
  }
}

function createPersistedPromptInputHistory() {
  const [normal, setNormal] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<PromptHistoryState>({ entries: [] }),
  )
  const [shell, setShell] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<PromptHistoryState>({ entries: [] }),
  )
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

export interface PromptInputProps {
  class?: string
  variant?: "dock" | "new-session"
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  controls: PromptInputControls
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => boolean | void
  onAbort?: () => void
  onSubmit?: () => void
  toolbar?: JSX.Element
  /**
   * A prompt handed to this composer to send as soon as models and agents have
   * loaded. It is sent only while the composer still holds exactly this text.
   */
  autoSubmit?: string
  /** Called once when that automatic submission starts. */
  onAutoSubmit?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()

  const sync = useSync()
  const files = useFile()
  const prompt = props.state ?? usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const planMode = usePlanMode()
  const settings = useSettings()
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = () => props.controls.session.tabs
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement
  let restoreEndOnFocus = true

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  createEffect(() => {
    if (planMode.enabled()) return
    if (props.controls.agents.current !== "plan") return

    const next = props.controls.agents.available.find(
      (agent) => agent.name !== "plan" && agent.mode !== "subagent" && !agent.hidden,
    )
    if (!next) return
    props.controls.agents.select(next.name)
  })

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false

    const diffs = sync().data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createPromptInputTransientState(
    () => prompt.capture(),
    Math.floor(Math.random() * EXAMPLES.length),
  )
  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  // While the agent is busy and queue mode is active, a non-empty submit enqueues
  // the message instead of interrupting the turn — surface that as "Queue".
  const queueing = createMemo(() => working() && !blank() && !!props.shouldQueue?.())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t(queueing() ? "prompt.action.queue" : "prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }
  const [listening, setListening] = createSignal(false)
  const [transcribing, setTranscribing] = createSignal(false)
  const [recordingLevel, setRecordingLevel] = createSignal(0)
  let dictation: DictationHandle | undefined
  let dictationStarting = false
  let voiceDisposed = false
  const appendPromptText = (text: string) => {
    const addition = text.trim()
    if (!addition) return
    const current = prompt.current()
    const currentText = current
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .trimEnd()
    const nextText = currentText ? `${currentText} ${addition}` : addition
    const images = current.filter((part): part is ImageAttachmentPart => part.type === "image")
    prompt.set([{ type: "text", content: nextText, start: 0, end: nextText.length }, ...images], nextText.length)
    requestAnimationFrame(() => {
      editorRef?.focus()
      if (editorRef) setCursorPosition(editorRef, nextText.length)
    })
  }
  const micAvailable = createMemo(() => dictationAvailable())

  // One engine per runtime, chosen by the shared dictation service: desktop
  // always records natively and transcribes on-device with Whisper (Electron's
  // SpeechRecognition engine always fails with "network"); web uses the
  // browser's SpeechRecognition.
  const startVoiceInput = async () => {
    if (transcribing()) return
    if (dictation) {
      dictation.stop()
      return
    }
    if (dictationStarting) return
    dictationStarting = true
    try {
      const handle = await startDictation({
        onState: (state) => {
          if (voiceDisposed) return
          setListening(state === "listening")
          setTranscribing(state === "transcribing")
          if (state !== "listening") setRecordingLevel(0)
        },
        onLevel: setRecordingLevel,
        onFinal: (text) => {
          dictation = undefined
          setRecordingLevel(0)
          if (!voiceDisposed) appendPromptText(text)
        },
        onError: (message) => {
          dictation = undefined
          setRecordingLevel(0)
          if (!voiceDisposed) showToast({ title: "Dictation", description: message })
        },
      })
      if (voiceDisposed) {
        handle?.cancel()
        return
      }
      dictation = handle
      if (handle && globalThis.window?.api) {
        showToast({ title: "Listening", description: "Tap the microphone again when you are finished." })
      }
    } finally {
      dictationStarting = false
    }
  }

  onCleanup(() => {
    voiceDisposed = true
    dictation?.cancel()
    dictation = undefined
  })

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false
    const messages = sync().data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const history = props.history ?? createPersistedPromptInputHistory()

  // Parallel-delegation suggestion: cheap to compute (skipped entirely in
  // shell mode) and purely additive — it never intercepts submit, only
  // offers to hand the current prompt to Parallel Workspaces.
  const delegationPromptText = createMemo(() => {
    if (store.mode === "shell") return ""
    return prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
  })
  const delegationIntent = createMemo(() => {
    const text = delegationPromptText()
    if (!text) return undefined
    return detectParallelIntent(text)
  })
  const [delegationDismissedFor, setDelegationDismissedFor] = createSignal("")
  const showDelegationChip = createMemo(() => {
    if (!props.controls.newLayoutDesigns) return false
    if (!delegationIntent()) return false
    return delegationDismissedFor() !== delegationPromptText()
  })
  const dismissDelegation = () => setDelegationDismissedFor(delegationPromptText())
  const delegateToParallel = () => {
    const intent = delegationIntent()
    if (!intent) return
    globalThis.window?.dispatchEvent(
      new CustomEvent("vector:delegate-parallel", { detail: { missions: intent.missions } }),
    )
    setDelegationDismissedFor(delegationPromptText())
  }

  // Recommend only available models with enough completed or positively validated work.
  // Execution failures remain in the ranking evidence; completion itself does not imply passing checks.
  const taskCategory = createMemo(() => categorizeTask(delegationPromptText()))
  const economicsOutcomes = createOutcomes(() => sdk().directory)
  const recommendationModels = createMemo(() =>
    props.controls.model.selection
      .list()
      .map((model) => ({
        providerID: model.provider.id,
        modelID: model.id,
        variants: visibleModelVariants(Object.keys(model.variants ?? {})),
      }))
      .filter((model) => props.controls.model.selection.visible(model)),
  )
  const modelRecommendation = createMemo(() =>
    recommendModel(economicsOutcomes() ?? [], taskCategory(), 3, recommendationModels()),
  )
  const [recommendationDismissedFor, setRecommendationDismissedFor] = createSignal("")
  const recommendationDiffersFromCurrent = createMemo(() => {
    const rec = modelRecommendation()
    if (!rec) return false
    const current = props.controls.model.selection.current()
    return (
      current?.provider?.id !== rec.provider ||
      current?.id !== rec.model ||
      props.controls.model.selection.variant.current() !== rec.variant
    )
  })
  const recommendationKey = createMemo(() =>
    JSON.stringify([
      taskCategory(),
      modelRecommendation()?.provider,
      modelRecommendation()?.model,
      modelRecommendation()?.variant,
    ]),
  )
  const showRecommendationChip = createMemo(() => {
    if (!props.controls.newLayoutDesigns) return false
    if (!modelRecommendation()) return false
    if (!recommendationDiffersFromCurrent()) return false
    return recommendationDismissedFor() !== recommendationKey()
  })
  const dismissRecommendation = () => setRecommendationDismissedFor(recommendationKey())
  const useRecommendedModel = () => {
    const rec = modelRecommendation()
    if (!rec || !recommendationAvailable(rec, recommendationModels())) return
    props.controls.model.selection.set(
      { providerID: rec.provider, modelID: rec.model, variant: rec.variant },
      { recent: true },
    )
    dismissRecommendation()
  }

  const suggest = createMemo(() => !hasUserPrompt())

  // The mode is per session. Deep research is sticky: a session whose latest request went to the research agent stays
  // in it, and a new session starts in it when it was the last mode picked in this repository. Normal, Quick and Fast
  // last until the composer changes session, as before.
  const [pickedModes, setPickedModes] = createStore<Record<string, Mode>>({})
  const modeKey = () => props.controls.session.id ?? `new:${sdk().directory}`
  // Vector Local as the engine holds it, for the pill, the Mode menu and the image check on send.
  const localMode = useLocalStatus()
  // Where the engine says the selected model's requests go: on a server someone hosts (this computer, the user's network
  // or the Vector Local list) Fast is hidden, and a research cap is a step count only when the engine counts the
  // model's steps as having no per-token price.
  const hosted = createMemo(() => props.controls.model.selection.hosted())
  const modes = createMemo(() => modesFor(hosted() !== undefined, hasResearch(sync().data.agent)))
  const sessionTitle = (id: string) => sync().data.session.find((item) => item.id === id)?.title
  const executionMode = createMemo<Mode>(() => {
    const chosen = (() => {
      const picked = pickedModes[modeKey()]
      if (picked) return picked
      const id = props.controls.session.id
      if (id) return stickyMode(sync().data.message?.[id] ?? []) ?? "normal"
      return rememberedMode(browserStorage(), sdk().directory) ?? "normal"
    })()
    return sendMode(chosen, hosted() !== undefined)
  })
  const setExecutionMode = (mode: Mode) => {
    setPickedModes(modeKey(), mode)
    rememberMode(browserStorage(), sdk().directory, mode)
  }
  // The first message of a new session gives this composer its session: the mode picked for it stays.
  createEffect(
    on(
      () => props.controls.session.id,
      (id, previous) => {
        if (!id || previous !== undefined) return
        const picked = pickedModes[`new:${sdk().directory}`]
        if (picked && !pickedModes[id]) setPickedModes(id, picked)
      },
      { defer: true },
    ),
  )
  const researching = createMemo(() => executionMode() === "research" && store.mode !== "shell")
  const [researchDepth, setResearchDepth] = createSignal<Depth>("auto")
  const [researchScope, setResearchScope] = createSignal<Research.Scope>("web+brain")
  const researchCap = createMemo(() =>
    capLabel({
      depth: researchDepth(),
      local: hosted()?.local === true,
      codium: Billing.isCodium(props.controls.model.selection.current()?.provider?.id),
      own: sync().data.config.budget?.run,
      limits: sync().data.config.research?.limits,
    }),
  )
  const placeholder = createMemo(() =>
    store.mode !== "shell" && executionMode() === "research" && !commentCount()
      ? RESEARCH_PLACEHOLDER
      : promptPlaceholder({
          mode: store.mode,
          commentCount: commentCount(),
          example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
          suggest: suggest(),
          t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
        }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => {
    pickAttachmentFiles({
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      fallback: () => fileInputRef?.click(),
      onFile: addAttachment,
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    if (mode === "shell" && planMode.enabled()) {
      showToast({
        title: "Plan Mode is on",
        description: "Exit Plan Mode before running shell commands.",
      })
      return
    }
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell" || planMode.enabled(),
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  const handleFocus = () => {
    if (!restoreEndOnFocus) return
    restoreEndOnFocus = false
    requestAnimationFrame(() => {
      if (document.activeElement !== editorRef) return
      setCursorPosition(editorRef, prompt.cursor() ?? promptLength(prompt.current()))
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    props.controls.session.id
    if (props.controls.session.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const referenceDescription = (reference: ReferenceInfo) =>
    reference.source.type === "git" ? reference.source.repository : reference.source.path

  const referenceList = createMemo(() =>
    sync()
      .data.reference.filter((reference) => !reference.hidden)
      .map(
        (reference): AtOption => ({
          type: "reference",
          name: reference.name,
          path: reference.path,
          display: reference.name,
          description: reference.description ?? referenceDescription(reference),
        }),
      ),
  )

  const agentList = createMemo(() =>
    props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map(
        (agent): AtOption => ({
          type: "agent",
          name: agent.name,
          display: agent.name,
          description: agent.description,
        }),
      ),
  )

  const mcpResourceList = createMemo(() =>
    Object.values(sync().data.mcp_resource).map(
      (resource): AtOption => ({
        type: "resource",
        name: resource.name,
        uri: resource.uri,
        client: resource.client,
        display: resource.name,
        description: resource.description,
        mime: resource.mimeType,
      }),
    ),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
      return
    }
    if (option.type === "reference") {
      addPart({
        type: "file",
        path: option.path,
        content: "@" + option.name,
        start: 0,
        end: 0,
        mime: "application/x-directory",
        filename: option.name,
      })
      return
    }
    if (option.type === "resource") {
      addPart({
        type: "file",
        path: option.uri,
        content: "@" + option.name,
        start: 0,
        end: 0,
        mime: option.mime ?? "text/plain",
        filename: option.name,
        url: option.uri,
        source: {
          type: "resource",
          text: { value: "@" + option.name, start: 0, end: 0 },
          clientName: option.client,
          uri: option.uri,
        },
      })
      return
    }
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    if (x.type === "agent") return `agent:${x.name}`
    if (x.type === "reference") return `reference:${x.name}`
    if (x.type === "resource") return `resource:${x.client}:${x.uri}`
    return `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const references = referenceList()
      const agents = agentList()
      const mcpResources = mcpResourceList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...references, ...agents, ...mcpResources, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...references, ...agents, ...mcpResources, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    skipFilter: (item) => item.type === "file" && !item.recent,
    groupBy: (item) => {
      if (item.type === "reference") return "reference"
      if (item.type === "agent") return "agent"
      if (item.type === "resource") return "resource"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "reference") return 0
        if (category === "agent") return 1
        if (category === "resource") return 2
        if (category === "recent") return 3
        return 4
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync().data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") {
      pill.setAttribute("data-path", part.path)
      if (part.mime) pill.setAttribute("data-mime", part.mime)
      if (part.filename) pill.setAttribute("data-filename", part.filename)
      if (part.url) pill.setAttribute("data-url", part.url)
      if (part.source?.type === "resource") {
        pill.setAttribute("data-source-type", part.source.type)
        pill.setAttribute("data-source-client-name", part.source.clientName)
        pill.setAttribute("data-source-uri", part.source.uri)
      }
    }
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  const scrollSlashActiveIntoView = () => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  }
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      const source =
        file.dataset.sourceType === "resource" && file.dataset.sourceClientName && file.dataset.sourceUri
          ? {
              type: "resource" as const,
              text: {
                value: content,
                start: position,
                end: position + content.length,
              },
              clientName: file.dataset.sourceClientName,
              uri: file.dataset.sourceUri,
            }
          : undefined
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
        ...(file.dataset.mime ? { mime: file.dataset.mime } : {}),
        ...(file.dataset.filename ? { filename: file.dataset.filename } : {}),
        ...(file.dataset.url ? { url: file.dataset.url } : {}),
        ...(source ? { source } : {}),
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    history.add(prompt, mode, mode === "shell" ? [] : historyComments())
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: history.entries(store.mode),
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  // Long pasted prose the composer offers to keep as a document, until the user keeps it, dismisses it or sends.
  const [pasted, setPasted] = createSignal<{ text: string; name: string; busy: boolean }>()
  const { addAttachment, addAttachments, removeAttachment, updateAttachment, handlePaste } = createPromptAttachments({
    prompt,
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
    getPathForFile: platform.getPathForFile,
    onProse: (text) => setPasted({ text, name: pasteName(text), busy: false }),
  })
  createEffect(() => {
    if (blank()) setPasted(undefined)
  })
  // What the user pastes is someone else's words (an email, a log), so the message marks where it sits and Vector never
  // learns from it.
  const paste = (event: ClipboardEvent) => {
    rememberPaste(prompt.capture(), event.clipboardData?.getData("text/plain") ?? "")
    return handlePaste(event)
  }
  // A message brought back whole (from history, by Undo, by a fork or from the queue) marks what was pasted into it
  // again, as this window sent it or as the session's copy of it says. Typing changes the text a character at a time
  // and brings back nothing.
  createEffect(
    on(
      () =>
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join(""),
      (text, previous) => {
        if (!text || (previous !== undefined && Math.abs(text.length - previous.length) <= 1)) return
        const sessionID = props.controls.session.id
        const data = sync().data
        const marked = (sessionID ? (data.message[sessionID] ?? []) : []).flatMap((message) =>
          message.role !== "user"
            ? []
            : (data.part[message.id] ?? []).flatMap((part) =>
                part.type === "text" && part.text === text ? pastedIn(part) : [],
              ),
        )
        restorePastes(prompt.capture(), text, marked)
      },
    ),
  )
  // The "Learned 2 things" chip under a reply reads what Vector learned from the events of this composer's sessions.
  createEffect(() => watchLearned(sdk().event))

  // A PDF attached from this computer, to the app's own engine, is counted by the engine (pages and tokens), so the
  // composer can suggest remembering it instead of sending every page. Anything else is judged by its size.
  const server = useServer()
  const probed = new Set<string>()
  createEffect(() => {
    const builtin = !!server.current && ServerConnection.builtin(server.current)
    if (!builtin) return
    for (const attachment of imageAttachments()) {
      if (documentKind(attachment) !== "pdf" || !attachment.sourcePath || attachment.probe || probed.has(attachment.id))
        continue
      probed.add(attachment.id)
      void sdk()
        .client.memory.documents.probe({ path: attachment.sourcePath })
        .then((result) => {
          if (result.data) updateAttachment(attachment.id, { probe: result.data })
        })
        .catch(() => undefined)
    }
  })

  const keepPasted = async () => {
    const current = pasted()
    if (!current || current.busy) return
    setPasted({ ...current, busy: true })
    const sessionID = props.controls.session.id
    const result = await sdk()
      .client.memory.documents.text({ name: current.name, text: current.text, ...(sessionID ? { sessionID } : {}) })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setPasted(undefined)
    if (result.data) {
      showToast({ title: pasteKept(current.name) })
      return
    }
    const why = refusal(result.error)
    showToast({ title: refusalLabel(why.reason, why.message, current.name), variant: "error" })
  }
  const rememberChips = () => (
    <PromptRemember
      attachments={imageAttachments()}
      onMode={(id, remember) => updateAttachment(id, { remember })}
      onRemove={removeAttachment}
      paste={pasted() ? { name: pasted()!.name, busy: pasted()!.busy } : undefined}
      onPasteKeep={() => void keepPasted()}
      onPasteDismiss={() => setPasted(undefined)}
    />
  )

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  const effortIndex = createMemo(() => {
    const current = props.controls.model.selection.variant.current() ?? "default"
    const index = variants().indexOf(current)
    return index < 0 ? 0 : index
  })
  const effortProgress = createMemo(() => {
    const steps = variants().length - 1
    return steps <= 0 ? 0 : (effortIndex() / steps) * 100
  })
  // The lit run covers whole segments: the lowest level is one segment, not an
  // empty bar, because "low" is a setting rather than the absence of one.
  const effortFill = createMemo(() => {
    const total = variants().length
    return total <= 0 ? 0 : ((effortIndex() + 1) / total) * 100
  })
  const selectEffortIndex = (index: number) => {
    const value = variants()[Math.max(0, Math.min(index, variants().length - 1))]
    props.controls.model.selection.variant.set(value === "default" ? undefined : value)
  }
  const isMaxEffort = createMemo(() => modelVariantLabel(props.controls.model.selection.variant.current()) === "Max")
  // Check provider variants directly: `variants` also includes the UI-only default option.
  const showVariantControl = createMemo(() => props.controls.model.selection.variant.list().length > 0)
  const [executionModeMenuOpen, setExecutionModeMenuOpen] = createSignal(false)
  const executionModeMeta = createMemo(() => MODES.find((mode) => mode.id === executionMode()) ?? MODES[0])
  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })

  // Codex/Claude-style approval MODES, mapped onto Vector's real state:
  // plan mode + auto-accept (full access). Sits next to the effort control.
  const setFullAccess = (on: boolean) => {
    if (accepting() === on) return
    const id = props.controls.session.id
    if (id) permission.toggleAutoAccept(id, sdk().directory)
    else permission.toggleAutoAcceptDirectory(sdk().directory)
  }
  const composerMode = createMemo<"manual" | "plan" | "full">(() =>
    planMode.enabled() ? "plan" : accepting() ? "full" : "manual",
  )
  const setComposerMode = (mode: "manual" | "plan" | "full") => {
    if (mode === "plan") {
      setFullAccess(false)
      planMode.setEnabled(true)
    } else if (mode === "full") {
      planMode.setEnabled(false)
      setFullAccess(true)
    } else {
      planMode.setEnabled(false)
      setFullAccess(false)
    }
  }
  const COMPOSER_MODES = [
    {
      id: "manual" as const,
      label: "Manual",
      description: "Ask before editing files or running commands",
      dot: "#8a8595",
    },
    { id: "plan" as const, label: "Plan", description: "Plan and explain only — no file changes", dot: "#9b6cff" },
    {
      id: "full" as const,
      label: "Full access",
      description: "Edit files, run commands, and use the browser without asking",
      dot: "#e6a15c",
    },
  ]
  const composerModeMeta = createMemo(
    () => COMPOSER_MODES.find((mode) => mode.id === composerMode()) ?? COMPOSER_MODES[0],
  )
  const [composerModeMenuOpen, setComposerModeMenuOpen] = createSignal(false)
  // Mirrors the submit guard: with no connected provider, a send points here instead of failing.
  const needsModel = createMemo(() => sync().data.provider_loaded && props.controls.model.selection.list().length === 0)
  const [modelStartNudge, setModelStartNudge] = createSignal(0)

  const { abort, handleSubmit } =
    props.submission ??
    createPromptSubmit({
      prompt,
      info,
      imageAttachments,
      commentCount,
      autoAccept: () => accepting(),
      mode: () => store.mode,
      working,
      editor: () => editorRef,
      queueScroll,
      promptLength,
      addToHistory,
      resetHistoryNavigation: () => {
        resetHistoryNavigation(true)
      },
      setMode: (mode) => setStore("mode", mode),
      setPopover: (popover) => setStore("popover", popover),
      newSessionWorktree: () => props.newSessionWorktree,
      onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
      shouldQueue: props.shouldQueue,
      onQueue: props.onQueue,
      onAbort: props.onAbort,
      onSubmit: props.onSubmit,
      executionMode,
      researchDepth,
      researchScope,
      llmJudge: settings.general.llmJudge,
      judgeScope: settings.general.judgeScope,
      secondOpinion: settings.general.secondOpinion,
      autoModelRouting: settings.general.autoModelRouting,
      connectProvider: () => setModelStartNudge((count) => count + 1),
      localMode: () => localMode.status()?.policy.enabled === true,
      confirmFreeModelTraining: (model) => {
        const client = sdk().client
        return freeModelTrainingGate({
          model,
          consent: () => client.provider.freeModels.consent().then((result) => result.data?.training === true),
          ask: () =>
            new Promise<boolean>((resolve) =>
              dialog.show(
                () => (
                  <DialogFreeModelTraining
                    model={model}
                    onAccept={() => {
                      resolve(true)
                      dialog.close()
                    }}
                    onCancel={() => dialog.close()}
                  />
                ),
                () => resolve(false),
              ),
            ),
          accept: () =>
            acceptFreeModelTraining(client.provider.freeModels, (description) =>
              showToast({ title: "Nothing was sent", description, variant: "error" }),
            ),
        })
      },
    })

  // A prompt another surface handed over to send (Fix this deploy, for example)
  // goes through the same submission as pressing Enter, so it gets the user's
  // model, agent and permissions. Without a model, that submission keeps the
  // prompt in the composer and points the user at connecting one.
  createEffect(() => {
    const text = props.autoSubmit
    if (!text) return
    if (!sync().data.provider_loaded || props.controls.model.loading || props.controls.agents.loading) return
    // Wait for the default model to be chosen, unless there is none to choose.
    const selection = props.controls.model.selection
    if (!selection.current() && selection.list().length > 0) return
    untrack(() => {
      props.onAutoSubmit?.()
      // A composer the user changed since keeps what they wrote, and an empty
      // one is never submitted, since that would stop a running turn.
      if (!holdsHandoff(prompt.current(), text)) return
      void handleSubmit(new Event("submit"))
    })
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal" && !planMode.enabled()) {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
          if (event.key === "ArrowUp" || event.key === "ArrowDown" || ctrlNav) {
            scrollSlashActiveIntoView()
          }
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleSubmit(event)
    }
  }

  const agentsLoading = () => props.controls.agents.loading
  const agentsShouldFadeIn = createMemo<boolean>((prev) => prev ?? agentsLoading())
  const providersLoading = () => props.controls.model.loading
  const providersShouldFadeIn = createMemo<boolean>((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready.promise,
    (p) => p,
  )

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    if (executionMode() === "research") return RESEARCH_PLACEHOLDER
    return "Ask anything, / for commands, @ for context..."
  }

  // The picker's own name for the model, so the copy of a free model on the user's own account keeps its "(free)" here
  // too and never reads as Vector's copy.
  const currentModelName = () => {
    const current = props.controls.model.selection.current()
    return current ? pickerModelName(current) : language.t("dialog.model.select.title")
  }

  // The chip's tooltip repeats the picker's "May train on your prompts" label for the selected model.
  const modelChipTitle = () => {
    const current = props.controls.model.selection.current()
    const training = current ? freeModelTrainingLabel(current) : undefined
    return training ? `${language.t("command.model.choose")} · ${training}` : language.t("command.model.choose")
  }

  // While a free model labelled "May train on your prompts" is selected, that label alone stays under the composer.
  const trainingLabel = createMemo(() => {
    const current = props.controls.model.selection.current()
    return current ? freeModelTrainingLabel(current) : undefined
  })

  const modelControlState = createMemo<ComposerModelControlState>(() => ({
    loading: providersLoading(),
    shouldAnimate: providersShouldFadeIn(),
    paid: props.controls.model.paid,
    title: modelChipTitle(),
    keybind: command.keybindParts("model.choose"),
    model: props.controls.model.selection,
    providerID: props.controls.model.selection.current()?.provider?.id,
    modelName: currentModelName(),
    newLayoutDesigns: props.controls.newLayoutDesigns,
    style: control(),
    onClose: restoreFocus,
    onChooseModel: () => {
      command.trigger("model.choose")
    },
  }))

  const newSession = () => props.variant === "new-session"
  const bindEditorRef = (el: HTMLDivElement) => {
    editorRef = el
    restoreEndOnFocus = true
    props.ref?.(el)
  }
  const showAgentControl = createMemo(() => props.controls.agents.visible && props.controls.agents.options.length > 0)
  const agentControlState = createMemo<ComposerAgentControlState>(() => ({
    title: language.t("command.agent.cycle"),
    keybind: command.keybindParts("agent.cycle"),
    options: props.controls.agents.options,
    current: props.controls.agents.current,
    style: control(),
    onSelect: (value) => {
      props.controls.agents.select(value)
      restoreFocus()
    },
  }))
  return (
    <div class="relative size-full flex flex-col gap-0">
      {(promptReady(), null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        commandKeybindParts={command.keybindParts}
        newLayoutDesigns={props.controls.newLayoutDesigns}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Show when={needsModel()}>
        <FreeModelStart directory={sdk().directory} nudge={modelStartNudge()} />
      </Show>
      <Show when={showDelegationChip()}>
        <div class="mx-1 mb-2 flex items-center gap-2 rounded-full border border-[#9374ec]/30 bg-[#9374ec]/10 px-3 py-1.5 text-[12px] text-[#d8cdfb] animate-in fade-in">
          <span class="shrink-0 text-[#ad95f5]" aria-hidden="true">
            ⑂
          </span>
          <span class="min-w-0 flex-1 truncate">
            Looks like {delegationIntent()?.missions.length} independent tasks — delegate to parallel agents?
          </span>
          <button
            type="button"
            class="shrink-0 rounded-full bg-[#9374ec] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110"
            onClick={delegateToParallel}
          >
            Delegate
          </button>
          <button
            type="button"
            class="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-[#d8cdfb]/60 transition hover:text-[#d8cdfb]"
            onClick={dismissDelegation}
            aria-label="Dismiss delegation suggestion"
          >
            Dismiss
          </button>
        </div>
      </Show>
      <Show when={showRecommendationChip()}>
        <div class="mx-1 mb-2 flex items-center gap-2 rounded-full border border-[#9374ec]/30 bg-[#9374ec]/10 px-3 py-1.5 text-[12px] text-[#d8cdfb] animate-in fade-in">
          <span class="shrink-0 text-[#ad95f5]" aria-hidden="true">
            ✦
          </span>
          <span class="min-w-0 flex-1 truncate">
            Suggested for this {taskCategory()}: {modelRecommendation()?.model} · {modelRecommendation()?.variant}{" "}
            effort — {modelRecommendation()?.evidence[0]} · {modelRecommendation()?.pricedSamples}/
            {modelRecommendation()?.sampleSize} priced
          </span>
          <button
            type="button"
            class="shrink-0 rounded-full bg-[#9374ec] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110"
            onClick={useRecommendedModel}
          >
            Use
          </button>
          <button
            type="button"
            class="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-[#d8cdfb]/60 transition hover:text-[#d8cdfb]"
            onClick={dismissRecommendation}
            aria-label="Dismiss model recommendation"
          >
            Dismiss
          </button>
        </div>
      </Show>
      <Switch>
        <Match when={props.controls.newLayoutDesigns}>
          <div class="flex flex-col gap-3">
            <DockShellForm
              data-component={newSession() ? "session-new-composer" : "session-composer"}
              onSubmit={handleSubmit}
              classList={{
                "group/prompt-input flex min-h-[96px] w-full flex-col rounded-[34px]": true,
                "border-icon-info-active border-dashed": store.draggingType !== null,
                [props.class ?? ""]: !!props.class,
              }}
            >
              <PromptDragOverlay
                type={store.draggingType}
                label={language.t(
                  store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
                )}
              />
              <PromptContextItems
                items={contextItems()}
                active={(item) => {
                  const active = comments.active()
                  return !!item.commentID && item.commentID === active?.id && item.path === active?.file
                }}
                openComment={openComment}
                remove={(item) => {
                  if (item.commentID) comments.remove(item.path, item.commentID)
                  prompt.context.remove(item.key)
                }}
                t={(key) => language.t(key as Parameters<typeof language.t>[0])}
              />
              <PromptImageAttachments
                attachments={imageAttachments()}
                onOpen={(attachment) =>
                  dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
                }
                onRemove={removeAttachment}
                removeLabel={language.t("prompt.attachment.remove")}
              />
              {rememberChips()}
              <div
                class="relative min-h-[52px]"
                onMouseDown={(e) => {
                  const target = e.target
                  if (!(target instanceof HTMLElement)) return
                  if (target.closest('[data-action^="prompt-"]')) return
                  editorRef?.focus()
                }}
              >
                <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
                  <div
                    data-component="prompt-input"
                    ref={bindEditorRef}
                    role="textbox"
                    aria-multiline="true"
                    aria-label={designPlaceholder()}
                    contenteditable="true"
                    autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                    autocorrect={store.mode === "normal" ? "on" : "off"}
                    spellcheck={store.mode === "normal"}
                    inputMode="text"
                    // @ts-expect-error
                    autocomplete="off"
                    onInput={handleInput}
                    onPaste={paste}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    classList={{
                      "select-text": true,
                      "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[15px] font-normal text-v2-text-text-base": true,
                      "[&_[data-type=file]]:text-syntax-property": true,
                      "[&_[data-type=agent]]:text-syntax-type": true,
                      "font-mono!": store.mode === "shell",
                    }}
                  />
                  <div
                    data-component={newSession() ? "session-new-design-text" : "session-composer-text"}
                    class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[15px] font-normal text-v2-text-text-faint"
                    classList={{ "font-mono!": store.mode === "shell", hidden: prompt.dirty() }}
                  >
                    {designPlaceholder()}
                  </div>
                </div>
              </div>
              <Show when={researching()}>
                <ResearchChips
                  depth={researchDepth()}
                  scope={researchScope()}
                  cap={researchCap()}
                  onDepth={setResearchDepth}
                  onScope={setResearchScope}
                />
              </Show>
              {/* pr-2 and pb-2 must match, and the send button is self-end, so its gap to the box's right and bottom edges stays equal even when a neighbour is taller. */}
              <div class="mt-auto flex min-w-0 items-center gap-1 pr-2 pb-2 pl-3">
                <div
                  class="flex min-w-0 items-center gap-1"
                  classList={{
                    "flex-1": !listening() && !transcribing(),
                    "shrink-0": listening() || transcribing(),
                  }}
                >
                  {fileAttachmentInput()}
                  <Show when={showAgentControl()}>
                    <ComposerAgentControl state={agentControlState()} />
                  </Show>
                  {props.toolbar}
                  <ComposerModelControl state={modelControlState()} />
                  <MenuV2
                    open={composerModeMenuOpen()}
                    onOpenChange={setComposerModeMenuOpen}
                    gutter={6}
                    modal={false}
                    placement="top-start"
                  >
                    <MenuV2.Trigger
                      as={ButtonV2}
                      data-action="prompt-mode"
                      variant="ghost-muted"
                      size="normal"
                      class="max-w-[150px] justify-start"
                    >
                      <span class="size-1.5 shrink-0 rounded-full" style={{ background: composerModeMeta().dot }} />
                      <span class="truncate">{composerModeMeta().label}</span>
                      <span class="-ml-0.5 -mr-1 flex shrink-0">
                        <Icon name="chevron-down" size="small" />
                      </span>
                    </MenuV2.Trigger>
                    <MenuV2.Portal>
                      <MenuV2.Content>
                        <div class="w-[266px] p-1" role="group" aria-label="Mode">
                          <div class="px-2 pb-1 pt-1 text-[11px] font-medium text-v2-text-text-faint">Mode</div>
                          {COMPOSER_MODES.map((mode) => (
                            <button
                              type="button"
                              class="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
                              onClick={() => {
                                setComposerMode(mode.id)
                                setComposerModeMenuOpen(false)
                              }}
                            >
                              <span class="mt-1 size-2 shrink-0 rounded-full" style={{ background: mode.dot }} />
                              <span class="min-w-0 flex-1">
                                <span class="block text-[13px] font-medium text-v2-text-text-base">{mode.label}</span>
                                <span class="block text-[11px] leading-4 text-v2-text-text-muted">
                                  {mode.description}
                                </span>
                              </span>
                              <Show when={composerMode() === mode.id}>
                                <Icon name="check" size="small" class="mt-0.5 shrink-0 text-v2-text-text-accent" />
                              </Show>
                            </button>
                          ))}
                        </div>
                      </MenuV2.Content>
                    </MenuV2.Portal>
                  </MenuV2>
                  <Show when={!providersLoading() && store.mode !== "shell" && showVariantControl()}>
                    <div
                      data-component="prompt-variant-control"
                      class="[&_[data-action=prompt-model-variant]]:![font-weight:440]"
                      classList={{
                        "animate-in fade-in": providersShouldFadeIn(),
                      }}
                    >
                      <TooltipV2
                        placement="top"
                        gutter={4}
                        value={
                          <div class="max-w-64">
                            <div class="font-medium">
                              {modelVariantLabel(props.controls.model.selection.variant.current())}
                            </div>
                            <div class="mt-1 text-v2-text-text-muted">
                              {modelVariantDescription(props.controls.model.selection.variant.current())}
                            </div>
                            <div class="mt-2 flex items-center gap-2">
                              <span>{language.t("command.model.variant.cycle")}</span>
                              <KeybindV2 keys={command.keybindParts("model.variant.cycle")} variant="neutral" />
                            </div>
                          </div>
                        }
                      >
                        <MenuV2
                          gutter={6}
                          modal={false}
                          placement="top-start"
                          onOpenChange={(open) => setStore("variantOpen", open)}
                        >
                          <MenuV2.Trigger
                            as={ButtonV2}
                            data-action="prompt-model-variant"
                            variant="ghost-muted"
                            size="normal"
                            class="max-w-[160px] justify-start capitalize"
                            classList={{
                              "!text-[#c9b2ff] [text-shadow:0_0_14px_rgba(155,108,255,0.7)]": isMaxEffort(),
                            }}
                            style={control()}
                          >
                            <span class="truncate">
                              {modelVariantLabel(props.controls.model.selection.variant.current())}
                            </span>
                            <span class="-ml-0.5 -mr-1 flex shrink-0">
                              <Icon name="chevron-down" size="small" />
                            </span>
                          </MenuV2.Trigger>
                          <MenuV2.Portal>
                            <MenuV2.Content>
                              <div class="w-[248px] px-3 py-2.5" role="group" aria-label="Model effort">
                                <div class="flex items-center justify-between pb-2.5">
                                  <span class="text-xs font-medium text-v2-text-text-base">Effort</span>
                                  <span
                                    class="text-xs capitalize text-v2-text-text-muted"
                                    classList={{ "!text-[#c9b2ff]": isMaxEffort() }}
                                  >
                                    {modelVariantLabel(props.controls.model.selection.variant.current())}
                                  </span>
                                </div>
                                <div
                                  class="vector-effort-track"
                                  data-max={effortProgress() >= 100 ? "true" : "false"}
                                  style={`--vector-effort-progress: ${effortProgress()}%; --vector-effort-fill: ${effortFill()}%; --vector-effort-steps: ${Math.max(variants().length, 1)}; --vector-effort-t: ${(effortProgress() / 100).toFixed(3)};`}
                                >
                                  <div class="vector-effort-thumb" aria-hidden="true" />
                                  <input
                                    class="vector-effort-input"
                                    type="range"
                                    min="0"
                                    max={Math.max(variants().length - 1, 0)}
                                    step="1"
                                    value={effortIndex()}
                                    aria-label="Model effort"
                                    aria-valuetext={modelVariantLabel(props.controls.model.selection.variant.current())}
                                    title={`${modelVariantLabel(props.controls.model.selection.variant.current())} — ${modelVariantDescription(props.controls.model.selection.variant.current())}`}
                                    onInput={(event) => selectEffortIndex(Number(event.currentTarget.value))}
                                  />
                                </div>
                                <div class="flex items-center justify-between pt-2 text-[10px] text-v2-text-text-faint">
                                  <span>{modelVariantLabel(variants()[0])}</span>
                                  <span classList={{ "!text-[#c9b2ff]": isMaxEffort() }}>
                                    {modelVariantLabel(variants()[variants().length - 1])}
                                  </span>
                                </div>
                                <div
                                  class="mt-2 rounded-lg border border-[color:var(--vx-line)] bg-black/25 px-2.5 py-2 text-[11px] leading-4 text-v2-text-text-muted"
                                  classList={{ "!border-[#a78bfa]/30 !text-[#d5c8f5]": isMaxEffort() }}
                                >
                                  {modelVariantDescription(props.controls.model.selection.variant.current())}
                                </div>
                              </div>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </TooltipV2>
                    </div>
                  </Show>
                  <Show when={store.mode !== "shell"}>
                    <MenuV2
                      open={executionModeMenuOpen()}
                      onOpenChange={setExecutionModeMenuOpen}
                      gutter={6}
                      modal={false}
                      placement="top-start"
                    >
                      <MenuV2.Trigger
                        as={ButtonV2}
                        data-action="prompt-execution-mode"
                        variant="ghost-muted"
                        size="normal"
                        class="justify-start"
                        classList={{
                          "max-w-[116px]": executionMode() !== "research",
                          "max-w-[148px]": executionMode() === "research",
                          "!text-[#c9b2ff] [text-shadow:0_0_14px_rgba(155,108,255,0.45)]": executionMode() === "fast",
                          "!text-[#9ce0cf]": executionMode() === "quick",
                          "!text-[#a9c8ff]": executionMode() === "research",
                        }}
                      >
                        <span class="size-1.5 shrink-0 rounded-full" style={{ background: executionModeMeta().dot }} />
                        <span class="truncate">{executionModeMeta().label}</span>
                        <span class="-ml-0.5 -mr-1 flex shrink-0">
                          <Icon name="chevron-down" size="small" />
                        </span>
                      </MenuV2.Trigger>
                      <MenuV2.Portal>
                        <MenuV2.Content>
                          <div class="w-[286px] p-1" role="group" aria-label="Mode" data-component="prompt-mode-menu">
                            <div class="px-2 pb-1 pt-1 text-[11px] font-medium text-v2-text-text-faint">Mode</div>
                            {modes().map((mode) => (
                              <button
                                type="button"
                                class="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
                                onClick={() => {
                                  setExecutionMode(mode.id)
                                  setExecutionModeMenuOpen(false)
                                }}
                              >
                                <span class="mt-1 size-2 shrink-0 rounded-full" style={{ background: mode.dot }} />
                                <span class="min-w-0 flex-1">
                                  <span class="flex items-center gap-1.5 text-[13px] font-medium text-v2-text-text-base">
                                    {mode.label}
                                    <Show when={mode.preview}>
                                      <span data-component="research-preview-label">{PREVIEW}</span>
                                    </Show>
                                  </span>
                                  <span class="block text-[11px] leading-4 text-v2-text-text-muted">
                                    {mode.description}
                                  </span>
                                </span>
                                <Show when={executionMode() === mode.id}>
                                  <Icon name="check" size="small" class="mt-0.5 shrink-0 text-v2-text-text-accent" />
                                </Show>
                              </button>
                            ))}
                          </div>
                        </MenuV2.Content>
                      </MenuV2.Portal>
                    </MenuV2>
                  </Show>
                  <Show when={store.mode !== "shell"}>
                    <LocalStatusPill
                      reader={localMode}
                      sessionID={props.controls.session.id}
                      sessionTitle={sessionTitle}
                    />
                  </Show>
                </div>
                <Show when={micAvailable() && !listening() && !transcribing()}>
                  <button
                    data-action="prompt-mic"
                    type="button"
                    class="grid size-9 shrink-0 place-items-center rounded-full text-v2-icon-icon-muted transition hover:bg-white/[0.06] hover:text-v2-text-text-base"
                    title="Dictate prompt"
                    aria-label="Dictate prompt"
                    onClick={() => void startVoiceInput()}
                  >
                    <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                      <path
                        d="M8 9.6a2.1 2.1 0 0 0 2.1-2.1V4.1a2.1 2.1 0 1 0-4.2 0v3.4A2.1 2.1 0 0 0 8 9.6Zm4-2.1a4 4 0 0 1-8 0M8 11.5v2M6 13.5h4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.35"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </Show>
                <Show when={listening() || transcribing()}>
                  <DictationIndicator
                    state={transcribing() ? "transcribing" : "listening"}
                    level={recordingLevel()}
                    onStop={() => dictation?.stop()}
                  />
                </Show>
                <button
                  data-action="prompt-attach"
                  type="button"
                  class="grid size-9 shrink-0 place-items-center rounded-full text-v2-icon-icon-muted transition hover:bg-white/[0.06] hover:text-v2-text-text-base"
                  title={language.t("prompt.action.attachFile")}
                  aria-label={language.t("prompt.action.attachFile")}
                  onClick={() => fileInputRef?.click()}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path
                      d="M12.8 7.2 8.3 11.7a2.6 2.6 0 0 1-3.68-3.68l4.6-4.6a1.75 1.75 0 0 1 2.47 2.47l-4.6 4.6a.9.9 0 0 1-1.27-1.27l4.24-4.25"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <TooltipV2 class="self-end" placement="top" inactive={!working() && blank()} value={tip()}>
                  <IconButton
                    data-action="prompt-submit"
                    type="submit"
                    disabled={!working() && blank()}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                    variant="primary"
                    class="ml-1 size-9 shrink-0 self-end rounded-[8px] p-[8px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
                    style={{
                      "background-image":
                        "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
                    }}
                    aria-label={
                      stopping()
                        ? language.t("prompt.action.stop")
                        : language.t(queueing() ? "prompt.action.queue" : "prompt.action.send")
                    }
                  />
                </TooltipV2>
              </div>
            </DockShellForm>
          </div>
        </Match>
        <Match when>
          <DockShellForm
            onSubmit={handleSubmit}
            classList={{
              "group/prompt-input": true,
              "focus-within:shadow-xs-border": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <PromptDragOverlay
              type={store.draggingType}
              label={language.t(
                store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
              )}
            />
            <PromptContextItems
              items={contextItems()}
              active={(item) => {
                const active = comments.active()
                return !!item.commentID && item.commentID === active?.id && item.path === active?.file
              }}
              openComment={openComment}
              remove={(item) => {
                if (item.commentID) comments.remove(item.path, item.commentID)
                prompt.context.remove(item.key)
              }}
              t={(key) => language.t(key as Parameters<typeof language.t>[0])}
            />
            <PromptImageAttachments
              attachments={imageAttachments()}
              onOpen={(attachment) =>
                dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
              }
              onRemove={removeAttachment}
              removeLabel={language.t("prompt.attachment.remove")}
            />
            {rememberChips()}
            <Show when={researching()}>
              <ResearchChips
                depth={researchDepth()}
                scope={researchScope()}
                cap={researchCap()}
                onDepth={setResearchDepth}
                onScope={setResearchScope}
              />
            </Show>
            <div
              class="relative"
              onMouseDown={(e) => {
                const target = e.target
                if (!(target instanceof HTMLElement)) return
                if (
                  target.closest(
                    '[data-action="prompt-attach"], [data-action="prompt-submit"], [data-action="prompt-mic"]',
                  )
                ) {
                  return
                }
                editorRef?.focus()
              }}
            >
              <div
                class="relative max-h-[240px] overflow-y-auto no-scrollbar"
                ref={(el) => (scrollRef = el)}
                style={{ "scroll-padding-bottom": space }}
              >
                <div
                  data-component="prompt-input"
                  ref={bindEditorRef}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={placeholder()}
                  contenteditable="true"
                  autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                  autocorrect={store.mode === "normal" ? "on" : "off"}
                  spellcheck={store.mode === "normal"}
                  inputMode="text"
                  // @ts-expect-error
                  autocomplete="off"
                  onInput={handleInput}
                  onPaste={paste}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  classList={{
                    "select-text": true,
                    "w-full pl-3 pr-2 pt-2 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
                    "[&_[data-type=file]]:text-syntax-property": true,
                    "[&_[data-type=agent]]:text-syntax-type": true,
                    "font-mono!": store.mode === "shell",
                  }}
                  style={{ "padding-bottom": space }}
                />
                <div
                  class="absolute top-0 inset-x-0 pl-3 pr-2 pt-2 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
                  classList={{ "font-mono!": store.mode === "shell" }}
                  style={{ "padding-bottom": space, display: prompt.dirty() ? "none" : undefined }}
                >
                  {placeholder()}
                </div>
              </div>

              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 bottom-0"
                style={{
                  height: space,
                  background:
                    "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
                }}
              />

              <div class="pointer-events-none absolute bottom-2 left-3 right-4 flex min-w-0 items-center justify-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_FILE_TYPES.join(",")}
                  class="hidden"
                  onChange={(e) => {
                    const list = e.currentTarget.files
                    if (list) void addAttachments(Array.from(list))
                    e.currentTarget.value = ""
                  }}
                />

                <div class="pointer-events-auto flex min-w-0 flex-1 items-center justify-end gap-1">
                  <Show when={micAvailable() && !listening() && !transcribing()}>
                    <button
                      data-action="prompt-mic"
                      type="button"
                      class="grid size-9 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-white/[0.06] hover:text-text-strong"
                      title="Dictate prompt"
                      aria-label="Dictate prompt"
                      onClick={() => void startVoiceInput()}
                    >
                      <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                        <path
                          d="M8 9.6a2.1 2.1 0 0 0 2.1-2.1V4.1a2.1 2.1 0 1 0-4.2 0v3.4A2.1 2.1 0 0 0 8 9.6Zm4-2.1a4 4 0 0 1-8 0M8 11.5v2M6 13.5h4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.35"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </Show>
                  <Show when={listening() || transcribing()}>
                    <DictationIndicator
                      state={transcribing() ? "transcribing" : "listening"}
                      level={recordingLevel()}
                      onStop={() => dictation?.stop()}
                    />
                  </Show>
                  <button
                    data-action="prompt-attach"
                    type="button"
                    class="grid size-9 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-white/[0.06] hover:text-text-strong"
                    title={language.t("prompt.action.attachFile")}
                    aria-label={language.t("prompt.action.attachFile")}
                    onClick={() => fileInputRef?.click()}
                  >
                    <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                      <path
                        d="M12.8 7.2 8.3 11.7a2.6 2.6 0 0 1-3.68-3.68l4.6-4.6a1.75 1.75 0 0 1 2.47 2.47l-4.6 4.6a.9.9 0 0 1-1.27-1.27l4.24-4.25"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                  <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!working() && blank()}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                      variant="primary"
                      class="ml-1 mr-1 size-9 shrink-0 rounded-[8px]"
                      aria-label={
                        stopping()
                          ? language.t("prompt.action.stop")
                          : language.t(queueing() ? "prompt.action.queue" : "prompt.action.send")
                      }
                    />
                  </Tooltip>
                </div>
              </div>
            </div>
          </DockShellForm>
          <Show when={store.mode === "normal" || store.mode === "shell"}>
            <DockTray attach="top">
              <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
                  <div
                    class="h-7 flex items-center gap-1.5 min-w-0 absolute inset-0"
                    style={{
                      padding: "0 0px 0 8px",
                      ...shell(),
                    }}
                  >
                    <Icon name="console" />
                    <span class="truncate text-13-medium text-text-base">{language.t("prompt.mode.shell")}</span>
                    <div class="flex-1" />
                    <Button
                      variant="ghost"
                      class="text-text-base"
                      onClick={() => {
                        setStore("mode", "normal")
                      }}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                  <div class="flex items-center gap-1.5 min-w-0 flex-1 h-7">
                    <Show when={!agentsLoading()}>
                      <div
                        data-component="prompt-agent-control"
                        classList={{ "animate-in fade-in duration-300": agentsShouldFadeIn() }}
                      >
                        <TooltipKeybind
                          placement="top"
                          gutter={4}
                          title={language.t("command.agent.cycle")}
                          keybind={command.keybind("agent.cycle")}
                        >
                          <Select
                            size="normal"
                            options={props.controls.agents.options}
                            current={props.controls.agents.current}
                            onSelect={(value) => {
                              props.controls.agents.select(value)
                              restoreFocus()
                            }}
                            class="capitalize max-w-[160px] text-text-base"
                            valueClass="truncate text-13-regular text-text-base"
                            triggerStyle={control()}
                            triggerProps={{ "data-action": "prompt-agent" }}
                            variant="ghost"
                          />
                        </TooltipKeybind>
                      </div>
                    </Show>
                    <Show when={!providersLoading()}>
                      <Show when={store.mode !== "shell"}>
                        <div
                          data-component="prompt-model-control"
                          classList={{ "animate-in fade-in duration-300": providersShouldFadeIn() }}
                        >
                          <TooltipKeybind
                            placement="top"
                            gutter={4}
                            title={modelChipTitle()}
                            keybind={command.keybind("model.choose")}
                          >
                            <Button
                              type="button"
                              data-action="prompt-model"
                              variant="ghost"
                              size="normal"
                              class="min-w-0 max-w-[320px] text-13-regular text-text-base group"
                              style={control()}
                              onClick={() => {
                                modelControlState().onChooseModel()
                                restoreFocus()
                              }}
                            >
                              <Show when={props.controls.model.selection.current()?.provider?.id}>
                                <ProviderIcon
                                  id={props.controls.model.selection.current()?.provider?.id ?? ""}
                                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                />
                              </Show>
                              <span class="truncate">{currentModelName()}</span>
                              <Icon name="chevron-down" size="small" class="shrink-0" />
                            </Button>
                          </TooltipKeybind>
                        </div>
                        <Show when={showVariantControl()}>
                          <div
                            data-component="prompt-variant-control"
                            classList={{ "animate-in fade-in duration-300": providersShouldFadeIn() }}
                          >
                            <TooltipKeybind
                              placement="top"
                              gutter={4}
                              title={`${modelVariantLabel(props.controls.model.selection.variant.current())}: ${modelVariantDescription(props.controls.model.selection.variant.current())}`}
                              keybind={command.keybind("model.variant.cycle")}
                            >
                              <Select
                                size="normal"
                                options={variants()}
                                current={props.controls.model.selection.variant.current() ?? "default"}
                                label={modelVariantLabel}
                                onSelect={(value) => {
                                  props.controls.model.selection.variant.set(value === "default" ? undefined : value)
                                  restoreFocus()
                                }}
                                class="capitalize max-w-[160px] text-text-base"
                                valueClass="truncate text-13-regular text-text-base"
                                triggerStyle={control()}
                                triggerProps={{ "data-action": "prompt-model-variant" }}
                                variant="ghost"
                              />
                            </TooltipKeybind>
                          </div>
                        </Show>
                        <TooltipV2 placement="top" gutter={4} value={executionModeMeta().description}>
                          <Select
                            size="normal"
                            options={modes().map((mode) => mode.id)}
                            current={executionMode()}
                            label={(value) => MODES.find((mode) => mode.id === value)?.label ?? "Normal"}
                            onSelect={(value) => {
                              setExecutionMode(value as Mode)
                              restoreFocus()
                            }}
                            class="max-w-[140px] text-text-base"
                            valueClass="truncate text-13-regular text-text-base"
                            triggerStyle={control()}
                            triggerProps={{ "data-action": "prompt-execution-mode" }}
                            variant="ghost"
                          />
                        </TooltipV2>
                        <LocalStatusPill
                          reader={localMode}
                          sessionID={props.controls.session.id}
                          sessionTitle={sessionTitle}
                        />
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            </DockTray>
          </Show>
        </Match>
      </Switch>
      <Show when={store.mode !== "shell" && trainingLabel()}>
        {(label) => (
          <div data-component="free-model-training-notice" class="px-3 pt-2 text-12-regular" role="note">
            {label()}
          </div>
        )}
      </Show>
    </div>
  )
}

// Deep research's chip row: Depth (Auto, Focused, Deep) and Sources pick what the message asks for, and Cap says what
// stops the run.
function ResearchChips(props: {
  depth: Depth
  scope: Research.Scope
  cap: string
  onDepth: (depth: Depth) => void
  onScope: (scope: Research.Scope) => void
}) {
  return (
    <div data-component="research-chips" role="group" aria-label="Deep research options">
      <ResearchChip
        name="Depth"
        value={props.depth}
        options={DEPTHS}
        current={DEPTHS.find((item) => item.value === props.depth)?.label ?? "Auto"}
        onSelect={props.onDepth}
      />
      <ResearchChip
        name="Sources"
        value={props.scope}
        options={SCOPES.map((item) => ({ ...item, description: undefined }))}
        current={scopeLabel(props.scope)}
        onSelect={props.onScope}
      />
      <TooltipV2
        placement="top"
        gutter={4}
        value="What stops this research: your own run cap when you set one, otherwise Deep research's default for the depth."
      >
        <span data-slot="research-chip" data-static="true">
          {props.cap}
        </span>
      </TooltipV2>
    </div>
  )
}

function ResearchChip<T extends string>(props: {
  name: string
  value: T
  options: readonly { value: T; label: string; description?: string }[]
  current: string
  onSelect: (value: T) => void
}) {
  const [open, setOpen] = createSignal(false)
  return (
    <MenuV2 open={open()} onOpenChange={setOpen} gutter={6} modal={false} placement="top-start">
      <MenuV2.Trigger
        as="button"
        type="button"
        data-slot="research-chip"
        aria-label={`${props.name}: ${props.current}`}
      >
        <span data-slot="research-chip-name">{props.name}</span>
        <span>{props.current}</span>
        <Icon name="chevron-down" size="small" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <div class="w-[286px] p-1" role="group" aria-label={props.name}>
            <div class="px-2 pb-1 pt-1 text-[11px] font-medium text-v2-text-text-faint">{props.name}</div>
            {props.options.map((option) => (
              <button
                type="button"
                class="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
                onClick={() => {
                  props.onSelect(option.value)
                  setOpen(false)
                }}
              >
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] font-medium text-v2-text-text-base">{option.label}</span>
                  <Show when={option.description}>
                    <span class="block text-[11px] leading-4 text-v2-text-text-muted">{option.description}</span>
                  </Show>
                </span>
                <Show when={props.value === option.value}>
                  <Icon name="check" size="small" class="mt-0.5 shrink-0 text-v2-text-text-accent" />
                </Show>
              </button>
            ))}
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

type ComposerAgentControlState = {
  title: string
  keybind: string[]
  options: string[]
  current: string
  style: JSX.CSSProperties | undefined
  onSelect: (value: string | undefined) => void
}

type ComposerModelControlState = {
  loading: boolean
  shouldAnimate: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ReturnType<typeof useLocal>["model"]
  providerID?: string
  modelName: string
  newLayoutDesigns: boolean
  style: JSX.CSSProperties | undefined
  onClose: () => void
  onChooseModel: () => void
}

function ComposerAgentControl(props: { state: ComposerAgentControlState }) {
  return (
    <div class="relative">
      <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-v2-icon-icon-muted">
        <Icon name="sliders" size="small" />
      </div>
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {props.state.title}
            <KeybindV2 keys={props.state.keybind} variant="neutral" />
          </>
        }
      >
        <Select
          size="normal"
          options={props.state.options}
          current={props.state.current}
          onSelect={props.state.onSelect}
          class="max-w-[175px] justify-start text-v2-text-text-faint [&_[data-component=icon]]:text-v2-icon-icon-muted"
          valueClass="truncate pl-5 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
          triggerStyle={props.state.style}
          triggerProps={{ "data-action": "prompt-agent" }}
          variant="ghost"
        />
      </TooltipV2>
    </div>
  )
}

function ComposerModelControl(props: { state: ComposerModelControlState }) {
  return (
    <Show when={!props.state.loading}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {props.state.title}
            <KeybindV2 keys={props.state.keybind} variant="neutral" />
          </>
        }
      >
        <Show
          when={props.state.newLayoutDesigns}
          fallback={
            <Button
              type="button"
              data-action="prompt-model"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group"
              classList={{ "animate-in fade-in": props.state.shouldAnimate }}
              style={props.state.style}
              onClick={() => {
                props.state.onChooseModel()
                props.state.onClose()
              }}
            >
              <ModelControlContent state={props.state} />
            </Button>
          }
        >
          <ButtonV2
            type="button"
            data-action="prompt-model"
            variant="ghost-muted"
            size="normal"
            class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
            classList={{ "animate-in fade-in": props.state.shouldAnimate }}
            style={props.state.style}
            onClick={() => {
              props.state.onChooseModel()
              props.state.onClose()
            }}
          >
            <ModelControlContent state={props.state} v2 />
          </ButtonV2>
        </Show>
      </TooltipV2>
    </Show>
  )
}

function ModelControlContent(props: { state: ComposerModelControlState; v2?: boolean }) {
  return (
    <>
      <Show when={props.state.providerID}>
        {(providerID) => (
          <ProviderIcon
            id={providerID()}
            class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            style={{ "will-change": "opacity", transform: "translateZ(0)" }}
          />
        )}
      </Show>
      <span class="truncate">{props.state.modelName}</span>
      <span class={props.v2 ? "-ml-0.5 -mr-1 flex shrink-0" : "-ml-1 shrink-0 flex size-fit"}>
        <Icon name="chevron-down" size="small" class="text-v2-icon-icon-muted" />
      </span>
    </>
  )
}
import { Billing } from "@vectordevai/schema/billing"
