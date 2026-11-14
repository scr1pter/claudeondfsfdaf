import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import {
  accessLine,
  decodeApprove,
  decodeDownload,
  decodeHostedStatus,
  decodeJobs,
  decodeViewer,
  DELIVER_LABEL,
  handoffLine,
  HOSTED_LINE,
  hostedErrorText,
  hoursLine,
  isLive,
  jobReasonLine,
  jobStateLabel,
  overnightShown,
  queueLine,
  rampLine,
  sessionControls,
  sessionLine,
  stateLabel,
  takeoverLine,
  verdictLine,
  type HostedJob,
  type HostedSession,
} from "@/features/cloud/hosted/hosted-model"
import { hostedRoute, type HostedRequest } from "@/features/cloud/hosted/hosted-requests"
import { phoneApi, PhoneApiError } from "../api"
import { phonePath } from "../config"
import { alertsSupport } from "../environment"
import { alertsState } from "../push"
import { planNotice } from "../status"
import { browserPush } from "./notifications"
import { Empty, Notice, Panel, type RouteProps } from "./parts"

// The cloud computer on the phone (WP A56; the A38 shell's route): what runs on the computer Vector runs for you, with
// the purple-edged "Vector is using its cloud computer" line, why it needs you, Watch, Take over and Stop, the
// session's files, and Done by Morning's jobs and reports. Every action goes to vectordev.ai on this origin with the
// website session; the server decides each one from the plan (S1). Links the server gives (the live view, the files,
// a job's pull request) open as links the person taps, in the browser, with no referrer: the live view's single-use
// pass stays in its fragment. Starting a job stays on the desktop, which shows the most it can use first.
const POLL_MS = 15_000

type Link = { id: string; label: string; url: string }

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function ComputerRoute(props: RouteProps) {
  const call = async (request: HostedRequest) => {
    const route = hostedRoute(request)
    if (!route) throw new PhoneApiError(400, "HOSTED_REQUEST", "Vector could not send that.")
    return phoneApi(route.path, props.session, { method: route.method, ...(route.body ? { body: route.body } : {}) })
  }
  const [status, { refetch }] = createResource(async () => {
    try {
      return { status: decodeHostedStatus(await call({ kind: "status" })) }
    } catch (cause) {
      return { error: hostedErrorText(cause instanceof PhoneApiError ? cause : undefined) }
    }
  })
  const overnight = () => overnightShown(props.status)
  const [jobs, { refetch: refetchJobs }] = createResource(overnight, async () => {
    try {
      return { jobs: decodeJobs(await call({ kind: "jobs" })) }
    } catch (cause) {
      return { error: hostedErrorText(cause instanceof PhoneApiError ? cause : undefined) }
    }
  })
  const timer = setInterval(() => {
    if (globalThis.document?.visibilityState !== "hidden") void refetch()
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const live = () => (status()?.status?.sessions ?? []).filter(isLive)
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [done, setDone] = createSignal<string>()
  const [link, setLink] = createSignal<Link>()
  const [confirming, setConfirming] = createSignal<string>()

  const act = async (run: () => Promise<string | undefined>) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    setDone(undefined)
    setLink(undefined)
    try {
      const message = await run()
      if (message) setDone(message)
    } catch (cause) {
      setProblem(hostedErrorText(cause instanceof PhoneApiError ? cause : undefined))
    } finally {
      setBusy(false)
      setConfirming(undefined)
      void refetch()
    }
  }

  const viewer = async (session: HostedSession, mode: "view" | "control") => {
    const answer = decodeViewer(await call({ kind: "viewer", id: session.id, mode }))
    if (!answer) throw new PhoneApiError(502, undefined, "Vector could not read the live view's link.")
    setLink({
      id: session.id,
      label: mode === "control" ? "Open the computer to control it" : "Open the live view",
      url: answer.url,
    })
    return "The link works once, for five minutes."
  }
  const watch = (session: HostedSession) => act(() => viewer(session, "view"))
  const control = (session: HostedSession) => act(() => viewer(session, "control"))
  const takeover = (session: HostedSession) =>
    act(async () => {
      await call({ kind: "takeover", id: session.id })
      await viewer(session, "control")
      return "You have control. Vector waits until you give it back."
    })
  const release = (session: HostedSession) =>
    act(async () => {
      await call({ kind: "release", id: session.id })
      return "Vector has the computer again."
    })
  const stop = (session: HostedSession) =>
    act(async () => {
      await call({ kind: "stop", id: session.id })
      return "Vector is saving the computer's disk and stopping it."
    })
  const files = (session: HostedSession) =>
    act(async () => {
      const answer = decodeDownload(await call({ kind: "download", id: session.id }))
      if (!answer) throw new PhoneApiError(502, undefined, "Vector could not read the files' link.")
      if (!answer.ready) return "The computer is packing the files. Ask again in a minute."
      setLink({ id: session.id, label: "Download the files", url: answer.url })
      return "The link works for 24 hours."
    })
  const approve = (job: HostedJob) =>
    act(async () => {
      const answer = decodeApprove(await call({ kind: "approve-job", id: job.id }))
      if (!answer) throw new PhoneApiError(502, undefined, "Vector could not read the pull request's address.")
      setLink({ id: job.id, label: "Open the pull request", url: answer.url })
      void refetchJobs()
      return "Review and merge it yourself: Vector never merges."
    })
  const cancel = (job: HostedJob) =>
    act(async () => {
      await call({ kind: "cancel-job", id: job.id })
      void refetchJobs()
      return "Cancelled."
    })

  // Alerts: the computer tells the phone when it needs you, so a phone without alerts is offered them here.
  const support = alertsSupport(props.environment)
  const push = support === "ready" ? browserPush() : undefined
  const [alerts] = createResource(() => (push && props.status.listed.has("alerts") ? push : undefined), alertsState)

  const LinkFor = (linkProps: { id: string }) => (
    <Show when={link()?.id === linkProps.id ? link() : undefined}>
      {(current) => (
        <a class="phone-button" href={current().url} target="_blank" rel="noopener noreferrer">
          {current().label}
        </a>
      )}
    </Show>
  )

  return (
    <Panel title="Cloud computer">
      <Notice text={planNotice(props.status)} />
      <p class="phone-meta">{HOSTED_LINE}</p>
      <For each={[accessLine(status()?.status), rampLine(status()?.status?.plan), hoursLine(status()?.status)].filter(Boolean)}>
        {(line) => <p class="phone-meta">{line}</p>}
      </For>
      <Show when={alerts() === "off"}>
        <div class="phone-row" role="note">
          <p>Get a short alert on this phone when Vector needs you on its cloud computer.</p>
          <button
            type="button"
            class="phone-button phone-button--quiet"
            onClick={() => props.navigate(phonePath("notifications"))}
          >
            Set up alerts
          </button>
        </div>
      </Show>
      <Notice text={status()?.error ?? problem()} />
      <Show when={done()}>
        <p class="phone-meta" role="status">
          {done()}
        </p>
      </Show>
      <Show
        when={live().length > 0}
        fallback={
          <Show when={!status.loading}>
            <Empty>
              Nothing runs on your cloud computer now. Start a job from Vector on your computer: "Run on my cloud
              computer" shows the most it can use of your month first.
            </Empty>
          </Show>
        }
      >
        <div class="phone-stack">
          <For each={live()}>
            {(session) => {
              const actions = () => sessionControls(session)
              return (
                <div class="phone-card phone-computer" classList={{ "phone-computer--needs-you": Boolean(session.handoff) }}>
                  <div class="phone-row-text">
                    <strong>{sessionLine(session)}</strong>
                    <span class="phone-meta">
                      {session.title ?? `Cloud computer ${session.computer}`} · {stateLabel(session)}
                    </span>
                    <Show when={handoffLine(session.handoff)}>{(line) => <span class="phone-alert-line">{line()}</span>}</Show>
                    <Show when={takeoverLine(session)}>{(line) => <span class="phone-meta">{line()}</span>}</Show>
                  </div>
                  <div class="phone-actions">
                    <Show when={actions().watch}>
                      <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => void watch(session)}>
                        Watch
                      </button>
                    </Show>
                    <Show when={actions().takeover}>
                      <button type="button" class="phone-button" disabled={busy()} onClick={() => void takeover(session)}>
                        Take over
                      </button>
                    </Show>
                    <Show when={actions().control}>
                      <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => void control(session)}>
                        Open control
                      </button>
                    </Show>
                    <Show when={actions().release}>
                      <button type="button" class="phone-button" disabled={busy()} onClick={() => void release(session)}>
                        Give back
                      </button>
                    </Show>
                    <Show when={actions().files}>
                      <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => void files(session)}>
                        Files
                      </button>
                    </Show>
                    <Show when={actions().stop}>
                      <Show
                        when={confirming() === session.id}
                        fallback={
                          <button
                            type="button"
                            class="phone-button phone-button--quiet"
                            disabled={busy()}
                            onClick={() => setConfirming(session.id)}
                          >
                            Stop
                          </button>
                        }
                      >
                        <button type="button" class="phone-button phone-button--danger" disabled={busy()} onClick={() => void stop(session)}>
                          Stop now
                        </button>
                      </Show>
                    </Show>
                    <LinkFor id={session.id} />
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <Show when={overnight()}>
        <h3>Done by Morning</h3>
        <Show when={jobs()?.jobs ? queueLine(jobs()!.jobs) : jobs()?.error}>{(line) => <p class="phone-meta">{line()}</p>}</Show>
        <Show when={(jobs()?.jobs?.jobs.length ?? 0) > 0} fallback={<Empty>No jobs yet. Queue one from Vector on your computer.</Empty>}>
          <div class="phone-stack">
            <For each={jobs()?.jobs?.jobs ?? []}>
              {(job) => (
                <div class="phone-card">
                  <div class="phone-row-text">
                    <strong>{job.title ?? job.prompt.split("\n")[0]}</strong>
                    <span class="phone-meta">
                      {jobStateLabel(job)} · {DELIVER_LABEL} {when(job.deliverBy)}
                    </span>
                    <Show when={jobReasonLine(job)}>{(line) => <span class="phone-meta">{line()}</span>}</Show>
                  </div>
                  <Show when={job.report}>
                    {(report) => (
                      <div class="phone-row-text">
                        <span>{report().summary}</span>
                        <span class="phone-meta">{verdictLine(report())}</span>
                        <ul class="phone-list">
                          <For each={report().results}>
                            {(result) => (
                              <li>
                                {result.pass ? "Met" : "Not met"}: {result.criterion}
                              </li>
                            )}
                          </For>
                        </ul>
                        <For each={report().links}>
                          {(item) => (
                            <a class="phone-link" href={item.url} target="_blank" rel="noopener noreferrer">
                              {item.title ?? item.url}
                            </a>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                  <div class="phone-actions">
                    <Show when={job.report?.pullRequest}>
                      <button type="button" class="phone-button" disabled={busy()} onClick={() => void approve(job)}>
                        Approve
                      </button>
                    </Show>
                    <Show when={job.state === "queued" || job.state === "running"}>
                      <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => void cancel(job)}>
                        Cancel
                      </button>
                    </Show>
                    <LinkFor id={job.id} />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </Panel>
  )
}
