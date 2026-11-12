import assert from "node:assert/strict"
import { once } from "node:events"
import { createConnection } from "node:net"
import { setTimeout } from "node:timers/promises"

/** Exercises the real bundled owner, runner, hub and HttpApi handler under the desktop's native Node transport. */
export async function connectedReviews(engine: { url: URL; authorization: string }, directory: string) {
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

  const approvedSession = await session()
  // Catch immediately so an unexpected early response cannot become an unobserved rejection during polling.
  const approved = json(`/experimental/session/${approvedSession}/connect`, { background: false }).catch(
    (error: unknown) => error,
  )
  const approval = await wait(() => pending(approvedSession), "the native Node owner review never asked before work")
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
