import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { agentsApi, type AgentsStatus } from "./agents-model"

/** A repository change retires every in-flight status read before it can enable an action. */
export function useAgentsStatus(cwd: () => string | undefined) {
  const [state, setState] = createStore<{ status?: AgentsStatus; error?: string; loading: boolean; revision: number }>({
    loading: true,
    revision: 0,
  })
  createEffect(() => {
    const directory = cwd()
    state.revision
    const api = agentsApi()
    let current = true
    onCleanup(() => {
      current = false
    })
    setState({ status: undefined, error: undefined, loading: !!directory && !!api })
    if (!directory || !api) return
    void api
      .status(directory)
      .then((status) => {
        if (current) setState({ status, loading: false })
      })
      .catch(() => {
        if (current) setState({ error: "Could not check GitHub. Try again.", loading: false })
      })
  })
  return { state, reload: () => setState("revision", (value) => value + 1) }
}
