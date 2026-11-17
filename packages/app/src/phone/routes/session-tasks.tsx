import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  cancelRunRequest,
  connectRunsRequest,
  reviewTarget,
  type ApprovalResult,
  type PhoneRemote,
  type ReviewTarget,
} from "../remote/client"
import {
  applyConnectAskEvent,
  connectAsks,
  connectCancelProblem,
  connectRefusalText,
  connectRunRows,
  connectRuns,
  connectRunsChanged,
  refusalText,
  type PermissionView,
} from "../remote/model"
import { decodeTasks, taskStatus } from "../remote/tasks"
import { PermissionCard } from "./approvals"
import { Notice } from "./parts"
import { ConnectCard } from "./remote-parts"

/** A task board on the paired computer; no timers poll or keep a sleeping connection alive. */
export function SessionTasks(props: { remote: PhoneRemote; computer: string; session: string; directory: string }) {
  const [state, setState] = createStore({ stopping: false, problem: "" })
  const [capabilities] = createResource(async () => {
    const answer = await props.remote.request(props.computer, { method: "GET", path: "/experimental/capabilities", directory: props.directory })
    return answer.status === 200 && !!answer.body && typeof answer.body === "object" && (answer.body as { sessionStop?: unknown }).sessionStop === true
  })
  const [tasks, { refetch }] = createResource(async () => {
    const answer = await props.remote.request(props.computer, { method: "GET", path: `/experimental/session/${props.session}/tasks`, directory: props.directory,
      query: { descendants: "true", shells: "true", limit: "100" },
    })
    if (answer.status === 404) return undefined
    if (answer.status !== 200) throw new Error(refusalText(answer))
    return decodeTasks(answer.body)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(props.remote.onEvents((computer, events) => {
    if (computer !== props.computer || timer || !events.some((event) => ["session.updated", "session.status", "session.idle", "session.error"].includes(event.type))) return
    timer = setTimeout(() => { timer = undefined; void refetch() }, 250)
  }))
  onCleanup(() => clearTimeout(timer))
  const stop = async () => {
    if (state.stopping) return
    setState({ stopping: true, problem: "" })
    try {
      const answer = await props.remote.request(props.computer, { method: "POST", path: `/experimental/session/${props.session}/stop`, directory: props.directory, body: { helpers: true } })
      if (answer.status >= 300) setState("problem", refusalText(answer))
      else await refetch()
    } catch (error) {
      setState("problem", error instanceof Error ? error.message : "The computer did not answer.")
    } finally { setState("stopping", false) }
  }
  return <section class="phone-stack" aria-label="Tasks">
    <h4>Tasks</h4>
    <Show when={!tasks.error} fallback={<Notice text="Tasks could not be loaded. Refresh to try again." />}>
      <Show when={tasks() !== undefined && !tasks.loading} fallback={<p class="phone-meta">{tasks.loading ? "Loading tasks…" : "Update Vector on your computer to see helper tasks here."}</p>}>
        <Show when={tasks()?.length} fallback={<p class="phone-meta">No helper tasks or background jobs.</p>}>
          <ul class="phone-stack"><For each={tasks()}>{(task) => <li><strong>{task.title}</strong><p class="phone-meta">{taskStatus(task.status)}</p><Show when={task.detail}><p class="phone-meta">{task.detail}</p></Show></li>}</For></ul>
          <Show when={capabilities() && tasks()?.some((task) => ["queued", "running", "waiting_on_user"].includes(task.status))}>
            <button type="button" class="phone-button phone-button--quiet" disabled={state.stopping} onClick={() => void stop()}>Stop including helpers</button>
          </Show>
        </Show>
      </Show>
    </Show>
    <button type="button" class="phone-link" disabled={tasks.loading} onClick={() => void refetch()}>Refresh tasks</button>
    <Notice text={state.problem} />
  </section>
}

/**
 * The open conversation's connected runs (CW-23c): read when it opens with connected tools on, and again when its turn
 * ends, one of its connect parts changes or one of its runs does. Such a read waits a second, so the events of that
 * second cost one read, and events that arrive while a read is going ask for one more after its answer, so a chatty
 * run costs about one relay round trip a second. The cards in the conversation and the runs list share this read.
 */
export function useConnectRuns(props: {
  remote: PhoneRemote
  computer: string
  session: string
  directory: string
  on: () => boolean
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Events arrived while a read was going: read once more after it.
  let again = false
  const later = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void refetch()
    }, 1_000)
  }
  const [runs, { refetch }] = createResource(
    () => (props.on() ? props.session : undefined),
    async (session) => {
      const answer = await props.remote
        .request(props.computer, connectRunsRequest(props.directory, session))
        .finally(() => {
          if (!again) return
          again = false
          later()
        })
      if (answer.status !== 200) throw new Error(connectRefusalText(answer))
      return connectRuns(answer.body, session)
    },
  )
  onCleanup(
    props.remote.onEvents((computer, events) => {
      if (computer !== props.computer || !props.on()) return
      if (!events.some((event) => connectRunsChanged(event, props.session))) return
      if (runs.loading) {
        again = true
        return
      }
      later()
    }),
  )
  onCleanup(() => {
    again = false
    clearTimeout(timer)
  })
  return {
    /** The runs last read; undefined before the first answer and after a refused one (a resource read then throws). */
    list: () => (runs.state === "ready" || runs.state === "refreshing" ? runs.latest : undefined),
    problem: () => (runs.state === "errored" ? errorText(runs.error) : undefined),
    loading: () => runs.loading,
    refetch: () => void refetch(),
  }
}

/**
 * A conversation's connected runs with Cancel, its pending connected-tools questions, and a VectorScope review of its
 * changes. The review starts after this phone's passkey, and its own questions show here while the start waits.
 */
export function ConnectRuns(props: {
  remote: PhoneRemote
  computer: string
  session: string
  directory: string
  runs: ReturnType<typeof useConnectRuns>
}) {
  const [state, setState] = createStore({
    kind: "uncommitted" as ReviewTarget["kind"],
    base: "",
    starting: false,
    cancelling: "",
    problem: "",
  })
  const [confirm, setConfirm] = createSignal<() => Promise<ApprovalResult>>()
  const [asks, setAsks] = createSignal<PermissionView[]>([])
  const readAsks = async () => {
    const answer = await props.remote
      .request(props.computer, { method: "GET", path: "/permission", directory: props.directory })
      .catch(() => undefined)
    if (answer?.status === 200) setAsks(connectAsks(answer.body, props.directory, props.session))
  }
  onMount(() => void readAsks())
  onCleanup(
    props.remote.onEvents((computer, events) => {
      if (computer !== props.computer) return
      const next = events.reduce(
        (acc, event) => {
          const applied = applyConnectAskEvent(acc.asks, props.session, event)
          return { asks: applied.asks, stale: acc.stale || applied.stale }
        },
        { asks: asks(), stale: false },
      )
      setAsks(next.asks)
      if (next.stale) void readAsks()
    }),
  )

  const choose = (kind: string, base: string) => {
    if (kind !== "uncommitted" && kind !== "staged" && kind !== "branch") return
    // A passkey prompt waiting for a tap was made for the changes chosen before.
    setConfirm(undefined)
    setState({ kind, base, problem: "" })
  }

  const start = async () => {
    if (state.starting) return
    const target = reviewTarget(state.kind, state.base)
    if (!target) {
      setState("problem", "That base is not a branch or commit name.")
      return
    }
    setState({ starting: true, problem: "" })
    try {
      const pending = confirm()
      const result = pending
        ? await pending()
        : await props.remote.startReview(props.computer, props.directory, props.session, target)
      if (result.kind === "tap") {
        // The browser wants the passkey prompt straight from a tap: the next tap asks for it.
        setConfirm(() => result.confirm)
        return
      }
      setConfirm(undefined)
      if (result.answer.status < 200 || result.answer.status >= 300)
        setState("problem", connectRefusalText(result.answer))
      props.runs.refetch()
    } catch (error) {
      setConfirm(undefined)
      setState("problem", errorText(error))
      props.runs.refetch()
    } finally {
      setState("starting", false)
    }
  }

  const cancel = async (runID: string) => {
    if (state.cancelling) return
    setState({ cancelling: runID, problem: "" })
    try {
      const answer = await props.remote.request(props.computer, cancelRunRequest(props.directory, props.session, runID))
      setState("problem", connectCancelProblem(answer) ?? "")
    } catch (error) {
      setState("problem", errorText(error))
    } finally {
      setState("cancelling", "")
      props.runs.refetch()
    }
  }

  return (
    <section class="phone-stack" aria-label="Connected tools">
      <h4>Connected tools</h4>
      <For each={asks()}>
        {(request) => (
          <PermissionCard
            remote={props.remote}
            computer={props.computer}
            request={request}
            settled={(id) => setAsks((list) => list.filter((item) => item.id !== id))}
          />
        )}
      </For>
      <form
        class="phone-form"
        method="post"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <label>
          Changes to review
          {/* Unchangeable while a start waits, so a passkey prompt kept for a tap is for the changes shown. */}
          <select
            disabled={state.starting}
            value={state.kind}
            onChange={(event) => choose(event.currentTarget.value, state.base)}
          >
            <option value="uncommitted">Uncommitted changes</option>
            <option value="staged">Staged changes</option>
            <option value="branch">This branch</option>
          </select>
        </label>
        <Show when={state.kind === "branch"}>
          <label>
            Compare with (optional)
            <input
              disabled={state.starting}
              value={state.base}
              placeholder="main"
              autocapitalize="off"
              spellcheck={false}
              onInput={(event) => choose(state.kind, event.currentTarget.value)}
            />
          </label>
        </Show>
        <button type="submit" class="phone-button" disabled={state.starting}>
          {confirm() ? "Confirm with your passkey" : "Review changes"}
        </button>
      </form>
      <Show when={state.starting}>
        <p class="phone-loading">Waiting for your computer…</p>
      </Show>
      <p class="phone-meta">
        VectorScope reviews them on your computer after this phone's passkey. If it asks for your approval, answer it
        here right away.
      </p>
      <Show when={!props.runs.problem()} fallback={<Notice text={props.runs.problem()} />}>
        <Show
          when={props.runs.list()?.length}
          fallback={
            <p class="phone-meta">
              {props.runs.loading() ? "Loading runs…" : "No connected runs in this conversation yet."}
            </p>
          }
        >
          <For each={connectRunRows(props.runs.list() ?? [])}>
            {(run) => (
              <ConnectCard run={run}>
                <Show when={run.going}>
                  <button
                    type="button"
                    class="phone-button phone-button--quiet"
                    disabled={state.cancelling !== ""}
                    onClick={() => void cancel(run.id)}
                  >
                    Cancel
                  </button>
                </Show>
              </ConnectCard>
            )}
          </For>
        </Show>
      </Show>
      <button type="button" class="phone-link" onClick={() => props.runs.refetch()}>
        Refresh runs
      </button>
      <Notice text={state.problem} />
    </section>
  )
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : "The computer did not answer."
}
