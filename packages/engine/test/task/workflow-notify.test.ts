import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowRuns } from "@/orchestration/runs"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTaskSize } from "@/session/task-size"
import { TaskNotify } from "@/task/notify"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { isRecord } from "@/util/record"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { fixture, layer, spec } from "../tool/workflow-fixture"

afterEach(disposeAllInstances)
const it = testEffect(layer())

const completed = Effect.fn("WorkflowNotifyTest.completed")(function* () {
  const f = yield* fixture()
  const runs = yield* WorkflowRuns.Service
  const jobs = yield* BackgroundJob.Service
  const started = yield* runs.launch({
    ctx: { ...f.ctx, extra: { ...f.ctx.extra, [WorkflowMarkers.USER_START]: true } },
    input: { spec: JSON.stringify(spec) },
    task: f.task,
  })
  const runID = SessionID.make(started.runID)
  const result = yield* awaitWithTimeout(jobs.wait({ id: runID }), "Workflow did not finish", "5 seconds")
  expect(result.info?.status).toBe("completed")
  return { ...f, runID }
})

it.instance(
  "owner-started workflows default to a durable quiet root completion with workflow resume guidance",
  () =>
    Effect.gen(function* () {
      const f = yield* completed()
      const stored = yield* pollWithTimeout(
        f.sessions
          .messages({ sessionID: f.parent.id })
          .pipe(
            Effect.map((messages) =>
              messages.find((message) =>
                message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    isRecord(part.metadata?.taskNotification) &&
                    part.metadata.taskNotification.taskID === f.runID,
                ),
              ),
            ),
          ),
        "The workflow completion note never reached its root",
      )
      const prompt = f.prompts.find((input) => input.sessionID === f.parent.id && input.messageID === stored.info.id)!
      expect(prompt).toBeDefined()
      expect(f.asks).toEqual([])
      expect(prompt.noReply).toBe(true)
      expect(prompt.messageID).toBeDefined()
      expect(f.prompts.filter((input) => input.sessionID === f.parent.id)).toHaveLength(1)
      const note = prompt.parts.find((part) => part.type === "text" && part.metadata?.taskNotification !== undefined)
      expect(note).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: {
          [SessionTaskSize.QUIET]: true,
          taskNotification: { taskID: f.runID, state: "completed", quiet: true },
        },
      })
      if (!note || note.type !== "text") throw new Error("Missing workflow completion text")
      expect(note.text).toContain(f.runID)
      expect(note.text).toContain("Resume through workflow with run_id")
      expect(note.text).toContain("Do not send a message to the coordinator")
      expect(note.text).toContain('tokens="2"')
      expect(note.text).toContain('tool_calls="1"')
      expect(stored?.info.role).toBe("user")
      expect(stored?.parts).toContainEqual(expect.objectContaining({ text: note.text, synthetic: true }))
      const record = SubagentLifecycle.read(yield* f.sessions.get(f.runID))!
      expect(record.workflow).toMatchObject({ role: "run", quiet: true })
      expect(record.notification).toMatchObject({ messageID: prompt.messageID, state: "completed" })
      expect(record.notification?.claimedAt).toBeGreaterThan(0)
      expect(f.prompts.filter((input) => input.sessionID === f.runID)).toEqual([])
    }),
  { trusted: true },
)

it.instance(
  "worker completion and attention become quiet coordinator messages without prompt execution or lost claims",
  () =>
    Effect.gen(function* () {
      const f = yield* completed()
      const notify = yield* TaskNotify.Service
      const [worker] = yield* f.sessions.children(f.runID)
      expect(worker).toBeDefined()
      const record = SubagentLifecycle.read(worker)!
      const launchID = MessageID.make(record.parentMessageID)
      const called: SessionID[] = []
      const ops: TaskPromptOps = {
        ...f.ops,
        prompt: (input) =>
          Effect.sync(() => {
            called.push(input.sessionID)
          }).pipe(Effect.andThen(f.ops.prompt(input))),
      }
      // Exercise the real completion pipeline against the actual worker and its durable launch message.
      yield* notify.result({
        parentID: f.runID,
        taskID: worker.id,
        title: record.title,
        state: "completed",
        text: "Worker completion evidence was retained.",
        usage: record.usage,
        launchID,
        attempt: record.attempt!,
        ops,
        agent: "workflow",
      })
      const completion = yield* pollWithTimeout(
        f.sessions
          .messages({ sessionID: f.runID })
          .pipe(
            Effect.map((messages) =>
              messages.find((message) =>
                message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    isRecord(part.metadata?.taskNotification) &&
                    part.metadata.taskNotification.taskID === worker.id,
                ),
              ),
            ),
          ),
        "Worker completion did not become a durable coordinator message",
      )
      expect(completion.info).toMatchObject({ role: "user", agent: "workflow" })
      expect(completion.parts).toContainEqual(
        expect.objectContaining({
          type: "text",
          synthetic: true,
          metadata: expect.objectContaining({
            [SessionTaskSize.QUIET]: true,
            taskNotification: { taskID: worker.id, state: "completed", attempt: 1, quiet: true },
          }),
        }),
      )
      const claim = SubagentLifecycle.read(yield* f.sessions.get(worker.id))!.notification!
      expect(claim).toMatchObject({ messageID: completion.info.id, state: "completed" })
      expect(claim.claimedAt).toBeGreaterThan(0)
      const before = (yield* f.sessions.messages({ sessionID: f.runID })).length
      yield* notify.post({
        parentID: f.runID,
        ops,
        agent: "workflow",
        notes: [
          {
            kind: "result",
            taskID: worker.id,
            launchID,
            attempt: record.attempt,
            state: "completed",
            text: claim.text,
            wake: true,
          },
        ],
      })
      expect((yield* f.sessions.messages({ sessionID: f.runID })).length).toBe(before)
      expect(SubagentLifecycle.read(yield* f.sessions.get(worker.id))!.notification).toEqual(claim)
      yield* notify.post({
        parentID: f.runID,
        ops,
        agent: "workflow",
        notes: [
          {
            kind: "attention",
            taskID: worker.id,
            launchID,
            attempt: record.attempt,
            attention: "permission",
            state: "waiting",
            text: "Worker waits for permission.",
            wake: true,
          },
          {
            kind: "attention",
            taskID: worker.id,
            launchID,
            attempt: record.attempt,
            attention: "question",
            state: "expired",
            text: "Worker question expired.",
            wake: true,
          },
        ],
      })
      const attention = (yield* f.sessions.messages({ sessionID: f.runID })).find((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.taskAttention !== undefined),
      )!
      expect(attention.info).toMatchObject({ role: "user", agent: "workflow" })
      expect(
        attention.parts
          .filter((part) => part.type === "text")
          .map((part) => ({
            quiet: part.metadata?.[SessionTaskSize.QUIET],
            synthetic: part.synthetic,
            attention: part.metadata?.taskAttention,
          })),
      ).toEqual([
        { quiet: true, synthetic: true, attention: { taskID: worker.id, kind: "permission", state: "waiting" } },
        { quiet: true, synthetic: true, attention: { taskID: worker.id, kind: "question", state: "expired" } },
      ])
      expect(SubagentLifecycle.read(yield* f.sessions.get(worker.id))!.notification).toEqual(claim)
      expect(called).toEqual([])
      expect(f.prompts.filter((input) => input.sessionID === f.runID)).toEqual([])
    }),
  { trusted: true },
)
