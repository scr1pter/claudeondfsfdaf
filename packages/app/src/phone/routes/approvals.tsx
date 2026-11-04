import { createResource, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { phonePath } from "../config"
import { canPair } from "../environment"
import type { ApprovalResult, ComputerView, PhoneRemote } from "../remote/client"
import {
  applyApprovalEvent,
  computerLine,
  decodeProjects,
  permissionView,
  questionView,
  refusalText,
  type PermissionView,
  type QuestionView,
} from "../remote/model"
import { Empty, InstallCard, Notice, Panel, type RouteProps } from "./parts"
import { ConnectionNotice, useRemoteView } from "./remote-parts"

// Remote's approvals (WP A42, S6). A permission an agent asks for on a paired computer can be allowed once or denied
// here, never allowed always. Allowing once signs the computer's challenge with this phone's passkey, and the computer
// checks that signature itself before it answers. Questions an agent asks can be answered or dismissed.
export function ApprovalsRoute(props: RouteProps) {
  const view = useRemoteView(props.remote)
  onMount(() => void props.remote.load().then(() => {
      if (props.remote.view().computers.length) return props.remote.connect()
    }))
  return (
    <Panel title="Approvals">
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="Approvals work only in the installed app, where this phone keeps its pairing keys."
          />
        }
      >
        <ConnectionNotice remote={props.remote} view={view()} />
        <p class="phone-meta">
          When an agent on a paired computer asks for permission, you can allow it once or deny it here. Each
          allowance asks for this phone's passkey.
        </p>
        <Show
          when={view().computers.length}
          fallback={
            <>
              <Empty>Pair a computer first.</Empty>
              <button type="button" class="phone-button" onClick={() => props.navigate(phonePath("pair"))}>
                Pair a computer
              </button>
            </>
          }
        >
          <Index each={view().computers}>
            {(computer) => <ComputerApprovals remote={props.remote} computer={computer()} />}
          </Index>
        </Show>
      </Show>
    </Panel>
  )
}

function ComputerApprovals(props: { remote: PhoneRemote; computer: ComputerView }) {
  const [lists, setLists] = createSignal<{ permissions: PermissionView[]; questions: QuestionView[] }>({
    permissions: [],
    questions: [],
  })
  const [stale, setStale] = createSignal(false)
  const [loaded, { refetch }] = createResource(
    () => (props.computer.channel === "open" ? props.computer.device : undefined),
    async (device) => {
      const projects = decodeProjects((await props.remote.request(device, { method: "GET", path: "/project" })).body)
      const permissions: PermissionView[] = []
      const questions: QuestionView[] = []
      for (const directory of projects.slice(0, 8).flatMap((project) => [project.worktree, ...project.sandboxes])) {
        const [pending, asked] = await Promise.all([
          props.remote.request(device, { method: "GET", path: "/permission", directory }),
          props.remote.request(device, { method: "GET", path: "/question", directory }),
        ])
        for (const item of Array.isArray(pending.body) ? pending.body : []) {
          const shown = permissionView(item, directory)
          if (shown && !permissions.some((other) => other.id === shown.id)) permissions.push(shown)
        }
        for (const item of Array.isArray(asked.body) ? asked.body : []) {
          const shown = questionView(item, directory)
          if (shown && !questions.some((other) => other.id === shown.id)) questions.push(shown)
        }
      }
      setLists({ permissions, questions })
      setStale(false)
      await props.remote.watch(device, true).catch(() => {})
      return true
    },
  )
  onCleanup(() => void props.remote.watch(props.computer.device, false).catch(() => {}))
  onCleanup(
    props.remote.onEvents((computer, events) => {
      if (computer !== props.computer.device) return
      let next = lists()
      for (const event of events) {
        const applied = applyApprovalEvent(next, event)
        next = { permissions: applied.permissions, questions: applied.questions }
        if (applied.stale) setStale(true)
      }
      setLists(next)
    }),
  )
  const settled = (id: string) =>
    setLists((current) => ({
      permissions: current.permissions.filter((item) => item.id !== id),
      questions: current.questions.filter((item) => item.id !== id),
    }))

  return (
    <section class="phone-stack" aria-label={props.computer.name}>
      <h3>{props.computer.name}</h3>
      <Show when={props.computer.channel === "open"} fallback={<p class="phone-meta">{computerLine(props.computer)}</p>}>
        <Show when={loaded.error}>
          <Notice text="The computer did not answer. Try again." />
        </Show>
        <Show when={stale()}>
          <Notice text="Something new is waiting. Refresh to see it." />
        </Show>
        <Show when={!loaded.loading} fallback={<p class="phone-loading">Loading…</p>}>
          <Show
            when={lists().permissions.length || lists().questions.length}
            fallback={<Empty>Nothing is waiting for you.</Empty>}
          >
            <For each={lists().permissions}>
              {(request) => (
                <PermissionCard
                  remote={props.remote}
                  computer={props.computer.device}
                  request={request}
                  settled={settled}
                />
              )}
            </For>
            <For each={lists().questions}>
              {(question) => (
                <QuestionCard
                  remote={props.remote}
                  computer={props.computer.device}
                  question={question}
                  settled={settled}
                />
              )}
            </For>
          </Show>
          <button type="button" class="phone-link" onClick={() => refetch()}>
            Refresh
          </button>
        </Show>
      </Show>
    </section>
  )
}

function PermissionCard(props: {
  remote: PhoneRemote
  computer: string
  request: PermissionView
  settled: (id: string) => void
}) {
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [confirm, setConfirm] = createSignal<() => Promise<ApprovalResult>>()

  const finish = (result: ApprovalResult) => {
    if (result.kind === "tap") {
      // The browser wants the passkey prompt straight from a tap: the next tap asks for it.
      setConfirm(() => result.confirm)
      return
    }
    setConfirm(undefined)
    if (result.answer.status >= 200 && result.answer.status < 300) props.settled(props.request.id)
    else if (result.answer.status === 404) props.settled(props.request.id)
    else setProblem(refusalText(result.answer))
  }

  const run = async (work: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      await work()
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : "That did not work. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const allow = () =>
    run(async () => {
      const pending = confirm()
      finish(
        pending
          ? await pending()
          : await props.remote.approve(props.computer, props.request.directory, props.request.id),
      )
    })
  const deny = () =>
    run(async () => {
      const answer = await props.remote.deny(props.computer, props.request.directory, props.request.id)
      if (answer.status < 300 || answer.status === 404) props.settled(props.request.id)
      else setProblem(refusalText(answer))
    })

  return (
    <div class="phone-card">
      <strong>{props.request.title}</strong>
      <Show when={props.request.detail}>
        <pre class="phone-detail">{props.request.detail}</pre>
      </Show>
      <div class="phone-actions">
        <button type="button" class="phone-button" disabled={busy()} onClick={allow}>
          {confirm() ? "Confirm with your passkey" : "Allow once"}
        </button>
        <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={deny}>
          Deny
        </button>
      </div>
      <Notice text={problem()} />
    </div>
  )
}

function QuestionCard(props: {
  remote: PhoneRemote
  computer: string
  question: QuestionView
  settled: (id: string) => void
}) {
  const [chosen, setChosen] = createSignal<string[][]>(props.question.questions.map(() => []))
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const toggle = (index: number, label: string, multiple: boolean) =>
    setChosen((current) =>
      current.map((answer, at) =>
        at !== index
          ? answer
          : multiple
            ? answer.includes(label)
              ? answer.filter((item) => item !== label)
              : [...answer, label]
            : [label],
      ),
    )
  const send = async (path: "reply" | "reject") => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      const answer = await props.remote.request(props.computer, {
        method: "POST",
        path: `/question/${props.question.id}/${path}`,
        directory: props.question.directory,
        body: path === "reply" ? { answers: chosen() } : {},
      })
      if (answer.status < 300 || answer.status === 404) props.settled(props.question.id)
      else setProblem(refusalText(answer))
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : "That did not work. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="phone-card">
      <For each={props.question.questions}>
        {(item, index) => (
          <div class="phone-stack">
            <strong>{item.header || "A question"}</strong>
            <p>{item.question}</p>
            <div class="phone-actions">
              <For each={item.options}>
                {(label) => (
                  <button
                    type="button"
                    class={
                      chosen()[index()]?.includes(label) ? "phone-button" : "phone-button phone-button--quiet"
                    }
                    aria-pressed={chosen()[index()]?.includes(label) ? "true" : "false"}
                    onClick={() => toggle(index(), label, item.multiple)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
      <div class="phone-actions">
        <button
          type="button"
          class="phone-button"
          disabled={busy() || chosen().some((answer) => answer.length === 0)}
          onClick={() => void send("reply")}
        >
          Send answer
        </button>
        <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => void send("reject")}>
          Dismiss
        </button>
      </div>
      <Notice text={problem()} />
    </div>
  )
}
