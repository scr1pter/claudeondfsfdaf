import { Cause, Clock, Effect, Fiber, Schema, Semaphore } from "effect"
import type { Workflow } from "@vectordevai/schema/workflow"
import { WorkflowLimits } from "@vectordevai/core/orchestration/limits"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowPredicate } from "@vectordevai/core/orchestration/predicate"
import { WorkflowProgress } from "@vectordevai/core/orchestration/progress"
import { WorkflowReport } from "@vectordevai/core/orchestration/report"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowTemplate } from "@vectordevai/core/orchestration/template"
import type { SubagentUsage } from "@/agent/subagent-kind"
import { SessionID, type MessageID } from "@/session/schema"
import { WorkflowLaunch } from "./launch"
import { WorkflowMarkers } from "./constants"
import { WorkflowSources } from "./sources"
import type { WorkflowRuntime } from "./runtime"

type Json = WorkflowSources.Item["value"]
export type Node = WorkflowProgress.Node & {
  readonly itemKey: string
  readonly value: Json
  readonly index: number
  readonly source?: string
  readonly sessionID?: SessionID
  readonly verifierID?: SessionID
  readonly output?: Json
  readonly outputMessageID?: MessageID
  readonly outputStructured?: boolean
  readonly feedbackMessageID?: MessageID
  readonly final?: boolean
  readonly execution?: "producer" | "verifier" | "repair" | "done"
  /** Persisted before task admission so a crash before its metadata callback can recover the exact child. */
  readonly pendingLaunch?: { readonly key: string; readonly verifier: boolean; readonly round: number }
  readonly pendingResult?: {
    readonly verifier: boolean
    readonly round: number
    readonly result: WorkflowLaunch.Result
  }
  readonly retriesDone?: number
  readonly settledOrder?: number
  readonly skippedReason?: "when" | "verification" | "limit"
  readonly feedback?: Json
}
export type Counters = {
  readonly launched: number
  readonly steps: number
  readonly tokens: number
  readonly spentUsd: number
  readonly elapsedMs: number
}
export type State = {
  readonly nodes: readonly Node[]
  readonly usage: Counters
  readonly groups: Readonly<Record<string, Counters>>
  readonly sessions: Readonly<Record<string, SubagentUsage>>
  readonly sessionGroups?: Readonly<Record<string, string>>
  readonly uncertain?: boolean
  readonly files?: Readonly<Record<string, { readonly digest: string; readonly path: string }>>
  readonly clock?: { readonly at: number; readonly active: boolean; readonly groups: readonly string[] }
}
export type Observation = {
  readonly usage: Omit<WorkflowLimits.Usage, "launched" | "elapsedMs">
  readonly groups?: Readonly<Record<string, Omit<WorkflowLimits.Usage, "launched" | "elapsedMs">>>
  readonly waiting?: Readonly<Record<string, number>>
  /** Session display accounting includes Codium in unpricedSteps; guard unknown counters remain separate. */
  readonly unpricedSteps?: number
  readonly codiumSteps?: number
}
export type Ops = {
  readonly initial: WorkflowSources.Interface["initial"]
  readonly launch: (
    request: WorkflowLaunch.Request,
    onSession: (sessionID: SessionID) => Effect.Effect<void>,
  ) => Effect.Effect<WorkflowLaunch.Result>
  readonly observe: () => Effect.Effect<Observation>
  /** Persist accounting and node identities before admission and after outcomes, without throttling. */
  readonly checkpoint: (state: State) => Effect.Effect<void>
  readonly progress: (progress: WorkflowProgress.Progress) => Effect.Effect<void>
  readonly write: (value: Json) => Effect.Effect<string>
  readonly finish: (report: string) => Effect.Effect<void>
}
export type Input = {
  readonly runID: SessionID
  readonly rootID: SessionID
  readonly spec: WorkflowSpec.Spec
  readonly built: WorkflowPlan.Built
  readonly agents: readonly WorkflowPlan.Agent[]
  readonly seed?: State
  readonly retryFailed?: boolean
}
export type Result = {
  readonly outcome: "completed" | "failed"
  readonly state: State
  readonly results: readonly Json[]
  readonly report: string
}
export class ConnectUnavailable extends Schema.TaggedErrorClass<ConnectUnavailable>()("WorkflowConnectUnavailable", {
  code: Schema.Literal("unsupported"),
  stage: Schema.String,
  message: Schema.String,
}) {}

/** Ordinary reviewer prompts renew to the conversation root, so they cannot retain private workflow/group scopes. */
export function assertSupported(input: Pick<Input, "spec" | "built">) {
  const connected =
    input.built.stages?.find((entry) => "connect" in entry.stage)?.stage ??
    input.spec.stages.find((stage) => "connect" in stage)
  return connected && "connect" in connected
    ? Effect.fail(
        new ConnectUnavailable({
          code: "unsupported",
          stage: connected.id,
          message:
            "Connected workflow stages are unavailable until reviewer helpers preserve the actual workflow, group and ancestor budget scopes. No connected action was started.",
        }),
      )
    : Effect.void
}

export const run = Effect.fn("WorkflowRunner.run")(function* (input: WorkflowRuntime.Input) {
  yield* assertSupported(input)
  const { WorkflowRuntime } = yield* Effect.promise(() => import("./runtime"))
  return yield* WorkflowRuntime.run(input)
}, Effect.scoped)

const empty = (): Counters => ({ launched: 0, steps: 0, tokens: 0, spentUsd: 0, elapsedMs: 0 })
const gates = new Map<string, { gate: Semaphore.Semaphore; users: number }>()

/** Scheduling performs no model inference; launch delegates each admitted node to the existing task lifecycle. */
export const schedule = Effect.fn("WorkflowRunner.schedule")(function* (input: Input, ops: Ops) {
  yield* assertSupported(input)
  if (!input.built.ok || !input.built.plan || !input.built.stages || !input.built.limits)
    return yield* Effect.die(new Error("A workflow must validate successfully before running."))
  const plan = input.built.plan
  const expanded = input.built.stages.filter(WorkflowPlan.isAgent)
  const limits = input.built.limits
  const started = yield* Clock.currentTimeMillis
  const gate = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const shared = gates.get(input.rootID) ?? { gate: Semaphore.makeUnsafe(16), users: 0 }
      shared.users += 1
      gates.set(input.rootID, shared)
      return shared
    }),
    (shared) =>
      Effect.sync(() => {
        if (--shared.users === 0) gates.delete(input.rootID)
      }),
  )
  const nodes = new Map<string, Node>()
  const previous = new Map((input.seed?.nodes ?? []).map((node) => [node.key, node]))
  const running = new Map<string, { group?: string; fiber?: Fiber.Fiber<void> }>()
  const complete = new Set<string>()
  const fingerprints = new Map<string, string>()
  const initial = new Map<string, readonly WorkflowSources.Item[]>()
  const outputs: WorkflowSources.Output[] = []
  const files = new Map<string, string>()
  const artifacts = { ...input.seed?.files }
  const groupStarted = new Map<string, number>()
  const groupStops = new Map<string, WorkflowLimits.Stop>()
  let settlementOrder = Math.max(-1, ...(input.seed?.nodes ?? []).map((node) => node.settledOrder ?? -1))
  const usage = { ...(input.seed?.usage ?? empty()) }
  const groups = Object.fromEntries(
    Object.keys(input.built.groupLimits ?? {}).map((id) => [id, { ...(input.seed?.groups[id] ?? empty()) }]),
  )
  const sessions = { ...input.seed?.sessions }
  const sessionGroups: Record<string, string> = Object.fromEntries(
    Object.entries(input.seed?.sessionGroups ?? {}).filter(([, group]) => Object.hasOwn(groups, group)),
  )
  const sums = (group?: string) =>
    Object.entries(sessions)
      .filter(([id]) => group === undefined || sessionGroups[id] === group)
      .reduce(
        (sum, [, value]) => ({
          steps: sum.steps + value.steps,
          tokens: sum.tokens + value.total,
          spentUsd: sum.spentUsd + value.cost,
        }),
        { steps: 0, tokens: 0, spentUsd: 0 },
      )
  const offset = (counter: Counters, group?: string) => {
    const total = sums(group)
    return {
      steps: Math.max(0, counter.steps - total.steps),
      tokens: Math.max(0, counter.tokens - total.tokens),
      spentUsd: Math.max(0, counter.spentUsd - total.spentUsd),
    }
  }
  const offsets = {
    run: offset(usage),
    groups: Object.fromEntries(Object.entries(groups).map(([id, counter]) => [id, offset(counter, id)])),
  }
  const reconcile = () => {
    for (const [counter, baseline, total] of [
      [usage, offsets.run, sums()],
      ...Object.entries(groups).map(([id, counter]) => [counter, offsets.groups[id], sums(id)] as const),
    ] as const) {
      counter.steps = Math.max(counter.steps, baseline.steps + total.steps)
      counter.tokens = Math.max(counter.tokens, baseline.tokens + total.tokens)
      counter.spentUsd = Math.max(counter.spentUsd, baseline.spentUsd + total.spentUsd)
    }
  }
  let observation: Observation = { usage: { steps: 0, tokens: 0, spentUsd: 0 } }
  let uncertain = input.seed?.uncertain ?? false
  let stop: { reason: string; message: string; abort: boolean } | undefined = uncertain
    ? { reason: "usage", message: "Prior workflow usage is unavailable; reconcile it before resuming.", abort: false }
    : undefined
  let lastProgress = -Infinity
  let lastClockBeat = -Infinity
  let lastFingerprint = ""
  let clockAt = started
  let activeAttempt = true
  const state = (): State => ({
    nodes: [...nodes.values()],
    usage: { ...usage },
    groups: structuredClone(groups),
    sessions: { ...sessions },
    sessionGroups: { ...sessionGroups },
    uncertain,
    files: { ...artifacts },
    clock: {
      at: clockAt,
      active: activeAttempt,
      groups: activeAttempt ? [...groupStarted.keys()].filter((id) => !groupDone(id)) : [],
    },
  })
  const checkpointLock = Semaphore.makeUnsafe(1)
  let checkpointFailed = false
  const persist = () =>
    Effect.gen(function* () {
      if (checkpointFailed) return
      const now = yield* Clock.currentTimeMillis
      clockAt = Math.max(clockAt, now)
      refreshElapsed(now)
      yield* ops.checkpoint(state())
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
        return Effect.sync(() => {
          checkpointFailed = true
          stop = {
            reason: "state",
            message: `Workflow checkpoint could not be saved: ${String(Cause.squash(cause))}`,
            abort: true,
          }
        })
      }),
      checkpointLock.withPermits(1),
    )
  const fingerprint = (id: string): string => {
    const known = fingerprints.get(id)
    if (known) return known
    const found = expanded.find((entry) => entry.stage.id === id)!
    const key = WorkflowPlan.key({
      stage: found.stage,
      inputs: found.inputs,
      dependencies: found.dependencies.map(fingerprint),
    })
    fingerprints.set(id, key)
    return key
  }
  expanded.forEach((entry) => fingerprint(entry.stage.id))
  const groupDone = (id: string) => (input.built.groups?.[id] ?? [id]).every((stage) => complete.has(stage))
  const groupOutput = (id: string): WorkflowSources.Output[] => {
    const members = input.built.groups?.[id]
    if (!members || (members.length === 1 && members[0] === id)) return outputs.filter((output) => output.stage === id)
    const policy = input.built.groupResults?.[id]
    const selected = new Set(policy?.stages ?? members)
    const values = outputs.filter(
      (output) => selected.has(output.stage) && WorkflowPredicate.evaluate(policy?.where, output.value),
    )
    return (policy?.max_items === undefined ? values : values.slice(0, policy.max_items)).map((output) => ({
      ...output,
      stage: id,
    }))
  }
  // Every template sees the same stage outputs and artifact paths. They change only when an output settles or an
  // artifact is written, so the view is rebuilt on those changes rather than for every item and launch.
  let viewVersion = 0
  let view: { version: number; stages: NonNullable<WorkflowTemplate.Context["stages"]> } | undefined
  const changed = () => {
    viewVersion += 1
  }
  const stagesView = () => {
    if (view?.version === viewVersion) return view.stages
    const stages = Object.fromEntries(
      Object.keys(input.built.groups ?? {})
        .map((id) => {
          const own = groupOutput(id).map((item) => item.value)
          return [id, { output: own.at(-1), outputs: own, outputs_file: files.get(id) }]
        })
        .concat(
          expanded
            .filter((entry) => !input.built.groups?.[entry.stage.id])
            .map((entry) => {
              const own = groupOutput(entry.stage.id).map((item) => item.value)
              return [entry.stage.id, { output: own.at(-1), outputs: own, outputs_file: files.get(entry.stage.id) }]
            }),
        ),
    )
    view = { version: viewVersion, stages }
    return stages
  }
  const context = (
    entry: WorkflowPlan.ExpandedAgent,
    item: WorkflowSources.Item,
    index: number,
    output?: unknown,
    round?: number,
  ): WorkflowTemplate.Context => ({
    run: { title: plan.title },
    inputs: entry.inputs,
    item: item.value,
    itemSource: item.source,
    index,
    output,
    round,
    stages: stagesView(),
  })
  const counts = (entry: WorkflowPlan.ExpandedAgent) => (entry.group ? [usage, groups[entry.group]] : [usage])
  const checks = (entry: WorkflowPlan.ExpandedAgent, fresh: boolean) => {
    if (stop) return stop
    const check = (budget: WorkflowLimits.Resolved, counter: Counters, observed?: Observation["usage"]) =>
      WorkflowLimits.check(budget, {
        ...counter,
        ...observed,
        steps: Math.max(counter.steps, observed?.steps ?? 0),
        tokens: Math.max(counter.tokens, observed?.tokens ?? 0),
        spentUsd: Math.max(counter.spentUsd, observed?.spentUsd ?? 0),
        launched: fresh ? counter.launched : Math.max(0, counter.launched - 1),
      })
    const root = check(limits, usage, observation.usage)
    if (root) {
      stop = root
      return root
    }
    if (!entry.group) return
    const prior = groupStops.get(entry.group)
    if (prior) return prior
    const local = check(input.built.groupLimits![entry.group], groups[entry.group], observation.groups?.[entry.group])
    if (local) groupStops.set(entry.group, local)
    return local
  }
  const account = (entry: WorkflowPlan.ExpandedAgent, result: WorkflowLaunch.Result) => {
    if (!result.sessionID) return
    if (!result.usage) {
      uncertain = true
      stop ??= {
        reason: "usage",
        message: "Workflow usage could not be read; further launches were stopped.",
        abort: false,
      }
      return
    }
    sessions[result.sessionID] = result.usage
    if (entry.group) sessionGroups[result.sessionID] = entry.group
    reconcile()
  }
  const refreshElapsed = (now: number) => {
    usage.elapsedMs = Math.max(usage.elapsedMs, (input.seed?.usage.elapsedMs ?? 0) + Math.max(0, now - started))
    for (const [id, counter] of Object.entries(groups)) {
      const began = groupStarted.get(id)
      if (began !== undefined && !groupDone(id))
        counter.elapsedMs = Math.max(
          counter.elapsedMs,
          (input.seed?.groups[id]?.elapsedMs ?? 0) + Math.max(0, now - began),
        )
    }
  }
  const waitForAdmission = (entry: WorkflowPlan.ExpandedAgent) =>
    Effect.gen(function* () {
      while (!stop && !(entry.group && groupStops.has(entry.group))) {
        const now = yield* Clock.currentTimeMillis
        refreshElapsed(now)
        if (!Object.values(observation.waiting ?? {}).some((since) => now - since >= 60_000)) return
        yield* Effect.sleep("50 millis")
      }
    })
  const execute = (entry: WorkflowPlan.ExpandedAgent, key: string, item: WorkflowSources.Item, index: number) =>
    Effect.gen(function* () {
      const stage = entry.stage
      let current = nodes.get(key)!
      let output = current.output
      let producer = current.sessionID
      let verifier = current.verifierID
      let round = current.round ?? 0
      let execution = current.execution ?? "producer"
      const groupLimits = entry.group && input.built.groupLimits?.[entry.group]
      const perSteps = Math.min(limits.perAgentSteps, groupLimits ? groupLimits.perAgentSteps : Infinity)
      const perUsd = Math.min(
        limits.perAgentUsd ?? Infinity,
        groupLimits ? (groupLimits.perAgentUsd ?? Infinity) : Infinity,
      )
      const launch = (verify: boolean, feedback?: unknown) =>
        Effect.gen(function* () {
          const kept = current.pendingResult
          if (kept && kept.verifier === verify && kept.round === round) return kept.result
          const setting = verify ? { ...stage, ...stage.verify } : stage
          const id = verify ? verifier : producer
          yield* waitForAdmission(entry)
          if (stop) return undefined
          const launchStop = checks(entry, !id)
          if (launchStop) return undefined
          const previousUsage = id ? sessions[id] : undefined
          const remainingSteps = perSteps - (previousUsage?.steps ?? 0)
          const remainingUsd = perUsd - (previousUsage?.cost ?? 0)
          if (remainingSteps <= 0 || remainingUsd <= 0)
            return {
              sessionID: id!,
              status: "failed" as const,
              retryable: false,
              usage: previousUsage,
              error: "This agent reached its workflow budget.",
            }
          const ctx = context(entry, item, index, output, round)
          const rendered = WorkflowTemplate.render(setting.prompt, ctx)
          const safeTitle = JSON.stringify(plan.title).replace(
            /[<>@\[\]]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
          const feedbackText =
            feedback === undefined
              ? ""
              : `\n\nVerifier feedback:\n${WorkflowTemplate.envelope(feedback, `${stage.id}#verifier`)}`
          // The full logical prompt keys the execution and is bounded, so crash recovery and the 64 KiB rule are unchanged.
          const prompt = `You are one agent in workflow ${safeTitle}, stage "${stage.id}". Complete only this stage's assignment.\n\n${rendered}${feedbackText}`
          // A repair resumes a producer that already answered this brief in its own session, so only the feedback is new
          // input; resending the whole brief would cost uncached tokens and repeat its instructions. A failed attempt is
          // retried with the whole brief: it may have failed before its brief ever reached the child.
          const sent =
            !verify && feedback !== undefined && id !== undefined && output !== undefined
              ? `The verifier did not accept your answer to the assignment above. Revise your work using this feedback, then answer again in the same format.${feedbackText}`
              : prompt
          if (new TextEncoder().encode(prompt).byteLength > 64 * 1024)
            return {
              sessionID: id,
              status: "failed" as const,
              retryable: false,
              usage: previousUsage,
              error: "The complete workflow prompt exceeds 64 KiB.",
            }
          const agent = setting.agent ?? "general"
          const writes = input.agents.find((candidate) => candidate.name === agent)?.writes ?? true
          const ownedPaths = stage.owned_paths?.map((template) => WorkflowTemplate.ownedPath(template, ctx))
          const permits = !writes || setting.isolation === "worktree" ? 0 : ownedPaths?.length ? 1 : 16
          return yield* Effect.gen(function* () {
            // Recheck after the shared writer gate: another node may spend the remaining budget while this one waits.
            yield* waitForAdmission(entry)
            if (stop) return undefined
            const afterWait = checks(entry, !id)
            if (afterWait) return undefined
            if (!id) for (const counter of counts(entry)) counter.launched += 1
            const executionKey = WorkflowPlan.key({
              node: key,
              round,
              verify,
              prompt,
              agent,
              model: setting.model,
              effort: setting.effort,
              isolation: setting.isolation,
              schema: setting.output?.schema,
              ownedPaths,
            })
            current = {
              ...current,
              execution,
              round,
              output,
              outputStructured: stage.output?.schema !== undefined,
              feedback: feedback as Json | undefined,
              pendingLaunch: { key: executionKey, verifier: verify, round },
            }
            nodes.set(key, current)
            yield* persist()
            if (checkpointFailed) {
              if (!id) for (const counter of counts(entry)) counter.launched -= 1
              return undefined
            }
            const result = yield* ops.launch(
              {
                marker: {
                  runID: input.runID,
                  stage: stage.id,
                  phase: stage.phase ?? "",
                  item: item.key,
                  key: executionKey,
                  node: key,
                  round,
                  verifier: verify,
                },
                title: stage.title ? WorkflowTemplate.render(stage.title, ctx) : stage.id,
                prompt: sent,
                agent,
                model: setting.model,
                effort: setting.effort,
                isolation: setting.isolation,
                ownedPaths,
                successCriteria: stage.success_criteria?.map((template) => WorkflowTemplate.render(template, ctx)),
                outputSchema: setting.output?.schema,
                budget: { steps: remainingSteps, ...(Number.isFinite(remainingUsd) ? { usd: remainingUsd } : {}) },
                sessionID: id,
              },
              (sessionID) =>
                Effect.gen(function* () {
                  if (verify) verifier = sessionID
                  else producer = sessionID
                  if (entry.group) sessionGroups[sessionID] = entry.group
                  current = { ...current, sessionID: producer, verifierID: verifier, round }
                  nodes.set(key, current)
                  yield* persist()
                  if (checkpointFailed)
                    return yield* Effect.die(
                      new Error("The workflow could not save its child identity before execution."),
                    )
                }),
            )
            if (!id && !result.sessionID) for (const counter of counts(entry)) counter.launched -= 1
            account(entry, result)
            if (result.sessionID) {
              if (verify) verifier = result.sessionID
              else producer = result.sessionID
            }
            current = {
              ...current,
              sessionID: producer,
              verifierID: verifier,
              round,
              pendingLaunch: undefined,
              pendingResult: { verifier: verify, round, result },
            }
            nodes.set(key, current)
            yield* persist()
            return result
          }).pipe(permits ? gate.gate.withPermits(permits) : (effect) => effect)
        })
      while (execution !== "done") {
        const checking = execution === "verifier"
        const result = yield* launch(checking, execution === "repair" ? current.feedback : undefined)
        if (!result) {
          nodes.set(key, { ...current, status: "skipped", skippedReason: "limit", final: false })
          return
        }
        if (result.status === "cancelled") {
          nodes.set(key, {
            ...current,
            status: "cancelled",
            final: true,
            error: result.error,
            pendingResult: undefined,
          })
          if (stage.on_error !== "skip" && !(entry.group && groupStops.has(entry.group)))
            stop ??= { reason: "cancelled", message: "A workflow agent was stopped.", abort: false }
          return
        }
        if (result.status === "failed") {
          const retries = current.retriesDone ?? 0
          if (result.retryable !== false && retries < (stage.retries ?? 1)) {
            current = { ...current, retriesDone: retries + 1, pendingResult: undefined }
            nodes.set(key, current)
            yield* persist()
            continue
          }
          nodes.set(key, { ...current, status: "failed", final: true, error: result.error, pendingResult: undefined })
          if (stage.on_error !== "skip" && !(entry.group && groupStops.has(entry.group)))
            stop ??= { reason: "stage", message: result.error ?? "A workflow stage failed.", abort: false }
          return
        }
        if (!checking) {
          output = result.output as Json
          if (execution === "repair") round += 1
          execution = stage.verify ? "verifier" : "done"
          current = {
            ...current,
            execution,
            round,
            output,
            outputMessageID: result.messageID,
            outputStructured: stage.output?.schema !== undefined,
            retriesDone: 0,
            pendingResult: undefined,
            feedback: undefined,
            feedbackMessageID: undefined,
          }
          nodes.set(key, current)
          yield* persist()
          continue
        }
        if (WorkflowPredicate.evaluate(stage.verify!.until, result.output)) {
          execution = "done"
          current = { ...current, execution, verified: true, pendingResult: undefined }
          continue
        }
        if (round + 1 < (stage.verify!.max_rounds ?? 2)) {
          execution = "repair"
          current = {
            ...current,
            execution,
            feedback: result.output as Json,
            feedbackMessageID: result.messageID,
            retriesDone: 0,
            pendingResult: undefined,
          }
          nodes.set(key, current)
          yield* persist()
          continue
        }
        current = { ...current, verified: false, pendingResult: undefined }
        if (stage.verify!.on_fail === "drop") {
          nodes.set(key, { ...current, status: "skipped", skippedReason: "verification", final: true })
          return
        }
        if (stage.verify!.on_fail === "fail") {
          nodes.set(key, { ...current, status: "failed", final: true, error: "Verification did not pass." })
          stop ??= { reason: "verify", message: "Workflow verification did not pass.", abort: false }
          return
        }
        execution = "done"
        current = { ...current, execution }
      }
      nodes.set(key, { ...current, status: "completed", final: true, round, output, settledOrder: ++settlementOrder })
      outputs.push({ stage: stage.id, key, value: output as Json })
      changed()
      outputs.sort(
        (left, right) => (nodes.get(left.key)?.settledOrder ?? 0) - (nodes.get(right.key)?.settledOrder ?? 0),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const current = nodes.get(key)!
          nodes.set(key, {
            ...current,
            status: Cause.hasInterrupts(cause) ? "interrupted" : "failed",
            final: !Cause.hasInterrupts(cause),
            error: String(Cause.squash(cause)),
          })
          if (!Cause.hasInterrupts(cause) && entry.stage.on_error !== "skip")
            stop = { reason: "stage", message: "A workflow node failed.", abort: false }
        }),
      ),
      Effect.ensuring(Effect.sync(() => running.delete(key)).pipe(Effect.andThen(persist()))),
    )

  const publishArtifacts = () =>
    Effect.gen(function* () {
      for (const id of [
        ...new Set([...expanded.map((entry) => entry.stage.id), ...Object.keys(input.built.groups ?? {})]),
      ]) {
        if (!groupDone(id) || files.has(id)) continue
        const values = groupOutput(id).map((output) => output.value)
        const digest = WorkflowPlan.key(values)
        const kept = artifacts[id]
        const path = kept?.digest === digest ? kept.path : yield* ops.write(values)
        artifacts[id] = { digest, path }
        files.set(id, path)
        changed()
      }
    })
  const ready: { entry: WorkflowPlan.ExpandedAgent; item: WorkflowSources.Item; index: number; key: string }[] = []
  const stageGroups = new Map(expanded.map((entry) => [entry.stage.id, entry.group]))
  // Per stage, each source item's node key once it has one.
  const admitted = new Map<string, Map<string, string>>()
  // Settlement order of outputs, for streaming sources; rebuilt when outputs change.
  let ordered: { version: number; keys: Map<string, number> } | undefined
  const order = () => {
    if (ordered?.version !== viewVersion)
      ordered = { version: viewVersion, keys: new Map(outputs.map((output, index) => [output.key, index])) }
    return ordered.keys
  }
  const aggregates = () => {
    const counts = new Map<string, { done: number; failed: number; items: number }>()
    for (const node of nodes.values()) {
      const count = counts.get(node.stage) ?? { done: 0, failed: 0, items: 0 }
      count.items += 1
      if (node.status === "completed") count.done += 1
      if (node.status === "failed") count.failed += 1
      counts.set(node.stage, count)
    }
    const sum = (members: readonly string[]) =>
      members.reduce(
        (total, id) => {
          const count = counts.get(id)
          return count
            ? { done: total.done + count.done, failed: total.failed + count.failed, items: total.items + count.items }
            : total
        },
        { done: 0, failed: 0, items: 0 },
      )
    const tree: Record<string, unknown> = Object.create(null)
    const entries = Object.keys(input.built.groups ?? {})
      .map((id) => [id, sum(input.built.groups?.[id] ?? [id])] as const)
      .concat(
        expanded
          .filter((entry) => !input.built.groups?.[entry.stage.id])
          .map((entry) => [entry.stage.id, sum([entry.stage.id])] as const),
      )
    for (const [id, aggregate] of entries) {
      let cursor = tree
      for (const part of id.split(".")) {
        const next = cursor[part]
        if (!next || typeof next !== "object") cursor[part] = Object.create(null)
        cursor = cursor[part] as Record<string, unknown>
      }
      Object.assign(cursor, aggregate)
    }
    return tree
  }
  const publish = (force = false) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      // Durable checkpoints are already saved before each admission and after each outcome. Publication only refreshes
      // their elapsed clock on the 30 s heartbeat, never on every once-a-second progress change (G.4).
      if (force || now - lastClockBeat >= WorkflowMarkers.HEARTBEAT_INTERVAL) {
        yield* persist()
        lastClockBeat = now
      }
      // Checked before the progress projection, which walks every node.
      if (!force && now - lastProgress < WorkflowMarkers.PROGRESS_INTERVAL) return
      const problem =
        stop ?? [...groupStops].map(([id, value]) => ({ reason: value.reason, message: `${id}: ${value.message}` }))[0]
      const progress = {
        ...WorkflowProgress.of(plan, [...nodes.values()], usage),
        ...(problem ? { stop: { reason: problem.reason, message: problem.message } } : {}),
      }
      const signature = WorkflowPlan.key(progress)
      if (!force && signature === lastFingerprint && now - lastProgress < WorkflowMarkers.HEARTBEAT_INTERVAL) return
      yield* ops.progress(progress)
      lastProgress = now
      lastFingerprint = signature
    })
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    refreshElapsed(now)
    observation = yield* ops.observe()
    for (const [counter, observed] of [
      [usage, observation.usage],
      ...Object.entries(groups).map(([id, counter]) => [counter, observation.groups?.[id]] as const),
    ] as const) {
      if (!observed) continue
      counter.steps = Math.max(counter.steps, observed.steps)
      counter.tokens = Math.max(counter.tokens, observed.tokens)
      counter.spentUsd = Math.max(counter.spentUsd, observed.spentUsd)
    }
    for (const [key, node] of nodes) {
      if (!running.has(key)) continue
      const waiting =
        (node.sessionID && observation.waiting?.[node.sessionID]) ??
        (node.verifierID && observation.waiting?.[node.verifierID])
      nodes.set(key, { ...node, status: waiting !== undefined ? "waiting" : "running" })
    }
    if (running.size) {
      const global = WorkflowLimits.check(limits, {
        ...usage,
        ...observation.usage,
        steps: usage.steps,
        tokens: usage.tokens,
        spentUsd: usage.spentUsd,
      })
      if (global?.abort) stop = global
      for (const [id, counter] of Object.entries(groups)) {
        if (groupDone(id) || ![...running.values()].some((entry) => entry.group === id)) continue
        const group = WorkflowLimits.check(input.built.groupLimits![id], {
          ...counter,
          ...observation.groups?.[id],
          steps: counter.steps,
          tokens: counter.tokens,
          spentUsd: counter.spentUsd,
        })
        if (group?.abort) groupStops.set(id, group)
      }
    }
    if (stop?.abort)
      yield* Fiber.interruptAll([...running.values()].flatMap((entry) => (entry.fiber ? [entry.fiber] : [])))
    for (const [id, problem] of groupStops) {
      if (problem.abort)
        yield* Fiber.interruptAll(
          [...running.values()]
            .filter((entry) => entry.group === id)
            .flatMap((entry) => (entry.fiber ? [entry.fiber] : [])),
        )
      for (const [key, node] of nodes)
        if (node.status === "pending" && stageGroups.get(node.stage) === id)
          nodes.set(key, { ...node, status: "skipped", skippedReason: "limit", final: false })
      if (![...running.values()].some((entry) => entry.group === id))
        for (const stage of input.built.groups?.[id] ?? []) complete.add(stage)
    }
    for (let index = ready.length - 1; index >= 0; index--)
      if (ready[index].entry.group && groupStops.has(ready[index].entry.group!)) ready.splice(index, 1)

    // Stage conditions read only completed stages (they are barriers), so one aggregate pass per tick is exact.
    let aggregateTree: Record<string, unknown> | undefined
    // Stages with a non-final node, kept current as this tick adds pending nodes.
    const unsettled = new Set<string>()
    for (const node of nodes.values()) if (!node.final) unsettled.add(node.stage)
    for (const entry of expanded) {
      if (stop || ready.length >= Math.max(1, Math.min(WorkflowMarkers.MAX_READY, limits.maxAgents - usage.launched)))
        break
      const stage = entry.stage
      if (entry.group && groupStops.has(entry.group)) continue
      if (complete.has(stage.id) || !entry.barriers.every((id) => complete.has(id))) continue
      if (entry.group && !groupStarted.has(entry.group)) groupStarted.set(entry.group, now)
      if (stage.if && !WorkflowPredicate.evaluate(stage.if, { stages: (aggregateTree ??= aggregates()) })) {
        complete.add(stage.id)
        yield* publishArtifacts()
        continue
      }
      const source = stage.for_each
      if (!source || !("from" in source)) {
        if (!initial.has(stage.id)) {
          const items = yield* ops.initial(source).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                stop ??= { reason: "source", message: error.message, abort: false }
                return [] as readonly WorkflowSources.Item[]
              }),
            ),
          )
          initial.set(stage.id, items)
        }
      }
      const upstream = source && "from" in source ? (typeof source.from === "string" ? [source.from] : source.from) : []
      const exhausted = upstream.every(groupDone)
      const items =
        source && "from" in source
          ? WorkflowSources.iterate(
              source,
              upstream
                .flatMap(groupOutput)
                .toSorted((left, right) => (order().get(left.key) ?? 0) - (order().get(right.key) ?? 0)),
              { complete: exhausted },
            )
          : (initial.get(stage.id) ?? [])
      let scanned = true
      let index = -1
      try {
        const seen = admitted.get(stage.id) ?? new Map<string, string>()
        admitted.set(stage.id, seen)
        for (const item of items) {
          index += 1
          // An item already turned into a node is never rendered or hashed again.
          const known = seen.get(item.key)
          if (known !== undefined && nodes.has(known)) continue
          if (ready.length >= Math.max(1, Math.min(WorkflowMarkers.MAX_READY, limits.maxAgents - usage.launched))) {
            scanned = false
            break
          }
          if (!WorkflowPredicate.evaluate(stage.when, item.value)) {
            const key = WorkflowPlan.key({ stage: fingerprint(stage.id), item: item.key, skipped: "when" })
            seen.set(item.key, key)
            if (!nodes.has(key)) {
              if (nodes.size >= WorkflowMarkers.MAX_NODES)
                throw new Error("Workflow state exceeded 32,000 nodes; narrow its inputs.")
              nodes.set(key, {
                key,
                stage: stage.id,
                phase: stage.phase,
                item: item.key,
                itemKey: item.key,
                value: item.value,
                index,
                source: item.source,
                status: "skipped",
                skippedReason: "when",
                final: true,
              })
            }
            continue
          }
          const ctx = context(entry, item, index)
          let key: string
          try {
            key = WorkflowPlan.key({
              title: plan.title,
              stage: fingerprint(stage.id),
              item: item.key,
              prompt: WorkflowTemplate.render(stage.prompt, ctx),
              paths: stage.owned_paths?.map((template) => WorkflowTemplate.ownedPath(template, ctx)),
            })
          } catch (error) {
            stop ??= { reason: "template", message: String(error), abort: false }
            scanned = false
            break
          }
          seen.set(item.key, key)
          if (nodes.has(key)) continue
          if (nodes.size >= WorkflowMarkers.MAX_NODES)
            throw new Error("Workflow state exceeded 32,000 nodes; narrow its inputs.")
          const stored = previous.get(key)
          const reused =
            stored?.final &&
            (stored.status === "completed" ||
              (stored.status === "skipped" && stored.skippedReason !== "limit") ||
              stored.status === "cancelled" ||
              (stored.status === "failed" && input.retryFailed === false))
          const node: Node = reused
            ? stored
            : {
                ...stored,
                key,
                stage: stage.id,
                phase: stage.phase,
                item: item.key,
                itemKey: item.key,
                value: item.value,
                index,
                source: item.source,
                status: "pending",
                final: false,
              }
          nodes.set(key, node)
          if (!node.final) unsettled.add(stage.id)
          if (reused && stored.status === "completed" && stored.output !== undefined) {
            outputs.push({ stage: stage.id, key, value: stored.output })
            changed()
            outputs.sort(
              (left, right) => (nodes.get(left.key)?.settledOrder ?? 0) - (nodes.get(right.key)?.settledOrder ?? 0),
            )
          }
          if (reused && (stored.status === "failed" || stored.status === "cancelled") && stage.on_error !== "skip")
            stop ??= {
              reason: stored.status,
              message: stored.error ?? "A workflow child remains stopped or failed.",
              abort: false,
            }
          if (nodes.get(key)?.status === "pending") ready.push({ entry, item, index, key })
        }
      } catch (error) {
        scanned = false
        stop ??= { reason: "source", message: String(error), abort: false }
      }
      if (scanned && exhausted && !unsettled.has(stage.id)) {
        complete.add(stage.id)
        yield* publishArtifacts()
      }
    }
    yield* publishArtifacts()
    const paused = Object.values(observation.waiting ?? {}).some((since) => now - since >= 60_000)
    while (ready.length && running.size < limits.concurrency && !paused && !stop) {
      const index = ready.findIndex(
        (candidate) =>
          !candidate.entry.group ||
          (!groupStops.has(candidate.entry.group) &&
            [...running.values()].filter((entry) => entry.group === candidate.entry.group).length <
              input.built.groupLimits![candidate.entry.group].concurrency),
      )
      if (index === -1) break
      const next = ready.splice(index, 1)[0]
      const limit = checks(next.entry, !nodes.get(next.key)?.sessionID)
      if (limit) continue
      nodes.set(next.key, { ...nodes.get(next.key)!, status: "running" })
      const active: { group?: string; fiber?: Fiber.Fiber<void> } = { group: next.entry.group }
      running.set(next.key, active)
      active.fiber = yield* execute(next.entry, next.key, next.item, next.index).pipe(Effect.forkChild)
    }
    if (stop)
      for (const [key, node] of nodes)
        if (node.status === "pending")
          nodes.set(key, { ...node, status: "skipped", skippedReason: "limit", final: false })
    yield* publish()
  })
  yield* Effect.gen(function* () {
    while (true) {
      yield* tick
      if (!running.size && (stop || complete.size === expanded.length)) break
      yield* Effect.sleep("50 millis")
    }
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        yield* Fiber.interruptAll([...running.values()].flatMap((entry) => (entry.fiber ? [entry.fiber] : [])))
        activeAttempt = false
        yield* persist()
        yield* publish(true)
      }),
    ),
  )
  activeAttempt = false
  yield* persist()
  yield* publish(true)
  const selected = new Set(input.spec.result?.stages ?? input.spec.stages.map((stage) => stage.id))
  const all = [...selected]
    .flatMap(groupOutput)
    .filter((output) => WorkflowPredicate.evaluate(input.spec.result?.where, output.value))
    .map((output) => output.value)
  const results = input.spec.result?.max_items === undefined ? all : all.slice(0, input.spec.result.max_items)
  const resultsPath = yield* ops.write(results)
  const outcome = stop || groupStops.size ? "failed" : "completed"
  const problem = stop ?? [...groupStops].map(([id, value]) => ({ ...value, message: `${id}: ${value.message}` }))[0]
  const progress = { ...WorkflowProgress.of(plan, [...nodes.values()], usage), ...(problem ? { stop: problem } : {}) }
  const report = WorkflowReport.render({
    title: plan.title,
    outcome,
    resultsPath,
    progress,
    durationMs: usage.elapsedMs,
    costUsd: uncertain ? undefined : usage.spentUsd,
    unpricedSteps: Math.max(
      uncertain ? 1 + (observation.codiumSteps ?? 0) : 0,
      observation.unpricedSteps ?? Object.values(sessions).reduce((sum, value) => sum + (value.unpricedSteps ?? 0), 0),
    ),
    codiumSteps:
      observation.codiumSteps ?? Object.values(sessions).reduce((sum, value) => sum + (value.codiumSteps ?? 0), 0),
    failures: [...nodes.values()]
      .filter((node) => node.error)
      .map((node) => ({ stage: node.stage, message: node.error! })),
    results,
  })
  yield* ops.finish(report)
  return { outcome, state: state(), results, report } satisfies Result
})

export * as WorkflowRunner from "./runner"
