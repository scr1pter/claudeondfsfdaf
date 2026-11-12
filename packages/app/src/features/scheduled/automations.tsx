import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { cronFor } from "@vectordevai/core/review/schedule"
import { ACTIONS_COPY, agentsApi, agentsView } from "@/features/github-agents/agents-model"
import { useAgentsStatus } from "@/features/github-agents/use-status"
import {
  automationTargetResults,
  buildAutomationInput,
  describeAutomationNextRun,
  describeAutomationTargets,
  describeMissedRuns,
  describeRecurrence,
  sortAutomations,
  supportsGithubSchedule,
  SUGGESTIONS,
  type AutomationInput,
  type AutomationRecord,
  type Recurrence,
  type Suggestion,
} from "./schedule-model"

// A repository an automation can run in.
export type AutomationRepository = { directory: string; name: string }

// A session an automation can continue instead of opening a new one.
// `directory` is where the session actually lives — a session in a sandbox is
// not addressable from the repository worktree — while `repository` is the
// worktree it is listed under.
export type AutomationSession = { id: string; title: string; directory: string; repository: string }

// The desktop scheduler, as the renderer sees it over IPC. Structurally the
// preload's AgentTeamsAPI-style `scheduledAgents` bridge; on the web build the
// whole object is absent, which is how every surface here knows to explain
// itself instead of rendering controls that cannot work.
export type AutomationsApi = {
  list: (scope?: { directory?: string; parentSessionId?: string }) => Promise<AutomationRecord[]>
  create: (input: {
    title?: string
    prompt: string
    model?: { providerID: string; id: string; variant?: string }
    recurrence?: Recurrence
    directory?: string
    targets?: { directory: string; sessionId?: string }[]
    parentSessionId?: string
    runAt: string
  }) => Promise<AutomationRecord>
  cancel: (id: string) => Promise<AutomationRecord | undefined>
  // Older desktop builds shipped only `cancel`, so callers must fall back
  // rather than let pause silently do nothing.
  setPaused?: (id: string, paused: boolean) => Promise<AutomationRecord | undefined>
  remove: (id: string) => Promise<AutomationRecord[]>
}

export function automationsApi() {
  return (globalThis.window?.api as (Record<string, unknown> & { scheduledAgents?: AutomationsApi }) | undefined)
    ?.scheduledAgents
}

const REPEATS = [
  { kind: "once", label: "Once" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
] as const

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const FIELD =
  "w-full rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none placeholder:text-white/35 focus:border-[color:var(--vx-purple)]"
const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.09em] text-white/40"

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. toISOString() would
// shift by the timezone offset and schedule the run at the wrong hour.
function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function Automations(props: {
  open: boolean
  supported: boolean
  repositories: AutomationRepository[]
  sessions: AutomationSession[]
  records: AutomationRecord[]
  loadError?: string
  // Preselected in the form, so opening this from a focused repository does not
  // make the user find it again.
  focusedRepository?: string
  onClose: () => void
  onCreate: (input: AutomationInput) => Promise<boolean>
  onTogglePause: (id: string, paused: boolean) => void
  onDelete: (id: string) => void
}) {
  const [composing, setComposing] = createSignal(false)
  const [seed, setSeed] = createSignal<Suggestion | undefined>(undefined)
  // Bumped on every compose(). The form reads the seed once, to fill its
  // fields, so without a fresh key a suggestion picked while the form is
  // already open would leave the previous one sitting in the fields — a live
  // button that does nothing.
  const [composeKey, setComposeKey] = createSignal(0)
  // Ticked while the panel is open: a countdown frozen at the moment the panel
  // first mounted would quietly lie about when the next run lands.
  const [now, setNow] = createSignal(new Date())
  createEffect(() => {
    if (!props.open) return
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  const visible = createMemo(() => sortAutomations(props.records))
  const repositoryName = (directory: string) =>
    props.repositories.find((repository) => repository.directory === directory)?.name ??
    props.sessions.find((session) => session.directory === directory)?.repository ??
    directory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ??
    directory

  const compose = (suggestion?: Suggestion) => {
    setSeed(suggestion)
    setComposeKey((key) => key + 1)
    setComposing(true)
  }

  return (
    <Show when={props.open}>
      {/* Portalled: home renders inside the rounded, clipped workspace card, and
          a fixed overlay left in that subtree would be trapped by it. */}
      <Portal>
        <div
          data-vector-automations
          role="dialog"
          aria-modal="true"
          aria-label="Automations"
          class="fixed inset-0 z-[90] overflow-y-auto bg-[color:var(--vx-canvas)]"
        >
          <header class="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)]/95 px-6 backdrop-blur">
            <span class="text-[13.5px] font-semibold text-white">Automations</span>
            <span class="text-[12.5px] text-white/40">
              {props.records.length === 1 ? "1 scheduled" : `${props.records.length} scheduled`}
            </span>
            <div class="flex-1" />
            <button
              type="button"
              aria-label="Close automations"
              class="grid size-8 place-items-center rounded-[8px] text-white/45 transition hover:bg-white/[0.06] hover:text-white"
              onClick={props.onClose}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path
                  d="m4 4 8 8m0-8-8 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <div class="mx-auto w-full max-w-[840px] px-6 pb-24 pt-10">
            <h1 class="text-[32px] font-semibold leading-[1.15] tracking-[-0.02em] text-white">
              Work Vector repeats without you
            </h1>
            <p class="mt-3 max-w-[640px] text-[15px] leading-[1.6] text-white/60">
              An automation is one task Vector runs again and again on a schedule. Write the task, pick the repositories
              it runs in — and in each one whether it starts a new session or continues one you already have — then
              choose how often it repeats.
            </p>

            <Show when={props.loadError}>
              <p
                class="mt-4 rounded-[8px] border border-rose-400/35 bg-rose-400/[0.07] px-3 py-2 text-[12.5px] text-rose-100"
                role="alert"
              >
                {props.loadError}
              </p>
            </Show>

            <ul class="mt-8 grid gap-2.5 sm:grid-cols-3">
              <For
                each={[
                  {
                    title: "Across repositories",
                    body: "One task, one schedule, every repository you select. Each run reports back separately.",
                  },
                  {
                    title: "New or existing sessions",
                    body: "Keep adding to a thread you already started, or open a fresh session for every run.",
                  },
                  {
                    title: "While you are away",
                    body: "Vector stays in the tray after you close the window, so runs fire without you here.",
                  },
                ]}
              >
                {(point) => (
                  <li class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.022] px-3.5 py-3">
                    <span class="block text-[12.5px] font-medium text-white">{point.title}</span>
                    <span class="mt-1.5 block text-[12.5px] leading-[1.55] text-white/50">{point.body}</span>
                  </li>
                )}
              </For>
            </ul>

            <p class="mt-3 text-[12.5px] leading-[1.55] text-white/40">
              Runs that fall due while Vector is fully closed are not replayed one by one — the next start catches up
              with a single run and says how many it skipped.
            </p>

            <Show
              when={props.supported}
              fallback={
                <p class="mt-10 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.022] px-4 py-3.5 text-[13px] leading-[1.6] text-white/60">
                  Automations run from the Vector desktop app, which keeps a scheduler alive in the tray. This surface
                  activates once Vector connects to this workspace.
                </p>
              }
            >
              <Show when={!composing()}>
                <div class="mt-10">
                  <button
                    type="button"
                    class="rounded-[9px] bg-[color:var(--vx-purple)] px-4 py-2 text-[13px] font-medium text-white transition hover:brightness-110"
                    onClick={() => compose(undefined)}
                  >
                    New automation
                  </button>
                </div>
              </Show>

              <Show when={composing()}>
                {/* Keyed on the compose nonce so picking a second suggestion
                    rebuilds the form against the new seed instead of leaving
                    the first one's text in the fields. */}
                <Show when={composeKey()} keyed>
                  <AutomationForm
                    seed={seed()}
                    repositories={props.repositories}
                    sessions={props.sessions}
                    focusedRepository={props.focusedRepository}
                    onCancel={() => setComposing(false)}
                    onCreate={async (input) => {
                      const created = await props.onCreate(input)
                      if (created) setComposing(false)
                      return created
                    }}
                  />
                </Show>
              </Show>

              <div class="mt-10">
                <h2 class="text-[11px] font-semibold uppercase tracking-[0.09em] text-white/40">Your automations</h2>
                <Show
                  when={visible().length}
                  fallback={
                    <p class="mt-3 rounded-[10px] border border-dashed border-[color:var(--vx-line)] px-4 py-6 text-center text-[13px] text-white/40">
                      Nothing scheduled yet. Create one above, or start from a suggestion below.
                    </p>
                  }
                >
                  <div class="mt-3 flex flex-col gap-2">
                    <For each={visible()}>
                      {(record) => (
                        <AutomationRow
                          record={record}
                          now={now()}
                          repositoryName={repositoryName}
                          onTogglePause={props.onTogglePause}
                          onDelete={props.onDelete}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="mt-10 border-t border-[color:var(--vx-line)] pt-8">
                <h2 class="mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-white/40">
                  Start from a suggestion
                </h2>
                <For each={SUGGESTIONS}>
                  {(suggestion) => (
                    <button
                      type="button"
                      class="flex w-full items-start gap-3 rounded-[9px] border border-transparent px-3 py-3 text-left transition hover:border-[color:var(--vx-line)] hover:bg-white/[0.03]"
                      onClick={() => compose(suggestion)}
                    >
                      <span class="mt-0.5 grid size-4 shrink-0 place-items-center text-[color:var(--vx-purple-bright)]">
                        <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                          <path
                            d="M8 3.4v4.7l3 1.8"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.15"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                          <circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.15" />
                        </svg>
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex flex-wrap items-baseline gap-2">
                          <span class="text-[13px] font-medium text-white">{suggestion.title}</span>
                          <span class="text-[12.5px] text-white/40">{suggestion.schedule}</span>
                        </span>
                        <span class="mt-1 block text-[12.5px] leading-[1.55] text-white/50">
                          {suggestion.description}
                        </span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

function AutomationRow(props: {
  record: AutomationRecord
  now: Date
  repositoryName: (directory: string) => string
  onTogglePause: (id: string, paused: boolean) => void
  onDelete: (id: string) => void
}) {
  const targets = createMemo(() => automationTargetResults(props.record))
  const caughtUp = createMemo(() => describeMissedRuns(props.record.missedRuns))

  return (
    <div class="group rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.018] px-3 py-3 transition hover:bg-white/[0.03]">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="text-[14.5px] font-medium text-white">{props.record.title ?? "Automation"}</span>
            <Show when={props.record.paused}>
              <span class="rounded-full bg-white/[0.07] px-1.5 py-px text-[9.5px] uppercase tracking-wide text-white/45">
                paused
              </span>
            </Show>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-white/40">
            <span>{props.record.recurrence ? describeRecurrence(props.record.recurrence) : "Runs once"}</span>
            <span aria-hidden="true">·</span>
            <span>{describeAutomationNextRun(props.record, props.now)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {describeAutomationTargets(
                targets().map((entry) => entry.target),
                props.repositoryName,
              )}
            </span>
          </div>
        </div>
        <div class="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            class="rounded-[6px] px-2 py-1 text-[12px] text-white/55 transition hover:text-white"
            onClick={() => props.onTogglePause(props.record.id, !props.record.paused)}
          >
            {props.record.paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            class="rounded-[6px] px-2 py-1 text-[12px] text-white/45 transition hover:text-rose-300"
            onClick={() => props.onDelete(props.record.id)}
          >
            Delete
          </button>
        </div>
      </div>

      <p class="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-white/40">{props.record.prompt}</p>

      <Show when={caughtUp()}>
        {(explanation) => (
          <p class="mt-2 rounded-[8px] border border-amber-300/25 bg-amber-300/[0.06] px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-100/80">
            {explanation()}
          </p>
        )}
      </Show>

      <ul class="mt-2 flex flex-col gap-1">
        <For each={targets()}>
          {(entry) => (
            <li class="flex flex-wrap items-baseline gap-x-2 text-[12px] text-white/40">
              <span class="text-white/60">{props.repositoryName(entry.target.directory)}</span>
              <span>{entry.target.sessionId ? "existing session" : "new session each run"}</span>
              <span aria-hidden="true">·</span>
              <span
                classList={{
                  "text-emerald-200/80": entry.result?.status === "completed",
                  "text-rose-200/80": entry.result?.status === "failed",
                  "text-[color:var(--vx-purple-bright)]": entry.result?.status === "running",
                }}
              >
                {entry.result?.status === "failed"
                  ? (entry.result.error ?? "Failed")
                  : (entry.result?.status ?? "not run yet")}
              </span>
              <Show when={entry.result?.completedAt}>
                {(completedAt) => <span>{new Date(completedAt()).toLocaleString()}</span>}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

function AutomationForm(props: {
  seed?: Suggestion
  repositories: AutomationRepository[]
  sessions: AutomationSession[]
  focusedRepository?: string
  onCancel: () => void
  onCreate: (input: AutomationInput) => Promise<boolean>
}) {
  const [title, setTitle] = createSignal(props.seed?.title ?? "")
  const [prompt, setPrompt] = createSignal(props.seed?.prompt ?? "")
  const seeded = props.seed?.recurrence
  const [kind, setKind] = createSignal<Recurrence["kind"]>(seeded?.kind ?? "daily")
  const [at, setAt] = createSignal(
    seeded?.kind === "once"
      ? localDateTimeValue(new Date(seeded.at))
      : localDateTimeValue(new Date(Date.now() + 3_600_000)),
  )
  const [time, setTime] = createSignal(seeded && seeded.kind !== "once" ? seeded.time : "09:00")
  const [weekday, setWeekday] = createSignal(seeded?.kind === "weekly" ? seeded.weekday : 1)
  // Keyed by repository worktree. The value carries the directory the run
  // happens in, which differs from the worktree when the picked session lives
  // in a sandbox. A missing key means the repository is not selected.
  const [selection, setSelection] = createSignal<Record<string, { directory: string; sessionId: string }>>(
    props.focusedRepository ? { [props.focusedRepository]: { directory: props.focusedRepository, sessionId: "" } } : {},
  )
  const [submitting, setSubmitting] = createSignal(false)
  const [github, setGithub] = createStore<{ enabled: boolean; error?: string; url?: string }>({ enabled: false })

  const drafts = createMemo(() =>
    props.repositories.map((repository) => ({
      directory: selection()[repository.directory]?.directory ?? repository.directory,
      enabled: repository.directory in selection(),
      sessionId: selection()[repository.directory]?.sessionId ?? "",
    })),
  )
  const built = createMemo(() =>
    buildAutomationInput(
      { title: title(), prompt: prompt(), targets: drafts(), kind: kind(), at: at(), time: time(), weekday: weekday() },
      new Date(),
    ),
  )
  const directory = createMemo(() => {
    const selected = drafts().filter((target) => target.enabled)
    return supportsGithubSchedule(kind(), selected) ? selected[0].directory : undefined
  })
  const remote = useAgentsStatus(directory)
  const githubAvailable = createMemo(() => {
    const status = remote.state.status
    return (
      !!directory() &&
      !!status &&
      agentsView(status).kind === "ready" &&
      status.canDispatch &&
      agentsView(status).scheduled
    )
  })
  const cron = createMemo(() => {
    const result = built()
    return result.ok ? cronFor(result.input.recurrence, Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined
  })
  createEffect(() => {
    directory()
    kind()
    githubAvailable()
    setGithub({ enabled: false, error: undefined, url: undefined })
  })

  const toggle = (repository: string) => {
    const next = { ...selection() }
    if (repository in next) delete next[repository]
    else next[repository] = { directory: repository, sessionId: "" }
    setSelection(next)
  }

  const pickSession = (repository: string, sessionId: string) => {
    const session = props.sessions.find((item) => item.id === sessionId)
    setSelection({
      ...selection(),
      [repository]: { directory: session?.directory ?? repository, sessionId: session ? session.id : "" },
    })
  }

  // Either the reason the form cannot be submitted, or what it will actually do
  // — the same sentence answers "why is this disabled" and "what am I creating".
  const summary = createMemo(() => {
    const result = built()
    if (!result.ok) return result.error
    return `${describeRecurrence(result.input.recurrence)} · first run ${new Date(result.input.runAt).toLocaleString()}`
  })

  const submit = async (event: Event) => {
    event.preventDefault()
    const result = built()
    if (!result.ok || submitting()) return
    if (github.enabled) {
      const api = agentsApi()
      const cwd = directory()
      const schedule = cron()
      const status = remote.state.status
      if (!api || !cwd || !schedule || !status || !githubAvailable()) return
      const existing = status.options?.schedules ?? []
      if (existing.length >= 20 || existing.some((entry) => entry.cron === schedule.cron)) {
        setGithub(
          "error",
          "This workflow already has this UTC schedule or has reached its schedule limit. Review its existing schedules in Settings > GitHub.",
        )
        return
      }
      setSubmitting(true)
      setGithub({ error: undefined, url: undefined })
      await api
        .schedules({
          cwd,
          schedules: [
            ...existing,
            { id: `automation-${crypto.randomUUID()}`, cron: schedule.cron, prompt: result.input.prompt },
          ],
        })
        .then((value) => {
          if (cwd === directory()) setGithub("url", value.url)
        })
        .catch(() => {
          if (cwd === directory())
            setGithub("error", "Could not open the schedule update pull request. Check GitHub before trying again.")
        })
      setSubmitting(false)
      return
    }
    setSubmitting(true)
    await props.onCreate(result.input)
    setSubmitting(false)
  }

  return (
    <form class="mt-10 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] p-5" onSubmit={submit}>
      <label class={LABEL} for="automation-prompt">
        What should Vector do, every time?
      </label>
      <textarea
        id="automation-prompt"
        rows={3}
        value={prompt()}
        placeholder="Summarise what changed since yesterday and open issues for anything broken"
        class={`mt-2 resize-y ${FIELD}`}
        onInput={(event) => setPrompt(event.currentTarget.value)}
      />

      <label class={`mt-5 ${LABEL}`} for="automation-title">
        Name <span class="normal-case text-white/30">(optional)</span>
      </label>
      <input
        id="automation-title"
        value={title()}
        placeholder="Morning repo brief"
        class={`mt-2 ${FIELD}`}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />

      <div class="mt-5">
        <span class={LABEL}>Where it runs</span>
        <Show
          when={props.repositories.length}
          fallback={
            <p class="mt-1.5 text-[12.5px] text-white/40">
              Open a repository on this device first — an automation needs somewhere to run.
            </p>
          }
        >
          <div class="mt-1.5 flex flex-col gap-1">
            <For each={props.repositories}>
              {(repository) => {
                const sessions = createMemo(() =>
                  props.sessions.filter((session) => session.repository === repository.directory),
                )
                const chosen = () => selection()[repository.directory]
                return (
                  <div class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.02] px-3 py-2">
                    <label class="flex items-center gap-2.5 text-[13.5px] text-white">
                      <input
                        type="checkbox"
                        checked={Boolean(chosen())}
                        class="size-3.5 accent-[color:var(--vx-purple)]"
                        onChange={() => toggle(repository.directory)}
                      />
                      <span class="min-w-0 flex-1 truncate">{repository.name}</span>
                      <span class="shrink-0 text-[11.5px] text-white/30">
                        {sessions().length === 1 ? "1 session" : `${sessions().length} sessions`}
                      </span>
                    </label>
                    <Show when={chosen()}>
                      <select
                        aria-label={`Session for ${repository.name}`}
                        value={chosen()?.sessionId ?? ""}
                        class={`mt-2 ${FIELD}`}
                        onChange={(event) => pickSession(repository.directory, event.currentTarget.value)}
                      >
                        <option value="">Start a new session each run</option>
                        <For each={sessions()}>
                          {(session) => <option value={session.id}>Continue: {session.title}</option>}
                        </For>
                      </select>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="mt-5 flex flex-wrap gap-3">
        <div class="min-w-[150px] flex-1">
          <label class={LABEL} for="automation-repeat">
            Repeat
          </label>
          <select
            id="automation-repeat"
            value={kind()}
            class={`mt-2 ${FIELD}`}
            onChange={(event) => setKind(event.currentTarget.value as Recurrence["kind"])}
          >
            <For each={REPEATS}>{(item) => <option value={item.kind}>{item.label}</option>}</For>
          </select>
        </div>

        <Show when={kind() === "weekly"}>
          <div class="min-w-[150px] flex-1">
            <label class={LABEL} for="automation-weekday">
              Day
            </label>
            <select
              id="automation-weekday"
              value={String(weekday())}
              class={`mt-2 ${FIELD}`}
              onChange={(event) => setWeekday(Number(event.currentTarget.value))}
            >
              <For each={WEEKDAYS}>{(name, index) => <option value={String(index())}>{name}</option>}</For>
            </select>
          </div>
        </Show>

        <div class="min-w-[170px] flex-1">
          <label class={LABEL} for="automation-when">
            {kind() === "once" ? "When" : "Time"}
          </label>
          <Show
            when={kind() === "once"}
            fallback={
              <input
                id="automation-when"
                type="time"
                value={time()}
                class={`mt-2 ${FIELD}`}
                onInput={(event) => setTime(event.currentTarget.value)}
              />
            }
          >
            <input
              id="automation-when"
              type="datetime-local"
              value={at()}
              class={`mt-2 ${FIELD}`}
              onInput={(event) => setAt(event.currentTarget.value)}
            />
          </Show>
        </div>
      </div>

      <Show when={githubAvailable()}>
        <div class="mt-5 space-y-2 text-[12.5px] text-white/65">
          <label class="flex items-start gap-2">
            <input
              type="checkbox"
              checked={github.enabled}
              disabled={submitting()}
              onChange={(event) =>
                setGithub({ enabled: event.currentTarget.checked, error: undefined, url: undefined })
              }
            />
            <span>
              Run in GitHub Actions when this computer is off<span class="block text-white/40">{ACTIONS_COPY}</span>
            </span>
          </label>
          <Show when={github.enabled}>
            <p>
              This opens a workflow update pull request. Merge it to enable the schedule; no local automation is
              created.
            </p>
            <Show when={cron()}>
              {(schedule) => (
                <p>
                  <code>{schedule().cron}</code> (UTC). {schedule().note}
                </p>
              )}
            </Show>
            <p>
              GitHub schedules are best effort. In public repositories, GitHub disables schedules after 60 days without
              activity.
            </p>
            <Show when={remote.state.status?.publicRepository}>
              <p>This repository is public: its Actions logs are public.</p>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={github.error}>
        <p class="mt-3 text-rose-200" role="alert">
          {github.error}
        </p>
      </Show>
      <Show when={github.url}>
        <p class="mt-3 text-emerald-200" role="status">
          <a class="underline" href={github.url} target="_blank" rel="noopener noreferrer">
            Open schedule update pull request
          </a>
          . Merge it on the default branch to apply the schedule.
        </p>
      </Show>
      <div class="mt-4 flex items-center justify-between gap-3">
        <span class="text-[12.5px] text-white/40">{summary()}</span>
        <div class="flex shrink-0 gap-2">
          <button
            type="button"
            class="rounded-full px-3.5 py-1.5 text-[13px] text-white/55 transition hover:text-white"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              !built().ok || submitting() || (github.enabled && (!cron() || !githubAvailable() || !!github.url))
            }
            class="rounded-full bg-white/[0.12] px-4 py-1.5 text-[13px] font-medium text-white transition enabled:hover:bg-white/[0.18] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting() ? "Creating…" : github.enabled ? "Open schedule update pull request" : "Create automation"}
          </button>
        </div>
      </div>
    </form>
  )
}
