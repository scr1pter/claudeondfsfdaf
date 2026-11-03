import { Clock, Effect, FileSystem, Option, Schema, Stream } from "effect"
import type { EventV2 } from "@vectordevai/core/event"
import { WorkflowCheckpointStore } from "@vectordevai/core/workflow-checkpoint-store"
import { JsonSchemaCheck } from "@vectordevai/core/json-schema-check"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import type { SpendGuard } from "@vectordevai/core/spend-guard"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import type { SubagentUsage } from "@/agent/subagent-kind"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { TaskStructured } from "@/tool/task-structured"
import type { Truncate } from "@/tool/truncate"
import { WorkflowCheckpoint } from "./checkpoint"
import { WorkflowLaunch } from "./launch"
import { WorkflowLedger } from "./ledger"
import { WorkflowRunner } from "./runner"
import { WorkflowSources } from "./sources"
import { WorkflowState } from "./state"

export type Input = Omit<WorkflowRunner.Input, "seed"> &
  WorkflowLaunch.Input & {
    readonly events: EventV2.Interface
    readonly guard: SpendGuard.Interface
    readonly sources: WorkflowSources.Interface
    readonly truncate: Pick<Truncate.Interface, "write">
    readonly fs: Pick<FileSystem.FileSystem, "stat" | "readFileString">
    /** The run's versioned checkpoint lives in its own row, never in the run Session's metadata or events. */
    readonly checkpoints: Pick<WorkflowCheckpointStore.Interface, "read" | "write">
  }

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("WorkflowRuntime.RuntimeError", {
  message: Schema.String,
}) {}

type Json = WorkflowSources.Item["value"]
const counters = () => ({ launched: 0, steps: 0, tokens: 0, spentUsd: 0, elapsedMs: 0 })
const zero = (): SubagentUsage => ({
  cost: 0,
  steps: 0,
  toolUses: 0,
  total: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  unpricedSteps: 0,
  codiumSteps: 0,
})
const tokens = (value?: SubagentUsage["tokens"]) =>
  value ? value.input + value.output + value.reasoning + value.cache.read + value.cache.write : 0
const coversTokens = (proven: SubagentUsage, other: SubagentUsage) =>
  proven.tokensOwnOnly === true &&
  proven.total >= other.total &&
  proven.tokens.input >= other.tokens.input &&
  proven.tokens.output >= other.tokens.output &&
  proven.tokens.reasoning >= other.tokens.reasoning &&
  proven.tokens.cache.read >= other.tokens.cache.read &&
  proven.tokens.cache.write >= other.tokens.cache.write
const mergeUsage = (left: SubagentUsage, right: SubagentUsage): SubagentUsage => ({
  // A known subtotal cannot certify a larger retained legacy quantity. A proven
  // observation may cover all retained token buckets, independently of cost.
  tokensOwnOnly:
    (left.tokensOwnOnly === true && right.tokensOwnOnly === true) ||
    coversTokens(left, right) ||
    coversTokens(right, left),
  cost: Math.max(left.cost, right.cost),
  steps: Math.max(left.steps, right.steps),
  total: Math.max(left.total, right.total),
  toolUses: Math.max(left.toolUses, right.toolUses),
  unpricedSteps: Math.max(left.unpricedSteps ?? 0, right.unpricedSteps ?? 0),
  codiumSteps: Math.max(left.codiumSteps ?? 0, right.codiumSteps ?? 0),
  tokens: {
    input: Math.max(left.tokens.input, right.tokens.input),
    output: Math.max(left.tokens.output, right.tokens.output),
    reasoning: Math.max(left.tokens.reasoning, right.tokens.reasoning),
    cache: {
      read: Math.max(left.tokens.cache.read, right.tokens.cache.read),
      write: Math.max(left.tokens.cache.write, right.tokens.cache.write),
    },
  },
})

/** The only persistence/event adapter. All model work still enters the ordinary TaskTool lifecycle. */
export const run = Effect.fn("WorkflowRuntime.run")(function* (input: Input) {
  if (!input.built.ok || !input.built.limits || !input.built.stages)
    return yield* new RuntimeError({ message: "Validate the workflow before starting its runtime." })
  const owner = yield* input.sessions.get(input.runID)
  const record = SubagentLifecycle.read(owner)
  if (
    !owner.parentID ||
    record?.parentSessionID !== owner.parentID ||
    record?.workflow?.role !== "run" ||
    (record.rootSessionID ?? owner.parentID) !== input.rootID
  )
    return yield* new RuntimeError({ message: "The workflow runner requires its own trusted run session." })
  const attempt = record.attempt
  const read = (ref: { sessionID: SessionID; messageID: string; structured: boolean }) =>
    Effect.gen(function* () {
      const child = yield* input.sessions.get(ref.sessionID)
      const workflow = SubagentLifecycle.read(child)?.workflow
      if (child.parentID !== input.runID || workflow?.role !== "agent" || workflow.runID !== input.runID)
        return yield* new RuntimeError({ message: "A workflow output reference does not belong to this run." })
      const found = yield* input.sessions.findMessage(ref.sessionID, (message) => message.info.id === ref.messageID)
      if (Option.isNone(found) || found.value.info.role !== "assistant")
        return yield* new RuntimeError({ message: "A saved workflow answer is missing." })
      if (!ref.structured)
        return found.value.parts
          .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
          .join("\n\n")
      const text = TaskStructured.latest([found.value])
      const decoded =
        text === undefined ? Option.none() : Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
      const json = Option.isSome(decoded) ? Schema.decodeUnknownOption(Schema.Json)(decoded.value) : Option.none()
      if (Option.isNone(json)) return yield* new RuntimeError({ message: "A saved workflow JSON answer is invalid." })
      return json.value
    })
  const saved = yield* WorkflowCheckpoint.load(input.checkpoints, input.runID, record)
  // A checkpoint an earlier build kept in lifecycle metadata moves to the checkpoint table on the first save.
  let legacy = record.workflow.progress.runtime !== undefined
  const seed: WorkflowRunner.State =
    saved === undefined
      ? ({ nodes: [], usage: counters(), groups: {}, sessions: {}, sessionGroups: {} } satisfies WorkflowRunner.State)
      : yield* WorkflowState.hydrate(saved, { read }).pipe(
          Effect.map((snapshot) => ({
            ...snapshot,
            // Serialized proof is historical display data. Current Session observations
            // must independently cover these quantities before runtime certifies them.
            sessions: Object.fromEntries(
              Object.entries(snapshot.sessions).map(([id, usage]) => [id, { ...usage, tokensOwnOnly: false }]),
            ),
            nodes: snapshot.nodes.map((node) =>
              !node.pendingResult?.result.usage
                ? node
                : {
                    ...node,
                    pendingResult: {
                      ...node.pendingResult,
                      result: {
                        ...node.pendingResult.result,
                        usage: { ...node.pendingResult.result.usage, tokensOwnOnly: false },
                      },
                    },
                  },
            ),
          })),
        )
  const children = yield* input.sessions.children(input.runID)
  const books = new Map<SessionID, { usage: SubagentUsage; parts: Map<string, SessionV1.StepFinishPart> }>()
  const active = new Set<SessionID>()
  const sessionGroups: Record<string, string> = Object.fromEntries(
    Object.entries(seed.sessionGroups ?? {}).filter(([, group]) => Object.hasOwn(input.built.groupLimits ?? {}, group)),
  )
  const groupOf = (stage: string) => input.built.stages!.find((entry) => entry.stage.id === stage)?.group
  const add = (part: SessionV1.StepFinishPart) => {
    const book = books.get(part.sessionID)
    if (!book) return
    const prior = book.parts.get(part.id)
    book.parts.set(part.id, part)
    const delta = (next: number, previous = 0) => next - previous
    const current = part.billing === "codium" ? zero().tokens : part.tokens
    const previous = prior?.billing === "codium" ? zero().tokens : prior?.tokens
    book.usage = {
      ...book.usage,
      // Step parts carry context figures but no positive provider identity. The
      // authoritative terminal/session observation can certify them afterward.
      tokensOwnOnly: false,
      steps: book.usage.steps + (prior ? 0 : 1),
      cost: Math.max(
        book.usage.cost,
        book.usage.cost +
          delta(part.billing === "codium" ? 0 : part.cost, prior?.billing === "codium" ? 0 : prior?.cost),
      ),
      total: Math.max(book.usage.total, book.usage.total + delta(tokens(current), tokens(previous))),
      unpricedSteps:
        (book.usage.unpricedSteps ?? 0) +
        Number(part.unpriced || part.billing === "codium") -
        Number(prior?.unpriced || prior?.billing === "codium"),
      codiumSteps:
        (book.usage.codiumSteps ?? 0) + Number(part.billing === "codium") - Number(prior?.billing === "codium"),
    }
    for (const key of ["input", "output", "reasoning"] as const)
      book.usage.tokens[key] += delta(current[key], previous?.[key])
    for (const key of ["read", "write"] as const)
      book.usage.tokens.cache[key] += delta(current.cache[key], previous?.cache[key])
  }
  // Subscribe before any launch. A task's metadata callback registers its child before model execution begins.
  yield* input.events.subscribe(MessageV2.Event.PartUpdated).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.data.part.type === "step-finish") add(event.data.part)
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  for (const child of children) {
    const lifecycle = SubagentLifecycle.read(child)
    const workflow = lifecycle?.workflow
    if (workflow?.role !== "agent" || workflow.runID !== input.runID)
      return yield* new RuntimeError({ message: "The run contains a child without trusted workflow ownership." })
    const group = sessionGroups[child.id] ?? groupOf(workflow.stage)
    if (group) sessionGroups[child.id] = group
    const messages = yield* input.sessions.messages({ sessionID: child.id })
    books.set(child.id, { usage: zero(), parts: new Map() })
    for (const message of messages)
      for (const part of message.parts) {
        if (part.type === "step-finish") add(part)
        if (part.type === "tool") books.get(child.id)!.usage.toolUses += 1
      }
    const book = books.get(child.id)!
    book.usage = mergeUsage(mergeUsage(book.usage, seed.sessions[child.id] ?? zero()), {
      ...zero(),
      tokensOwnOnly: child.tokensOwnOnly === true,
      cost: child.cost ?? 0,
      tokens: child.tokens ?? zero().tokens,
      total: tokens(child.tokens),
      unpricedSteps: child.unpricedSteps ?? 0,
      codiumSteps: child.codiumSteps ?? 0,
    })
    if (SubagentLifecycle.open(lifecycle)) active.add(child.id)
  }
  const nodes: WorkflowRunner.Node[] = []
  const recoveredUsage = { ...seed.usage }
  const recoveredGroups: Record<string, WorkflowRunner.Counters> = structuredClone(seed.groups)
  const now = yield* Clock.currentTimeMillis
  if (seed.clock && seed.clock.at > now)
    return yield* new RuntimeError({
      message:
        "The saved workflow clock is in the future; resume was refused rather than replenishing its time budget.",
    })
  if (seed.clock?.active) {
    const stops = [record.interruption?.at, record.completedAt, record.stop?.at].filter(
      (at): at is number => at !== undefined && at >= seed.clock!.at && at <= now,
    )
    const elapsed = Math.max(0, Math.min(now, ...stops) - seed.clock.at)
    recoveredUsage.elapsedMs += elapsed
    for (const id of seed.clock.groups)
      recoveredGroups[id] = { ...recoveredGroups[id], elapsedMs: recoveredGroups[id].elapsedMs + elapsed }
  }
  for (const node of seed.nodes) {
    if (!node.pendingLaunch || node.pendingResult) {
      nodes.push(node)
      continue
    }
    const matches = children.filter((child) => {
      const workflow = SubagentLifecycle.read(child)?.workflow
      return workflow?.role === "agent" && workflow.key === node.pendingLaunch!.key
    })
    if (matches.length > 1)
      return yield* new RuntimeError({
        message: "Multiple workflow children match one durable launch; refusing an ambiguous resume.",
      })
    const child = matches[0]
    const priorID = node.pendingLaunch.verifier ? node.verifierID : node.sessionID
    if (!child && !priorID) {
      // Admission was checkpointed but no Session was created; release just that unused reservation.
      recoveredUsage.launched = Math.max(0, recoveredUsage.launched - 1)
      const group = groupOf(node.stage)
      if (group && recoveredGroups[group])
        recoveredGroups[group] = {
          ...recoveredGroups[group],
          launched: Math.max(0, recoveredGroups[group].launched - 1),
        }
      nodes.push({ ...node, pendingLaunch: undefined })
      continue
    }
    if (!child && priorID) {
      if (!books.has(priorID))
        return yield* new RuntimeError({ message: "A workflow child needed for resume is missing." })
      nodes.push(node)
      continue
    }
    const lifecycle = SubagentLifecycle.read(child!)!
    const verify = node.pendingLaunch.verifier
    let recovered: WorkflowRunner.Node = { ...node, ...(verify ? { verifierID: child!.id } : { sessionID: child!.id }) }
    if (!SubagentLifecycle.open(lifecycle) && !lifecycle.interruption) {
      const stage = input.built.stages.find((entry) => entry.stage.id === node.stage)?.stage
      const outputSchema = verify ? stage?.verify?.output?.schema : stage?.output?.schema
      const answer = yield* input.sessions.findMessage(child!.id, (message) => message.info.role === "assistant")
      const messageID = Option.isSome(answer) ? answer.value.info.id : undefined
      const output =
        lifecycle.status === "completed" && messageID
          ? yield* read({ sessionID: child!.id, messageID, structured: outputSchema !== undefined })
          : undefined
      const invalid = outputSchema && JsonSchemaCheck.validate(outputSchema, output).length > 0
      recovered = {
        ...recovered,
        pendingLaunch: undefined,
        pendingResult: {
          verifier: verify,
          round: node.pendingLaunch.round,
          result: {
            sessionID: child!.id,
            messageID,
            status:
              lifecycle.status === "cancelled"
                ? "cancelled"
                : lifecycle.status === "completed" && !invalid
                  ? "completed"
                  : "failed",
            error: invalid ? "The saved workflow answer did not satisfy its schema." : lifecycle.error,
            output,
            usage: books.get(child!.id)!.usage,
          },
        },
      }
    }
    nodes.push(recovered)
  }
  const sessions = { ...seed.sessions, ...Object.fromEntries([...books].map(([id, book]) => [id, book.usage])) }
  const totals = (group?: string) =>
    Object.entries(sessions)
      .filter(([id]) => group === undefined || sessionGroups[id] === group)
      .reduce(
        (sum, [, usage]) => ({
          steps: sum.steps + usage.steps,
          tokens: sum.tokens + usage.total,
          spentUsd: sum.spentUsd + usage.cost,
          unpricedSteps: sum.unpricedSteps + (usage.unpricedSteps ?? 0),
          codiumSteps: sum.codiumSteps + (usage.codiumSteps ?? 0),
        }),
        { steps: 0, tokens: 0, spentUsd: 0, unpricedSteps: 0, codiumSteps: 0 },
      )
  const liveTotals = (group?: string) => {
    for (const [id, book] of books) sessions[id] = book.usage
    return totals(group)
  }
  const recovered: WorkflowRunner.State = {
    ...seed,
    nodes,
    sessions,
    sessionGroups,
    uncertain: false,
    usage: {
      ...recoveredUsage,
      launched: Math.max(recoveredUsage.launched, children.length),
      steps: Math.max(recoveredUsage.steps, totals().steps),
      tokens: Math.max(recoveredUsage.tokens, totals().tokens, tokens(owner.subagentTokens)),
      spentUsd: Math.max(recoveredUsage.spentUsd, totals().spentUsd, owner.subagentCost ?? 0),
    },
    groups: Object.fromEntries(
      Object.entries(recoveredGroups).map(([id, usage]) => [
        id,
        {
          ...usage,
          steps: Math.max(usage.steps, totals(id).steps),
          tokens: Math.max(usage.tokens, totals(id).tokens),
          spentUsd: Math.max(usage.spentUsd, totals(id).spentUsd),
        },
      ]),
    ),
  }
  // Transient full-results artifacts may have expired. Recreate them from pinned answers before exposing their paths.
  const files = { ...recovered.files }
  for (const [id, file] of Object.entries(files)) {
    const valid = yield* Effect.gen(function* () {
      const stat = yield* input.fs.stat(file.path)
      if (stat.type !== "File" || stat.size > WorkflowState.LIMIT.hydratedBytes) return false
      const text = yield* input.fs.readFileString(file.path)
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
      return Option.isSome(parsed) && WorkflowPlan.key(parsed.value) === file.digest
    }).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!valid) delete files[id]
  }
  const ledger = yield* WorkflowLedger.make({
    guard: input.guard,
    runID: input.runID,
    groups: Object.fromEntries(
      Object.entries(input.built.groupLimits ?? {}).map(([id, limit]) => [
        id,
        {
          budget: { steps: limit.steps, ...(limit.usd === undefined ? {} : { usd: limit.usd }) },
          used: WorkflowLedger.fromDisplay({
            ...totals(id),
            steps: Math.max(totals(id).steps, recovered.groups[id]?.steps ?? 0),
            cost: Math.max(totals(id).spentUsd, recovered.groups[id]?.spentUsd ?? 0),
          }),
        },
      ]),
    ),
  })
  const launcher = WorkflowLaunch.make(input)
  // Once this attempt has saved its checkpoint row, the record keeps only small progress fields: a legacy runtime copy is
  // dropped rather than rewritten into the Session and its durable update event on every progress save.
  let stored = false
  const save = (patch: Record<string, unknown>) =>
    SubagentLifecycle.modify(input.sessions, input.runID, (current) => {
      if (current.attempt !== attempt || current.workflow?.role !== "run") return { value: false }
      const { runtime: retained, ...progress } = current.workflow.progress
      return {
        value: true,
        patch: {
          workflow: {
            ...current.workflow,
            progress: { ...progress, ...(stored || retained === undefined ? {} : { runtime: retained }), ...patch },
          },
        },
      }
    }).pipe(
      Effect.flatMap((ok) =>
        ok ? Effect.void : Effect.die(new Error("The workflow attempt lost ownership of its durable record.")),
      ),
      Effect.orDie,
    )
  let lastDigest: string | undefined
  let lastAccounting: WorkflowCheckpoint.Accounting | undefined
  let lastPoll = -Infinity
  let rollup = {
    tokens: tokens(owner.subagentTokens),
    spentUsd: owner.subagentCost ?? 0,
    unpricedSteps: owner.subagentUnpricedSteps ?? 0,
    codiumSteps: owner.subagentCodiumSteps ?? 0,
  }
  let waiting: Record<string, number> = {}
  const observe = Effect.fn("WorkflowRuntime.observe")(function* () {
    const now = yield* Clock.currentTimeMillis
    if (now - lastPoll >= 1000) {
      const info = yield* input.sessions.get(input.runID).pipe(Effect.orDie)
      rollup = {
        tokens: tokens(info.subagentTokens),
        spentUsd: info.subagentCost ?? 0,
        unpricedSteps: info.subagentUnpricedSteps ?? 0,
        codiumSteps: info.subagentCodiumSteps ?? 0,
      }
      waiting = {}
      for (const id of active) {
        const child = yield* input.sessions.get(id).pipe(Effect.orDie)
        const lifecycle = SubagentLifecycle.read(child)
        if (lifecycle?.waiting) waiting[id] = lifecycle.waiting.since
        if (!SubagentLifecycle.open(lifecycle)) active.delete(id)
      }
      lastPoll = now
    }
    const view = yield* ledger.inspect().pipe(Effect.orDie)
    const total = liveTotals()
    const groups: NonNullable<WorkflowRunner.Observation["groups"]> = Object.fromEntries(
      yield* Effect.forEach(Object.keys(input.built.groupLimits ?? {}), (id) =>
        Effect.gen(function* () {
          const nested = yield* ledger.inspect(id).pipe(Effect.orDie)
          return [id, { ...liveTotals(id), ledgerStopped: !!nested.groupStop, delegatedStopped: !!nested.ancestorStop }]
        }),
      ),
    )
    return {
      usage: {
        steps: Math.max(total.steps, recovered.usage.steps),
        tokens: Math.max(total.tokens, rollup.tokens, recovered.usage.tokens),
        spentUsd: Math.max(total.spentUsd, rollup.spentUsd, recovered.usage.spentUsd),
        ledgerStopped: !!view.ancestorStop && view.ancestorStop.kind !== "delegated",
        delegatedStopped: view.ancestorStop?.kind === "delegated",
      },
      groups,
      waiting,
      unpricedSteps: Math.max(total.unpricedSteps, rollup.unpricedSteps),
      codiumSteps: Math.max(total.codiumSteps, rollup.codiumSteps),
    }
  })
  return yield* WorkflowRunner.schedule(
    { ...input, seed: { ...recovered, files } },
    {
      initial: input.sources.initial,
      observe,
      launch: (request, onSession) =>
        Effect.gen(function* () {
          const group = groupOf(request.marker.stage)
          const parent = yield* ledger.parent(group).pipe(Effect.orDie)
          return yield* launcher
            .node({ ...request, guardParent: parent }, (id) =>
              Effect.gen(function* () {
                if (!books.has(id)) books.set(id, { usage: zero(), parts: new Map() })
                if (group) sessionGroups[id] = group
                active.add(id)
                yield* onSession(id)
              }),
            )
            .pipe(
              Effect.orDie,
              Effect.map((result) => {
                if (!result.sessionID) return result
                active.delete(result.sessionID)
                const book = books.get(result.sessionID)
                if (book && result.usage) book.usage = mergeUsage(book.usage, result.usage)
                return book && result.usage ? { ...result, usage: book.usage } : result
              }),
            )
        }),
      checkpoint: (state) =>
        Effect.gen(function* () {
          liveTotals()
          const cumulative = { ...state.sessions }
          for (const [id, value] of Object.entries(sessions))
            cumulative[id] = mergeUsage(cumulative[id] ?? zero(), value)
          const compact = yield* WorkflowState.encode({
            ...state,
            sessions: cumulative,
            sessionGroups: { ...sessionGroups, ...state.sessionGroups },
          }).pipe(Effect.orDie)
          const data = JSON.stringify(compact)
          const digest = WorkflowCheckpointStore.digest(data)
          if (digest !== lastDigest) {
            const current = SubagentLifecycle.read(yield* input.sessions.get(input.runID).pipe(Effect.orDie))
            if (!current || current.attempt !== attempt || current.workflow?.role !== "run")
              return yield* Effect.die(new Error("The workflow attempt lost ownership of its durable record."))
            if (!(yield* input.checkpoints.write({ sessionID: input.runID, attempt: attempt ?? 0, data })))
              return yield* Effect.die(new Error("A newer workflow attempt owns the durable checkpoint."))
            lastDigest = digest
            stored = true
          }
          // Lifecycle observation reads this small summary; it is rewritten only when the totals change.
          const summary = WorkflowCheckpoint.accounting({ usage: state.usage, sessions: cumulative })
          if (legacy || summary.steps !== lastAccounting?.steps || summary.toolUses !== lastAccounting.toolUses) {
            yield* save({ accounting: summary })
            lastAccounting = summary
            legacy = false
          }
        }),
      progress: (progress) => save(progress),
      write: (value: Json) => input.truncate.write(JSON.stringify(value)),
      finish: (report) => launcher.finish(report).pipe(Effect.andThen(save({ report }))),
    },
  )
})

export * as WorkflowRuntime from "./runtime"
