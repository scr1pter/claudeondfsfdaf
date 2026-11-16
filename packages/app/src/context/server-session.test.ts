import { describe, expect, test } from "bun:test"
import type { retry } from "@vectordevai/core/util/retry"
import type { Message, VectorClient, Part, Session } from "@vectordevai/sdk/v2/client"
import { createServerSession } from "./server-session"

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  parentID,
  time: { created: 1, updated: 1 },
})

type UserMessage = Extract<Message, { role: "user" }>
type TextPart = Extract<Part, { type: "text" }>
type MessageResponse = {
  data: { info: Message; parts: Part[] }[]
  response: { headers: Headers }
}

const userMessage = (id: string, input: Partial<UserMessage> = {}): UserMessage => ({
  id,
  sessionID: "child",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
  ...input,
})

const textPart = (messageID: string, input: Partial<TextPart> = {}): TextPart => ({
  id: "part",
  sessionID: "child",
  messageID,
  type: "text",
  text: "text",
  ...input,
})

const response = (data: MessageResponse["data"] = [], cursor?: string): MessageResponse => ({
  data,
  response: { headers: new Headers(cursor ? { "x-next-cursor": cursor } : undefined) },
})

const deferredResponse = () => Promise.withResolvers<MessageResponse>()

function messageClient(...responses: Array<MessageResponse | Promise<MessageResponse>>) {
  let index = 0
  const requests: unknown[] = []
  const waiting = new Map<number, () => void>()
  const client = {
    session: {
      get: async () => ({ data: session("child", "root") }),
      messages: (input: unknown) => {
        requests.push(input)
        waiting.get(requests.length)?.()
        waiting.delete(requests.length)
        return responses[index++]
      },
    },
  } as unknown as VectorClient
  return Object.assign(client, {
    requests,
    requested(count: number) {
      if (requests.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => waiting.set(count, resolve))
    },
  })
}

const retryImmediately: typeof retry = async (task, options = {}) => {
  const attempts = options.attempts ?? 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt === attempts - 1) throw error
    }
  }
}

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const messages: unknown[] = []
  const client = {
    session: {
      get: async (input: unknown) => {
        get.push(input)
        const id = (input as { sessionID: string }).sessionID
        return { data: sessions[id] }
      },
      messages: async (input: unknown) => {
        messages.push(input)
        return response()
      },
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as VectorClient
  return { get, messages, store: createServerSession(client) }
}

describe("server session", () => {
  test("re-reads every held session above a helper or subagent when its spend settles", async () => {
    const ctx = setup({})
    ctx.store.remember(session("root"))
    ctx.store.remember(session("child", "root"))
    ctx.store.remember({ ...session("review", "child"), internal: "vectorscope.review" })
    const step = { id: "part", sessionID: "review", messageID: "message", type: "step-finish", cost: 0.1 }
    ctx.store.apply({ type: "message.part.updated", properties: { part: step } })
    ctx.store.apply({ type: "message.part.updated", properties: { part: { ...step, id: "part-2" } } })
    // A text part is not spend, and a session with no parent has nothing above it to refresh.
    ctx.store.apply({ type: "message.part.updated", properties: { part: { ...step, type: "text" } } })
    ctx.store.apply({ type: "session.next.step.ended", properties: { sessionID: "root" } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    // One read per ancestor for the burst of steps.
    expect(ctx.get.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { sessionID: "child" },
      { sessionID: "root" },
    ])
  })

  test("the first spend event for an unseen helper refreshes its parent after metadata arrives", async () => {
    const pending = Promise.withResolvers<{ data: Session }>()
    const calls: string[] = []
    const client = {
      session: {
        get: ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID)
          return sessionID === "helper"
            ? pending.promise
            : Promise.resolve({ data: { ...session("root"), subagentCost: 0.25 } })
        },
      },
    } as unknown as VectorClient
    const store = createServerSession(client)
    store.remember({ ...session("root"), subagentCost: 0 })
    store.apply({ type: "session.next.step.ended", properties: { sessionID: "helper" } })
    expect(calls).toEqual(["helper"])
    pending.resolve({ data: { ...session("helper", "root"), internal: "vectorscope.review" } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(calls).toEqual(["helper", "root"])
    expect(store.get("root")?.subagentCost).toBe(0.25)
  })

  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  test("ancillary spend re-reads only that session's metadata", async () => {
    const sessions = { root: session("root") }
    const ctx = setup(sessions)
    await ctx.store.resolve("root")
    sessions.root = { ...session("root"), cost: 0.0003, time: { created: 1, updated: 2 } }

    ctx.store.apply({ type: "session.next.ancillary.usage", properties: { sessionID: "root", cost: 0.0003 } })
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.get).toEqual([{ sessionID: "root" }, { sessionID: "root" }])
    expect(ctx.messages).toEqual([])
    expect(ctx.store.get("root")?.cost).toBe(0.0003)
  })

  test("a session read answered after a newer session.updated keeps the newer session", async () => {
    const answers: ((value: { data: Session }) => void)[] = []
    const client = {
      session: { get: () => new Promise((resolve) => answers.push(resolve)) },
    } as unknown as VectorClient
    const store = createServerSession(client)
    store.apply({ type: "session.created", properties: { info: session("root") } })

    // The title's spend lands first and starts a read; the title itself arrives before the read is answered.
    store.apply({ type: "session.next.ancillary.usage", properties: { sessionID: "root", cost: 0.0003 } })
    const titled = {
      ...session("root"),
      title: "Refactor the request module",
      cost: 0.0003,
      time: { created: 1, updated: 2 },
    }
    store.apply({ type: "session.updated", properties: { info: titled } })
    answers[0]!({ data: { ...session("root"), cost: 0.0003, time: { created: 1, updated: 2 } } })
    await Promise.resolve()
    await Promise.resolve()

    expect(answers).toHaveLength(1)
    expect(store.get("root")?.title).toBe("Refactor the request module")
    expect(store.get("root")?.time.updated).toBe(2)
  })

  test("loads session content through the server client", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
    expect(ctx.messages).toEqual([{ sessionID: "root", limit: 2, before: undefined }])
    expect(ctx.store.data.message.root).toEqual([])
  })

  test("merges live events into the initial page", async () => {
    const pending = deferredResponse()
    const user = userMessage("message-1")
    const live = userMessage("message-2", { time: { created: 2 } })
    const livePart = textPart(live.id, { text: "live" })
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: livePart, time: 2 } })
    pending.resolve(response([{ info: user, parts: [] }]))
    await loading

    expect(store.data.message.child).toEqual([user, live])
    expect(store.data.part[live.id]).toEqual([livePart])
  })

  test("preserves same-ID live updates over the initial page", async () => {
    const pending = deferredResponse()
    const fetched = userMessage("message")
    const fetchedPart = textPart(fetched.id, { text: "fetched" })
    const live = { ...fetched, time: { created: 2 } }
    const livePart = { ...fetchedPart, text: "live" }
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: livePart, time: 2 } })
    pending.resolve(response([{ info: fetched, parts: [fetchedPart] }]))
    await loading

    expect(store.data.message.child).toEqual([live])
    expect(store.data.part[live.id]).toEqual([livePart])
  })

  test("preserves removals received during the initial load", async () => {
    const pending = deferredResponse()
    const removed = userMessage("message-1")
    const kept = { ...removed, id: "message-2" }
    const part = textPart(kept.id, { text: "removed" })
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: removed.id } })
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: kept.id, partID: part.id },
    })
    pending.resolve(
      response([
        { info: removed, parts: [] },
        { info: kept, parts: [part] },
      ]),
    )
    await loading

    expect(store.data.message.child).toEqual([kept])
    expect(store.data.part[kept.id]).toBeUndefined()
  })

  test("keeps removal tracking isolated across load generations", async () => {
    const firstResponse = deferredResponse()
    const secondResponse = deferredResponse()
    const message = userMessage("message")
    const store = createServerSession(messageClient(firstResponse.promise, secondResponse.promise))
    const first = store.sync("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({
      type: "session.deleted",
      properties: { sessionID: "child", info: session("child", "root") },
    })
    const second = store.sync("child")

    firstResponse.resolve(response())
    await first
    secondResponse.resolve(response([{ info: message, parts: [] }]))
    await second

    expect(store.data.message.child).toEqual([message])
  })

  test("tracks removals in a replacement load generation", async () => {
    const firstResponse = deferredResponse()
    const secondResponse = deferredResponse()
    const message = userMessage("message")
    const store = createServerSession(messageClient(firstResponse.promise, secondResponse.promise))
    const first = store.sync("child")
    store.apply({
      type: "session.deleted",
      properties: { sessionID: "child", info: session("child", "root") },
    })
    const second = store.sync("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    firstResponse.resolve(response())
    await first
    secondResponse.resolve(response([{ info: message, parts: [] }]))
    await second

    expect(store.data.message.child).toEqual([])
  })

  test("preserves remove then re-add when a refresh omits the message", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const store = createServerSession(messageClient(response([{ info: message, parts: [] }]), pending.promise))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({ type: "message.updated", properties: { info: message } })
    pending.resolve(response())
    await refreshing

    expect(store.data.message.child).toEqual([message])
  })

  test("preserves a re-added message without restoring removed parts", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const part = textPart(message.id, { text: "stale" })
    const store = createServerSession(messageClient(response([{ info: message, parts: [] }]), pending.promise))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({ type: "message.updated", properties: { info: message } })
    pending.resolve(response([{ info: message, parts: [part] }]))
    await refreshing

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("preserves optimistic parts re-added after removal during a refresh", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const stale = textPart(message.id, { id: "stale", text: "stale" })
    const part = textPart(message.id, { id: "optimistic", text: "optimistic" })
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [] }]), pending.promise, response()),
    )
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    pending.resolve(response([{ info: message, parts: [stale] }]))
    await refreshing

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])

    await store.sync("child", { force: true })
    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])
  })

  test("drops stale event content omitted by a complete initial page", async () => {
    const stale = userMessage("stale")
    const store = createServerSession(messageClient(response()))
    store.apply({ type: "message.updated", properties: { info: stale } })

    await store.sync("child")

    expect(store.data.message.child).toEqual([])
  })

  test("preserves event content outside an incomplete initial page", async () => {
    const live = userMessage("message-1")
    const fetched = userMessage("message-2", { time: { created: 2 } })
    const store = createServerSession(messageClient(response([{ info: fetched, parts: [] }], "older")))
    store.apply({ type: "message.updated", properties: { info: live } })

    await store.sync("child")

    expect(store.data.message.child).toEqual([live, fetched])
  })

  test("does not restore removed optimistic content on refresh", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "removed" })
    const kept = { ...message, id: "kept" }
    const keptPart = { ...part, id: "kept-part", messageID: kept.id }
    const store = createServerSession(messageClient(response([{ info: kept, parts: [] }])))
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.optimistic.add({ sessionID: "child", message: kept, parts: [keptPart] })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: kept.id, partID: keptPart.id },
    })
    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([kept])
    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part[kept.id]).toBeUndefined()
  })

  test("replaces confirmed optimistic content with the initial page", async () => {
    const optimistic = userMessage("message")
    const fetched = { ...optimistic, time: { created: 2 } }
    const store = createServerSession(messageClient(response([{ info: fetched, parts: [] }])))
    store.optimistic.add({ sessionID: "child", message: optimistic, parts: [] })

    await store.sync("child")

    expect(store.data.message.child).toEqual([fetched])
  })

  test("replaces a confirmed optimistic part with fetched content", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const optimistic = textPart(message.id, { text: "optimistic" })
    const fetched = { ...optimistic, text: "fetched" }
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")

    store.optimistic.add({ sessionID: "child", message, parts: [optimistic] })
    pending.resolve(response([{ info: message, parts: [fetched] }]))
    await loading

    expect(store.data.part[message.id]).toEqual([fetched])
  })

  test("rolls back only unconfirmed optimistic parts", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const confirmed = textPart(message.id, { id: "confirmed", text: "confirmed" })
    const pendingPart = textPart(message.id, { id: "pending", text: "pending" })
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")
    store.optimistic.add({ sessionID: "child", message, parts: [confirmed, pendingPart] })

    pending.resolve(response([{ info: message, parts: [confirmed] }]))
    await loading
    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([confirmed])
  })

  test("updates confirmed optimistic parts from later pages", async () => {
    const message = userMessage("message")
    const confirmed = textPart(message.id, { id: "confirmed", text: "first" })
    const updated = { ...confirmed, text: "updated" }
    const pendingPart = textPart(message.id, { id: "pending", text: "pending" })
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [confirmed] }]), response([{ info: message, parts: [updated] }])),
    )
    store.optimistic.add({ sessionID: "child", message, parts: [confirmed, pendingPart] })
    await store.sync("child")

    await store.sync("child", { force: true })
    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.part[message.id]).toEqual([updated])
  })

  test("does not restore a confirmed optimistic part after its removal event", async () => {
    const message = userMessage("message")
    const confirmed = textPart(message.id, { id: "confirmed", text: "confirmed" })
    const pendingPart = textPart(message.id, { id: "pending", text: "pending" })
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [confirmed] }]), response([{ info: message, parts: [] }])),
    )
    store.optimistic.add({ sessionID: "child", message, parts: [confirmed, pendingPart] })
    await store.sync("child")
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: message.id, partID: confirmed.id },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([pendingPart])
  })

  test("clears delta buffers when removing optimistic content", () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "optimistic" })
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("does not remove content confirmed by a message event", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: message } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not remove parts confirmed by part events", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])
  })

  test("treats a part event as confirmation when it precedes the message event", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])
  })

  test("clears stale parts when the initial page has none", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const part = textPart(message.id, { text: "stale" })
    const store = createServerSession(messageClient(pending.promise))
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 1 } })
    const loading = store.sync("child")

    pending.resolve(response([{ info: message, parts: [] }]))
    await loading

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("clears delta buffers for parts omitted by the initial page", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const kept = textPart(message.id, { id: "part-1", text: "kept" })
    const removed: Part = { ...kept, id: "part-2", text: "removed" }
    const store = createServerSession(messageClient(pending.promise))
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: kept, time: 1 } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: removed, time: 1 } })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: removed.id, field: "text", delta: " delta" },
    })
    const loading = store.sync("child")

    pending.resolve(response([{ info: message, parts: [kept] }]))
    await loading

    expect(store.data.part[message.id]).toEqual([kept])
    expect(store.data.part_text_accum_delta[removed.id]).toBeUndefined()
  })

  test("clears a stale delta buffer when a refresh replaces its part", async () => {
    const message = userMessage("message")
    const stale = textPart(message.id, { text: "stale" })
    const fetched = { ...stale, text: "fetched" }
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [stale] }]), response([{ info: message, parts: [fetched] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: stale.id, field: "text", delta: " delta" },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([fetched])
    expect(store.data.part_text_accum_delta[stale.id]).toBeUndefined()
  })

  test("preserves a non-durable delta received before refresh", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "stale" })
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [{ ...part }] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([{ ...part, text: "stale delta" }])
    expect(store.data.part_text_accum_delta[part.id]).toBe("stale delta")
  })

  test("accepts fetched text that intentionally replaces an accumulated prefix", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "abc" })
    const fetched = { ...part, text: "ab" }
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [fetched] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: "def" },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([fetched])
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("preserves an unpersisted delta suffix after partial server catch-up", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "a" })
    const fetched = { ...part, text: "ab" }
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [fetched] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: "bc" },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([{ ...part, text: "abc" }])
    expect(store.data.part_text_accum_delta[part.id]).toBe("abc")
  })

  test("clears delta state after exact server catch-up", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "a" })
    const fetched = { ...part, text: "ab" }
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [fetched] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: "b" },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toEqual([fetched])
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("uses the successful retry response over events from a failed attempt", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const stale = textPart(message.id, { text: "stale" })
    const intermediate = { ...stale, text: "intermediate" }
    const fetched = { ...stale, text: "fetched" }
    const client = messageClient(failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: stale, time: 1 } })
    const loading = store.sync("child")

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: intermediate, time: 2 } })
    failed.reject(new Error("failed to fetch"))
    await client.requested(2)
    retried.resolve(response([{ info: message, parts: [fetched] }]))
    await loading

    expect(store.data.part[message.id]).toEqual([fetched])
  })

  test("preserves non-durable deltas across message retries", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const part = textPart(message.id, { text: "stale" })
    const client = messageClient(failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 1 } })
    const loading = store.sync("child")

    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })
    failed.reject(new Error("failed to fetch"))
    await client.requested(2)
    retried.resolve(response([{ info: message, parts: [part] }]))
    await loading

    expect(store.data.part[message.id]).toEqual([{ ...part, text: "stale delta" }])
  })

  test("preserves part removals across message retries", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const part = textPart(message.id)
    const client = messageClient(response([{ info: message, parts: [part] }]), failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    await store.sync("child")
    const loading = store.sync("child", { force: true })

    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: message.id, partID: part.id },
    })
    failed.reject(new Error("failed to fetch"))
    await client.requested(3)
    retried.resolve(response([{ info: message, parts: [part] }]))
    await loading

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("preserves message removals across message retries", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const part = textPart(message.id)
    const client = messageClient(response([{ info: message, parts: [part] }]), failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    await store.sync("child")
    const loading = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    failed.reject(new Error("failed to fetch"))
    await client.requested(3)
    retried.resolve(response([{ info: message, parts: [part] }]))
    await loading

    expect(store.data.message.child).toEqual([])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("preserves optimistic re-adds across message retries", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const stale = textPart(message.id, { id: "stale", text: "stale" })
    const optimistic = textPart(message.id, { id: "optimistic", text: "optimistic" })
    const client = messageClient(response([{ info: message, parts: [stale] }]), failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    await store.sync("child")
    const loading = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.optimistic.add({ sessionID: "child", message, parts: [optimistic] })
    failed.reject(new Error("failed to fetch"))
    await client.requested(3)
    retried.resolve(response([{ info: message, parts: [stale] }]))
    await loading

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([optimistic])
  })

  test("accepts part omission from a successful retry after an earlier delta", async () => {
    const failed = Promise.withResolvers<MessageResponse>()
    const retried = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const part = textPart(message.id)
    const client = messageClient(response([{ info: message, parts: [part] }]), failed.promise, retried.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    await store.sync("child")
    const loading = store.sync("child", { force: true })

    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })
    failed.reject(new Error("failed to fetch"))
    await client.requested(3)
    retried.resolve(response([{ info: message, parts: [] }]))
    await loading

    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("clears load-owned orphan parts when all retries fail", async () => {
    const first = Promise.withResolvers<MessageResponse>()
    const second = Promise.withResolvers<MessageResponse>()
    const third = Promise.withResolvers<MessageResponse>()
    const message = userMessage("message")
    const part = textPart(message.id)
    const client = messageClient(first.promise, second.promise, third.promise)
    const store = createServerSession(client, { retry: retryImmediately })
    const loading = store.sync("child").catch((error) => error)

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })
    first.reject(new Error("failed to fetch"))
    await client.requested(2)
    second.reject(new Error("failed to fetch"))
    await client.requested(3)
    third.reject(new Error("failed to fetch"))
    await loading

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("preserves live updates during a forced refresh", async () => {
    const pending = deferredResponse()
    const stale = userMessage("message")
    const stalePart = textPart(stale.id, { text: "stale" })
    const store = createServerSession(messageClient(response([{ info: stale, parts: [stalePart] }]), pending.promise))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })
    const live = { ...stale, time: { created: 2 } }

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: stale.id, partID: stalePart.id, field: "text", delta: " live" },
    })
    pending.resolve(response([{ info: stale, parts: [stalePart] }]))
    await refreshing

    expect(store.data.message.child).toEqual([live])
    expect(store.data.part[stale.id]).toEqual([{ ...stalePart, text: "stale live" }])
  })

  test("keeps fetched message metadata when only a part changes", async () => {
    const pending = deferredResponse()
    const stale = userMessage("message")
    const fetched = { ...stale, time: { created: 2 } }
    const part = textPart(stale.id, { text: "stale" })
    const store = createServerSession(messageClient(response([{ info: stale, parts: [part] }]), pending.promise))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: stale.id, partID: part.id, field: "text", delta: " live" },
    })
    pending.resolve(response([{ info: fetched, parts: [part] }]))
    await refreshing

    expect(store.data.message.child).toEqual([fetched])
    expect(store.data.part[stale.id]).toEqual([{ ...part, text: "stale live" }])
  })

  test("preserves a part update when a forced refresh omits its message", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const stale = textPart(message.id, { text: "stale" })
    const live = { ...stale, text: "live" }
    const store = createServerSession(messageClient(response([{ info: message, parts: [stale] }]), pending.promise))
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: live, time: 2 } })
    pending.resolve(response())
    await refreshing

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([live])
  })

  test("ignores a late part update after its message is removed", async () => {
    const pending = deferredResponse()
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")

    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })
    pending.resolve(response([{ info: message, parts: [part] }]))
    await loading

    expect(store.data.message.child).toEqual([])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("ignores a late part update after a completed message removal", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not restore a completed message removal from a stale refresh", async () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [part] }])),
    )
    await store.sync("child")
    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })

    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not restore a completed part removal from a stale refresh", async () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = createServerSession(
      messageClient(response([{ info: message, parts: [part] }]), response([{ info: message, parts: [part] }])),
    )
    await store.sync("child")
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: message.id, partID: part.id },
    })

    await store.sync("child", { force: true })

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not cache skipped optimistic parts", () => {
    const message = userMessage("message")
    const part = { id: "part", sessionID: "child", messageID: message.id, type: "step-start" as const }
    const store = setup({ child: session("child") }).store

    store.optimistic.add({ sessionID: "child", message, parts: [part] })

    expect(store.data.part[message.id]).toEqual([])
  })

  test("clears stale delta buffers when replacing optimistic parts", () => {
    const message = userMessage("message")
    const stale = textPart(message.id, { id: "stale", text: "stale" })
    const optimistic = textPart(message.id, { id: "optimistic", text: "optimistic" })
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [stale] })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: stale.id, field: "text", delta: " delta" },
    })

    store.optimistic.add({ sessionID: "child", message, parts: [optimistic] })

    expect(store.data.part_text_accum_delta[stale.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[optimistic.id]).toBeUndefined()
  })

  test("keeps one copy of an attachment once a re-echoed message is stored", async () => {
    const message = userMessage("message")
    const image = (id: string): Extract<Part, { type: "file" }> => ({
      id,
      sessionID: "child",
      messageID: message.id,
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: "data:image/png;base64,AAAA",
    })
    const first = [textPart(message.id, { id: "a-text" }), image("a-image")]
    const second = [textPart(message.id, { id: "b-text" }), image("b-image")]
    const stored = [second[1], textPart(message.id, { id: "b-note", text: "hidden", synthetic: true }), second[0]]
    const store = createServerSession(messageClient(response([{ info: message, parts: stored }])))
    const shown = () => store.data.part[message.id] ?? []

    // Echoing a message again replaces its earlier echo; it does not add to it.
    store.optimistic.add({ sessionID: "child", message, parts: first })
    store.optimistic.add({ sessionID: "child", message, parts: second })
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: message } })
    for (const part of stored) {
      store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })
    }
    expect(shown().map((part) => part.id)).toEqual(["b-image", "b-note", "b-text"])

    // Every echoed part is confirmed, so a reload restores nothing and a rollback removes nothing.
    await store.sync("child")
    store.optimistic.remove({ sessionID: "child", messageID: message.id })
    expect(shown().map((part) => part.id)).toEqual(["b-image", "b-note", "b-text"])
    expect(shown().filter((part) => part.type === "file")).toHaveLength(1)
  })

  test("preserves removals during history prepend", async () => {
    const pending = deferredResponse()
    const latest = userMessage("message-2", { time: { created: 2 } })
    const older = { ...latest, id: "message-1", time: { created: 1 } }
    const store = createServerSession(messageClient(response([{ info: latest, parts: [] }], "older"), pending.promise))
    await store.sync("child")
    const loading = store.history.loadMore("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: older.id } })
    pending.resolve(response([{ info: older, parts: [] }]))
    await loading

    expect(store.data.message.child).toEqual([latest])
  })

  test("preserves loaded history during an incomplete refresh", async () => {
    const older = userMessage("message-1")
    const latest = userMessage("message-2", { time: { created: 2 } })
    const fresh = userMessage("message-3", { time: { created: 3 } })
    const store = createServerSession(
      messageClient(
        response(
          [
            { info: older, parts: [] },
            { info: latest, parts: [] },
          ],
          "older",
        ),
        response(
          [
            { info: latest, parts: [] },
            { info: fresh, parts: [] },
          ],
          "older",
        ),
      ),
    )
    await store.sync("child")

    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([older, latest, fresh])
  })

  test("drops stale recent messages omitted by an incomplete refresh", async () => {
    const third = userMessage("message-3", { time: { created: 3 } })
    const fourth = userMessage("message-4", { time: { created: 4 } })
    const stale = userMessage("message-5", { time: { created: 5 } })
    const store = createServerSession(
      messageClient(
        response(
          [
            { info: fourth, parts: [] },
            { info: stale, parts: [] },
          ],
          "older",
        ),
        response(
          [
            { info: third, parts: [] },
            { info: fourth, parts: [] },
          ],
          "older",
        ),
      ),
    )
    await store.sync("child")

    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([third, fourth])
  })

  test("uses message creation time for incomplete refresh boundaries", async () => {
    const older = userMessage("msg_z", { time: { created: 1 } })
    const boundary = userMessage("msg_m", { time: { created: 2 } })
    const stale = userMessage("msg_a", { time: { created: 3 } })
    const store = createServerSession(
      messageClient(
        response(
          [
            { info: older, parts: [] },
            { info: stale, parts: [] },
          ],
          "older",
        ),
        response([{ info: boundary, parts: [] }], "older"),
      ),
    )
    await store.sync("child")

    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([boundary, older])
  })

  test("preserves a part update for a message being loaded from history", async () => {
    const pending = deferredResponse()
    const latest = userMessage("message-2", { time: { created: 2 } })
    const older = userMessage("message-1")
    const stale = textPart(older.id, { text: "stale" })
    const live = { ...stale, text: "live" }
    const store = createServerSession(messageClient(response([{ info: latest, parts: [] }], "older"), pending.promise))
    await store.sync("child")
    const loading = store.history.loadMore("child")

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: live, time: 2 } })
    pending.resolve(response([{ info: older, parts: [stale] }]))
    await loading

    expect(store.data.part[older.id]).toEqual([live])
  })

  test("does not clear newer orphan parts after terminal history prepend", async () => {
    const pending = deferredResponse()
    const latest = userMessage("message-2", { time: { created: 2 } })
    const older = userMessage("message-1")
    const newer = userMessage("message-3", { time: { created: 3 } })
    const part = textPart(newer.id, { text: "live" })
    const store = createServerSession(messageClient(response([{ info: latest, parts: [] }], "older"), pending.promise))
    await store.sync("child")
    const loading = store.history.loadMore("child")

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 3 } })
    pending.resolve(response([{ info: older, parts: [] }]))
    await loading
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: newer } })

    expect(store.data.part[newer.id]).toEqual([part])
  })

  test("accepts an authoritative history part after an earlier unknown-parent update", async () => {
    const pending = deferredResponse()
    const history = deferredResponse()
    const latest = userMessage("message-2", { time: { created: 2 } })
    const older = userMessage("message-1")
    const part = textPart(older.id, { text: "live" })
    const store = createServerSession(messageClient(pending.promise, history.promise))
    const loading = store.sync("child")

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })
    pending.resolve(response([{ info: latest, parts: [] }], "older"))
    await loading

    expect(store.data.part[older.id]).toEqual([part])

    const loadingHistory = store.history.loadMore("child")
    history.resolve(response([{ info: older, parts: [{ ...part, text: "stale" }] }]))
    await loadingHistory

    expect(store.data.part[older.id]).toEqual([{ ...part, text: "stale" }])
  })

  test("preserves an unknown-parent part removal across pages", async () => {
    const initial = deferredResponse()
    const history = deferredResponse()
    const latest = userMessage("message-2", { time: { created: 2 } })
    const older = userMessage("message-1")
    const part = textPart(older.id)
    const store = createServerSession(messageClient(initial.promise, history.promise))
    const loading = store.sync("child")

    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: older.id, partID: part.id },
    })
    initial.resolve(response([{ info: latest, parts: [] }], "older"))
    await loading
    const loadingHistory = store.history.loadMore("child")
    history.resolve(response([{ info: older, parts: [part] }]))
    await loadingHistory

    expect(store.data.part[older.id]).toBeUndefined()
  })

  test("clears orphaned parts when a refresh drops a message", async () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "stale" })
    const store = createServerSession(messageClient(response([{ info: message, parts: [part] }]), response()))
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })
    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([])
    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { sessionID: "root", info: session("root") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })

    expect(ctx.store.get("root")?.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
    expect(ctx.get).toEqual([])
  })

  test("preserves pinned session content under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.optimistic.add({
      sessionID: "active",
      message: {
        id: "message",
        sessionID: "active",
        role: "assistant",
        time: { created: 1 },
        parentID: "parent",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "agent",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })

    for (let index = 0; index < 50; index++) {
      ctx.store.remember(session(`session-${index}`))
      ctx.store.apply({
        type: "session.status",
        properties: { sessionID: `session-${index}`, status: { type: "idle" } },
      })
    }

    expect(ctx.store.data.message.active?.map((message) => message.id)).toEqual(["message"])
    expect(ctx.store.data.session_status["session-0"]).toBeUndefined()
  })
})

describe("computer screenshots deleted by desktop main (D23)", () => {
  const image = {
    id: "file",
    sessionID: "child",
    messageID: "message",
    type: "file",
    mime: "image/jpeg",
    url: "data:,",
  }
  const shot = (id: string, end: number, tool = "computer") =>
    ({
      id,
      sessionID: "child",
      messageID: "message",
      type: "tool",
      tool,
      callID: `call-${id}`,
      state: {
        status: "completed",
        input: { action: "screenshot" },
        output: "Looked at Numbers",
        title: "Looked at Numbers",
        metadata: { action: "screenshot" },
        time: { start: end - 1, end },
        attachments: [image],
      },
    }) as unknown as Part
  // What the engine stored after the deletion: its media gone and the removal marker set.
  const removed = (part: Part) => {
    const { attachments: _, ...state } = (part as unknown as { state: Record<string, unknown> }).state
    return {
      ...part,
      state: { ...state, metadata: { ...(state.metadata as object), screenshotRemoved: true } },
    } as unknown as Part
  }
  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve()
  }
  const toolState = (part: Part | undefined) => (part as unknown as { state: Record<string, unknown> }).state

  test("the cached copy changes at once, keeping the removal marker, and the conversation is read again", async () => {
    const message = userMessage("message")
    const old = shot("part-old", 10)
    const recent = shot("part-new", 1_000)
    const other = shot("part-read", 10, "read")
    const text = textPart(message.id)
    const client = messageClient(
      response([{ info: message, parts: [old, recent, other, text] }]),
      response([{ info: message, parts: [removed(old), recent, other, text] }]),
    )
    const store = createServerSession(client)
    await store.sync("child")

    expect(store.removeComputerScreenshots({ before: 100 })).toEqual(["child"])
    const parts = store.data.part[message.id]!
    expect(toolState(parts.find((part) => part.id === old.id))).toEqual(toolState(removed(old)))
    // A screenshot inside the cutoff's range, another tool's file and plain text keep everything.
    expect(toolState(parts.find((part) => part.id === recent.id))).toEqual(toolState(recent))
    expect(toolState(parts.find((part) => part.id === other.id))).toEqual(toolState(other))
    expect(parts.find((part) => part.id === text.id)).toEqual(text)

    await client.requested(2)
    await flush()
    expect(client.requests).toEqual([
      { sessionID: "child", limit: 2, before: undefined },
      { sessionID: "child", limit: 1, before: undefined },
    ])
    expect(toolState(store.data.part[message.id]!.find((part) => part.id === old.id))).toEqual(toolState(removed(old)))
  })

  test("a deletion outside the cache changes nothing and reads nothing", async () => {
    const message = userMessage("message")
    const client = messageClient(response([{ info: message, parts: [shot("part", 10)] }]))
    const store = createServerSession(client)
    await store.sync("child")
    expect(store.removeComputerScreenshots({ sessionID: "another" })).toEqual([])
    expect(store.removeComputerScreenshots({ before: 5 })).toEqual([])
    await flush()
    expect(client.requests).toHaveLength(1)
    expect(toolState(store.data.part[message.id]![0]).attachments).toHaveLength(1)
  })

  test("a page read before the deletion finished cannot bring its screenshots back", async () => {
    const message = userMessage("message")
    const part = shot("part", 10)
    const pending = deferredResponse()
    const store = createServerSession(messageClient(pending.promise))
    const loading = store.sync("child")
    // Nothing is cached yet, so there is nothing to change or read again now.
    expect(store.removeComputerScreenshots({ all: true })).toEqual([])
    pending.resolve(response([{ info: message, parts: [part] }]))
    await loading
    expect(toolState(store.data.part[message.id]![0])).toEqual(toolState(removed(part)))
  })

  test("the conversation is read again only after a read already under way has finished", async () => {
    const message = userMessage("message")
    const part = shot("part", 10)
    const stale = deferredResponse()
    const client = messageClient(
      response([{ info: message, parts: [part] }]),
      stale.promise,
      response([{ info: message, parts: [removed(part)] }]),
    )
    const store = createServerSession(client)
    await store.sync("child")
    const reading = store.sync("child", { force: true })
    await client.requested(2)

    expect(store.removeComputerScreenshots({ sessionID: "child" })).toEqual(["child"])
    await flush()
    expect(client.requests).toHaveLength(2)
    // The read under way answers with the screenshot it saw before the deletion; the marker survives it.
    stale.resolve(response([{ info: message, parts: [part] }]))
    await reading
    expect(toolState(store.data.part[message.id]![0])).toEqual(toolState(removed(part)))
    await client.requested(3)
    await flush()
    expect(toolState(store.data.part[message.id]![0])).toEqual(toolState(removed(part)))
  })
})
