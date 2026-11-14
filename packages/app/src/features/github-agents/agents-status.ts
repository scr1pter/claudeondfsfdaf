import { createEffect, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentsStatus, GithubAgentsAPI } from "./agents-model"

/** A repository change retires every in-flight status read before it can enable an action. */
export function createAgentsStatus(input: {
  cwd: () => string | undefined
  api: () => Pick<GithubAgentsAPI, "status"> | undefined
  onRetire?: () => void
}) {
  const [state, setState] = createStore<{
    status?: AgentsStatus
    error?: string
    loading: boolean
    revision: number
    authorityEpoch: number
  }>({
    loading: true,
    revision: 0,
    authorityEpoch: 0,
  })
  let requestEpoch = 0
  const retire = () => {
    requestEpoch += 1
    untrack(() => input.onRetire?.())
    setState({ status: undefined, error: undefined, loading: false })
    setState("authorityEpoch", (value) => value + 1)
  }
  const reload = () => {
    retire()
    setState("revision", (value) => value + 1)
  }
  createEffect(() => {
    const directory = input.cwd()
    state.revision
    const api = input.api()
    retire()
    const current = requestEpoch
    onCleanup(() => {
      requestEpoch += 1
    })
    setState({ status: undefined, error: undefined, loading: !!directory && !!api })
    if (!directory || !api) return
    void api
      .status(directory)
      .then((status) => {
        if (current === requestEpoch) setState({ status, loading: false })
      })
      .catch(() => {
        if (current === requestEpoch) setState({ error: "Could not check GitHub. Try again.", loading: false })
      })
  })
  return { state, reload }
}
