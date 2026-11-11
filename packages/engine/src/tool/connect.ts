import { Effect, Schema } from "effect"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectFrame } from "@vectordevai/core/connect/frame"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectHub } from "@/connect/hub"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import type { TaskSizeContext } from "./escalate"
// Types only: the prompt calls arrive in `ctx.extra.promptOps`, and the hub builds its helper handle from them.
import type { TaskPromptOps } from "./task"
import { Tool } from "./tool"
import DESCRIPTION from "./connect.txt"

// connect: the build agent's way to hand work to a connected tool. Through Phase C the only member that takes
// hand-offs is VectorScope, so the model sees no member list, only this tool, whose description names VectorScope.
// The tool is offered only while `experimentalConnect` is on, and only to the build agent (registry.ts); here it also
// refuses a subagent, a hidden helper, a session an invited guest is in, and a review on a Light request. Everything
// else is the hub's: the effect check, the requester's read rules, the per-request cap, the consents (asked through
// this call's `ctx.ask`), the run record and the events. A review's run is saved in this call's metadata
// (`ConnectHub.metadata`), so `since`, `findings` and `status` find it again after a restart. The other actions save
// no run, so a later request's cap never counts an earlier review again. What a reviewer wrote reaches the model only
// inside the untrusted block `ConnectFrame` builds. Foreground only until CW-08.

export const CONNECT_TOOL = "connect"

const RunRef = Schema.String.check(Schema.isLengthBetween(1, 64))

export const Parameters = Schema.Struct({
  action: Schema.Literals(["review", "findings", "status", "cancel"]).annotate({
    description:
      "review: review the changes. findings: a review's findings in full. status: one run, or this conversation's recent runs. cancel: stop a run that is going",
  }),
  to: Schema.optional(Schema.Literal("vectorscope")).annotate({
    description: "The connected tool: vectorscope (the default, and the only one)",
  }),
  target: Schema.optional(Schema.Literals(["uncommitted", "staged", "branch"])).annotate({
    description:
      "For review: uncommitted (default: the working tree against HEAD, untracked files included), staged, or branch (against its merge base)",
  }),
  base: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 256))).annotate({
    description: "For target branch only: the ref to compare against",
  }),
  security: Schema.optional(Schema.Boolean).annotate({
    description:
      "For review: true always runs the security pass, false never does; leave it out to let VectorScope decide",
  }),
  since: Schema.optional(RunRef).annotate({
    description:
      "For review: an earlier review's run id of the same target kind, to mark findings fixed, still open or new",
  }),
  run: Schema.optional(RunRef).annotate({
    description: "For findings, status and cancel: the run id a review returned",
  }),
  findings: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 200))).check(Schema.isMaxLength(Connect.MAX_FINDINGS)),
  ).annotate({
    description: "For findings: only these finding ids",
  }),
  max_cost: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
    description: "For review: a dollar cap greater than 0; it can only lower connect's cap",
  }),
})
export type Params = Schema.Schema.Type<typeof Parameters>

/** What the tool says when connected tools are off. The registry does not offer the tool then. */
export const OFF = "Connected tools are off in this build (VECTOR_EXPERIMENTAL_CONNECT)."
/** What a Light request gets: reviews run on Work and Thorough requests. */
export const LIGHT =
  "VectorScope reviews run on Work and Thorough requests, not on a Light one. Call escalate if the work needs a review."
/** What a request the engine did not size gets: only the conversation's own requests are sized. */
export const UNSIZED =
  "VectorScope reviews run on the conversation's own Work and Thorough requests, and this request has no size, so connect did not start one."
/** What a subagent or one of Vector's helpers gets: only the conversation's own agent hands work off. */
export const SUBAGENT =
  "Only the conversation's own agent can hand work to VectorScope, not a subagent or a helper. Say in your report what should be reviewed instead."
/** What a session an invited guest is in gets. */
export const GUEST =
  "An invited guest is in this conversation, so connect does not hand work to VectorScope here. The owner can ask for a review in their own conversation."
/** What any agent but build gets. */
export const NOT_BUILD = "Only the build agent hands work to VectorScope."

/** The most runs `status` lists without a run id. */
export const STATUS_RUNS = 10

export const ConnectTool = Tool.define(
  CONNECT_TOOL,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const hub = yield* ConnectHub.Service
    const sessions = yield* Session.Service
    const guests = yield* FreeModelGuests.Service

    const review = Effect.fnUntraced(function* (params: Params, ctx: Tool.Context) {
      const size = ctx.extra?.taskSize as TaskSizeContext | undefined
      if (!size) return refused(params.action, "not-allowed", "Not reviewed", UNSIZED)
      if (size.tier === "light" || size.tier === "chat")
        return refused(params.action, "escalate", "Not reviewed", LIGHT)
      if (params.run !== undefined || params.findings !== undefined)
        return refused(
          params.action,
          "input",
          "Not reviewed",
          "run and findings are for the findings, status and cancel actions. A review takes target, base, security, since and max_cost.",
        )
      const kind = params.target ?? "uncommitted"
      if (params.base !== undefined && kind !== "branch")
        return refused(params.action, "input", "Not reviewed", "base is for target branch only.")
      // The schema already holds max_cost above 0; this keeps the tool's word the same as the policy's.
      const cost = ConnectPolicy.maxCostInput(params.max_cost)
      if (!cost.ok) return refused(params.action, "input", "Not reviewed", cost.refusal.message)
      const target: Connect.Target =
        kind === "branch" ? { kind, ...(params.base !== undefined ? { base: params.base } : {}) } : { kind }
      const directory = (yield* InstanceState.context).directory
      const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
      // The hub holds the whole request to the schema (a `since` that is not a run id is refused there with `input`)
      // and derives the request id itself, from the message the user last wrote.
      const run = yield* hub.run({
        request: {
          to: params.to ?? "vectorscope",
          action: "review",
          target,
          requester: { kind: "agent", sessionID: ctx.sessionID, agent: ctx.agent },
          directory,
          background: false,
          ...(params.security !== undefined ? { security: params.security } : {}),
          ...(params.since !== undefined ? { since: params.since as Connect.RunID } : {}),
          ...(cost.value !== undefined ? { budget: { maxCostUsd: cost.value } } : {}),
        },
        call: {
          ask: (request) => ctx.ask(request),
          ...(promptOps ? { promptOps } : {}),
          abort: ctx.abort,
          // Progress streams into this call's part; a part cut off mid-run reads back as cancelled (`settled`).
          update: (next) => ctx.metadata({ title: titleOf(next), metadata: ConnectHub.metadata(next) }),
        },
      })
      const result = run.result
      if (!result) return { title: titleOf(run), output: "The review did not end.", metadata: ConnectHub.metadata(run) }
      const comparable = result.state === "completed" || result.state === "partial"
      return {
        title: titleOf(run),
        output: ConnectFrame.frame(result, comparable ? { run: run.id } : {}),
        metadata: ConnectHub.metadata(run),
      }
    })

    const findings = Effect.fnUntraced(function* (params: Params, ctx: Tool.Context) {
      if (params.run === undefined)
        return refused(params.action, "input", "No findings", "findings needs run: the id a review returned.")
      const found = yield* hub.get(params.run, ctx.sessionID)
      if (!found || found.request.action !== "review")
        return plain(params, "No findings", `There is no review ${params.run} in this conversation.`)
      if (!found.result)
        return plain(params, "No findings", `${found.id} is still ${found.status}; its findings arrive when it ends.`)
      const all = found.result.findings
      const wanted = params.findings ? new Set(params.findings) : undefined
      const chosen = wanted ? all.filter((finding) => wanted.has(finding.id)) : all
      const missing = wanted ? [...wanted].filter((id) => !all.some((finding) => finding.id === id)) : []
      const lines = [
        `${found.id}: ${ConnectFindings.targetWords(found.result.target ?? found.request.target)}, verdict ${ConnectFrame.shownVerdict(found.result)}.`,
        ...(found.result.sendsTo
          ? [`Where the diff went: ${ConnectFrame.describeSendsTo(found.result.sendsTo)}.`]
          : []),
        ...(missing.length
          ? [`This review has no finding ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}.`]
          : []),
      ]
      if (chosen.length === 0) {
        lines.push(all.length === 0 ? "This review has no findings." : "No finding matched those ids.")
        return plain(params, "No findings", lines.join("\n"))
      }
      const block = ConnectFrame.untrustedBlock(chosen, { bodies: true })
      lines.push(ConnectFrame.FINDINGS_PREAMBLE, block.text)
      if (block.shortened || block.omitted)
        lines.push(
          `${block.shortened + block.omitted} of ${chosen.length} findings are shown without a body or not at all, to keep this short. Pass their ids in findings to read them.`,
        )
      return plain(params, `${chosen.length} ${chosen.length === 1 ? "finding" : "findings"}`, lines.join("\n"))
    })

    const status = Effect.fnUntraced(function* (params: Params, ctx: Tool.Context) {
      if (params.run !== undefined) {
        const found = yield* hub.get(params.run, ctx.sessionID)
        if (!found) return plain(params, "No run", `There is no run ${params.run} in this conversation.`)
        return plain(params, titleOf(found), describe(found).join("\n"))
      }
      const list = (yield* hub.runs({ sessionID: ctx.sessionID })).slice(0, STATUS_RUNS)
      if (list.length === 0) return plain(params, "No runs", "This conversation has no connect runs yet.")
      return plain(
        params,
        `${list.length} ${list.length === 1 ? "run" : "runs"}`,
        list.map((run) => `- ${line(run)}`).join("\n"),
      )
    })

    const cancel = Effect.fnUntraced(function* (params: Params, ctx: Tool.Context) {
      if (params.run === undefined)
        return refused(params.action, "input", "Not cancelled", "cancel needs run: the id of a run that is going.")
      const stopped = yield* hub.cancel(params.run, { sessionID: ctx.sessionID })
      return stopped
        ? plain(params, "Cancelled", `Cancelled ${params.run}.`)
        : plain(
            params,
            "Not cancelled",
            `No run ${params.run} of this conversation is going, so nothing was cancelled.`,
          )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!flags.experimentalConnect) return refused(params.action, "not-allowed", "Connected tools off", OFF)
          if (ctx.agent !== "build") return refused(params.action, "not-allowed", "Not allowed", NOT_BUILD)
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          // A subagent or one of Vector's hidden helpers never hands work off (no chains, I9).
          if (!session || ctx.parentID !== undefined || session.parentID !== undefined || session.internal)
            return refused(params.action, "not-allowed", "Not allowed", SUBAGENT)
          if (yield* guests.marked(ctx.sessionID)) return refused(params.action, "not-allowed", "Not allowed", GUEST)
          if (params.action === "review") return yield* review(params, ctx)
          if (params.action === "findings") return yield* findings(params, ctx)
          if (params.action === "status") return yield* status(params, ctx)
          return yield* cancel(params, ctx)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)

/** The title of a run's tool call. */
export function titleOf(run: Connect.Run): string {
  if (run.status !== "done" || !run.result)
    return run.progress?.message ? `VectorScope: ${run.progress.message}` : "VectorScope review"
  const state = run.result.state
  if (state === "refused") return "VectorScope did not review"
  if (state === "failed") return "VectorScope review failed"
  if (state === "cancelled") return "VectorScope review cancelled"
  return `VectorScope review: ${ConnectFrame.shownVerdict(run.result)}`
}

/** One run in a line, for `status` without a run id. */
function line(run: Connect.Run): string {
  const what =
    run.request.action === "review"
      ? `review of ${ConnectFindings.targetWords(run.result?.target ?? run.request.target)}`
      : `fix of ${run.request.findings.length} ${run.request.findings.length === 1 ? "finding" : "findings"} from ${run.request.run}`
  if (run.status !== "done" || !run.result)
    return `${run.id}: ${what}, ${run.status}${run.progress ? ` (${run.progress.message})` : ""}`
  const result = run.result
  const verdict = run.request.action === "review" ? `, verdict ${ConnectFrame.shownVerdict(result)}` : ""
  const count = result.findings.length
    ? `, ${result.findings.length} ${result.findings.length === 1 ? "finding" : "findings"}`
    : ""
  return `${run.id}: ${what}, ${result.state}${verdict}${count}`
}

/** A run in a few lines, for `status` with a run id. Only Vector's own words: no finding text. */
function describe(run: Connect.Run): string[] {
  const lines = [line(run)]
  const result = run.result
  if (!result) return lines
  if (result.summary) lines.push(result.summary)
  if (result.sendsTo) lines.push(`Where the diff went: ${ConnectFrame.describeSendsTo(result.sendsTo)}.`)
  const cost = ConnectFrame.describeCost(result.cost, result.sendsTo)
  if (cost) lines.push(`Cost: ${cost}.`)
  if (result.findings.length) lines.push(`Call connect with action findings and run ${run.id} to read the findings.`)
  return lines
}

function refused(
  action: Params["action"],
  code: Connect.RefusalCode,
  title: string,
  output: string,
): Tool.ExecuteResult {
  return { title, output, metadata: { action, refused: code } }
}

function plain(params: Params, title: string, output: string): Tool.ExecuteResult {
  return { title, output, metadata: { action: params.action, ...(params.run ? { run: params.run } : {}) } }
}
