import type { Event, VectorClient, WorkflowStartInput, WorkflowRunDetail } from "@vectordevai/sdk/v2"
import { sanitizeTerminalText } from "@vectordevai/tui/util/presentation"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { isRecord } from "@/util/record"
import { assertWorkflowOwner, formatWorkflowPlan, requireWorkflowCapability } from "../workflow"
import { backgroundTracker, nextBackgroundEvent } from "./background-wait"

type Output = { stdout: (text: string) => void; stderr: (text: string) => void }

/** Owner workflow execution over the same SDK in both attached and in-process modes. */
export async function runWorkflow(
  client: VectorClient,
  input: { sessionID: string; source: WorkflowStartInput; summarize?: boolean; auto?: boolean; timeout?: number },
  output: Output,
) {
  await assertWorkflowOwner("start workflows")
  const abort = new AbortController()
  let activeAt = Date.now()
  const timeout = input.timeout ?? 10 * 60 * 1000
  const request = async <T>(call: (signal: AbortSignal) => Promise<T>, until = activeAt + timeout) => {
    abort.signal.throwIfAborted()
    const operation = new AbortController()
    const expired = Promise.withResolvers<never>()
    const timer = setTimeout(
      () => {
        operation.abort()
        expired.reject(new Error("Workflow request timed out before completion was confirmed"))
      },
      Math.max(0, until - Date.now()),
    )
    try {
      return await Promise.race([call(AbortSignal.any([abort.signal, operation.signal])), expired.promise])
    } finally {
      clearTimeout(timer)
      operation.abort()
    }
  }
  await request((signal) => requireWorkflowCapability(client, "start", signal))
  const validation = (
    await request((signal) =>
      client.experimental.workflow.validate(
        { workflowValidateInput: { spec: input.source.spec, name: input.source.name, inputs: input.source.inputs } },
        { throwOnError: true, signal },
      ),
    )
  ).data
  if (!validation?.ok || !validation.plan)
    throw new Error(
      validation?.issues.map((issue) => sanitizeTerminalText(`${issue.path}: ${issue.message}`)).join("\n") ||
        "Invalid workflow",
    )
  for (const warning of validation.warnings) output.stderr(`Warning: ${sanitizeTerminalText(warning.message)}\n`)
  output.stderr(formatWorkflowPlan(validation.plan) + "\n")

  const events = await client.event.subscribe(undefined, { signal: abort.signal, sseMaxRetryAttempts: 1 })
  const iterator = events.stream[Symbol.asyncIterator]()
  const tracker = backgroundTracker()
  const tree = new Set<string>()
  const summary = new Map<string, { messageID: string; text: string }>()
  const assistants = new Map<string, { parentID: string; completed?: number; failed: boolean }>()
  let latestAssistant: { parentID: string; completed?: number; id: string } | undefined
  let runID: string | undefined
  let uncertainStart = false
  let detail: WorkflowRunDetail | undefined
  let idle = false
  let failed = false
  let lastProgress = ""
  const settleSummary = () => {
    const note = runID && tracker.noted.get(runID)
    if (!note) return
    for (const [id, assistant] of assistants) {
      if (assistant.parentID !== note.messageID || assistant.completed === undefined) continue
      tracker.answer(id)
      if (assistant.failed) failed = true
    }
  }
  const terminal = () => detail && ["completed", "failed", "stopped"].includes(detail.task.status)
  const inspect = async () => {
    detail = (
      await request((signal) =>
        client.experimental.workflow.get({ sessionID: input.sessionID, runID: runID! }, { throwOnError: true, signal }),
      )
    ).data
    if (!detail) throw new Error("The workflow engine returned no run details")
    tracker.status(runID!, detail.task.status, detail.task.attempt)
    const progress = [
      `${runID}: ${detail.task.status}`,
      ...(detail.task.workflow?.stages ?? []).map(
        (stage) =>
          `${stage.title || stage.id} ${stage.done}/${stage.total ?? "?"} done, ${stage.running} running, ${stage.failed} failed`,
      ),
    ]
      .map(sanitizeTerminalText)
      .join(" · ")
    if (progress !== lastProgress) output.stderr(progress + "\n")
    lastProgress = progress
  }
  const inRun = async (sessionID: string, depth = 0): Promise<boolean> => {
    if (tree.has(sessionID)) return true
    if (sessionID === input.sessionID) return false
    if (depth > 4) return false
    const parent = (await request((signal) => client.session.get({ sessionID }, { throwOnError: true, signal }))).data
      ?.parentID
    if (!parent || !(await inRun(parent, depth + 1))) return false
    tree.add(sessionID)
    return true
  }
  try {
    // subscribe() is lazy: consume the connected event before starting so a fast
    // run's terminal event and quiet note cannot fall into a subscription gap.
    const connected = await nextBackgroundEvent(iterator, Math.min(timeout, 10_000), true)
    if (connected.timedOut || connected.disconnected || connected.event.done)
      throw new Error("Could not subscribe to workflow progress; the workflow was not started")
    uncertainStart = true
    const start = await request((signal) =>
      client.experimental.workflow.start(
        { sessionID: input.sessionID, workflowStartInput: { ...input.source, quiet: !input.summarize } },
        { throwOnError: false, signal },
      ),
    )
    if (start.response) uncertainStart = false
    if (start.error) throw start.error
    const started = start.data
    if (!started?.runID) {
      uncertainStart = true
      throw new Error("The workflow engine returned no run ID")
    }
    runID = started.runID
    tree.add(runID)
    await inspect()

    while (true) {
      // A quiet note is already answered. A requested summary must finish its
      // actual parent turn before an in-process engine may shut down.
      if (terminal() && tracker.settled() && (!input.summarize || idle)) break
      const next = await nextBackgroundEvent<Event>(iterator, timeout - (Date.now() - activeAt), true)
      if (next.timedOut || next.disconnected || next.event.done)
        throw new Error(
          next.timedOut
            ? "Workflow progress timed out before completion was confirmed"
            : "The workflow event stream ended before completion was confirmed",
        )
      const event = next.event.value
      if (
        (event.type === "session.created" || event.type === "session.updated") &&
        event.properties.info.id === runID
      ) {
        activeAt = Date.now()
        await inspect()
      }
      if (event.type === "session.status" && event.properties.sessionID === input.sessionID) {
        activeAt = Date.now()
        idle = event.properties.status.type === "idle"
      }
      if (
        event.type === "message.updated" &&
        event.properties.sessionID === input.sessionID &&
        event.properties.info.role === "assistant"
      ) {
        activeAt = Date.now()
        assistants.set(event.properties.info.id, {
          parentID: event.properties.info.parentID,
          completed: event.properties.info.time.completed,
          failed: event.properties.info.error !== undefined,
        })
        if (!latestAssistant || event.properties.info.id >= latestAssistant.id)
          latestAssistant = {
            id: event.properties.info.id,
            parentID: event.properties.info.parentID,
            completed: event.properties.info.time.completed,
          }
        settleSummary()
      }
      if (
        event.type === "message.part.updated" &&
        event.properties.part.sessionID === input.sessionID &&
        event.properties.part.type === "text"
      ) {
        const part = event.properties.part
        const note = part.metadata?.taskNotification
        if (isRecord(note) && note.taskID === runID) {
          activeAt = Date.now()
          tracker.note(
            runID,
            part.messageID,
            note.quiet === true,
            typeof note.attempt === "number" ? note.attempt : undefined,
          )
          settleSummary()
        } else if (input.summarize && part.time?.end) {
          summary.set(part.id, { messageID: part.messageID, text: part.text })
        }
      }
      if (event.type === "session.error" && event.properties.sessionID === input.sessionID) {
        // Session errors have no causal message ID; only an owned assistant
        // error can classify this workflow's summary as failed.
        const error = event.properties.error
        output.stderr(
          sanitizeTerminalText(
            error && "data" in error && "message" in error.data
              ? String(error.data.message)
              : (error?.name ?? "Workflow summary failed"),
          ) + "\n",
        )
      }
      if (
        event.type === "permission.asked" &&
        ((event.properties.sessionID === input.sessionID &&
          input.summarize &&
          latestAssistant &&
          tracker.noted.has(runID) &&
          latestAssistant.parentID === tracker.noted.get(runID)?.messageID &&
          latestAssistant.completed === undefined) ||
          (await inRun(event.properties.sessionID)))
      ) {
        activeAt = Date.now()
        const permission = event.properties
        const allow =
          input.auto && PermissionPolicy.canAutoApprove(permission.permission, permission.always, permission.patterns)
        if (!allow)
          output.stderr(
            `Permission ${sanitizeTerminalText(permission.permission)} was rejected in this non-interactive run.\n`,
          )
        await request((signal) =>
          client.permission.reply(
            { requestID: permission.id, reply: allow ? "once" : "reject" },
            { throwOnError: true, signal },
          ),
        )
      }
    }
    await inspect()
    if (detail?.report) output.stdout(detail.report.split("\n").map(sanitizeTerminalText).join("\n") + "\n")
    if (input.summarize) {
      // The launch acknowledgement predates the completion note and is not a summary.
      const note = tracker.noted.get(runID)
      if (note)
        for (const part of summary.values()) {
          if (assistants.get(part.messageID)?.parentID !== note.messageID) continue
          output.stdout(part.text.split("\n").map(sanitizeTerminalText).join("\n") + "\n")
        }
    }
    return { runID, exitCode: failed || detail?.task.status !== "completed" ? 1 : 0 }
  } catch (error) {
    if (uncertainStart && !runID)
      output.stderr(
        `The workflow may have started. Check workflow runs in conversation ${sanitizeTerminalText(input.sessionID)} before retrying.\n`,
      )
    const until = Date.now() + Math.min(timeout, 5_000)
    const stoppedRunID = runID
    if (stoppedRunID && !terminal())
      await request(
        (signal) =>
          client.experimental.task.stop(
            {
              sessionID: input.sessionID,
              taskIDs: [stoppedRunID],
              reason: "Workflow CLI disconnected or failed before completion",
            },
            { signal, throwOnError: true },
          ),
        until,
      ).catch(() => undefined)
    if (runID && input.summarize) {
      // Recheck current history so a later human turn is never intentionally
      // aborted just because this CLI's workflow already finished.
      await request(
        (signal) => client.session.messages({ sessionID: input.sessionID, limit: 10 }, { signal, throwOnError: true }),
        until,
      )
        .then(async (messages) => {
          const ordered = (messages.data ?? []).toSorted((a, b) => a.info.id.localeCompare(b.info.id))
          const user = ordered.findLast((message) => message.info.role === "user")
          const assistant = ordered.findLast((message) => message.info.role === "assistant")
          const owned = user?.parts.some(
            (part) =>
              part.type === "text" &&
              isRecord(part.metadata?.taskNotification) &&
              part.metadata.taskNotification.taskID === runID,
          )
          if (
            !owned ||
            (assistant?.info.role === "assistant" &&
              user &&
              assistant.info.id > user.info.id &&
              (assistant.info.parentID !== user.info.id || assistant.info.time.completed !== undefined))
          )
            return
          await request(
            (signal) =>
              client.experimental.session.stop(
                {
                  sessionID: input.sessionID,
                  helpers: false,
                  reason: "Workflow CLI disconnected before its summary completed",
                },
                { signal, throwOnError: true },
              ),
            until,
          )
        })
        .catch(() => output.stderr("Could not confirm that the workflow summary stopped; check the conversation.\n"))
    }
    throw error
  } finally {
    abort.abort()
    const finished = Promise.withResolvers<void>()
    const timer = setTimeout(() => finished.resolve(), Math.min(timeout, 5_000))
    await Promise.race([iterator.return?.().catch(() => undefined), finished.promise]).finally(() =>
      clearTimeout(timer),
    )
  }
}
