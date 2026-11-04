import { completionPolicy } from "@/features/judge/verified-completion"
import type { Message, Session } from "@vectordevai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@vectordevai/core/util/encode"
import { Binary } from "@vectordevai/core/util/binary"
import { getFilename } from "@vectordevai/core/util/path"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePlanMode } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts, withSyntheticText } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { initialSessionTitle } from "./session-title"
import {
  classifyTaskDifficulty,
  isFreeModelSelection,
  planPending,
  supportsImageInput,
  routeModelForImages,
  routeModelForTask,
  routeVariantForTask,
  type TaskDifficulty,
  workOpen,
} from "@/utils/task-intelligence"
import { modelDisplayName } from "@/utils/provider-brand"
import { freeModelMayTrain, type FreeModelChoice } from "@vectordevai/core/free-model-choice"
import { NO_VISION } from "@/features/local/local-model"
import { cachedSpendPolicy, promptRunBudget } from "@/features/economics/spend-limits-api"
import { AGENT as RESEARCH, requireResearch, sizeOf, type Depth } from "@/features/research/research-model"
import type { Research } from "@vectordevai/schema/research"
import { requireLocalEngine } from "@/features/local/engine-compatibility"
import { BrainSchema } from "@vectordevai/core/brain/schema"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export function resolveSubmissionAgent(input: {
  planMode: boolean
  current: string
  available: Array<{ name: string; mode: string; hidden?: boolean }>
}) {
  if (input.planMode) return "plan"
  if (input.current !== "plan") return input.current

  return (
    input.available.find((item) => item.name !== "plan" && item.mode !== "subagent" && !item.hidden)?.name ?? "build"
  )
}

export function resolveExecutionAgent(input: {
  planMode: boolean
  quickRequested: boolean
  /** The composer's Deep research mode: every message goes to the research agent, a greeting aside. */
  researchRequested?: boolean
  difficulty: TaskDifficulty
  current: string
}) {
  // A greeting in Deep research still takes the quick lane, so "hi" plans no research and recalls nothing.
  if (input.researchRequested) return input.difficulty === "trivial" ? "quick" : RESEARCH
  if (input.planMode) return input.current
  if (input.quickRequested) return "quick"
  // A greeting, thanks or a farewell takes the quick lane from here on every agent, with or without the judge, so an
  // engine that does not size requests itself (an older Vector, a remote server) also answers it with one small
  // request. A current engine sizes it as a build request and offers escalate there, so a message misread as social
  // still goes on as Work. "yes" or "continue", a bare "ok" after a plan from Plan mode, and anything sent while work
  // waits on the user, are not trivial: they continue the work before them, which the engine sizes.
  if (input.difficulty === "trivial") return "quick"
  // A session can remember the quick lane or the research agent from its last message; outside their modes neither
  // takes ordinary work.
  return input.current === "quick" || input.current === RESEARCH ? "build" : input.current
}

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  difficulty?: TaskDifficulty
  executionMode?: "normal" | "fast"
  // When LLM-as-a-judge is on: which runs Vector judges. A draft queued before this field existed carries llmJudge.
  judge?: "thorough" | "changes"
  llmJudge?: boolean
  // The composer's Quick mode: the person picked the quick lane, so the engine answers there and never escalates it.
  // In Deep research the Depth chip sets it: Focused is Work and Deep is Thorough.
  size?: "chat" | "standard" | "thorough"
  // Deep research's Sources chip: where the run may look, which the plan the model proposes keeps.
  research?: { scope?: Research.Scope }
  // Where the prompt's text holds what the user pasted, as `[start, end]` offsets, so Vector never learns from it.
  pasted?: [number, number][]
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

// What a message carries besides its text, as the engine counts it when it sizes the message: a greeting with a
// screenshot, a file or a named subagent is never a bare reply.
const attachments = (prompt: Prompt, context: readonly unknown[]) => {
  const images = draftImages(prompt).filter((part) => part.mime.startsWith("image/")).length
  return {
    images,
    files: prompt.filter((part) => part.type === "file" || part.type === "image").length - images + context.length,
    agents: prompt.flatMap((part) => (part.type === "agent" ? [part.name] : [])),
  }
}

// Task preparation and the judge policy for older engines can each add one hidden instruction after the typed text.
const SYNTHETIC_SLOTS = 2

export async function sendFollowupDraft(input: FollowupSendInput) {
  requireResearch(input.draft.agent === RESEARCH, input.sync.data.agent)
  await requireLocalEngine(input.client)
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const messages = input.sync.data.message?.[input.draft.sessionID] ?? []
  const difficulty =
    input.draft.difficulty ??
    classifyTaskDifficulty(text, {
      open: workOpen(messages, (id) => input.sync.data.part?.[id]),
      plan: planPending(messages),
      ...attachments(input.draft.prompt, input.draft.context),
    })
  const agent = resolveExecutionAgent({
    planMode: input.draft.agent === "plan",
    quickRequested: input.draft.agent === "quick",
    researchRequested: input.draft.agent === RESEARCH,
    difficulty,
    current: input.draft.agent,
  })
  // A current engine decides whether a run is judged, from the request's size and this setting.
  const judge = input.draft.judge ?? (input.draft.llmJudge ? ("thorough" as const) : undefined)
  // An engine from before Vector ran the judge itself ignores that setting and runs the judge only when its model is
  // told to, so a build prompt still carries the policy. A current engine reads the setting, drops the policy before
  // the model sees it, and judges only large tasks.
  const legacyJudge = judge !== undefined && agent === "build"
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    // A queued draft may wait while the engine or its policy changes. Recheck at dispatch, before any model call.
    requireResearch(input.draft.agent === RESEARCH, input.sync.data.agent)
    await requireLocalEngine(input.client)
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      // A command starts a run like a chat message does, so it gets the same per-run cap.
      const budget = promptRunBudget({
        configured: input.sync.data.config.budget?.run,
        policy: await cachedSpendPolicy(),
      })
      const args = tail.join(" ")
      const pasted = within(input.draft.pasted ?? [], text.length - args.length, args.length)
      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: args,
        ...(pasted.length ? { pasted } : {}),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        executionMode: input.draft.executionMode,
        ...(budget ? { budget } : {}),
        ...(judge ? { judge } : {}),
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const baseParts = withPasted(
    withResearchOptions(
      buildRequestParts({
        prompt: input.draft.prompt,
        context: input.draft.context,
        images,
        text,
        sessionID: input.draft.sessionID,
        messageID,
        sessionDirectory: input.draft.sessionDirectory,
        syntheticSlots: SYNTHETIC_SLOTS,
      }),
      agent === RESEARCH ? input.draft.research : undefined,
    ),
    input.draft.pasted,
  )

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: { ...input.draft.model, variant: input.draft.variant },
    executionMode: input.draft.executionMode,
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: baseParts.optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    // The file map is a starting point for a session's real work. On a later message it would stay in the history and
    // be sent again on every request, while the agent already knows the code it has read; a greeting needs none.
    const history = input.sync.data.message?.[input.draft.sessionID] ?? []
    const replied = history.some((message) => message.role === "assistant")
    // Deep research reads the repository through its own tools when its scope takes the brain and files.
    const preparation =
      difficulty === "trivial" || replied || agent === RESEARCH
        ? undefined
        : await globalThis.window?.api?.prepareAgentTask?.(input.draft.sessionDirectory, text).catch(() => undefined)
    const syntheticText = [
      ...(preparation?.instruction ? [preparation.instruction] : []),
      ...(legacyJudge ? [completionPolicy(history, (id) => input.sync.data.part?.[id])] : []),
    ]
    const budget = promptRunBudget({
      configured: input.sync.data.config.budget?.run,
      policy: await cachedSpendPolicy(),
    })
    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent,
      model: input.draft.model,
      messageID,
      // The echo above is already on screen under these part ids. The instructions take the ids
      // held for them, so the parts the engine stores confirm the echo instead of sitting beside it.
      parts: withSyntheticText(baseParts, syntheticText),
      variant: input.draft.variant,
      executionMode: input.draft.executionMode,
      ...(budget ? { budget } : {}),
      ...(judge ? { judge } : {}),
      ...(input.draft.size && sized(agent, input.draft.size) ? { size: input.draft.size } : {}),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

// The size a draft carries goes with the lane it was picked for: Chat with Quick, Work or Thorough with Deep research.
function sized(agent: string, size: NonNullable<FollowupDraft["size"]>) {
  if (agent === "quick") return size === "chat"
  return agent === RESEARCH && size !== "chat"
}

/**
 * The typed text carries Deep research's Sources chip as `vector.research`, where research_plan reads the scope the
 * user chose (the CLI's --scope goes the same way). The echo carries it too, so the two stay the same part.
 */
function withResearchOptions(built: ReturnType<typeof buildRequestParts>, research: FollowupDraft["research"]) {
  if (!research?.scope) return built
  const metadata = { [RESEARCH_OPTIONS]: { scope: research.scope } }
  const [typed, ...rest] = built.requestParts
  const [echo, ...echoed] = built.optimisticParts
  if (typed?.type !== "text" || echo?.type !== "text") return built
  return {
    ...built,
    requestParts: [{ ...typed, metadata: { ...typed.metadata, ...metadata } }, ...rest],
    optimisticParts: [{ ...echo, metadata: { ...echo.metadata, ...metadata } }, ...echoed],
  }
}

/** Where the engine reads `vector run --research`'s choices and the composer's (engine `ResearchRun.OPTIONS`). */
const RESEARCH_OPTIONS = "vector.research"

/**
 * The typed text carries the spans the user pasted into it as `vector.pasted` (BrainSchema.PASTED), which the engine
 * leaves out of what Vector learns about the user: an email, a log or someone else's message vouches for nothing. The
 * composer puts pastes inline, so they stay in the one text part the message shows and restores, and its mentions keep
 * their offsets. The echo carries them too, so the two stay the same part.
 */
function withPasted(built: ReturnType<typeof buildRequestParts>, pasted: FollowupDraft["pasted"]) {
  if (!pasted?.length) return built
  const metadata = { [BrainSchema.PASTED]: pasted }
  const [typed, ...rest] = built.requestParts
  const [echo, ...echoed] = built.optimisticParts
  if (typed?.type !== "text" || echo?.type !== "text") return built
  return {
    ...built,
    requestParts: [{ ...typed, metadata: { ...typed.metadata, ...metadata } }, ...rest],
    optimisticParts: [{ ...echo, metadata: { ...echo.metadata, ...metadata } }, ...echoed],
  }
}

// The spans of a text that fall in its last `length` characters, from `start`, made relative to them: a slash
// command's arguments.
function within(spans: readonly [number, number][], start: number, length: number) {
  return spans.flatMap(([from, to]): [number, number][] => {
    const begin = Math.max(from, start) - start
    const end = Math.min(to, start + length) - start
    return begin < end ? [[begin, end]] : []
  })
}

// What the user pasted into each draft (the composer's prompt state it went into), newest last, to find in the message
// it goes out with. Kept in memory only, and each draft's own, so a paste never marks a message it did not go into.
const drafts = new WeakMap<object, readonly string[]>()
// What was pasted into the messages this window sent, by their text, so the same message brought back into a composer
// (after a failed send, from history, by Undo or by a fork) marks it again.
const sent = new Map<string, readonly string[]>()
const SENT = 64
const PASTES = 64
const PASTE_CHARS = 4_000_000

/** Notes text the user pasted into a draft, so the message that carries it marks it as pasted. */
export function rememberPaste(draft: object, text: string) {
  const clean = cleanPaste(text)
  if (!clean) return
  drafts.set(draft, newest([...(drafts.get(draft) ?? []), clean]))
}

/**
 * The draft holds a whole message again: what was pasted into it, by this window's record of what it sent or by the
 * session's own copy of the message (`marked`), is marked again when it is sent.
 */
export function restorePastes(draft: object, text: string, marked: readonly string[] = []) {
  const found = [...(sent.get(text) ?? []), ...marked].map(cleanPaste).filter(Boolean)
  if (found.length === 0) return
  const known = drafts.get(draft) ?? []
  drafts.set(draft, newest([...known, ...found.filter((item) => !known.includes(item))]))
}

/** What a sent text part says the user pasted into it (BrainSchema.PASTED), as text. */
export function pastedIn(part: { text: string; metadata?: Record<string, unknown> }) {
  const spans = part.metadata?.[BrainSchema.PASTED]
  if (!Array.isArray(spans)) return []
  return spans.flatMap((span: unknown) =>
    Array.isArray(span) &&
    Number.isInteger(span[0]) &&
    Number.isInteger(span[1]) &&
    span[0] >= 0 &&
    span[0] < span[1] &&
    span[1] <= part.text.length
      ? [part.text.slice(span[0], span[1])]
      : [],
  )
}

/**
 * Where the draft's text holds what the user pasted into it. The draft's pastes go with the message: the next message
 * starts with none, and this one, brought back whole, marks them again (`restorePastes`).
 */
export function takePastes(draft: object, text: string) {
  const spans = pastedSpans(text, drafts.get(draft) ?? [])
  drafts.delete(draft)
  if (spans.length === 0) return spans
  sent.delete(text)
  sent.set(
    text,
    spans.map(([start, end]) => text.slice(start, end)),
  )
  fit(sent)
  return spans
}

// The newest pastes that fit what one draft keeps.
function newest(list: readonly string[]) {
  return list.filter(
    (_, index) =>
      list.length - index <= PASTES && list.slice(index).reduce((sum, item) => sum + item.length, 0) <= PASTE_CHARS,
  )
}

// Forgets the oldest sends until what is left fits.
function fit(record: Map<string, readonly string[]>) {
  const size = [...record.keys()].reduce((sum, text) => sum + text.length, 0)
  if (record.size <= SENT && size <= PASTE_CHARS) return
  record.delete(record.keys().next().value!)
  fit(record)
}

function cleanPaste(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u200B/g, "")
    .replaceAll("\u00a0", " ")
    .trim()
}

/**
 * Where a message's text holds what the user pasted, as sorted `[start, end]` spans. A paste is found where it stands
 * as words of its own, never inside a word, whole or, once edited, line by line. Where it cannot be placed (the text
 * holds it more often than it was pasted), or where a pasted line was changed in place and a run of three of its words
 * is left among the typed ones, the whole text is marked: it then vouches for none of its words. Text pasted and
 * deleted again marks nothing.
 */
export function pastedSpans(text: string, pasted: readonly string[]): [number, number][] {
  const plain = text.replaceAll("\u00a0", " ")
  const taken: [number, number][] = []
  // The places `needle` stands as words of its own, outside those taken: taken when there are no more of them than the
  // times it was pasted, and otherwise none of them can be told from the user's own words.
  const place = (needle: string, count: number) => {
    const free = occurrences(plain, needle)
      .map((at): [number, number] => [at, at + needle.length])
      .filter(([start, end]) => bounded(plain, start, end) && !taken.some(([from, to]) => start < to && end > from))
    if (free.length > count) return "unclear"
    taken.push(...free)
    return free.length > 0 ? "found" : "none"
  }
  // Longest first, so a short paste never takes the place of a long one that holds it.
  const missing = tally(pasted.map(cleanPaste).filter(Boolean))
    .toSorted((a, b) => b[0].length - a[0].length)
    .flatMap(([paste, count]) => {
      const whole = place(paste, count)
      if (whole === "unclear") return [WHOLE]
      if (whole === "found") return []
      const lines = paste
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      // A long log changed somewhere is still that log: found by one of its first long lines, it marks the whole text.
      if (lines.length > MANY_LINES)
        return lines
          .filter((line) => line.length >= 20)
          .slice(0, 50)
          .some((line) => plain.includes(line))
          ? [WHOLE]
          : []
      const placed = tally(lines).map(([line, times]) => ({ line, found: place(line, times * count) }))
      if (placed.some((item) => item.found === "unclear")) return [WHOLE]
      return placed.flatMap((item) => (item.found === "none" ? [item.line] : []))
    })
  if (missing.includes(WHOLE)) return text.length ? [[0, text.length]] : []
  // What is left between the pastes found, each stretch on its own, so no run of words spans a paste.
  const left = gaps(plain, merge(taken)).map((gap) => ` ${words(gap).join(" ")} `)
  const edited = missing.some((line) => {
    const run = words(line)
    return run
      .slice(0, Math.max(0, run.length - 2))
      .some((_, at) => left.some((gap) => gap.includes(` ${run.slice(at, at + 3).join(" ")} `)))
  })
  if (edited) return [[0, text.length]]
  return merge(taken)
}

const MANY_LINES = 400
const WHOLE = "\u0000whole"
const WORD = /[\p{L}\p{N}_]/u

// Where `needle` starts in `text`, without overlaps.
function occurrences(text: string, needle: string) {
  return text
    .split(needle)
    .slice(0, -1)
    .reduce<number[]>((found, piece) => {
      found.push((found.length ? found.at(-1)! + needle.length : 0) + piece.length)
      return found
    }, [])
}

// Whether `[start, end]` neither starts nor ends inside a word: "test" pasted is not the start of "tests".
function bounded(text: string, start: number, end: number) {
  const inside = (at: number) => WORD.test(text[at - 1] ?? "") && WORD.test(text[at] ?? "")
  return !inside(start) && !inside(end)
}

// Each distinct item with the times it appears.
function tally(items: readonly string[]) {
  return [...items.reduce((count, item) => count.set(item, (count.get(item) ?? 0) + 1), new Map<string, number>())]
}

function words(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

// The text outside sorted spans that do not overlap.
function gaps(text: string, spans: readonly [number, number][]) {
  const ends = [0, ...spans.flatMap(([start, end]) => [start, end]), text.length]
  return ends.flatMap((at, index) => (index % 2 === 0 ? [text.slice(at, ends[index + 1])] : []))
}

function merge(spans: readonly [number, number][]) {
  return spans
    .toSorted((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((out, span) => {
      const last = out.at(-1)
      if (last && span[0] <= last[1]) return [...out.slice(0, -1), [last[0], Math.max(last[1], span[1])]]
      return [...out, [span[0], span[1]]]
    }, [])
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => boolean | void
  onAbort?: () => void
  onSubmit?: () => void
  executionMode?: Accessor<"normal" | "quick" | "fast" | "research">
  /** Deep research's Depth and Sources chips. */
  researchDepth?: Accessor<Depth>
  researchScope?: Accessor<Research.Scope>
  llmJudge?: Accessor<boolean>
  judgeScope?: Accessor<"thorough" | "changes">
  autoModelRouting?: Accessor<boolean>
  connectProvider?: () => void
  /** Asks once before the first prompt to a free model whose provider may train on prompts; false keeps it unsent. */
  confirmFreeModelTraining?: (model: FreeModelChoice) => Promise<boolean>
  /** Vector Local is on: the models offered are only those on the servers the user listed. */
  localMode?: Accessor<boolean>
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const planMode = usePlanMode()
  const platform = usePlatform()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const workspaceAvailable = async () => {
    if (!params.id) return true
    return sdk()
      .client.file.list({ path: "." })
      .then(() => true)
      .catch((err) => {
        showToast({
          title: "Repository folder unavailable",
          description: formatServerError(err, language.t, "Reopen the repository from its existing folder."),
          variant: "error",
          duration: 10_000,
        })
        return false
      })
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .client.session.abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const isPlanMode = planMode.enabled()
    const mode = isPlanMode ? "normal" : input.mode()
    const requestedExecutionMode = input.executionMode?.() ?? "normal"
    const executionMode = requestedExecutionMode === "fast" ? "fast" : "normal"

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const destination = sdk()
    try {
      requireResearch(mode !== "shell" && requestedExecutionMode === "research", sync().data.agent)
      await requireLocalEngine(destination.client)
    } catch (error) {
      showToast({ title: "This engine cannot run this request", description: errorMessage(error) })
      return
    }
    if (sdk().client !== destination.client) return

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const selectedVariant = local.model.variant.current()
    // With no connected provider the model picker is empty, so asking the user
    // to choose a model is a dead end. Send them to the connect flow instead and
    // leave the prompt in the editor so they can send it once a model exists.
    // The list is also empty while the provider catalog is still loading or after
    // it failed to load, so only take this branch once it has loaded successfully.
    if (!currentModel && sync().data.provider_loaded && local.model.list().length === 0) {
      showToast({
        title: language.t("prompt.toast.providerRequired.title"),
        // Only the desktop app can sign in to Vector from here; elsewhere the engine signs in with `vector login`.
        description: language.t(
          platform.vectorAccount
            ? "prompt.toast.providerRequired.description"
            : "prompt.toast.providerRequired.descriptionEngine",
        ),
      })
      input.connectProvider?.()
      return
    }
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    // A social message takes the quick lane only when no work waits on the user; then it answers that work. A bare "ok"
    // after a plan from Plan mode carries the plan out.
    const messages = params.id ? (sync().data.message?.[params.id] ?? []) : []
    const difficulty =
      mode === "normal" && !text.trim().startsWith("/")
        ? classifyTaskDifficulty(text, {
            open: workOpen(messages, (id) => sync().data.part?.[id]),
            plan: planPending(messages),
            ...attachments([...currentPrompt.filter((part) => part.type !== "image"), ...images], context),
          })
        : ("standard" as const)
    // Hiding a model in Settings is how the first-run tour tells people to
    // control what Vector uses, so routing must not reach past that filter and
    // pick something they deliberately turned off.
    const allModels = typeof local.model.list === "function" ? local.model.list() : [currentModel]
    const availableModels = allModels.filter(
      (item) =>
        item.id === currentModel.id ||
        typeof local.model.visible !== "function" ||
        local.model.visible({ providerID: item.provider.id, modelID: item.id }),
    )
    // Automatic routing upgrades the model for work it judges complex, which
    // spends the user's own key at up to an order of magnitude more per token.
    // Opt-in only. A free selection remains within guarded free models, and
    // unsupported images require the user to explicitly choose another model.
    const taskRoute = input.autoModelRouting?.()
      ? routeModelForTask({ difficulty, current: currentModel, available: availableModels })
      : { model: currentModel, routed: false }
    const hasImageInput = images.some((attachment) => attachment.mime.startsWith("image/"))
    const imageRoute = hasImageInput
      ? routeModelForImages({ current: taskRoute.model, available: availableModels })
      : undefined
    if (hasImageInput && !imageRoute?.model) {
      // With Vector Local on, the models listed are only those on the user's servers; images can go nowhere else.
      if (input.localMode?.()) {
        showToast({ ...NO_VISION, variant: "error", duration: 10_000 })
        return
      }
      showToast({
        title: "Connect an image-capable model",
        description: isFreeModelSelection(currentModel)
          ? "Free models currently accept text only. Remove the image to continue with your free model."
          : availableModels.some((item) => item.provider.id === ModelPlanStatus.PROVIDER_ID && supportsImageInput(item))
            ? "This model accepts text only, and Vector never switches to Vector Codium on its own. Choose a model with image input, then send again."
            : "The connected models only accept text. Choose or connect a model with image input, then send again.",
        variant: "error",
        duration: 10_000,
      })
      return
    }
    const routed = {
      model: imageRoute?.model ?? taskRoute.model,
      task: taskRoute.routed,
      image: imageRoute?.routed ?? false,
    }
    const variant = input.autoModelRouting?.()
      ? routeVariantForTask({
          difficulty,
          selected: selectedVariant,
          variants: Object.keys(routed.model.variants ?? {}),
        })
      : selectedVariant
    const model = {
      modelID: routed.model.id,
      providerID: routed.model.provider.id,
    }
    // A session can remember the hidden `plan` agent after Plan Mode is turned
    // off. Never carry that read-only agent into an ordinary build submission.
    const resolvedAgent = resolveSubmissionAgent({
      planMode: isPlanMode,
      current: currentAgent.name,
      available: local.agent.list(),
    })
    const judge = input.llmJudge?.() ? (input.judgeScope?.() ?? "thorough") : undefined
    const agent = resolveExecutionAgent({
      planMode: isPlanMode,
      quickRequested: requestedExecutionMode === "quick",
      researchRequested: mode !== "shell" && requestedExecutionMode === "research",
      difficulty,
      current: resolvedAgent,
    })
    const researchSize = agent === RESEARCH ? sizeOf(input.researchDepth?.() ?? "auto") : undefined
    const researchScope = agent === RESEARCH ? input.researchScope?.() : undefined

    if (!(await workspaceAvailable())) return
    // Before anything is created or sent: the draft stays in the editor if the user does not accept.
    if (
      freeModelMayTrain(routed.model) &&
      input.confirmFreeModelTraining &&
      !(await input.confirmFreeModelTraining(routed.model))
    )
      return

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = destination.directory

    const isNewSession = !params.id
    const shouldAutoAccept = !isPlanMode && isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = destination.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = destination.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create({
          // The engine already titles greetings without a model request and may retitle them for the first real task.
          title:
            difficulty === "trivial"
              ? undefined
              : initialSessionTitle(
                  currentPrompt.flatMap((part) => (part.type === "text" ? [part.content] : [])).join(""),
                  [
                    ...context.flatMap((item) => (item.comment ? [item.comment] : [])),
                    ...images.map((item) => item.filename),
                    ...currentPrompt.flatMap((part) => (part.type === "file" ? [getFilename(part.path)] : [])),
                    ...context.map((item) => getFilename(item.path)),
                  ],
                ),
        })
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        const draftID = search.draftId
        if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    // A toast disappears; the composer chip is what the user reads before every
    // subsequent prompt. Leaving it on the model they picked while sending to a
    // different one meant they could not tell what they were being billed for.
    if ((routed.image || routed.task) && routed.model.id !== currentModel.id) {
      local.model.set({ providerID: routed.model.provider.id, modelID: routed.model.id }, { recent: true })
    }
    if (routed.image) {
      showToast({
        title: "Vector selected an image-capable model",
        description: `Switched to ${modelDisplayName(routed.model)} to inspect the attached image.`,
        duration: 5_000,
      })
    } else if (routed.task) {
      showToast({
        title: "Vector routed a complex task",
        description: `Switched to ${modelDisplayName(routed.model)} for stronger planning and implementation.`,
        duration: 5_000,
      })
    }
    const pasted = takePastes(target, text)
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      difficulty,
      executionMode,
      ...(pasted.length ? { pasted } : {}),
      ...(judge ? { judge } : {}),
      ...(requestedExecutionMode === "quick" && agent === "quick" ? { size: "chat" as const } : {}),
      ...(researchSize ? { size: researchSize } : {}),
      ...(researchScope ? { research: { scope: researchScope } } : {}),
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      restorePastes(restored.target, text)
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isPlanMode && !isNewSession && mode === "normal" && input.shouldQueue?.()) {
      if (input.onQueue?.(draft) === false) {
        restorePastes(target, text)
        return
      }
      clearContext(submission.target())
      clearInput()
      return
    }

    // Shell and slash commands bypass sendFollowupDraft, so recheck their destination after asynchronous setup too.
    if (mode === "shell" || text.startsWith("/")) {
      try {
        await requireLocalEngine(client)
      } catch (error) {
        showToast({ title: "This engine cannot run this request", description: errorMessage(error) })
        restorePastes(target, text)
        return
      }
    }
    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const typed = args.join(" ")
        const spans = within(pasted, text.length - typed.length, typed.length)
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: typed,
            ...(spans.length ? { pasted: spans } : {}),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            executionMode,
            ...(judge ? { judge } : {}),
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
