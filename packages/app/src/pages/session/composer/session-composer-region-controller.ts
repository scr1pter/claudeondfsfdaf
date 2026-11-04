import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@vectordevai/ui/motion-spring"
import { type Accessor, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInputState } from "@/components/prompt-input"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import type { SessionComposerController } from "./session-composer-state"

export type SessionComposerFollowupDock = {
  items: { id: string; text: string; failed?: boolean }[]
  sending?: string
  paused?: string
  onSend: (id: string) => void
  onDelete: (id: string) => void
  onResume?: () => void
}

export type SessionComposerRevertDock = {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}

export function createSessionComposerRegionController(input: {
  state: SessionComposerController
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  ready: Accessor<boolean>
  centered: Accessor<boolean>
  todo: {
    collapsed: Accessor<boolean>
    onToggle: () => void
  }
  followup: Accessor<SessionComposerFollowupDock | undefined>
  revert: Accessor<SessionComposerRevertDock | undefined>
  onResponseSubmit: () => void
  openParent: () => void
  setPromptRef: (el: HTMLDivElement) => void
  setDockRef: (el: HTMLDivElement) => void
}) {
  const sync = useSync()
  const [store, setStore] = createStore({
    ready: input.ready() || input.state.dock(),
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    timer = undefined
    frame = undefined
  }

  createEffect(() => {
    input.sessionKey()
    const ready = input.ready()
    const dock = input.state.dock()

    clear()
    if (store.ready || (!ready && !dock)) return
    if (dock) {
      setStore("ready", true)
      return
    }

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, 140)
    })
  })

  createEffect(() => {
    if (!input.prompt.ready()) return
    setSessionHandoff(input.sessionKey(), {
      prompt: input.prompt
        .current()
        .map((part) => {
          if (part.type === "file") return `[file:${part.path}]`
          if (part.type === "agent") return `@${part.name}`
          if (part.type === "image") return `[image:${part.filename}]`
          return part.content
        })
        .join("")
        .trim(),
    })
  })

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(el, update)
    update()
  })

  onCleanup(clear)

  const parentID = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.get(id)?.parentID : undefined
  })
  const open = createMemo(() => store.ready && input.state.dock() && !input.state.closing())
  const progress = useSpring(
    () => (open() ? 1 : 0),
    { visualDuration: 0.3, bounce: 0 },
    () => `${input.sessionKey()}\0${store.ready}`,
  )
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const ready = Promise.resolve()
  const [promptReady] = createResource(
    () => input.prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  const working = () => {
    const id = input.sessionID()
    return id ? sync().data.session_working(id) : false
  }

  // The in-flight assistant turn is the last assistant message still missing a
  // completion timestamp. Its server-recorded start is reload-safe; the status
  // component falls back to a client timestamp when it is absent.
  const startedAt = () => {
    const id = input.sessionID()
    if (!id) return undefined
    const messages = sync().data.message[id] ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      if (msg.time.completed !== undefined) continue
      return msg.time.created
    }
    return undefined
  }

  const codium = () => {
    const id = input.sessionID()
    const message = id ? (sync().data.message[id] ?? []).findLast((message) => message.role === "assistant") : undefined
    return Boolean(message && Billing.of(message))
  }

  const tokens = () => {
    if (codium()) return 0
    const id = input.sessionID()
    if (!id) return 0
    const data = sync().data
    const messages = data.message[id] ?? []
    // Show the tokens the CURRENT task/turn is using — growing as it runs — never
    // the session's cumulative lifetime total.
    let inflightId: string | undefined
    let inflightReal = 0
    let baseContext = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const turn =
        msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
      if (!inflightId && msg.time.completed === undefined) {
        inflightId = msg.id
        inflightReal = turn
        continue
      }
      // The most recent turn that reported usage = the context carried into the
      // running turn.
      if (turn > 0) {
        baseContext = turn
        break
      }
    }
    // Not streaming a turn: show the last completed turn's footprint.
    if (!inflightId) return baseContext
    // Provider already reported usage for the running turn: use it verbatim.
    if (inflightReal > 0) return inflightReal
    // Streaming: the provider only reports usage at turn completion, so estimate
    // the output produced so far from the streamed text (~4 chars/token) and add
    // the context carried in. This ticks up live and snaps to the real count when
    // the turn finishes.
    let chars = 0
    for (const part of data.part[inflightId] ?? []) {
      if (part.type !== "text" && part.type !== "reasoning") continue
      chars += (data.part_text_accum_delta[part.id] ?? part.text ?? "").length
    }
    return baseContext + Math.round(chars / 4)
  }

  const runningTasks = () => {
    const rootId = input.sessionID()
    if (!rootId) return 0
    const inSubtree = (sid: string) => {
      let current: string | undefined = sid
      let guard = 0
      while (current && guard < 100) {
        if (current === rootId) return true
        current = sync().session.get(current)?.parentID
        guard++
      }
      return false
    }
    return Object.entries(sync().data.session_status).filter(
      ([sid, status]) => status.type !== "idle" && inSubtree(sid),
    ).length
  }

  const phrase = () => {
    const id = input.sessionID()
    if (!id) return undefined
    const status = sync().data.session_status[id]
    return status?.type === "retry" ? status.message : undefined
  }

  return {
    state: input.state,
    centered: input.centered,
    todo: input.todo,
    followup: input.followup,
    revert: input.revert,
    onResponseSubmit: input.onResponseSubmit,
    openParent: input.openParent,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    parentID,
    child: () => !!parentID(),
    showComposer: () => !input.state.blocked() || !!parentID(),
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => input.prompt.ready() || promptReady(),
    dock: () => (store.ready && input.state.dock()) || value() > 0.001,
    dockProgress: value,
    dockHeight: () => Math.max(78, store.height),
    lift: () => (input.revert()?.items.length ? 18 : 36 * value()),
    setDockBodyRef: (el: HTMLDivElement) => setStore("body", el),
    working,
    startedAt,
    tokens,
    codium,
    runningTasks,
    phrase,
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
import { Billing } from "@vectordevai/schema/billing"
