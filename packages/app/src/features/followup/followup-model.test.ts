import { describe, expect, test } from "bun:test"
import {
  adopt,
  ATTACHMENT_LIMIT,
  attachmentBytes,
  claim,
  enqueue,
  lastRunEnded,
  legacyQueues,
  markFailed,
  nextToSend,
  parseQueue,
  pause,
  previewText,
  release,
  remove,
  resume,
  retry,
  SERVER_LIMIT,
  SESSION_LIMIT,
  serversWithItems,
  type FollowupGate,
  type FollowupItem,
  type FollowupQueue,
} from "./followup-model"

const item = (id: string, extra: Partial<FollowupItem> = {}): FollowupItem => ({
  id,
  sessionID: "ses_1",
  sessionDirectory: "/repo",
  prompt: [{ type: "text", content: `message ${id}`, start: 0, end: 9 }],
  context: [],
  agent: "build",
  model: { providerID: "p", modelID: "m" },
  ...extra,
})

const queueOf = (...ids: string[]): FollowupQueue => ({ items: ids.map((id) => item(id)) })

const open: FollowupGate = { busy: false, blocked: false, child: false, sending: false, lastRun: { ended: "ok" } }

const image = (bytes: number) => ({
  type: "image" as const,
  id: "img",
  filename: "a.png",
  mime: "image/png",
  dataUrl: "x".repeat(bytes),
})

describe("follow-up model: limits", () => {
  test("accepts messages until the per-session limit", () => {
    const queue = { items: Array.from({ length: SESSION_LIMIT - 1 }, (_, index) => item(`i${index}`)) }
    const result = enqueue(queue, item("last"), SESSION_LIMIT - 1)
    expect("queue" in result && result.queue.items).toHaveLength(SESSION_LIMIT)
  })

  test("refuses a twenty-first message in one session", () => {
    const queue = { items: Array.from({ length: SESSION_LIMIT }, (_, index) => item(`i${index}`)) }
    expect(enqueue(queue, item("over"), SESSION_LIMIT)).toEqual({ refused: "session" })
  })

  test("refuses past 200 queued messages on one server", () => {
    expect(enqueue(undefined, item("a"), SERVER_LIMIT - 1)).toHaveProperty("queue")
    expect(enqueue(undefined, item("a"), SERVER_LIMIT)).toEqual({ refused: "server" })
  })

  test("refuses attachments past 8 MB in one session's queue", () => {
    const half = Math.floor(ATTACHMENT_LIMIT / 2)
    const first = item("a", { prompt: [image(half)] })
    const queued = enqueue(undefined, first, 0)
    expect(queued).toHaveProperty("queue")
    const queue = (queued as { queue: FollowupQueue }).queue
    expect(enqueue(queue, item("b", { prompt: [image(ATTACHMENT_LIMIT - half)] }), 1)).toHaveProperty("queue")
    expect(enqueue(queue, item("c", { prompt: [image(ATTACHMENT_LIMIT - half + 1)] }), 1)).toEqual({
      refused: "attachments",
    })
    expect(attachmentBytes([first])).toBe(half)
  })
})

describe("follow-up model: the gate", () => {
  test("sends the head when everything is open", () => {
    expect(nextToSend(queueOf("a", "b"), open)).toEqual({ send: item("a") })
  })

  test("holds on an empty queue", () => {
    expect(nextToSend(undefined, open)).toEqual({ hold: "empty" })
    expect(nextToSend({ items: [] }, open)).toEqual({ hold: "empty" })
  })

  test.each([
    ["child", { child: true }],
    ["sending", { sending: true }],
    ["busy", { busy: true }],
    ["blocked", { blocked: true }],
  ] as const)("holds on %s", (hold, gate) => {
    expect(nextToSend(queueOf("a"), { ...open, ...gate })).toEqual({ hold })
  })

  test("holds on a paused queue", () => {
    expect(nextToSend(pause(queueOf("a"), "aborted", 1), open)).toEqual({ hold: "paused" })
  })

  test("holds on a failed head, and only on the head", () => {
    expect(nextToSend(markFailed(queueOf("a", "b"), "a"), open)).toEqual({ hold: "failed" })
    expect(nextToSend(markFailed(queueOf("a", "b"), "b"), open)).toEqual({ send: item("a") })
  })

  test.each(["budget", "aborted", "error"] as const)(
    "holds and asks for a pause when the last run ended %s",
    (ended) => {
      expect(nextToSend(queueOf("a"), { ...open, lastRun: { id: "msg_run", ended } })).toEqual({
        hold: "ended",
        reason: ended,
      })
    },
  )

  test("a resume after that run lets the queue send; a later run's error holds it again", () => {
    const resumed = resume(pause(queueOf("a"), "budget", 1), "msg_run")
    expect(nextToSend(resumed, { ...open, lastRun: { id: "msg_run", ended: "budget" } })).toEqual({ send: item("a") })
    expect(nextToSend(resumed, { ...open, lastRun: { id: "msg_next", ended: "error" } })).toEqual({
      hold: "ended",
      reason: "error",
    })
  })

  // I7: a queued follow-up is never sent after a spend stop, an abort or an error until the user resumes the queue.
  test("I7: after a spend stop nothing is sent until the queue is resumed", () => {
    const gate = { ...open, lastRun: { id: "msg_stop", ended: "budget" as const } }
    const first = nextToSend(queueOf("a"), gate)
    expect(first).toEqual({ hold: "ended", reason: "budget" })
    const paused = pause(queueOf("a"), "budget", 1)
    // Enqueueing more, a failed item removed, or the session going idle again never reopens it.
    const more = enqueue(paused, item("b"), 1)
    expect("queue" in more && nextToSend(more.queue, gate)).toEqual({ hold: "paused" })
    expect(nextToSend(remove(markFailed(paused, "a"), "a") ?? { items: [] }, gate)).toEqual({ hold: "empty" })
    expect(nextToSend(resume(paused, "msg_stop"), gate)).toEqual({ send: item("a") })
  })
})

describe("follow-up model: how the last run ended", () => {
  const assistant = (id: string, error?: { name: string }) => ({ id, role: "assistant", error })
  const user = (id: string) => ({ id, role: "user" })

  test("reads the last assistant message", () => {
    expect(lastRunEnded([user("u1"), assistant("a1", { name: "BudgetStopError" })])).toEqual({
      id: "a1",
      ended: "budget",
    })
    expect(lastRunEnded([assistant("a1", { name: "MessageAbortedError" })])).toEqual({ id: "a1", ended: "aborted" })
    expect(lastRunEnded([assistant("a1", { name: "APIError" })])).toEqual({ id: "a1", ended: "error" })
    expect(lastRunEnded([assistant("a0", { name: "APIError" }), assistant("a1")])).toEqual({ id: "a1", ended: "ok" })
    // A user message after the run (a steer, a queued send) does not hide how the run ended.
    expect(lastRunEnded([assistant("a1", { name: "APIError" }), user("u2")])).toEqual({ id: "a1", ended: "error" })
  })

  test("no messages or no assistant reads as ok", () => {
    expect(lastRunEnded(undefined)).toEqual({ ended: "ok" })
    expect(lastRunEnded([user("u1")])).toEqual({ ended: "ok" })
  })
})

describe("follow-up model: remove, markFailed, retry, claims", () => {
  test("remove drops the item and its failure; an emptied queue is gone", () => {
    const failed = markFailed(queueOf("a", "b"), "a")
    expect(remove(failed, "a")).toEqual({ items: [item("b")] })
    expect(remove(queueOf("a"), "a")).toBeUndefined()
    expect(remove(pause(queueOf("a"), "error", 1), "a")).toBeUndefined()
    const same = queueOf("a")
    expect(remove(same, "missing")).toBe(same)
  })

  test("markFailed names only an item the queue holds, and keeps its claim", () => {
    const claimed = claim(queueOf("a"), "a", "msg_sent", 5)
    expect(markFailed(claimed, "a")).toEqual({
      items: [item("a", { claim: { messageID: "msg_sent", claimedAt: 5 } })],
      failed: "a",
    })
    expect(markFailed(queueOf("a"), "zz")).toEqual(queueOf("a"))
    expect(markFailed(undefined, "a")).toBeUndefined()
  })

  test("retry clears the failure and the pause and accepts the last run", () => {
    const stuck = markFailed(pause(queueOf("a"), "error", 1), "a")
    expect(retry(stuck, "msg_run")).toEqual({ items: [item("a")], resumed: "msg_run" })
    // Resume alone keeps a failed head waiting for its own Retry.
    expect(resume(stuck, "msg_run")).toEqual({ items: [item("a")], failed: "a", resumed: "msg_run" })
  })

  test("claim and release", () => {
    const claimed = claim(queueOf("a", "b"), "a", "msg_1", 9)
    expect(claimed?.items[0]?.claim).toEqual({ messageID: "msg_1", claimedAt: 9 })
    expect(claimed?.items[1]?.claim).toBeUndefined()
    expect(release(claimed, "a")).toEqual(queueOf("a", "b"))
  })

  test("serversWithItems lists servers that hold at least one item", () => {
    expect(
      serversWithItems({ one: { ses_1: queueOf("a") }, two: { ses_2: undefined }, three: { ses_3: { items: [] } } }),
    ).toEqual(["one"])
  })
})

describe("follow-up model: stored and legacy queues", () => {
  test("parseQueue keeps valid items and drops the rest", () => {
    const parsed = parseQueue({
      items: [item("a"), { id: "broken" }, item("b", { claim: { messageID: 3 } as never })],
      failed: "gone",
      paused: { reason: "budget", at: 4 },
      resumed: "msg_x",
    })
    expect(parsed?.items.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(parsed?.items[1]?.claim).toBeUndefined()
    expect(parsed?.failed).toBeUndefined()
    expect(parsed?.paused).toEqual({ reason: "budget", at: 4 })
    expect(parsed?.resumed).toBe("msg_x")
    expect(parseQueue({ items: [{ id: "broken" }] })).toBeUndefined()
    expect(parseQueue("nope")).toBeUndefined()
  })

  test("adopt reads followup.v1, marks every item replied, and carries the pause and the failure", () => {
    const legacy = legacyQueues({
      items: { ses_1: [item("a"), item("b")], ses_2: [item("c", { sessionID: "ses_2" })], ses_3: [] },
      failed: { ses_1: "b" },
      paused: { ses_2: true },
    })
    expect(Object.keys(legacy)).toEqual(["ses_1", "ses_2"])
    expect(legacy.ses_1?.items.every((entry) => entry.replied === true)).toBe(true)
    expect(legacy.ses_1?.failed).toBe("b")
    expect(legacy.ses_2?.paused?.reason).toBe("aborted")

    const merged = adopt(queueOf("a"), legacy.ses_1!, 1)
    expect(merged?.items.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(merged?.failed).toBe("b")
    expect(adopt(undefined, legacy.ses_2!, 0)?.paused?.reason).toBe("aborted")
  })

  test("adopt stays within the session and server limits", () => {
    const many = { items: Array.from({ length: 30 }, (_, index) => item(`l${index}`)) }
    expect(adopt(undefined, many, 0)?.items).toHaveLength(SESSION_LIMIT)
    expect(adopt(undefined, many, SERVER_LIMIT - 3)?.items).toHaveLength(3)
    expect(adopt(undefined, many, SERVER_LIMIT)).toBeUndefined()
    expect(legacyQueues(undefined)).toEqual({})
  })

  test("previewText shows the first non-empty line, or nothing for attachments alone", () => {
    expect(previewText([{ type: "text", content: "\n  hello\nworld", start: 0, end: 14 }])).toBe("hello")
    expect(previewText([])).toBeUndefined()
  })
})
