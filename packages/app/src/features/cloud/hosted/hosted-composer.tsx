import { useDialog } from "@vectordevai/ui/context/dialog"
import { Dialog } from "@vectordevai/ui/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { usePlatform, type HostedPlatform } from "@/context/platform"
import { onCodiumChange } from "@/vector-account"
import { showToast } from "@/utils/toast"
import {
  accessLine,
  canStart,
  ceilingLine,
  COMPOSER_ACTION,
  computerShown,
  decodeApprove,
  decodeEstimate,
  decodeHostedStatus,
  decodeJobAnswer,
  decodeJobs,
  decodeSessionAnswer,
  defaultDeliverBy,
  DELIVER_LABEL,
  deliverByFromTime,
  handoffLine,
  HOSTED_LINE,
  hostedErrorText,
  hoursLine,
  isLive,
  jobReasonLine,
  jobStateLabel,
  minuteChoices,
  minutesLabel,
  overnightShown,
  queueLine,
  rampLine,
  sessionControls,
  sessionLine,
  SIZE_LABELS,
  stateLabel,
  takeoverLine,
  timeInputValue,
  verdictLine,
  type HostedJob,
  type HostedSession,
  type HostedStatus,
} from "./hosted-model"
import { cleanCriteria, cleanTitle, LIMITS, type HostedRequest, type HostedSize } from "./hosted-requests"
import "./hosted.css"

// The cloud computer in the desktop's composer (WP A56): the "Run on my cloud computer" button and its dialog with the
// pre-start ceiling from the estimate, the purple-edged bar above the composer that says "Vector is using its cloud
// computer" with Watch, Take over and Stop, and Done by Morning's jobs and reports. The main process holds the account
// token and asks vectordev.ai (platform.hosted); the live view opens in its own sandboxed window. Everything shows only
// when `computer` is listed and in the plan (H1); vectordev.ai decides every start, take-over and stop (S1).

type Answer = Awaited<ReturnType<HostedPlatform["request"]>>
type Result = { ok: true } | { ok: false; status?: number; code?: string; message: string }
const UNREACHABLE: Answer = { ok: false, message: "Vector could not reach the cloud computer. Try again shortly." }
// One reader for every composer in this window (the status route allows 600 reads an hour per account): every 15
// seconds while a session is live, every 60 seconds otherwise, and not while the window is hidden.
const LIVE_POLL_MS = 15_000
const IDLE_POLL_MS = 60_000

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const [sharedStatus, setSharedStatus] = createSignal<HostedStatus>()
const readers = new Set<() => Promise<Answer>>()
let polling: ReturnType<typeof setTimeout> | undefined
let reading: Promise<void> | undefined

/** Reads the status once with any composer's reader; concurrent asks share one request. */
function readShared() {
  const read = readers.values().next().value
  if (!read) return Promise.resolve()
  reading ??= read()
    .then((answer) => {
      if (answer.ok) setSharedStatus(decodeHostedStatus(answer.body))
    })
    .finally(() => (reading = undefined))
  return reading
}

function schedule() {
  if (polling !== undefined) clearTimeout(polling)
  polling = undefined
  if (readers.size === 0) return
  const live = (sharedStatus()?.sessions ?? []).some(isLive)
  polling = setTimeout(
    () => {
      const hidden = globalThis.document?.visibilityState === "hidden"
      void (hidden ? Promise.resolve() : readShared()).finally(schedule)
    },
    live ? LIVE_POLL_MS : IDLE_POLL_MS,
  )
}

/** The cloud computer for one composer: whether it shows, the window's shared status, and requests. */
export function useHostedComputer() {
  const platform = usePlatform()
  const [plan, { refetch: refetchPlan }] = createResource(
    () => Boolean(platform.hosted && platform.vectorAccount?.codium),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  onCleanup(onCodiumChange(() => void refetchPlan()))
  const shown = createMemo(() => Boolean(platform.hosted) && computerShown(plan.latest))
  const overnight = createMemo(() => shown() && overnightShown(plan.latest))

  const request = async (input: HostedRequest): Promise<Answer> =>
    platform.hosted ? platform.hosted.request(input).catch(() => UNREACHABLE) : UNREACHABLE

  const reader = () => request({ kind: "status" })
  const leave = () => {
    readers.delete(reader)
    if (readers.size === 0) {
      setSharedStatus(undefined)
      schedule()
    }
  }
  createEffect(
    on(shown, (visible) => {
      if (!visible) return leave()
      const first = readers.size === 0
      readers.add(reader)
      if (first) void readShared().finally(schedule)
    }),
  )
  onCleanup(leave)

  const status = () => (shown() ? sharedStatus() : undefined)
  const refresh = async () => {
    if (!shown()) return
    await readShared()
    schedule()
  }
  const live = createMemo(() => (status()?.sessions ?? []).filter(isLive))
  return { platform, shown, overnight, status, live, refresh, request }
}

export type HostedComputer = ReturnType<typeof useHostedComputer>

// ── The bar above the composer ─────────────────────────────────────────────────────────────────────────────────────

/** One purple-edged line per live session: who has the computer, why it needs the person, and what they can do. */
export function HostedBar(props: { computer: HostedComputer }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()
  const [notice, setNotice] = createSignal<{ id: string; text: string; error?: boolean }>()
  const hosted = () => props.computer.platform.hosted

  const act = async (session: HostedSession, label: string, run: () => Promise<Result>) => {
    if (busy()) return
    setBusy(session.id)
    setNotice(undefined)
    try {
      const answer: Result = await run().catch(() => UNREACHABLE)
      if (!answer.ok) setNotice({ id: session.id, text: hostedErrorText(answer), error: true })
      else if (label) setNotice({ id: session.id, text: label })
      await props.computer.refresh()
    } finally {
      setBusy(undefined)
      setConfirming(undefined)
    }
  }

  const watch = (session: HostedSession, mode: "view" | "control") =>
    act(session, "", () => hosted()!.liveView({ id: session.id, mode }))
  const takeover = (session: HostedSession) =>
    act(session, "You have control. Vector waits until you give it back.", async () => {
      const answer = await props.computer.request({ kind: "takeover", id: session.id })
      if (!answer.ok) return answer
      // Control links are issued only during a take-over, so the window opens once the server agreed.
      return hosted()!.liveView({ id: session.id, mode: "control" })
    })
  const release = (session: HostedSession) =>
    act(session, "Vector has the computer again.", () => props.computer.request({ kind: "release", id: session.id }))
  const stop = (session: HostedSession) =>
    act(session, "Vector is saving the computer's disk and stopping it.", () =>
      props.computer.request({ kind: "stop", id: session.id }),
    )
  const files = (session: HostedSession) =>
    act(session, "", async () => {
      const answer = await hosted()!.files({ id: session.id })
      if (answer.ok)
        setNotice({
          id: session.id,
          text:
            answer.ready === false
              ? "The computer is packing the files. Ask again in a minute."
              : "The download opened in your browser. Its link works for 24 hours.",
        })
      return answer.ok ? ({ ok: true } as const) : answer
    })

  return (
    <Show when={props.computer.shown() && props.computer.live().length > 0}>
      <div class="hosted-bar-stack">
        <For each={props.computer.live()}>
          {(session) => {
            const actions = () => sessionControls(session)
            return (
              <div
                class="hosted-bar"
                classList={{ "hosted-bar--needs-you": Boolean(session.handoff), "hosted-bar--control": session.state === "takeover" }}
                role="status"
                data-component="hosted-bar"
              >
                <div class="hosted-bar-text">
                  <strong>{sessionLine(session)}</strong>
                  <span class="hosted-bar-meta">
                    {session.title ?? `Cloud computer ${session.computer}`} · {stateLabel(session)}
                  </span>
                  <Show when={handoffLine(session.handoff)}>{(line) => <span class="hosted-bar-alert">{line()}</span>}</Show>
                  <Show when={takeoverLine(session)}>{(line) => <span class="hosted-bar-meta">{line()}</span>}</Show>
                  <Show when={notice()?.id === session.id ? notice() : undefined}>
                    {(shown) => (
                      <span classList={{ "hosted-bar-meta": !shown().error, "hosted-bar-error": Boolean(shown().error) }}>
                        {shown().text}
                      </span>
                    )}
                  </Show>
                </div>
                <div class="hosted-bar-actions">
                  <Show when={actions().watch}>
                    <ButtonV2 variant="ghost" disabled={busy() === session.id} onClick={() => void watch(session, "view")}>
                      Watch
                    </ButtonV2>
                  </Show>
                  <Show when={actions().takeover}>
                    <ButtonV2 variant="contrast" disabled={busy() === session.id} onClick={() => void takeover(session)}>
                      Take over
                    </ButtonV2>
                  </Show>
                  <Show when={actions().control}>
                    <ButtonV2 variant="ghost" disabled={busy() === session.id} onClick={() => void watch(session, "control")}>
                      Open control
                    </ButtonV2>
                  </Show>
                  <Show when={actions().release}>
                    <ButtonV2 variant="contrast" disabled={busy() === session.id} onClick={() => void release(session)}>
                      Give back
                    </ButtonV2>
                  </Show>
                  <Show when={actions().files}>
                    <ButtonV2 variant="ghost" disabled={busy() === session.id} onClick={() => void files(session)}>
                      Files
                    </ButtonV2>
                  </Show>
                  <Show when={actions().stop}>
                    <Show
                      when={confirming() === session.id}
                      fallback={
                        <ButtonV2 variant="ghost" disabled={busy() === session.id} onClick={() => setConfirming(session.id)}>
                          Stop
                        </ButtonV2>
                      }
                    >
                      <ButtonV2 variant="danger" disabled={busy() === session.id} onClick={() => void stop(session)}>
                        Stop now
                      </ButtonV2>
                    </Show>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
        <Show when={props.computer.overnight()}>
          <div class="hosted-bar-jobs">
            <button
              type="button"
              class="hosted-bar-link"
              onClick={() => dialog.show(() => <DialogHostedJobs computer={props.computer} />)}
            >
              Done by Morning: jobs and reports
            </button>
          </div>
        </Show>
      </div>
    </Show>
  )
}

// ── "Run on my cloud computer" ─────────────────────────────────────────────────────────────────────────────────────

/** The composer's button: shown only when the cloud computer is listed and in the plan. */
export function HostedRunButton(props: { computer: HostedComputer; prompt: () => string; class?: string }) {
  const dialog = useDialog()
  return (
    <Show when={props.computer.shown()}>
      <button
        data-action="prompt-hosted"
        type="button"
        class={`hosted-run-button ${props.class ?? ""}`}
        title={COMPOSER_ACTION}
        aria-label={COMPOSER_ACTION}
        onClick={() =>
          dialog.show(() => <DialogRunOnCloudComputer computer={props.computer} prompt={props.prompt()} />)
        }
      >
        <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
          <path
            d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h8.5a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 12.25 11h-8.5A1.25 1.25 0 0 1 2.5 9.75v-5.5ZM6 13.5h4M8 11v2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </Show>
  )
}

type Mode = "now" | "morning"

/** The start dialog: the job, its size and length, the pre-start ceiling, then Start (or queue it for the morning). */
export function DialogRunOnCloudComputer(props: { computer: HostedComputer; prompt: string }) {
  const dialog = useDialog()
  const status = () => props.computer.status()
  const plan = () => status()?.plan
  const [mode, setMode] = createSignal<Mode>("now")
  const [prompt, setPrompt] = createSignal(props.prompt.slice(0, LIMITS.prompt))
  const [size, setSize] = createSignal<HostedSize>("standard")
  const [minutes, setMinutes] = createSignal(60)
  const [criteria, setCriteria] = createSignal("")
  const [deliverAt, setDeliverAt] = createSignal(timeInputValue(defaultDeliverBy(Date.now())))
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  // Keep the choices inside what the plan allows.
  createEffect(() => {
    const current = plan()
    if (!current) return
    if (!current.sizes.includes(size())) setSize(current.sizes[0]!)
    const choices = minuteChoices(current.jobMinutes)
    if (choices.length > 0 && !choices.includes(minutes())) setMinutes(choices.includes(60) ? 60 : choices[0]!)
  })

  const [estimate] = createResource(
    () => (props.computer.shown() && plan() ? { size: size(), minutes: minutes() } : undefined),
    async (input) => {
      const answer = await props.computer.request({ kind: "estimate", ...input })
      return answer.ok ? { band: decodeEstimate(answer.body) } : { error: hostedErrorText(answer) }
    },
  )

  const title = () => cleanTitle(prompt().split("\n")[0]?.slice(0, LIMITS.title))
  const deliverBy = () => deliverByFromTime(deliverAt(), Date.now())

  const start = async () => {
    if (busy()) return
    setProblem(undefined)
    const text = prompt().trim()
    if (!text) return setProblem("Say what the computer should do.")
    setBusy(true)
    try {
      if (mode() === "now") {
        const answer = await props.computer.request({
          kind: "start",
          size: size(),
          jobMinutes: minutes(),
          prompt: text.slice(0, LIMITS.prompt),
          ...(title() ? { title: title() } : {}),
        })
        if (!answer.ok) return setProblem(hostedErrorText(answer))
        if (!decodeSessionAnswer(answer.body)) return setProblem("Vector could not read the cloud computer's answer.")
        showToast({ title: "Vector is starting its cloud computer", description: "Watch it or take over from the bar above the composer." })
      } else {
        const list = cleanCriteria(criteria())
        if (!list) return setProblem("Write one to ten success criteria, one per line, each under 300 characters.")
        const at = deliverBy()
        if (!at) return setProblem("Choose a time within the next day, at least half an hour away.")
        const answer = await props.computer.request({
          kind: "queue",
          prompt: text.slice(0, LIMITS.jobPrompt),
          criteria: list,
          deliverBy: at,
          size: size(),
          jobMinutes: minutes(),
          ...(title() ? { title: title() } : {}),
        })
        if (!answer.ok) return setProblem(hostedErrorText(answer))
        showToast({ title: "Queued for the morning", description: `${DELIVER_LABEL} ${when(at)}.` })
      }
      await props.computer.refresh()
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={COMPOSER_ACTION} description={HOSTED_LINE} class="hosted-dialog">
      <div class="hosted-form" data-component="hosted-start">
        <Show when={props.computer.overnight()}>
          <div class="hosted-tabs" role="tablist" aria-label="When">
            <button type="button" role="tab" class="hosted-tab" aria-selected={mode() === "now"} onClick={() => setMode("now")}>
              Start now
            </button>
            <button
              type="button"
              role="tab"
              class="hosted-tab"
              aria-selected={mode() === "morning"}
              onClick={() => setMode("morning")}
            >
              Done by Morning
            </button>
          </div>
        </Show>
        <label class="hosted-field">
          <span>What should Vector do?</span>
          <textarea
            rows={5}
            value={prompt()}
            maxLength={mode() === "now" ? LIMITS.prompt : LIMITS.jobPrompt}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>
        <Show when={mode() === "morning"}>
          <label class="hosted-field">
            <span>Success criteria, one per line (the report says whether each one was met)</span>
            <textarea rows={3} value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} />
          </label>
          <label class="hosted-field hosted-field--inline">
            <span>{DELIVER_LABEL}</span>
            <input type="time" value={deliverAt()} onInput={(event) => setDeliverAt(event.currentTarget.value)} />
          </label>
          <button
            type="button"
            class="hosted-bar-link"
            onClick={() => dialog.show(() => <DialogHostedJobs computer={props.computer} />)}
          >
            Queued jobs and reports
          </button>
        </Show>
        <div class="hosted-row">
          <label class="hosted-field hosted-field--inline">
            <span>Size</span>
            <select value={size()} onChange={(event) => setSize(event.currentTarget.value as HostedSize)}>
              <For each={plan()?.sizes ?? (["standard"] as HostedSize[])}>{(item) => <option value={item}>{SIZE_LABELS[item]}</option>}</For>
            </select>
          </label>
          <label class="hosted-field hosted-field--inline">
            <span>Longest job</span>
            <select value={String(minutes())} onChange={(event) => setMinutes(Number(event.currentTarget.value))}>
              <For each={minuteChoices(plan()?.jobMinutes)}>
                {(item) => <option value={String(item)}>{minutesLabel(item)}</option>}
              </For>
            </select>
          </label>
        </div>
        <p class="hosted-ceiling" role="status">
          <Show when={!estimate.loading} fallback="Working out the most this job can use of your month…">
            {estimate()?.band ? ceilingLine(estimate()!.band) : estimate()?.error}
          </Show>
        </p>
        <For each={[accessLine(status()), rampLine(plan()), hoursLine(status())].filter(Boolean)}>
          {(line) => <p class="hosted-muted">{line}</p>}
        </For>
        <Show when={problem()}>{(text) => <p class="hosted-error">{text()}</p>}</Show>
        <div class="hosted-actions">
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            Cancel
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            disabled={busy() || !canStart(status()) || !prompt().trim() || estimate()?.band?.share === "more than your month"}
            onClick={() => void start()}
          >
            {mode() === "now" ? "Start" : "Queue it"}
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}

// ── Done by Morning ────────────────────────────────────────────────────────────────────────────────────────────────

/** The queue and its reports: the pass or fail Vector reports per criterion, the recording, and Approve. */
export function DialogHostedJobs(props: { computer: HostedComputer }) {
  const platform = props.computer.platform
  const [jobs, { refetch }] = createResource(async () => {
    const answer = await props.computer.request({ kind: "jobs" })
    return answer.ok ? { jobs: decodeJobs(answer.body) } : { error: hostedErrorText(answer) }
  })
  const [busy, setBusy] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [recordings, setRecordings] = createSignal<Record<string, { n: number; url: string }[]>>({})

  const act = async (job: HostedJob, run: () => Promise<string | undefined>) => {
    if (busy()) return
    setBusy(job.id)
    setProblem(undefined)
    try {
      const failure = await run().catch(() => hostedErrorText(undefined))
      if (failure) setProblem(failure)
    } finally {
      setBusy(undefined)
    }
  }
  const approve = (job: HostedJob) =>
    act(job, async () => {
      const answer = await props.computer.request({ kind: "approve-job", id: job.id })
      if (!answer.ok) return hostedErrorText(answer)
      const approved = decodeApprove(answer.body)
      if (!approved) return "Vector could not read the pull request's address."
      const opened = await platform.hosted!.open({ kind: "pull-request", url: approved.url })
      void refetch()
      return opened.ok ? undefined : opened.message
    })
  const cancel = (job: HostedJob) =>
    act(job, async () => {
      const answer = await props.computer.request({ kind: "cancel-job", id: job.id })
      void refetch()
      return answer.ok ? undefined : hostedErrorText(answer)
    })
  const recording = (job: HostedJob) =>
    act(job, async () => {
      const answer = await props.computer.request({ kind: "job", id: job.id })
      if (!answer.ok) return hostedErrorText(answer)
      const segments = decodeJobAnswer(answer.body)?.segments ?? []
      setRecordings((current) => ({ ...current, [job.id]: segments }))
      return segments.length === 0 ? "This job's recording is not available." : undefined
    })

  return (
    <Dialog title="Done by Morning" description="Jobs your cloud computer runs while you are away, and their reports." class="hosted-dialog">
      <div class="hosted-form" data-component="hosted-jobs">
        <Show when={jobs()?.jobs ? queueLine(jobs()!.jobs) : jobs()?.error}>{(line) => <p class="hosted-muted">{line()}</p>}</Show>
        <Show when={problem()}>{(text) => <p class="hosted-error">{text()}</p>}</Show>
        <Show when={!jobs.loading} fallback={<p class="hosted-muted">Loading…</p>}>
          <Show when={(jobs()?.jobs?.jobs.length ?? 0) > 0} fallback={<p class="hosted-muted">No jobs yet.</p>}>
            <ul class="hosted-jobs">
              <For each={jobs()?.jobs?.jobs ?? []}>
                {(job) => (
                  <li class="hosted-job">
                    <div class="hosted-job-head">
                      <strong>{job.title ?? job.prompt.split("\n")[0]}</strong>
                      <span class="hosted-muted">{jobStateLabel(job)}</span>
                    </div>
                    <p class="hosted-muted">
                      {DELIVER_LABEL} {when(job.deliverBy)}
                      {jobReasonLine(job) ? ` · ${jobReasonLine(job)}` : ""}
                    </p>
                    <Show when={job.report}>
                      {(report) => (
                        <div class="hosted-report">
                          <p>{report().summary}</p>
                          <p class="hosted-muted">{verdictLine(report())}</p>
                          <ul class="hosted-results">
                            <For each={report().results}>
                              {(result) => (
                                <li classList={{ "hosted-pass": result.pass, "hosted-fail": !result.pass }}>
                                  {result.pass ? "Met" : "Not met"}: {result.criterion}
                                  {result.note ? ` (${result.note})` : ""}
                                </li>
                              )}
                            </For>
                          </ul>
                          <For each={report().links}>
                            {(link) => (
                              <button type="button" class="hosted-bar-link" onClick={() => platform.openLink(link.url)}>
                                {link.title ?? link.url}
                              </button>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                    <div class="hosted-actions hosted-actions--start">
                      <Show when={job.report?.pullRequest}>
                        <ButtonV2 variant="contrast" disabled={busy() === job.id} onClick={() => void approve(job)}>
                          {job.approvedAt ? "Open the pull request" : "Approve: open the pull request"}
                        </ButtonV2>
                      </Show>
                      <Show when={job.recording && job.recording.until > Date.now()}>
                        <ButtonV2 variant="ghost" disabled={busy() === job.id} onClick={() => void recording(job)}>
                          Recording
                        </ButtonV2>
                      </Show>
                      <Show when={job.state === "queued" || job.state === "running"}>
                        <ButtonV2 variant="ghost" disabled={busy() === job.id} onClick={() => void cancel(job)}>
                          Cancel
                        </ButtonV2>
                      </Show>
                    </div>
                    <Show when={(recordings()[job.id] ?? []).length > 0}>
                      <div class="hosted-actions hosted-actions--start">
                        <For each={recordings()[job.id]}>
                          {(segment) => (
                            <button
                              type="button"
                              class="hosted-bar-link"
                              onClick={() => void platform.hosted!.open({ kind: "recording", url: segment.url })}
                            >
                              Minute {segment.n}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
