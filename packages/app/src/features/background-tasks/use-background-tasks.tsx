import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { usePrompt, type Prompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { createBackgroundTasks, type BackgroundTasks } from "./background-tasks"
import { appendTaskQuestion } from "./task-board-model"

const Context = createContext<BackgroundTasks>()

/** Undefined outside a session page, so shared components can fall back to their old rendering. */
export function useBackgroundTasks() {
  return useContext(Context)
}

export function BackgroundTasksProvider(props: ParentProps<{ sessionID: Accessor<string | undefined> }>) {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string }>()
  const prompt = usePrompt()
  const language = useLanguage()
  const platform = usePlatform()
  const open = (sessionID: string) =>
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), sessionID)
        : legacySessionHref(sdk().directory, sessionID),
    )
  // The root's composer draft changes in place, attachments kept, and takes focus on the root's page.
  const compose = (rootID: string, change: (current: Prompt) => Prompt) => {
    const target = prompt.capture({ dir: sdk().directory, id: rootID })
    const next = change(target.current())
    target.set(
      next,
      next.reduce((end, part) => (part.type === "image" ? end : Math.max(end, part.end)), 0),
    )
    if (props.sessionID() !== rootID) open(rootID)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus())
  }
  const value = createBackgroundTasks({
    sessionID: props.sessionID,
    sync: useSync(),
    client: () => sdk().client,
    reconnects: () => serverSync().reconnects(),
    pin: (sessionID) => serverSync().session.pin(sessionID),
    unpin: (sessionID) => serverSync().session.unpin(sessionID),
    desktop: window.api?.agentTasks ? { api: window.api.agentTasks, sourcePath: () => sdk().directory } : undefined,
    open,
    openDesktop: (task) =>
      window.dispatchEvent(
        new CustomEvent("vector:open-agent-task", {
          detail: { taskID: task.id, parentSessionID: task.parentSessionID, sourcePath: sdk().directory },
        }),
      ),
    openPath: platform.platform === "desktop" && platform.openPath ? (path) => platform.openPath!(path) : undefined,
    capabilities: () => serverSync().capabilities(),
    t: language.t,
    compose,
    ask: (agent, rootID) => compose(rootID, (current) => appendTaskQuestion(current, agent)),
  })
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
