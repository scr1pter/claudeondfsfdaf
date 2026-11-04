import { createResource, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { phonePath } from "../config"
import { canPair } from "../environment"
import type { ComputerView, PhoneRemote } from "../remote/client"
import {
  applyMessageEvent,
  applySessionEvent,
  computerLine,
  decodeMessages,
  decodeProjects,
  refusalText,
  sessionRows,
  type MessageView,
  type Project,
  type SessionRow,
} from "../remote/model"
import { Empty, InstallCard, Notice, Panel, type RouteProps } from "./parts"
import { ConnectionNotice, useRemoteView } from "./remote-parts"

// Remote's sessions (WP A42): the sessions on each paired computer, streamed end-to-end encrypted through the relay
// while this page is open, and one session to read, steer or stop. What a phone may ask is the computer's allowlist
// (text turns only); a turn started here is never auto-approved, so its requests wait in Approvals.
export function SessionsRoute(props: RouteProps) {
  const view = useRemoteView(props.remote)
  const [open, setOpen] = createSignal<{ computer: string; session: SessionRow }>()
  // Opening the page is the person's action: connect, if a computer is paired to talk to.
  onMount(() => void props.remote.load().then(() => {
      if (props.remote.view().computers.length) return props.remote.connect()
    }))
  return (
    <Panel title="Sessions">
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="Sessions open only in the installed app, where this phone keeps its pairing keys."
          />
        }
      >
        <ConnectionNotice remote={props.remote} view={view()} />
        <Show
          when={view().computers.length}
          fallback={
            <>
              <Empty>Sessions on your paired computers show here. Pair a computer first.</Empty>
              <button type="button" class="phone-button" onClick={() => props.navigate(phonePath("pair"))}>
                Pair a computer
              </button>
            </>
          }
        >
          <Show
            when={open()}
            fallback={
              <Index each={view().computers}>
                {(computer) => (
                  <ComputerSessions
                    remote={props.remote}
                    computer={computer()}
                    onOpen={(session) => setOpen({ computer: computer().device, session })}
                  />
                )}
              </Index>
            }
          >
            {(current) => (
              <SessionView
                remote={props.remote}
                computer={current().computer}
                session={current().session}
                onBack={() => setOpen(undefined)}
              />
            )}
          </Show>
        </Show>
      </Show>
    </Panel>
  )
}

function ComputerSessions(props: { remote: PhoneRemote; computer: ComputerView; onOpen: (row: SessionRow) => void }) {
  const [rows, setRows] = createSignal<SessionRow[]>([])
  const [problem, setProblem] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [data, { refetch }] = createResource(
    () => (props.computer.channel === "open" ? props.computer.device : undefined),
    async (device) => {
      setProblem(undefined)
      const answer = await props.remote.request(device, { method: "GET", path: "/project" })
      const projects = decodeProjects(answer.body).slice(0, 8)
      const all: SessionRow[] = []
      for (const project of projects) {
        const [sessions, statuses] = await Promise.all([
          props.remote.request(device, {
            method: "GET",
            path: "/session",
            directory: project.worktree,
            query: { roots: "true", limit: "20" },
          }),
          props.remote.request(device, { method: "GET", path: "/session/status", directory: project.worktree }),
        ])
        all.push(...sessionRows(project, project.worktree, sessions.body, statuses.body))
      }
      setRows(all.sort((a, b) => b.updated - a.updated))
      // Live changes come as events while this page watches; nothing is asked again on its own.
      await props.remote.watch(device, true).catch(() => {})
      return projects
    },
  )
  onCleanup(() => void props.remote.watch(props.computer.device, false).catch(() => {}))
  onCleanup(
    props.remote.onEvents((computer, events) => {
      if (computer !== props.computer.device) return
      const projects = data.latest ?? []
      let next = rows()
      for (const event of events) next = applySessionEvent(next, projects, event)
      setRows(next)
    }),
  )

  const create = async (project: Project) => {
    if (creating()) return
    setCreating(true)
    setProblem(undefined)
    try {
      const answer = await props.remote.request(props.computer.device, {
        method: "POST",
        path: "/session",
        directory: project.worktree,
        body: { title: "From my phone" },
      })
      const [row] = sessionRows(project, project.worktree, [answer.body], {})
      if (answer.status >= 300 || !row) setProblem(refusalText(answer))
      else props.onOpen(row)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The computer did not answer.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <section class="phone-stack" aria-label={props.computer.name}>
      <h3>{props.computer.name}</h3>
      <Show when={props.computer.channel === "open"} fallback={<p class="phone-meta">{computerLine(props.computer)}</p>}>
        <Show when={data.error}>
          <Notice text="The computer did not answer. Try again." />
        </Show>
        <Show when={!data.loading} fallback={<p class="phone-loading">Loading sessions…</p>}>
          <Show when={rows().length} fallback={<Empty>No sessions yet.</Empty>}>
            <For each={rows()}>
              {(row) => (
                <button type="button" class="phone-feature phone-session" onClick={() => props.onOpen(row)}>
                  <strong>{row.title}</strong>
                  <span>
                    {row.project}
                    {row.status === "busy" ? " · working" : row.status === "retry" ? " · retrying" : ""}
                  </span>
                </button>
              )}
            </For>
          </Show>
          <For each={data.latest ?? []}>
            {(project) => (
              <button
                type="button"
                class="phone-button phone-button--quiet"
                disabled={creating()}
                onClick={() => void create(project)}
              >
                New session in {project.name}
              </button>
            )}
          </For>
          <button type="button" class="phone-link" onClick={() => refetch()}>
            Refresh
          </button>
        </Show>
        <Notice text={problem()} />
      </Show>
    </section>
  )
}

function SessionView(props: { remote: PhoneRemote; computer: string; session: SessionRow; onBack: () => void }) {
  const [messages, setMessages] = createSignal<MessageView[]>([])
  const [stale, setStale] = createSignal(false)
  const [busy, setBusy] = createSignal(props.session.status !== "idle")
  const [text, setText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const directory = props.session.directory

  const load = async () => {
    setProblem(undefined)
    const answer = await props.remote.request(props.computer, {
      method: "GET",
      path: `/session/${props.session.id}/message`,
      directory,
      query: { limit: "30" },
    })
    if (answer.status !== 200) throw new Error(refusalText(answer))
    setMessages(decodeMessages(answer.body))
    setStale(false)
    await props.remote.watch(props.computer, true).catch(() => {})
  }
  const [loaded, { refetch }] = createResource(load)
  onCleanup(
    props.remote.onEvents((computer, events) => {
      if (computer !== props.computer) return
      let next = messages()
      for (const event of events) {
        const properties = (event.properties ?? {}) as Record<string, unknown>
        if (properties.sessionID === props.session.id && event.type === "session.status") {
          const status = (properties.status ?? {}) as { type?: unknown }
          setBusy(status.type === "busy" || status.type === "retry")
        }
        if (properties.sessionID === props.session.id && event.type === "session.idle") setBusy(false)
        const applied = applyMessageEvent(next, props.session.id, event)
        next = applied.messages
        if (applied.stale) setStale(true)
      }
      setMessages(next)
    }),
  )

  const send = async () => {
    const prompt = text().trim()
    if (!prompt || sending()) return
    setSending(true)
    setProblem(undefined)
    try {
      const answer = await props.remote.request(props.computer, {
        method: "POST",
        path: `/session/${props.session.id}/prompt_async`,
        directory,
        body: { parts: [{ type: "text", text: prompt }] },
      })
      if (answer.status >= 300) setProblem(refusalText(answer))
      else {
        setText("")
        setBusy(true)
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The computer did not answer.")
    } finally {
      setSending(false)
    }
  }

  const abort = async () => {
    setProblem(undefined)
    try {
      const answer = await props.remote.request(props.computer, {
        method: "POST",
        path: `/session/${props.session.id}/abort`,
        directory,
        body: {},
      })
      if (answer.status >= 300) setProblem(refusalText(answer))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The computer did not answer.")
    }
  }

  return (
    <section class="phone-stack" aria-label={props.session.title}>
      <button type="button" class="phone-link" onClick={props.onBack}>
        All sessions
      </button>
      <h3>{props.session.title}</h3>
      <p class="phone-meta">
        {props.session.project}
        {busy() ? " · working" : ""}
      </p>
      <Show when={stale()}>
        <button type="button" class="phone-button phone-button--quiet" onClick={() => refetch()}>
          Load the latest
        </button>
      </Show>
      <Show when={loaded.error}>
        <Notice text="The computer did not answer. Try again." />
      </Show>
      <Show when={!loaded.loading} fallback={<p class="phone-loading">Loading…</p>}>
        <Show when={messages().length} fallback={<Empty>Nothing in this session yet.</Empty>}>
          <ol class="phone-messages">
            <For each={messages()}>
              {(message) => (
                <li class={message.role === "user" ? "phone-message phone-message--user" : "phone-message"}>
                  <For each={message.parts}>
                    {(part) => (
                      <Switch>
                        <Match when={part.kind === "text" && part}>
                          {(item) => <p class="phone-message-text">{(item() as { text: string }).text}</p>}
                        </Match>
                        <Match when={part.kind === "tool" && part}>
                          {(item) => {
                            const tool = item() as { tool: string; state: string; title?: string }
                            return (
                              <p class="phone-meta">
                                {tool.title ?? tool.tool} · {tool.state === "completed" ? "done" : tool.state}
                              </p>
                            )
                          }}
                        </Match>
                        <Match when={part.kind === "other" && part}>
                          {(item) => <p class="phone-meta">{(item() as { label: string }).label}</p>}
                        </Match>
                      </Switch>
                    )}
                  </For>
                  <Show when={message.error}>
                    <p class="phone-meta">{message.error}</p>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
      <form
        class="phone-form"
        method="post"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <label>
          Message
          <textarea rows={3} value={text()} onInput={(event) => setText(event.currentTarget.value)} />
        </label>
        <button type="submit" class="phone-button" disabled={sending() || !text().trim()}>
          Send
        </button>
      </form>
      <Show when={busy()}>
        <button type="button" class="phone-button phone-button--quiet" onClick={() => void abort()}>
          Stop
        </button>
      </Show>
      <p class="phone-meta">Turns you start here are never approved automatically: their requests wait in Approvals.</p>
      <Notice text={problem()} />
    </section>
  )
}
