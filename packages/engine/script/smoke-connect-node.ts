import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { realpath } from "node:fs/promises"
import { createConnection } from "node:net"
import { setTimeout } from "node:timers/promises"

/** Exercises the real bundled owner, runner, hub and HttpApi handler under the desktop's native Node transport. */
export async function connectedReviews(engine: { url: URL; authorization: string }, directory: string, ownerModel: string) {
  assert.equal(process.versions.bun, undefined, "connect transport acceptance must run under native Node")
  const headers = {
    authorization: engine.authorization,
    "content-type": "application/json",
    "x-vector-directory": encodeURIComponent(directory),
  }
  const request = (route: string, body?: unknown) =>
    fetch(new URL(route, engine.url), {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
  const json = async (route: string, body?: unknown): Promise<unknown> => {
    const response = await request(route, body)
    const text = await response.text()
    assert.equal(response.ok, true, `${route} returned ${response.status}: ${text.slice(0, 2_000)}`)
    return text ? JSON.parse(text) : undefined
  }
  const session = async () => {
    const created = await json("/session", { title: "Native Node connected review" })
    assert.ok(isRecord(created) && typeof created.id === "string", "the owner session was not created")
    return created.id
  }
  const pending = async (sessionID: string) => {
    const permissions = await json("/permission")
    assert.ok(Array.isArray(permissions))
    return permissions.find(
      (entry: unknown) => isRecord(entry) && entry.sessionID === sessionID && entry.permission === "connect",
    )
  }

  // Check the real owner-global loader, not the desktop's merged/project config or this fixture's seed object.
  const global = await json("/global/config")
  assert.ok(isRecord(global) && isRecord(global.agent) && isRecord(global.agent.vectorscope), "the native Node owner-global review configuration is missing")
  assert.equal(global.agent.vectorscope.model, ownerModel, "the native Node owner-global review model was not loaded")

  const approvedSession = await session()
  const early = { done: false, result: undefined as unknown }
  // Catch immediately so an unexpected early response cannot become an unobserved rejection during polling.
  const approved = json(`/experimental/session/${approvedSession}/connect`, { background: false }).catch(
    (error: unknown) => error,
  ).then((result) => { early.done = true; early.result = result; return result })
  const approval = await wait(async () => {
    const permission = await pending(approvedSession)
    if (permission) return permission
    assert.equal(early.done, false, `the native Node owner review returned before consent: ${early.result instanceof Error ? early.result.message : (JSON.stringify(early.result) ?? "no result").slice(0, 2000)}`)
    return undefined
  }, "the native Node owner review never asked before work")
  assert.ok(isRecord(approval) && typeof approval.id === "string")
  assert.ok(await pending(approvedSession), "consuming a POST body cancelled a live foreground request")
  const busy = await json("/session/status")
  assert.ok(isRecord(busy) && isRecord(busy[approvedSession]) && busy[approvedSession].type === "busy")
  const before = await json(`/session/${approvedSession}/message`)
  assert.ok(Array.isArray(before))
  const concurrent = await request(`/experimental/session/${approvedSession}/connect`, { background: false })
  assert.equal(concurrent.status, 400, "a concurrent owner review was admitted")
  const rejected: unknown = await concurrent.json()
  assert.ok(isRecord(rejected) && rejected.code === "invalid")
  const after = await json(`/session/${approvedSession}/message`)
  assert.ok(Array.isArray(after))
  assert.equal(after.length, before.length, "the rejected concurrent review changed the transcript")
  await json(`/permission/${approval.id}/reply`, { reply: "once" })
  const result = await approved
  assert.ok(isRecord(result) && result.status === "done" && isRecord(result.result))
  assert.notEqual(result.result.state, "cancelled", "a normally approved request was cancelled")
  assert.equal(result.result.verdict, "not-reviewed", "the non-Git fixture must never claim a clean review")
  const idle = await json("/session/status")
  assert.ok(isRecord(idle) && idle[approvedSession] === undefined)

  const cancelledSession = await session()
  const socket = createConnection({ host: engine.url.hostname.replace(/^\[|\]$/g, ""), port: Number(engine.url.port) })
  socket.on("error", () => {})
  try {
    const body = JSON.stringify({ background: false })
    socket.write(
      [
        `POST /experimental/session/${cancelledSession}/connect HTTP/1.1`,
        `Host: ${engine.url.host}`,
        `Authorization: ${engine.authorization}`,
        `x-vector-directory: ${encodeURIComponent(directory)}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    )
    await wait(() => pending(cancelledSession), "the native Node cancellable review never asked before work")
    assert.equal(socket.destroyed, false)
    const closed = once(socket, "close", { signal: AbortSignal.timeout(10_000) })
    socket.destroy()
    await closed
    assert.equal(socket.destroyed, true)
    await wait(async () => {
      const messages = await json(`/session/${cancelledSession}/message`)
      assert.ok(Array.isArray(messages))
      return messages
        .flatMap((message: unknown) => (isRecord(message) && Array.isArray(message.parts) ? message.parts : []))
        .some((part: unknown) => {
          if (!isRecord(part) || part.type !== "tool" || part.tool !== "connect" || !isRecord(part.state)) return false
          if (part.state.status !== "completed" && part.state.status !== "error") return false
          const run = isRecord(part.state.metadata) ? part.state.metadata.connect : undefined
          return isRecord(run) && run.status === "done" && isRecord(run.result) && run.result.state === "cancelled"
        })
    }, "a disconnected native Node owner review left its transcript or domain run running")
    assert.deepEqual(await json("/permission"), [], "the disconnected review left an approval behind")
    const settled = await json("/session/status")
    assert.ok(isRecord(settled) && settled[cancelledSession] === undefined)
  } finally {
    socket.destroy()
  }

  const visibleSessions = async () => {
    const rows = await json("/session")
    assert.ok(Array.isArray(rows))
    return rows
      .map((row: unknown) => {
        assert.ok(isRecord(row) && typeof row.id === "string")
        return row.id
      })
      .sort()
  }
  const visibleBefore = await visibleSessions()
  const directoryInput = { requestKey: randomUUID(), background: true }
  const directoryRun = await json("/experimental/connect/review", directoryInput)
  assert.ok(isRecord(directoryRun) && typeof directoryRun.id === "string" && isRecord(directoryRun.request))
  assert.notEqual(directoryRun.status, "done", "the owner must receive a real queued directory job before consent")
  const directoryRequest = directoryRun.request
  assert.ok(isRecord(directoryRequest.requester) && directoryRequest.requester.kind === "user")
  assert.equal(
    directoryRequest.requester.sessionID,
    undefined,
    "a directory review fabricated a requester conversation",
  )
  assert.ok(typeof directoryRequest.directory === "string")
  assert.equal(await realpath(directoryRequest.directory), await realpath(directory))
  const directoryApproval = await wait(async () => {
    const rows = await json("/permission")
    assert.ok(Array.isArray(rows))
    return rows.find(
      (row: unknown) => isRecord(row) && isRecord(row.metadata) && row.metadata.runID === directoryRun.id,
    )
  }, "the native directory owner job never asked for approval")
  assert.ok(
    isRecord(directoryApproval) &&
      typeof directoryApproval.id === "string" &&
      typeof directoryApproval.sessionID === "string",
  )
  assert.ok(isRecord(directoryApproval.metadata))
  assert.equal(directoryApproval.metadata.directoryReview, true)
  assert.equal(directoryApproval.metadata.directory, directoryRequest.directory)
  assert.equal(directoryApproval.permission, "connect")
  const directoryRetry = await json("/experimental/connect/review", {
    ...directoryInput,
    requestKey: directoryInput.requestKey.toUpperCase(),
  })
  assert.ok(isRecord(directoryRetry))
  assert.equal(directoryRetry.id, directoryRun.id, "the native explicit retry started another directory job")
  const retryApprovals = await json("/permission")
  assert.ok(Array.isArray(retryApprovals))
  assert.deepEqual(
    retryApprovals.map((row: unknown) => {
      assert.ok(isRecord(row))
      return row.id
    }),
    [directoryApproval.id],
    "the native explicit retry created another owner consent request",
  )
  assert.deepEqual(
    await json(`/session/${directoryApproval.sessionID}/message`),
    [],
    "the hidden execution anchor fabricated human messages",
  )
  assert.deepEqual(await visibleSessions(), visibleBefore, "a directory review created a visible conversation")
  const directoryFresh = await json(`/experimental/connect/runs/${directoryRun.id}`)
  assert.ok(isRecord(directoryFresh) && isRecord(directoryFresh.request) && isRecord(directoryFresh.request.requester))
  assert.equal(directoryFresh.request.requester.sessionID, undefined)
  assert.equal(await json(`/experimental/connect/runs/${directoryRun.id}/cancel`, {}), true)
  await wait(async () => {
    const value = await json(`/experimental/connect/runs/${directoryRun.id}`)
    return isRecord(value) && value.status === "done" && isRecord(value.result) && value.result.state === "cancelled"
  }, "the native directory cancel left a real job running")
  assert.deepEqual(await json("/permission"), [], "the canceled directory review left owner consent pending")
  const directoryTerminalRetry = await json("/experimental/connect/review", directoryInput)
  assert.ok(isRecord(directoryTerminalRetry) && isRecord(directoryTerminalRetry.result))
  assert.equal(directoryTerminalRetry.id, directoryRun.id, "a terminal native retry replaced the original job")
  assert.equal(directoryTerminalRetry.result.state, "cancelled")
  assert.deepEqual(await json("/permission"), [], "a terminal native retry created new owner consent")
  assert.deepEqual(await visibleSessions(), visibleBefore, "the canceled directory review left a visible conversation")
  return [] as string[]
}

async function wait<A>(read: () => Promise<A>, message: string): Promise<NonNullable<A>> {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await setTimeout(20)
  }
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
