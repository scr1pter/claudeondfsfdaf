import { beforeEach, describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import {
  continueRequest,
  discardRequest,
  mergeRequest,
  outputFolder,
  ownerOnlyRefusal,
  promoteRequest,
  RESUME_CHUNK,
  resumeRequest,
  resumeRunRequest,
  type TaskActionsClient,
} from "./background-tasks"
import { backgroundTasksPane, loadLayout } from "./background-tasks-state"

const V1 = "vector.backgroundTasks.pane.v1"
const V2 = "vector.backgroundTasks.pane.v2"

beforeEach(() => {
  localStorage.removeItem(V1)
  localStorage.removeItem(V2)
})

describe("background tasks layout", () => {
  test("floats by default", () => {
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })

  test("keeps a docked choice saved under v2", () => {
    localStorage.setItem(V2, JSON.stringify({ open: true, floating: false, expanded: true }))
    expect(loadLayout()).toEqual({ open: true, floating: false, expanded: true })
  })

  test("floats when v2 has no floating flag", () => {
    localStorage.setItem(V2, JSON.stringify({ open: true }))
    expect(loadLayout()).toEqual({ open: true, floating: true, expanded: false })
  })

  test("migrates v1 carrying over only open and expanded", () => {
    localStorage.setItem(V1, JSON.stringify({ open: true, floating: false, expanded: true }))
    expect(loadLayout()).toEqual({ open: true, floating: true, expanded: true })
    expect(localStorage.getItem(V1)).toBeNull()
    expect(JSON.parse(localStorage.getItem(V2) ?? "null")).toEqual({ open: true, floating: true, expanded: true })
  })

  test("prefers v2 over a leftover v1", () => {
    localStorage.setItem(V1, JSON.stringify({ open: true, floating: true, expanded: true }))
    localStorage.setItem(V2, JSON.stringify({ open: false, floating: false, expanded: false }))
    expect(loadLayout()).toEqual({ open: false, floating: false, expanded: false })
  })

  test("falls back to floating on unreadable storage", () => {
    localStorage.setItem(V2, "{not json")
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
    localStorage.removeItem(V2)
    localStorage.setItem(V1, "null")
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })

  test("docking persists under v2 and reserves the docked column", () => {
    backgroundTasksPane.open()
    backgroundTasksPane.setFloating(false)
    expect(backgroundTasksPane.dockedReserve()).toBe("320px")
    expect(loadLayout()).toMatchObject({ open: true, floating: false })
    backgroundTasksPane.setFloating(true)
    expect(backgroundTasksPane.dockedReserve()).toBeUndefined()
    backgroundTasksPane.close()
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })
})

// ---------------------------------------------------------------------------
// The pane's requests (5.I.3): what each control sends, and how a partial answer reads.

type Call = { method: string; parameters: Record<string, unknown>; options: unknown }

function info(id: string, input: Partial<Task.Info> = {}): Task.Info {
  return {
    id,
    sessionID: id,
    parentSessionID: "ses_root",
    source: "subagent",
    title: id,
    status: "running",
    startedAt: 1,
    elapsedMs: 0,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 2,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function httpError(status: number, body: unknown) {
  return new Error(`refused ${status}`, { cause: { status, body } })
}

function fakeClient(answers: Record<string, (parameters: Record<string, unknown>) => unknown>) {
  const calls: Call[] = []
  const method = (name: string) => async (parameters: Record<string, unknown>, options?: unknown) => {
    calls.push({ method: name, parameters, options })
    const answer = answers[name]?.(parameters)
    if (answer instanceof Error) throw answer
    return answer
  }
  const client = {
    experimental: {
      session: { background: method("session.background") },
      task: {
        background: method("task.background"),
        resume: method("task.resume"),
        merge: method("task.merge"),
        discard: method("task.discard"),
        changes: method("task.changes"),
      },
      workflow: { resume: method("workflow.resume") },
    },
  } as unknown as TaskActionsClient
  return { client, calls }
}

describe("background commands", () => {
  test("Open output opens the folder that holds the log, since the desktop opens only folders", () => {
    expect(outputFolder("/Users/me/.local/share/vector/tool-output/shell-shl_1.log")).toBe(
      "/Users/me/.local/share/vector/tool-output",
    )
    expect(outputFolder("C:\\Users\\me\\vector\\tool-output\\shell-shl_1.log")).toBe(
      "C:\\Users\\me\\vector\\tool-output",
    )
  })
})

describe("move to background", () => {
  test("with taskPromote, route 2 names the tasks and the answer says whether any moved", async () => {
    const moved = fakeClient({ "task.background": () => ({ data: { tasks: [info("ses_a")] } }) })
    expect(
      await promoteRequest({
        client: moved.client,
        sessionID: "ses_root",
        taskIDs: ["ses_a", "ses_b"],
        taskPromote: true,
      }),
    ).toBe(true)
    expect(moved.calls).toEqual([
      {
        method: "task.background",
        parameters: { sessionID: "ses_root", taskIDs: ["ses_a", "ses_b"] },
        options: { throwOnError: true },
      },
    ])
    const none = fakeClient({ "task.background": () => ({ data: { tasks: [] } }) })
    expect(
      await promoteRequest({ client: none.client, sessionID: "ses_root", taskIDs: ["ses_a"], taskPromote: true }),
    ).toBe(false)
  })

  test("without taskPromote, the old route moves the blocking subagent and answers a boolean", async () => {
    const old = fakeClient({ "session.background": () => ({ data: true }) })
    expect(
      await promoteRequest({ client: old.client, sessionID: "ses_root", taskIDs: ["ses_a"], taskPromote: false }),
    ).toBe(true)
    expect(old.calls.map((call) => [call.method, call.parameters])).toEqual([
      ["session.background", { sessionID: "ses_root" }],
    ])
    const refused = fakeClient({ "session.background": () => ({ data: false }) })
    expect(
      await promoteRequest({ client: refused.client, sessionID: "ses_root", taskIDs: ["ses_a"], taskPromote: false }),
    ).toBe(false)
  })
})

describe("resume", () => {
  test("route 3 carries every ID, in chunks of 32, and the text", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `ses_${index}`)
    const fake = fakeClient({
      "task.resume": (parameters) => ({ data: { tasks: (parameters.taskIDs as string[]).map((id) => info(id)) } }),
    })
    const outcome = await resumeRequest({ client: fake.client, sessionID: "ses_root", taskIDs: [...ids, ids[0]!] })
    expect(RESUME_CHUNK).toBe(32)
    expect(fake.calls.map((call) => (call.parameters.taskIDs as string[]).length)).toEqual([32, 8])
    expect(fake.calls[0]!.parameters).not.toHaveProperty("text")
    expect(outcome).toMatchObject({ requested: 40, missing: [] })
    expect(outcome.resumed).toHaveLength(40)
    expect(outcome.error).toBeUndefined()
  })

  test("a partial resume: a failed chunk leaves its IDs missing, earlier chunks stand and no later chunk is sent", async () => {
    const ids = Array.from({ length: 70 }, (_, index) => `ses_${index}`)
    let call = 0
    const refusal = httpError(400, { code: "limit", message: "This request has already started 32 of 32" })
    const fake = fakeClient({
      "task.resume": (parameters) => {
        call += 1
        if (call === 2) return refusal
        return { data: { tasks: (parameters.taskIDs as string[]).map((id) => info(id)) } }
      },
    })
    const outcome = await resumeRequest({ client: fake.client, sessionID: "ses_root", taskIDs: ids })
    expect(fake.calls).toHaveLength(2)
    expect(outcome.resumed).toHaveLength(32)
    expect(outcome.missing).toEqual(ids.slice(32))
    expect(outcome.error).toBe(refusal)
  })

  test("an answer listing fewer tasks than asked is partial too", async () => {
    const fake = fakeClient({ "task.resume": () => ({ data: { tasks: [info("ses_a")] } }) })
    const outcome = await resumeRequest({ client: fake.client, sessionID: "ses_root", taskIDs: ["ses_a", "ses_b"] })
    expect(outcome).toMatchObject({ requested: 2, missing: ["ses_b"] })
    expect(outcome.resumed.map((task) => task.id)).toEqual(["ses_a"])
  })

  test("Continue with this message is route 3 with one ID and the text", async () => {
    const fake = fakeClient({ "task.resume": () => ({ data: { tasks: [info("ses_a")] } }) })
    const outcome = await continueRequest({
      client: fake.client,
      sessionID: "ses_root",
      taskID: "ses_a",
      text: "Also cover the error path",
    })
    expect(fake.calls).toEqual([
      {
        method: "task.resume",
        parameters: { sessionID: "ses_root", taskIDs: ["ses_a"], text: "Also cover the error path" },
        options: { throwOnError: true },
      },
    ])
    expect(outcome.missing).toEqual([])
  })

  test("a workflow run resumes through route 12, retrying failed agents", async () => {
    const fake = fakeClient({ "workflow.resume": () => ({ data: { runID: "ses_run", title: "Audit", plan: {} } }) })
    await resumeRunRequest({ client: fake.client, sessionID: "ses_root", runID: "ses_run" })
    expect(fake.calls[0]).toMatchObject({
      method: "workflow.resume",
      parameters: { sessionID: "ses_root", runID: "ses_run", workflowResumeInput: { retryFailed: true } },
    })
  })
})

describe("merge and discard", () => {
  test("merge posts route 5 and returns merged, remaining and conflicting paths", async () => {
    const result = { task: info("ses_a"), merged: ["a.ts"], remaining: ["b.ts"], conflicts: ["b.ts"] }
    const fake = fakeClient({ "task.merge": () => ({ data: result }) })
    const merged: unknown = await mergeRequest({ client: fake.client, sessionID: "ses_root", taskID: "ses_a" })
    expect(merged).toEqual(result)
    expect(fake.calls[0]).toEqual({
      method: "task.merge",
      parameters: { sessionID: "ses_root", taskID: "ses_a" },
      options: { throwOnError: true },
    })
    await mergeRequest({ client: fake.client, sessionID: "ses_root", taskID: "ses_a", files: ["a.ts"] })
    expect(fake.calls[1]!.parameters).toEqual({ sessionID: "ses_root", taskID: "ses_a", files: ["a.ts"] })
  })

  test("discard posts route 6 with a reason and returns the recovery copy", async () => {
    const fake = fakeClient({ "task.discard": () => ({ data: { task: info("ses_a"), saved: "/data/patch" } }) })
    expect(await discardRequest({ client: fake.client, sessionID: "ses_root", taskID: "ses_a" })).toMatchObject({
      saved: "/data/patch",
    })
    expect(fake.calls[0]!.parameters).toEqual({
      sessionID: "ses_root",
      taskID: "ses_a",
      reason: "Discarded by the user",
    })
  })

  test("a 403 is the owner-only refusal; other failures are not", async () => {
    const fake = fakeClient({ "task.merge": () => httpError(403, { message: "Forbidden" }) })
    const error = await mergeRequest({ client: fake.client, sessionID: "ses_root", taskID: "ses_a" }).catch(
      (cause: unknown) => cause,
    )
    expect(ownerOnlyRefusal(error)).toBe(true)
    expect(ownerOnlyRefusal(httpError(400, { code: "conflict" }))).toBe(false)
    expect(ownerOnlyRefusal(new Error("network"))).toBe(false)
    expect(ownerOnlyRefusal("403")).toBe(false)
  })
})
