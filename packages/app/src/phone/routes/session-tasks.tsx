import { createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PhoneRemote } from "../remote/client"
import { refusalText } from "../remote/model"
import { decodeTasks, taskStatus } from "../remote/tasks"
import { Notice } from "./parts"

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
