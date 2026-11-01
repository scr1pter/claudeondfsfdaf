import { Billing } from "@vectordevai/schema/billing"
import { randomUUID } from "node:crypto"

import { getStore } from "./store"
import { nextRun, type Recurrence } from "@vectordevai/app/schedule"
import type { SpendLedger } from "./spend-limits"
import {
  measuredCost,
  newSpend,
  readSpend,
  sessionCost,
  sessionTokens,
  usageDelta,
  type EngineSessionResponse,
} from "./run-usage"

const STORE_NAME = "scheduled-agents"
const STORE_KEY = "records"
// The scheduler wakes up on this cadence to launch any records that are due.
const TICK_INTERVAL_MS = 20_000
const COMPLETION_POLL_MS = 1_500
const COMPLETION_TIMEOUT_MS = 6 * 60 * 60_000
const STARTUP_GRACE_MS = 3_000
// Ceiling on how far a missed schedule is walked forward when catching up. Two
// years of daily occurrences fit comfortably; past that the record re-anchors
// wherever the walk stopped rather than spinning on a pathological rule.
const MAX_CATCH_UP_OCCURRENCES = 800

export type ScheduledAgentStatus = "scheduled" | "running" | "completed" | "failed" | "canceled"

// One place a scheduled task runs. A task can carry several of these, which is
// how the same prompt runs across repositories on one schedule.
export type ScheduledAgentTarget = {
  directory: string
  // When set, the run continues this existing engine session instead of opening
  // a new one, so a recurring task can keep adding to an established thread.
  sessionId?: string
}

export type ScheduledAgentTargetResult = ScheduledAgentTarget & {
  status: "running" | "completed" | "failed" | "canceled"
  startedAt: string
  completedAt?: string
  error?: string
}

export type ScheduledAgentRecord = {
  id: string
  title?: string
  prompt: string
  // Fresh sessions must pin the model selected when the automation was
  // created. Falling through to the engine default is unsafe for unattended
  // work: a retired catalog default can remain locally enabled after the
  // upstream deployment has disappeared.
  model?: { providerID: string; id: string; variant?: string }
  // Absent means a one-shot run, which is what every record created before
  // recurrence existed is.
  recurrence?: Recurrence
  paused?: boolean
  // The first target's directory, mirrored here so records written before
  // multi-repo targeting — and every consumer that still reads a single
  // directory — keep working without a migration step.
  directory: string
  // Absent on single-directory records, which are left in their original shape
  // so an older build reading this store still understands them.
  targets?: ScheduledAgentTarget[]
  parentSessionId?: string
  runAt: string
  // The recurrence occurrence this pending run belongs to, set only when runAt
  // was pulled forward by a manual run. The following occurrence is computed
  // from this, so running a task by hand never shifts its schedule.
  scheduledFor?: string
  status: ScheduledAgentStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  // The first target's session, kept for consumers that open "the" session of a
  // run. The full set lives in `results`.
  sessionId?: string
  error?: string
  results?: ScheduledAgentTargetResult[]
  // Occurrences that elapsed unrun while Vector was closed. The single run that
  // just finished stands in for all of them; they are never replayed.
  missedRuns?: number
}

// Same shape as ServerReadyData; the IPC layer passes deps.awaitInitialization
// straight through so launches wait for the sidecar engine to be ready.
export type ScheduledAgentEngine = {
  url: string
  username: string | null
  password: string | null
}

export type CreateScheduledAgentInput = {
  title?: string
  recurrence?: Recurrence
  prompt: string
  model?: { providerID: string; id: string; variant?: string }
  // Either of these picks where the task runs; `targets` wins when both are
  // given. `directory` stays accepted so existing callers are untouched.
  directory?: string
  targets?: ScheduledAgentTarget[]
  parentSessionId?: string
  runAt: string
}

export type ScheduledAgentsStore = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
}

// Returns the parsed JSON body, which is untrusted: every caller narrows it
// itself rather than pretending the engine promised a shape.
export type ScheduledAgentRequest = (
  engine: ScheduledAgentEngine,
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>

// The targets a record runs against. A record from before multi-repo targeting
// has no `targets` array at all, and reads as the single directory it always
// was — that is the whole compatibility story, no rewrite of the store.
export function scheduledAgentTargets(
  record: Pick<ScheduledAgentRecord, "directory" | "targets">,
): ScheduledAgentTarget[] {
  const listed = record.targets?.filter((target) => typeof target?.directory === "string" && target.directory !== "")
  if (listed && listed.length > 0) return listed
  return [{ directory: record.directory }]
}

// The next occurrence of a recurring task, walked forward from the slot it was
// meant to run at rather than from the clock. Anchoring on the slot is what
// stops a late start or a six-hour run from dragging every future run later and
// later. Occurrences that fully elapsed while Vector was closed are counted and
// skipped, never replayed: the run that just happened is the single catch-up
// for the entire missed window.
export function advanceSchedule(
  recurrence: Recurrence,
  slot: Date,
  from: Date,
  skipped = 0,
): { next: Date; skipped: number } | undefined {
  const next = nextRun(recurrence, slot)
  if (!next || !Number.isFinite(next.getTime())) return undefined
  if (next > from || skipped >= MAX_CATCH_UP_OCCURRENCES) return { next, skipped }
  return advanceSchedule(recurrence, next, from, skipped + 1)
}

// Says out loud that a burst was collapsed, so the tray and the panel can admit
// the task did not run while the app was closed instead of quietly pretending
// it kept up.
export function describeCatchUp(record: Pick<ScheduledAgentRecord, "missedRuns">): string | undefined {
  if (!record.missedRuns) return undefined
  const missed = record.missedRuns === 1 ? "1 earlier run was" : `${record.missedRuns} earlier runs were`
  return `Caught up with a single run; ${missed} missed while Vector was closed and will not be replayed.`
}

// Pausing parks a pending run; resuming re-arms it. Resuming must not
// resurrect a one-shot run that already finished — that would execute the
// task a second time. A recurring task is different: its whole purpose is to
// fire again, and a pause that straddled a run leaves it "completed" (see the
// `!item.paused` branch in the completion handler), so resuming has to put it
// back on the schedule.
export function pausedStatus(
  record: Pick<ScheduledAgentRecord, "status" | "recurrence">,
  paused: boolean,
): ScheduledAgentStatus {
  if (paused) return record.status === "scheduled" ? "canceled" : record.status
  if (record.recurrence && record.recurrence.kind !== "once") return "scheduled"
  return record.status === "canceled" ? "scheduled" : record.status
}

function engineHeaders(engine: ScheduledAgentEngine) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (engine.username && engine.password) {
    headers.authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`
  }
  return headers
}

const engineRequest: ScheduledAgentRequest = async (engine, path, init = {}) => {
  const base = engine.url.endsWith("/") ? engine.url : `${engine.url}/`
  const response = await fetch(new URL(path.replace(/^\//, ""), base), {
    method: init.method ?? "GET",
    headers: engineHeaders(engine),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vector engine request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
  if (response.status === 204) return undefined
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

type EngineMessageError = { message?: string; data?: { message?: string } } | string

// The v2 route returns flat messages ({ type: "assistant", finish, error });
// the legacy route wraps them as { info: { role: "assistant", ... } }. This
// module calls v2, and matching only the legacy envelope meant no assistant
// message was ever found — so every scheduled run polled to the six-hour
// ceiling and was recorded as failed. Both shapes are accepted so the poller
// cannot silently break again if the route it uses changes.
type EngineMessage = {
  id?: string
  type?: string
  finish?: string
  error?: EngineMessageError
  info?: {
    id?: string
    role?: string
    finish?: string
    error?: EngineMessageError
  }
}

type EngineMessageResponse = {
  data?: EngineMessage[]
}

function activeSessionMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {}
  const record = value as Record<string, unknown>
  const candidate = record.data && typeof record.data === "object" ? record.data : record
  return candidate as Record<string, unknown>
}

function assistantOf(item: EngineMessage) {
  if (item.info?.role === "assistant") return item.info
  if (item.type === "assistant") return item
  return undefined
}

function assistantFailure(response: EngineMessageResponse, afterMessageId?: string) {
  const messages = response.data ?? []
  const item = messages
    .filter((message) => {
      const assistant = assistantOf(message)
      if (!assistant) return false
      const id = assistant.id
      return !afterMessageId || !id || id > afterMessageId
    })
    .at(-1)
  const assistant = item && assistantOf(item)
  if (!assistant) return { settled: false as const }
  if (!assistant.error) {
    // A projected V2 assistant without a finish reason is an in-progress turn,
    // even if the process-local active registry briefly has not observed it.
    if (item?.type === "assistant" && !item.finish) return { settled: false as const }
    return { settled: true as const, finish: assistant.finish }
  }
  if (typeof assistant.error === "string") return { settled: true as const, error: assistant.error }
  return {
    settled: true as const,
    error: assistant.error.data?.message ?? assistant.error.message ?? "The scheduled agent failed.",
  }
}

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createScheduledAgents(
  deps: {
    store?: ScheduledAgentsStore
    now?: () => Date
    request?: ScheduledAgentRequest
    delay?: (milliseconds: number) => Promise<void>
    spend?: () => Promise<Pick<SpendLedger, "checkAllowance" | "recordRunCost" | "release">>
  } = {},
) {
  // Resolved per call rather than captured, because electron-store cannot be
  // instantiated before app.setPath("userData", ...) has run.
  const store = deps.store ?? {
    get: (key: string) => getStore(STORE_NAME).get(key),
    set: (key: string, value: unknown) => getStore(STORE_NAME).set(key, value),
  }
  const clock = deps.now ?? (() => new Date())
  const transport = deps.request ?? engineRequest
  // The engine's JSON is untrusted, so this is the one place that pretends
  // otherwise: every call site declares the shape it reads and treats every
  // field in it as optional.
  const request = <T>(engine: ScheduledAgentEngine, path: string, init?: { method?: string; body?: unknown }) =>
    transport(engine, path, init) as Promise<T>
  const delay =
    deps.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const spend =
    deps.spend ??
    (async () => {
      const { spendLedger } = await import("./spend-limits")
      return spendLedger()
    })

  const activeRuns = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  let engineProvider: (() => Promise<ScheduledAgentEngine>) | undefined
  let tickTimer: NodeJS.Timeout | undefined
  // One slot each rather than a listener list: the main process has exactly one
  // tray, and this module must never keep a torn-down one alive.
  let changeListener: (() => void) | undefined
  let runFinishedListener: ((record: ScheduledAgentRecord) => void) | undefined

  const nowIso = () => clock().toISOString()

  function announceFinished(record: ScheduledAgentRecord) {
    const listener = runFinishedListener
    if (!listener) return
    // Desktop notifications and tray refreshes are observers, never part of a
    // run's transaction. Isolating them on a promise boundary keeps a platform
    // notification failure from rewriting a successful run as failed (and, for
    // recurring tasks, advancing its schedule a second time).
    void Promise.resolve()
      .then(() => listener(record))
      .catch(() => {})
  }

  function readRecords(): ScheduledAgentRecord[] {
    const raw = store.get(STORE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is ScheduledAgentRecord => typeof item?.id === "string")
  }

  function writeRecords(records: ScheduledAgentRecord[]) {
    store.set(STORE_KEY, records)
    // Every mutation funnels through here, so this is the one place that has to
    // announce a change.
    changeListener?.()
  }

  function updateRecord(id: string, update: (record: ScheduledAgentRecord) => ScheduledAgentRecord) {
    const records = readRecords()
    const index = records.findIndex((record) => record.id === id)
    if (index === -1) throw new Error("Scheduled agent was not found.")
    records[index] = update(records[index]!)
    writeRecords(records)
    return records[index]!
  }

  // A record left "running" by a crash is settled the same way a run that ends
  // badly is: reported as failed, but a recurring task is put back on its
  // schedule so one bad shutdown does not silently end the automation.
  function reconcileInterruptedRecords(records: ScheduledAgentRecord[]) {
    const interrupted = records.filter((record) => record.status === "running" && !activeRuns.has(record.id))
    if (interrupted.length === 0) return records
    const next = records.map((record) => {
      if (!interrupted.includes(record)) return record
      return settledRecord(record, "Interrupted by app restart before the agent completed.", record.results)
    })
    writeRecords(next)
    return next
  }

  function settledRecord(
    record: ScheduledAgentRecord,
    error: string | undefined,
    results: ScheduledAgentTargetResult[] | undefined,
  ): ScheduledAgentRecord {
    const completedAt = nowIso()
    // A target still marked running never gets to finish — the run is over —
    // so it inherits the failure rather than sitting in the store as in-flight.
    const settled = results?.map((result) =>
      result.status === "running" ? { ...result, status: "failed" as const, completedAt, error } : result,
    )
    // One repository failing must not condemn the whole task: a run counts as
    // failed only when nothing succeeded anywhere. Partial failures stay
    // visible through `error` and the per-target results.
    const status = (settled ?? []).some((result) => result.status === "completed") || !error ? "completed" : "failed"
    const anchor = new Date(record.scheduledFor ?? record.runAt)
    const advanced =
      record.recurrence && record.recurrence.kind !== "once" && !record.paused
        ? advanceSchedule(record.recurrence, Number.isFinite(anchor.getTime()) ? anchor : clock(), clock())
        : undefined
    if (!advanced) {
      return { ...record, status, completedAt, error, results: settled, scheduledFor: undefined, missedRuns: undefined }
    }
    // A recurring task returns to "scheduled" at its next occurrence rather
    // than finishing, which is what makes it repeat — including after a failure,
    // because a daily task that dies on one bad morning is not a schedule.
    return {
      ...record,
      status: "scheduled",
      completedAt,
      error,
      results: settled,
      runAt: advanced.next.toISOString(),
      scheduledFor: undefined,
      missedRuns: advanced.skipped || undefined,
    }
  }

  async function abortEngineSession(engine: ScheduledAgentEngine, sessionId: string) {
    await request(engine, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" }).catch(() => {})
  }

  async function waitForSessionCompletion(
    engine: ScheduledAgentEngine,
    recordId: string,
    sessionId: string,
    afterMessageId?: string,
  ) {
    const startedAt = clock().getTime()
    let observedActive = false
    while (clock().getTime() - startedAt < COMPLETION_TIMEOUT_MS) {
      const record = readRecords().find((item) => item.id === recordId)
      if (!record || record.status === "canceled") {
        await abortEngineSession(engine, sessionId)
        return { status: "canceled" as const }
      }

      // Scheduled agents run on the V2 session engine. Active sessions are
      // present in this registry and disappear only after the execution loop
      // settles, which avoids marking a merely admitted prompt as complete.
      const sessions = activeSessionMap(await request(engine, "/api/session/active"))
      const active = Boolean(sessions[sessionId])
      if (active) observedActive = true
      if (!active && (observedActive || clock().getTime() - startedAt >= STARTUP_GRACE_MS)) {
        const messages = await request<EngineMessageResponse | undefined>(
          engine,
          `/api/session/${encodeURIComponent(sessionId)}/context`,
        )
        const outcome = assistantFailure(messages ?? {}, afterMessageId)
        if (!outcome.settled) {
          await delay(COMPLETION_POLL_MS)
          continue
        }
        if (outcome.error) throw new Error(outcome.error)
        // A turn whose last step asked for another one was cut short at a
        // step boundary, as a spend guard stop does.
        return { status: "completed" as const, answered: outcome.finish !== "tool-calls" }
      }
      await delay(COMPLETION_POLL_MS)
    }
    await abortEngineSession(engine, sessionId)
    throw new Error("Scheduled agent exceeded the six-hour completion limit and was stopped.")
  }

  function patchResult(
    id: string,
    index: number,
    update: (result: ScheduledAgentTargetResult) => ScheduledAgentTargetResult,
  ) {
    const record = updateRecord(id, (current) => {
      const results = [...(current.results ?? [])]
      const existing = results[index] ?? {
        ...scheduledAgentTargets(current)[index],
        status: "running" as const,
        startedAt: nowIso(),
      }
      results[index] = update(existing)
      return { ...current, results, sessionId: results[0]?.sessionId ?? current.sessionId }
    })
    return record.results?.[index]
  }

  async function promptTarget(
    engine: ScheduledAgentEngine,
    id: string,
    index: number,
    target: ScheduledAgentTarget,
    prompt: string,
    model: ScheduledAgentRecord["model"],
    ledger: Pick<SpendLedger, "recordRunCost">,
    runId: string,
    budgetUsd: number | undefined,
  ) {
    // An existing session is continued, not duplicated: that is what lets a
    // recurring task keep appending to one established thread.
    if (!target.sessionId && !model) {
      throw new Error(
        "This automation was saved without a model. Open Automations and recreate it so Vector can pin your current model before it runs.",
      )
    }
    const sessionId = target.sessionId ?? (await openSession(engine, target.directory, model!))
    patchResult(id, index, (result) => ({ ...result, sessionId }))
    if (readRecords().find((item) => item.id === id)?.status === "canceled") {
      await abortEngineSession(engine, sessionId)
      return "canceled" as const
    }
    const before = await request<EngineSessionResponse | undefined>(
      engine,
      `/api/session/${encodeURIComponent(sessionId)}`,
    ).catch(() => undefined)
    // A continued session answers the spend route with its last run, which may
    // be an earlier recurrence or the user's own turn. Reading it first is what
    // tells this run's reading apart from that one.
    const earlier = await readSpend((path) => request(engine, path), sessionId)
    // Settled rather than thrown, so a failed turn is still measured below.
    const admission = await request<{ data?: { id?: string } } | undefined>(
      engine,
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        // The ledger headroom is this run's live budget: the engine stops the
        // run within one step of it for each agent running at the time,
        // instead of the ledger noticing afterwards.
        body: {
          prompt: { text: prompt },
          resume: true,
          budget: budgetUsd === undefined ? undefined : { usd: budgetUsd },
        },
      },
    ).then(
      (admitted) => ({ admitted }),
      (error: unknown) => ({ error }),
    )
    const execution =
      "error" in admission
        ? admission
        : await waitForSessionCompletion(engine, id, sessionId, admission.admitted?.data?.id).catch(
            (error: unknown) => ({ error }),
          )
    const after = await request<EngineSessionResponse | undefined>(
      engine,
      `/api/session/${encodeURIComponent(sessionId)}`,
    ).catch(() => undefined)
    // A prompt the engine never admitted started no run, so any reading is an
    // earlier run's, and so is one that has not moved since before the prompt.
    const snapshot =
      "error" in admission ? undefined : newSpend(earlier, await readSpend((path) => request(engine, path), sessionId))
    await ledger
      .recordRunCost({
        projectPath: target.directory,
        runId,
        provider: after?.data?.model?.providerID ?? before?.data?.model?.providerID ?? "Current Vector provider",
        model: after?.data?.model?.id ?? before?.data?.model?.id ?? "Current selected model",
        source: "scheduled",
        totalCostUsd: measuredCost(snapshot, sessionCost(before?.data), sessionCost(after?.data)),
        totalTokens: usageDelta(sessionTokens(before?.data), sessionTokens(after?.data)),
      })
      .catch(() => undefined)
    if ("status" in execution && execution.status === "canceled") return execution.status
    // A guard stop that cut the turn short fails this target, even when the
    // turn settled without an error, and its message says exactly why the run
    // ended. A final answer that crossed the cap also leaves the guard
    // stopped, but the turn finished and its answer stands, so it completes.
    const answered = "status" in execution && execution.status === "completed" && execution.answered
    if (snapshot?.state === "stopped" && !answered)
      throw new Error(snapshot.message ?? "Vector's spend guard stopped this run.")
    if ("error" in execution) throw execution.error
    return execution.status
  }

  async function openSession(
    engine: ScheduledAgentEngine,
    directory: string,
    model: NonNullable<ScheduledAgentRecord["model"]>,
  ) {
    const created = await request<{ data?: { id?: string } } | undefined>(engine, "/api/session", {
      method: "POST",
      body: { location: { directory }, model },
    })
    const sessionId = created?.data?.id
    if (!sessionId) throw new Error("Vector's engine did not return a session ID for the scheduled agent.")
    return sessionId
  }

  // Every target settles on its own. A repository that throws is recorded as a
  // failed target and nothing more — the other targets are already in flight
  // beside it and are never cancelled by it.
  async function runTarget(
    engine: ScheduledAgentEngine,
    id: string,
    index: number,
    target: ScheduledAgentTarget,
    prompt: string,
  ) {
    const record = readRecords().find((item) => item.id === id)
    const runId = `${id}:${record?.startedAt ?? nowIso()}:${index}`
    const execution = spend().then(async (ledger) => {
      // A recurrence continues its existing session, whose model may have changed since the schedule was saved.
      // Only a model observed on that session (or pinned when creating a new one) can skip the local dollar gate.
      const model = target.sessionId
        ? await request<EngineSessionResponse | undefined>(
            engine,
            `/api/session/${encodeURIComponent(target.sessionId)}`,
          )
            .then((response) => response?.data?.model)
            .catch(() => undefined)
        : record?.model
      const allowance = await ledger.checkAllowance({
        runId,
        source: "scheduled",
        billing: Billing.isCodium(model?.providerID) ? "codium" : undefined,
        // Every target of this launch is checked at once, so the hold has to
        // be taken inside the check, not after it.
        reserve: true,
      })
      if (!allowance.allowed) throw new Error(allowance.reason || "A spend limit blocked this scheduled run.")
      // recordRunCost releases the reservation on the normal path. This covers a
      // run that failed before it reached the engine.
      return promptTarget(engine, id, index, target, prompt, record?.model, ledger, runId, allowance.budgetUsd).finally(
        () => ledger.release(runId),
      )
    })
    const outcome = await execution.then(
      (status) => ({ status }),
      (error) => ({ status: "failed" as const, error: failureMessage(error) }),
    )
    return patchResult(id, index, (result) => ({
      ...result,
      status: outcome.status,
      completedAt: nowIso(),
      error: "error" in outcome ? outcome.error : undefined,
    }))
  }

  async function launch(id: string, awaitEngine: () => Promise<ScheduledAgentEngine>) {
    activeRuns.add(id)
    let finished: ScheduledAgentRecord | undefined
    try {
      // Marking the record running happens before the first await, so a tick
      // that overlaps this one can never select the same record twice.
      const started = updateRecord(id, (current) => ({
        ...current,
        status: "running",
        startedAt: nowIso(),
        error: undefined,
        results: scheduledAgentTargets(current).map((target) => ({
          ...target,
          status: "running" as const,
          startedAt: nowIso(),
        })),
      }))

      const engine = await awaitEngine()
      const results = await Promise.all(
        scheduledAgentTargets(started).map((target, index) => runTarget(engine, id, index, target, started.prompt)),
      )
      // patchResult returns undefined when the record moved out from under a
      // target mid-run. Compacting those holes would shift every later entry,
      // and the renderer pairs results to targets by position — so a single hole
      // would relabel every repository after it with another one's outcome.
      // Fill the hole instead, which keeps the pairing and is honest that the
      // target never reported.
      const targets = scheduledAgentTargets(started)
      const settled = results.map((result, index) => {
        if (result) return result
        return {
          ...targets[index]!,
          status: "failed" as const,
          startedAt: started.results?.[index]?.startedAt ?? nowIso(),
          completedAt: nowIso(),
          error: "The scheduled task changed while this repository was running, so its result was lost.",
        }
      })
      const failures = settled.filter((result) => result.status === "failed")
      finished = updateRecord(id, (current) => {
        // A run the user cancelled mid-flight stays cancelled; rescheduling it
        // here would undo the cancel the user just asked for.
        if (current.status === "canceled") return current
        return settledRecord(
          current,
          failures.length === 0
            ? undefined
            : failures
                .map((result) => `${result.directory}: ${result.error ?? "The scheduled agent failed."}`)
                .join("; ")
                .slice(0, 500),
          settled,
        )
      })
      if (finished.status === "canceled") finished = undefined
    } finally {
      activeRuns.delete(id)
      // Announced only after the run leaves activeRuns, so the tray refresh this
      // triggers no longer counts the finished run as still in flight.
      if (finished) announceFinished(finished)
    }
  }

  // Selection and every launch start synchronously — a record is marked running
  // before the first await — so a tick that overlaps another never picks the
  // same record twice, and a six-hour run never stops a later tick from
  // starting other records.
  async function tick() {
    if (!engineProvider) return
    const provider = engineProvider
    const nowMs = clock().getTime()
    readRecords()
      .filter((record) => {
        if (record.status !== "scheduled" || record.paused) return false
        if (activeRuns.has(record.id)) return false
        const runAtMs = Date.parse(record.runAt)
        // A record with an unreadable time can never become due later; fire it
        // now instead of leaving it stuck as "scheduled" forever.
        return !Number.isFinite(runAtMs) || runAtMs <= nowMs
      })
      .forEach((record) => {
        const run: Promise<void> = launch(record.id, provider)
          .catch((error) => {
            const failed = failRecord(record.id, failureMessage(error))
            // A run the user cancelled mid-flight is not a finish worth announcing.
            if (failed && failed.status !== "canceled") announceFinished(failed)
          })
          .finally(() => inFlight.delete(run))
        inFlight.add(run)
      })
    // Resolves only once the scheduler has nothing in flight at all, including
    // runs an earlier tick started, which is what makes a tick awaitable.
    while (inFlight.size > 0) await Promise.all(inFlight)
  }

  function failRecord(id: string, message: string) {
    const record = readRecords().find((item) => item.id === id)
    // The record was removed mid-run; there is nothing left to mark.
    if (!record) return undefined
    if (record.status === "canceled") return record
    return updateRecord(id, (current) => settledRecord(current, message, current.results))
  }

  function list(scope?: { directory?: string; parentSessionId?: string }) {
    return reconcileInterruptedRecords(readRecords()).filter((record) => {
      if (!scope) return true
      // A multi-repo task belongs to every repository it targets, so it shows up
      // in each of their panels rather than only the first one's.
      if (scope.directory && !scheduledAgentTargets(record).some((target) => target.directory === scope.directory)) {
        return false
      }
      return record.parentSessionId === scope.parentSessionId
    })
  }

  function setPaused(id: string, paused: boolean) {
    return updateRecord(id, (record) => ({
      ...record,
      paused,
      // Resuming a recurring task moves it to its next real moment; without this
      // it would still hold a runAt in the past and fire immediately. The parked
      // occurrence is abandoned rather than caught up. A run that is still in
      // flight keeps its current anchor: completion advances that slot itself,
      // and moving it here as well would skip the next occurrence.
      runAt:
        !paused && record.status !== "running" && record.recurrence && record.recurrence.kind !== "once"
          ? (nextRun(record.recurrence, clock())?.toISOString() ?? record.runAt)
          : record.runAt,
      scheduledFor: paused || record.status === "running" ? record.scheduledFor : undefined,
      status: pausedStatus(record, paused),
    }))
  }

  return {
    start(awaitEngine: () => Promise<ScheduledAgentEngine>) {
      if (tickTimer) return
      engineProvider = awaitEngine
      reconcileInterruptedRecords(readRecords())
      tickTimer = setInterval(() => {
        void tick()
      }, TICK_INTERVAL_MS)
    },

    stop() {
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = undefined
    },

    tick,
    list,
    setPaused,

    onChanged(listener: () => void) {
      changeListener = listener
    },

    onRunFinished(listener: (record: ScheduledAgentRecord) => void) {
      runFinishedListener = listener
    },

    // What the tray shows and what the keep-alive decision runs on. Runs in
    // flight come from the live in-process set rather than record status, so a
    // record left "running" by a crash can never hold the app resident forever.
    workState() {
      const records = readRecords()
      const armed = records.filter((record) => record.status === "scheduled" && !record.paused)
      const upcoming = armed.map((record) => Date.parse(record.runAt)).filter((value) => Number.isFinite(value))
      return {
        armedTasks: armed.length,
        inFlightRuns: activeRuns.size,
        nextRunAt: upcoming.length === 0 ? undefined : Math.min(...upcoming),
        // A paused record only counts as resumable if resuming would actually
        // re-arm it; one that already ran to completion never will.
        pausedTasks: records.filter((record) => record.paused === true && pausedStatus(record, false) === "scheduled")
          .length,
      }
    },

    // Pulls the soonest armed task forward instead of launching it directly, so
    // a manual run still goes through the same due selection and failure
    // bookkeeping as an ordinary tick.
    runNext() {
      const next = readRecords()
        .filter((record) => record.status === "scheduled" && !record.paused)
        // An unreadable runAt is already treated as due now by the tick, so the
        // NaN-to-zero fallback keeps such a record sorted first here too.
        .sort((left, right) => (Date.parse(left.runAt) || 0) - (Date.parse(right.runAt) || 0))
        .at(0)
      if (!next) return undefined
      const pulled = updateRecord(next.id, (record) => ({
        ...record,
        // Remembering the occurrence being pulled forward is what keeps a manual
        // run from shifting the recurrence to whenever the user pressed it.
        scheduledFor: record.scheduledFor ?? record.runAt,
        runAt: nowIso(),
      }))
      void tick()
      return pulled
    },

    setAllPaused(paused: boolean) {
      return readRecords()
        .filter((record) =>
          paused
            ? record.status === "scheduled" && !record.paused
            : record.paused === true && pausedStatus(record, false) === "scheduled",
        )
        .map((record) => setPaused(record.id, paused))
    },

    create(input: CreateScheduledAgentInput): ScheduledAgentRecord {
      const prompt = input.prompt?.trim()
      if (!prompt) throw new Error("Write a prompt for the scheduled agent to run.")
      const targets = normalizeTargets(input)
      if (targets.length === 0) throw new Error("Choose at least one repository folder for the scheduled agent.")
      const model = normalizeModel(input.model)
      if (!model && targets.some((target) => !target.sessionId)) {
        throw new Error("Choose a model for this automation before scheduling a fresh session.")
      }
      const parsed = Date.parse(input.runAt)
      if (!Number.isFinite(parsed)) throw new Error("The scheduled time is not a valid date.")

      // Past times are clamped to now so the record fires on the next scheduler
      // tick instead of being rejected.
      const record: ScheduledAgentRecord = {
        id: randomUUID(),
        title: input.title?.trim() || prompt.split("\n")[0]?.slice(0, 80),
        prompt,
        model,
        directory: targets[0].directory,
        // Left off entirely for a plain one-directory task, so those records
        // stay exactly the shape earlier versions wrote and read.
        targets: targets.length > 1 || targets[0].sessionId ? targets : undefined,
        recurrence: input.recurrence,
        paused: false,
        parentSessionId: input.parentSessionId?.trim() || undefined,
        runAt: new Date(Math.max(parsed, clock().getTime())).toISOString(),
        status: "scheduled",
        createdAt: nowIso(),
      }
      writeRecords([record, ...readRecords()])
      return record
    },

    async cancel(id: string) {
      const record = readRecords().find((item) => item.id === id)
      if (!record) return undefined
      if (record.status !== "scheduled" && record.status !== "running") return record
      const canceled = updateRecord(id, (current) => ({ ...current, status: "canceled", completedAt: nowIso() }))
      // Every session the run opened has to be stopped, not just the first one,
      // or a cancelled fan-out keeps burning tokens in the other repositories.
      const sessions = [record.sessionId, ...(record.results ?? []).map((result) => result.sessionId)].filter(
        (value): value is string => typeof value === "string" && value !== "",
      )
      if (sessions.length === 0 || !engineProvider) return canceled
      const engine = await engineProvider().catch(() => undefined)
      if (engine) await Promise.all([...new Set(sessions)].map((sessionId) => abortEngineSession(engine, sessionId)))
      return canceled
    },

    remove(id: string) {
      const next = readRecords().filter((item) => item.id !== id)
      writeRecords(next)
      return next
    },
  }
}

function normalizeModel(model: CreateScheduledAgentInput["model"]) {
  if (!model) return undefined
  const providerID = model.providerID?.trim()
  const id = model.id?.trim()
  if (!providerID || !id) throw new Error("Choose a model for this automation to use.")
  return { providerID, id, variant: model.variant?.trim() || undefined }
}

function normalizeTargets(input: Pick<CreateScheduledAgentInput, "directory" | "targets">) {
  const listed = input.targets?.length
    ? input.targets
    : input.directory
      ? [{ directory: input.directory }]
      : ([] as ScheduledAgentTarget[])
  const seen = new Set<string>()
  return listed
    .map((target) => ({ directory: target.directory?.trim() ?? "", sessionId: target.sessionId?.trim() || undefined }))
    .filter((target) => target.directory !== "")
    .filter((target) => {
      const key = `${target.directory}\u0000${target.sessionId ?? ""}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// The main process runs exactly one scheduler. It is created on first use
// rather than at import time because the store underneath it cannot exist
// before Electron has settled its userData path.
let shared: ReturnType<typeof createScheduledAgents> | undefined
const scheduler = () => (shared ??= createScheduledAgents())

export function initScheduledAgents(awaitEngine: () => Promise<ScheduledAgentEngine>): void {
  scheduler().start(awaitEngine)
}

// Lets the tray redraw its menu the moment the schedule changes, instead of
// waiting out its own refresh interval and showing a stale count.
export function onScheduledAgentsChanged(listener: () => void) {
  scheduler().onChanged(listener)
}

export function onScheduledAgentRunFinished(listener: (record: ScheduledAgentRecord) => void) {
  scheduler().onRunFinished(listener)
}

export function listScheduledAgents(scope?: { directory?: string; parentSessionId?: string }): ScheduledAgentRecord[] {
  return scheduler().list(scope)
}

export function createScheduledAgent(input: CreateScheduledAgentInput): ScheduledAgentRecord {
  return scheduler().create(input)
}

export function cancelScheduledAgent(id: string): Promise<ScheduledAgentRecord | undefined> {
  return scheduler().cancel(id)
}

export function removeScheduledAgent(id: string): ScheduledAgentRecord[] {
  return scheduler().remove(id)
}

export function setScheduledAgentPaused(id: string, paused: boolean): ScheduledAgentRecord {
  return scheduler().setPaused(id, paused)
}

export function setAllScheduledAgentsPaused(paused: boolean): ScheduledAgentRecord[] {
  return scheduler().setAllPaused(paused)
}

export function scheduledAgentWorkState() {
  return scheduler().workState()
}

export function runNextScheduledAgent(): ScheduledAgentRecord | undefined {
  return scheduler().runNext()
}
