import { expect, test } from "bun:test"
import type { Connect } from "@vectordevai/schema/connect"
import { createVectorClient, type PermissionRequest } from "@vectordevai/sdk/v2/client"
import { createConnectClient } from "./client"
import {
  createDirectoryReviewController,
  directoryPermissionMatches,
  directoryRunMatches,
  type DirectoryReviewState,
} from "./directory-review-controller"
import { createDirectoryReviewReservation } from "./directory-review-reservation"
import { reviewRun } from "./test-fixture"

const target = { workspaceID: "workspace-fixture", directory: "/fixture/isolated", base: "a".repeat(40) }
const consumed = {
  code: "consumed" as const,
  message: "This review start did not complete and no review ran. Start a new review.",
}
const pending = {
  code: "pending" as const,
  message: "This review start is not confirmed yet. Retry it shortly; a retry never starts a second review.",
}

/** A real SDK rejection, so the controller sees the SDK's own error shape. */
function refusal(body: unknown, status = 400) {
  return createConnectClient(
    createVectorClient({
      baseUrl: "http://engine.test",
      directory: target.directory,
      fetch: async () => Response.json(body, { status }),
    }),
  ).directoryReview({
    requestKey: "0196aa50-50d0-4f17-9c1d-85eff018e829",
    target: { kind: "branch", base: target.base },
    background: true,
  })
}

function marker() {
  const value = { pending: false, holds: [] as boolean[], confirms: 0, discards: 0 }
  const admission = {
    pending: () => value.pending,
    hold: (retry: boolean) => {
      value.holds.push(retry)
      value.pending = true
    },
    confirm: () => {
      value.confirms++
      value.pending = false
    },
    discard: () => {
      value.discards++
      value.pending = false
    },
  }
  return { value, admission }
}

function run(): Connect.Run {
  const fixture = reviewRun()
  if (fixture.request.action !== "review") throw new Error("The fixture must be a review.")
  return {
    ...fixture,
    request: {
      ...fixture.request,
      directory: target.directory,
      requester: { kind: "user" },
      target: { kind: "branch", base: target.base },
      background: true,
    },
    status: "running",
    result: undefined,
  }
}

function permission(): PermissionRequest {
  return {
    id: "per_fixture",
    sessionID: "ses_private_execution_anchor",
    permission: "connect_model",
    patterns: ["provider/model"],
    always: [],
    metadata: {
      directoryReview: true,
      runID: "cr_fixture",
      directory: target.directory,
      description: "Send this workspace diff to provider/model, capped at $0.50.",
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function fixture(enabled = true, admission?: Parameters<typeof createDirectoryReviewController>[0]["admission"]) {
  const data = {
    current: true,
    run: run(),
    runs: [] as Connect.Run[],
    pending: [] as PermissionRequest[],
    calls: [] as string[],
    replies: [] as { id: string; reply: string }[],
    signals: [] as AbortSignal[],
    states: [] as DirectoryReviewState[],
    invalidate: (): void => undefined,
    start: async (): Promise<Connect.Run> => data.run,
    get: async (): Promise<Connect.Run> => data.run,
    pendingRead: async (): Promise<readonly PermissionRequest[]> => data.pending,
  }
  const controller = createDirectoryReviewController({
    target,
    enabled,
    current: () => data.current,
    admission,
    changed: (state) => {
      data.states.push(state)
    },
    subscribe: (notify) => {
      data.calls.push("subscribe")
      data.invalidate = notify
      return () => data.calls.push("unsubscribe")
    },
    transport: {
      runs: async (signal) => {
        data.calls.push("runs")
        data.signals.push(signal)
        return data.runs
      },
      get: async (id, signal) => {
        data.calls.push(`get:${id}`)
        data.signals.push(signal)
        return data.get()
      },
      start: async () => {
        data.calls.push("start")
        return data.start()
      },
      pending: async (signal) => {
        data.calls.push("pending")
        data.signals.push(signal)
        return data.pendingRead()
      },
      reply: async (id, reply) => {
        data.calls.push("reply")
        data.replies.push({ id, reply })
      },
      cancel: async (id) => {
        data.calls.push(`cancel:${id}`)
        data.pending = []
        data.run = {
          ...data.run,
          status: "done",
          result: { ...reviewRun().result!, state: "cancelled", verdict: "not-reviewed" },
        }
        return true
      },
    },
  })
  return { data, controller }
}

test("disabled engines neither subscribe nor read, start, reply or stop", async () => {
  const { data, controller } = fixture(false)
  await controller.start()
  await controller.refresh()
  await controller.reply(permission().id, "once")
  await controller.cancel()
  controller.dispose()
  expect(data.calls).toEqual([])
  expect(controller.state.phase).toBe("unavailable")
})

test("an ask arriving before the POST response is recovered by owner GET, and only an explicit once click replies", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  const admission = deferred<Connect.Run>()
  data.start = () => {
    data.pending = [permission()]
    data.invalidate()
    return admission.promise
  }
  const started = controller.start()
  expect(data.replies).toEqual([])
  expect(data.calls.indexOf("subscribe")).toBeLessThan(data.calls.indexOf("start"))
  admission.resolve({ ...data.run, status: "queued" })
  await started
  expect(controller.state.run?.status).toBe("running")
  expect(controller.state.permission?.id).toBe(permission().id)
  expect(data.calls).toContain("get:cr_fixture")
  expect(data.calls).toContain("pending")
  const first = controller.reply(permission().id, "once")
  const second = controller.reply(permission().id, "once")
  await Promise.all([first, second])
  expect(data.replies).toEqual([{ id: permission().id, reply: "once" }])
  expect(controller.state.permission).toBeUndefined()
  controller.dispose()
})

test("reload recovers the owned run and pending consent; rejection and cancellation are explicit", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.runs = [data.run]
  data.pending = [permission()]
  await controller.refresh()
  expect(controller.state.permission?.id).toBe(permission().id)
  await controller.reply(permission().id, "reject")
  expect(data.replies).toEqual([{ id: permission().id, reply: "reject" }])
  expect(data.calls.some((call) => call.startsWith("cancel:"))).toBe(false)
  await controller.cancel()
  expect(data.calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:cr_fixture"])
  expect(controller.state.run?.result?.state).toBe("cancelled")
  expect(controller.state.permission).toBeUndefined()
  controller.dispose()
})

test("events cannot establish findings: a fresh owner read supplies partial results", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.runs = [data.run]
  await controller.refresh()
  data.run = { ...data.run, status: "done", result: reviewRun().result }
  data.invalidate()
  await controller.refresh()
  expect(controller.state.run?.result?.state).toBe("partial")
  expect(controller.state.run?.result?.verdict).toBe("incomplete")
  controller.dispose()
})

test("session, base, directory and ask metadata tampering cannot authorize a directory review", () => {
  const good = run()
  if (good.request.action !== "review") throw new Error("The fixture must be a review.")
  expect(directoryRunMatches(good, target)).toBe(true)
  expect(directoryRunMatches({ ...good, request: { ...good.request, directory: "/other" } }, target)).toBe(false)
  expect(
    directoryRunMatches({ ...good, request: { ...good.request, requester: reviewRun().request.requester } }, target),
  ).toBe(false)
  expect(
    directoryRunMatches(
      { ...good, request: { ...good.request, target: { kind: "branch", base: "b".repeat(40) } } },
      target,
    ),
  ).toBe(false)
  for (const metadata of [{ directoryReview: false }, { directory: "/other" }, { runID: "cr_other" }]) {
    const ask = permission()
    expect(directoryPermissionMatches({ ...ask, metadata: { ...ask.metadata, ...metadata } }, good)).toBe(false)
  }
  expect(directoryPermissionMatches({ ...permission(), permission: "connect_write" }, good)).toBe(false)
})

test("a stale SDK/workspace epoch cannot approve or cancel after an awaited owner read", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.runs = [data.run]
  data.pending = [permission()]
  await controller.refresh()
  const loaded = deferred<Connect.Run>()
  data.get = () => loaded.promise
  const answering = controller.reply(permission().id, "once")
  data.current = false
  loaded.resolve(data.run)
  await answering
  await controller.cancel()
  expect(data.replies).toEqual([])
  expect(data.calls.some((call) => call.startsWith("cancel:"))).toBe(false)
  controller.dispose()
  expect(data.signals.every((signal) => signal.aborted)).toBe(true)
})

test("unmount during admission ignores its late response without stopping the admitted job", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  const admission = deferred<Connect.Run>()
  data.start = () => admission.promise
  const started = controller.start()
  controller.dispose()
  admission.resolve(data.run)
  await started
  expect(data.calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
  expect(data.replies).toEqual([])
  expect(data.calls.filter((call) => call.startsWith("get:"))).toEqual([])
})

test("a cross-directory owner response clears the approval and refuses its reply", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.runs = [data.run]
  data.pending = [permission()]
  await controller.refresh()
  data.run = { ...data.run, request: { ...data.run.request, directory: "/other" } }
  await controller.reply(permission().id, "once")
  expect(data.replies).toEqual([])
  expect(controller.state.phase).toBe("unavailable")
  expect(controller.state.permission).toBeUndefined()
  expect(controller.state.run).toBeUndefined()
  controller.dispose()
})

test("a failed owner read destroys previously displayed private findings and aborts the pending approval read", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.run = { ...data.run, status: "done", result: reviewRun().result }
  data.runs = [data.run]
  await controller.refresh()
  expect(controller.state.run?.result?.findings).toHaveLength(1)
  const pending = deferred<readonly PermissionRequest[]>()
  data.pendingRead = () => pending.promise
  data.get = async () => {
    throw new Error("403 with private payload")
  }
  await controller.refresh()
  expect(controller.state.phase).toBe("unavailable")
  expect(controller.state.run).toBeUndefined()
  expect(controller.state.permission).toBeUndefined()
  expect(JSON.stringify(controller.state)).not.toContain(reviewRun().result!.findings[0].body)
  expect(data.signals.every((signal) => signal.aborted)).toBe(true)
  pending.resolve([permission()])
  await Promise.resolve()
  expect(controller.state.run).toBeUndefined()
  controller.dispose()
})

test("same-SDK authority retirement immediately clears results and ignores a delayed old GET without a reply or stop", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.run = { ...data.run, status: "done", result: reviewRun().result }
  data.runs = [data.run]
  await controller.refresh()
  const delayed = deferred<Connect.Run>()
  data.get = () => delayed.promise
  const old = controller.refresh()
  controller.retire()
  expect(controller.state.run).toBeUndefined()
  expect(controller.state.permission).toBeUndefined()
  delayed.resolve(data.run)
  await old
  await controller.start()
  await controller.reply(permission().id, "once")
  await controller.cancel()
  expect(controller.state.run).toBeUndefined()
  expect(data.replies).toEqual([])
  expect(data.calls.filter((call) => call === "start" || call.startsWith("cancel:"))).toEqual([])
})

test("a lost admission flushes early notifications but empty or unrelated terminal history never authorizes another POST", async () => {
  const marker = { pending: false }
  const admission = {
    pending: () => marker.pending,
    hold: () => {
      marker.pending = true
    },
    confirm: () => {
      marker.pending = false
    },
    discard: () => {
      marker.pending = false
    },
  }
  const { data, controller } = fixture(true, admission)
  await controller.refresh()
  data.start = async () => {
    data.invalidate()
    throw new Error("Lost POST response")
  }
  await controller.start()
  expect(controller.state.admissionUncertain).toBe(true)
  expect(marker.pending).toBe(true)
  expect(data.calls.filter((call) => call === "runs").length).toBeGreaterThan(1)
  await controller.start()
  data.run = { ...data.run, status: "done", result: reviewRun().result }
  data.runs = [data.run]
  await controller.refresh()
  await controller.start()
  expect(marker.pending).toBe(true)
  expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
  controller.dispose()
  const reopened = fixture(true, admission)
  await reopened.controller.refresh()
  await reopened.controller.start()
  expect(reopened.controller.state.admissionUncertain).toBe(true)
  expect(reopened.data.calls).not.toContain("start")
  reopened.controller.dispose()
})

test("only an explicit retry can confirm the same held admission, and a stale successful POST cannot release its marker", async () => {
  const marker = { pending: false, confirmations: 0 }
  const admission = {
    pending: () => marker.pending,
    hold: () => {
      marker.pending = true
    },
    confirm: () => {
      marker.pending = false
      marker.confirmations++
    },
    discard: () => {
      marker.pending = false
    },
  }
  const first = fixture(true, admission)
  await first.controller.refresh()
  first.data.start = async () => {
    throw new Error("Lost response")
  }
  await first.controller.start()
  expect(marker.confirmations).toBe(0)
  first.controller.dispose()
  const retry = fixture(true, admission)
  await retry.controller.refresh()
  expect(retry.data.calls).not.toContain("start")
  await retry.controller.start(true)
  expect(retry.data.calls.filter((call) => call === "start")).toHaveLength(1)
  expect(marker.confirmations).toBe(1)
  expect(retry.controller.state.admissionUncertain).toBe(false)
  retry.controller.dispose()
  const stale = fixture(true, admission)
  await stale.controller.refresh()
  const accepted = deferred<Connect.Run>()
  stale.data.start = () => accepted.promise
  const starting = stale.controller.start()
  stale.controller.retire()
  accepted.resolve(stale.data.run)
  await starting
  expect(marker.pending).toBe(true)
  expect(marker.confirmations).toBe(1)
  expect(stale.controller.state.run).toBeUndefined()
})

test("authority retirement while an approval GET is pending cannot send an old permission reply", async () => {
  const { data, controller } = fixture()
  await controller.refresh()
  data.runs = [data.run]
  data.pending = [permission()]
  await controller.refresh()
  const delayed = deferred<Connect.Run>()
  data.get = () => delayed.promise
  const reply = controller.reply(permission().id, "once")
  controller.retire()
  expect(controller.state.permission).toBeUndefined()
  delayed.resolve(data.run)
  await reply
  expect(data.replies).toEqual([])
  expect(controller.state.run).toBeUndefined()
})

test("a consumed answer discards its key and shows the engine's message; only an explicit new start sends again", async () => {
  const saved = marker()
  const { data, controller } = fixture(true, saved.admission)
  await controller.refresh()
  data.start = async () => {
    throw new TypeError("The POST response was lost")
  }
  await controller.start()
  data.start = () => refusal(consumed)
  await controller.start(true)
  expect(saved.value.discards).toBe(1)
  expect(saved.value.pending).toBe(false)
  expect(controller.state.admissionUncertain).toBe(false)
  expect(controller.state.admissionAnswer).toEqual(consumed)
  data.invalidate()
  await controller.refresh()
  await controller.start(true)
  expect(controller.state.admissionAnswer).toEqual(consumed)
  expect(data.calls.filter((call) => call === "start")).toHaveLength(2)
  expect(saved.value.holds).toEqual([false, true])
  data.start = async () => data.run
  await controller.start()
  expect(saved.value.holds).toEqual([false, true, false])
  expect(data.calls.filter((call) => call === "start")).toHaveLength(3)
  expect(saved.value.confirms).toBe(1)
  expect(saved.value.discards).toBe(1)
  expect(controller.state.admissionAnswer).toBeUndefined()
  expect(controller.state.run?.status).toBe("running")
  controller.dispose()
})

test("a pending answer keeps its key and the engine's message, and nothing retries on its own", async () => {
  const saved = marker()
  const { data, controller } = fixture(true, saved.admission)
  await controller.refresh()
  data.start = () => refusal(pending)
  await controller.start()
  expect(controller.state.admissionUncertain).toBe(true)
  expect(controller.state.admissionAnswer).toEqual(pending)
  expect(saved.value.pending).toBe(true)
  data.invalidate()
  await controller.refresh()
  await controller.start()
  expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
  expect(saved.value.holds).toEqual([false])
  expect(saved.value.discards).toBe(0)
  data.start = async () => data.run
  await controller.start(true)
  expect(saved.value.holds).toEqual([false, true])
  expect(saved.value.confirms).toBe(1)
  expect(saved.value.discards).toBe(0)
  expect(controller.state.admissionUncertain).toBe(false)
  expect(controller.state.admissionAnswer).toBeUndefined()
  controller.dispose()
})

test("a consumed answer that lands after retirement leaves the marker for the next view", async () => {
  const saved = marker()
  const { data, controller } = fixture(true, saved.admission)
  await controller.refresh()
  const answered = deferred<void>()
  data.start = async () => {
    await answered.promise
    return refusal(consumed)
  }
  const starting = controller.start()
  controller.retire()
  answered.resolve()
  await starting
  expect(saved.value.discards).toBe(0)
  expect(saved.value.pending).toBe(true)
  expect(controller.state.admissionAnswer).toBeUndefined()
})

for (const [name, failure] of [
  [
    "an invalid answer",
    () => refusal({ code: "invalid", message: "This request key already belongs to a different review input." }),
  ],
  ["a 403 refusal", () => refusal({ message: "Owner only" }, 403)],
  ["a consumed code on another status", () => refusal(consumed, 500)],
  ["a consumed answer without a message", () => refusal({ code: "consumed", message: "" })],
  ["an unknown code", () => refusal({ code: "other", message: "Something else happened." })],
  [
    "a fetch failure",
    async () => {
      throw new TypeError("fetch failed")
    },
  ],
] as const)
  test(`${name} keeps the key for the same explicit retry`, async () => {
    const saved = marker()
    const { data, controller } = fixture(true, saved.admission)
    await controller.refresh()
    data.start = failure
    await controller.start()
    expect(controller.state.admissionUncertain).toBe(true)
    expect(controller.state.admissionAnswer).toBeUndefined()
    expect(saved.value.pending).toBe(true)
    expect(saved.value.discards).toBe(0)
    await controller.start()
    expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
    controller.dispose()
  })

test("a consumed answer whose discard is refused keeps the key held and still shows the engine's message", async () => {
  const saved = marker()
  const admission = {
    ...saved.admission,
    discard: () => {
      throw new Error("The saved review request changed.")
    },
  }
  const { data, controller } = fixture(true, admission)
  await controller.refresh()
  data.start = async () => {
    throw new TypeError("The POST response was lost")
  }
  await controller.start()
  data.start = () => refusal(consumed)
  await controller.start(true)
  expect(saved.value.pending).toBe(true)
  expect(controller.state.admissionUncertain).toBe(true)
  expect(controller.state.admissionAnswer).toEqual(consumed)
  data.runs = [data.run]
  data.invalidate()
  await controller.refresh()
  expect(controller.state.run?.status).toBe("running")
  expect(controller.state.admissionAnswer).toEqual(consumed)
  await controller.start()
  expect(data.calls.filter((call) => call === "start")).toHaveLength(2)
  controller.dispose()
})

test("a consumed answer stays beside the finished run it was answered beside", async () => {
  const saved = marker()
  const { data, controller } = fixture(true, saved.admission)
  data.run = { ...data.run, status: "done", result: reviewRun().result }
  data.runs = [data.run]
  await controller.refresh()
  data.start = async () => {
    throw new TypeError("The POST response was lost")
  }
  await controller.start()
  data.start = () => refusal(consumed)
  await controller.start(true)
  expect(controller.state.run?.id).toBe(data.run.id)
  expect(controller.state.admissionAnswer).toEqual(consumed)
  data.invalidate()
  await controller.refresh()
  expect(controller.state.run?.status).toBe("done")
  expect(controller.state.admissionAnswer).toEqual(consumed)
  controller.dispose()
})

for (const status of ["running", "done"] as const)
  test(`another view's later ${status} run replaces a consumed message for good`, async () => {
    const saved = marker()
    const { data, controller } = fixture(true, saved.admission)
    await controller.refresh()
    data.start = async () => {
      throw new TypeError("The POST response was lost")
    }
    await controller.start()
    data.start = () => refusal(consumed)
    await controller.start(true)
    expect(controller.state.admissionAnswer).toEqual(consumed)
    data.run = status === "done" ? { ...data.run, status, result: reviewRun().result } : data.run
    data.runs = [data.run]
    data.invalidate()
    await controller.refresh()
    expect(controller.state.run?.status).toBe(status)
    expect(controller.state.admissionAnswer).toBeUndefined()
    data.run = { ...data.run, status: "done", result: reviewRun().result }
    data.invalidate()
    await controller.refresh()
    expect(controller.state.run?.status).toBe("done")
    expect(controller.state.admissionAnswer).toBeUndefined()
    expect(data.calls.filter((call) => call === "start")).toHaveLength(2)
    controller.dispose()
  })

test("a consumed retry beside another view's live run leaves only that run on the card", async () => {
  const saved = marker()
  saved.value.pending = true
  const { data, controller } = fixture(true, saved.admission)
  data.runs = [data.run]
  await controller.refresh()
  expect(controller.state.run?.status).toBe("running")
  expect(controller.state.admissionUncertain).toBe(true)
  data.start = () => refusal(consumed)
  await controller.start(true)
  expect(saved.value.discards).toBe(1)
  expect(controller.state.admissionUncertain).toBe(false)
  expect(controller.state.run?.status).toBe("running")
  expect(controller.state.admissionAnswer).toBeUndefined()
  controller.dispose()
})

// CN-10 (P1-9, 2026-11-25): a retry of a saved request whose age is unknown, in the future or at least a day old may
// start a new review, so it waits for an explicit "Retry anyway" and then sends the same saved key once. These cases
// use the real reservation, wired as the view wires it.
const HOUR = 60 * 60_000
const NOW = Date.UTC(2026, 10, 25, 12)
const SAVED_KEY = "0196aa50-50d0-4f17-9c1d-85eff018e829"
const savedBody = { target: { kind: "branch" as const, base: target.base }, background: true }

/** The real reservation over a marker a lost POST left behind, saved at `savedAt` (absent: a legacy 3-key marker). */
function savedMarker(savedAt?: number) {
  const values = new Map<string, string>()
  const raw = JSON.stringify({ requestKey: SAVED_KEY, ...savedBody, ...(savedAt === undefined ? {} : { savedAt }) })
  values.set("marker", raw)
  const reservation = createDirectoryReviewReservation({
    storage: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => void values.set(name, value),
      removeItem: (name: string) => void values.delete(name),
    },
    key: "marker",
    body: savedBody,
    requestKey: () => {
      throw new Error("A retry never mints a key.")
    },
    now: () => NOW,
  })
  return { values, raw, reservation, admission: { ...reservation, stale: () => reservation.retryStale() } }
}

for (const [name, savedAt] of [
  ["an unknown-age", undefined],
  ["a 25-hour-old", NOW - 25 * HOUR],
  ["a future-dated", NOW + HOUR],
] as const)
  test(`${name} saved request sends nothing until its retry is confirmed, then its original key once`, async () => {
    const saved = savedMarker(savedAt)
    const posts: unknown[] = []
    const { data, controller } = fixture(true, saved.admission)
    data.start = async () => {
      posts.push(saved.reservation.request())
      return data.run
    }
    await controller.refresh()
    expect(controller.state.admissionUncertain).toBe(true)
    await controller.start(true)
    expect(posts).toEqual([])
    expect(data.calls).not.toContain("start")
    expect(controller.state.confirmRetry).toBe(true)
    expect(controller.state.busy).toBe(false)
    expect(saved.values.get("marker")).toBe(saved.raw)
    // Cancel leaves the request held and unsent, and the next retry asks again.
    controller.cancelRetry()
    expect(controller.state.confirmRetry).toBeUndefined()
    expect(controller.state.admissionUncertain).toBe(true)
    expect(saved.reservation.pending()).toBe(true)
    expect(saved.values.get("marker")).toBe(saved.raw)
    expect(data.calls).not.toContain("start")
    await controller.start(true)
    expect(posts).toEqual([])
    expect(controller.state.confirmRetry).toBe(true)
    // A double click on "Retry anyway" still sends one request.
    await Promise.all([controller.confirmRetry(), controller.confirmRetry()])
    expect(posts).toEqual([{ requestKey: SAVED_KEY, ...savedBody }])
    expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
    expect(controller.state.confirmRetry).toBeUndefined()
    expect(controller.state.admissionUncertain).toBe(false)
    expect(saved.values.has("marker")).toBe(false)
    await controller.confirmRetry()
    expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
    controller.dispose()
  })

test("a saved request under 24 hours old retries at once with its original key, without asking", async () => {
  const saved = savedMarker(NOW - 23 * HOUR)
  const posts: unknown[] = []
  const { data, controller } = fixture(true, saved.admission)
  data.start = async () => {
    posts.push(saved.reservation.request())
    return data.run
  }
  await controller.refresh()
  await controller.start(true)
  expect(posts).toEqual([{ requestKey: SAVED_KEY, ...savedBody }])
  expect(data.states.some((state) => state.confirmRetry)).toBe(false)
  expect(controller.state.admissionUncertain).toBe(false)
  controller.dispose()
})

test("retirement drops an unanswered retry question, and a later confirmation sends nothing", async () => {
  const saved = savedMarker()
  const { data, controller } = fixture(true, saved.admission)
  await controller.refresh()
  await controller.start(true)
  expect(controller.state.confirmRetry).toBe(true)
  controller.retire()
  expect(controller.state.confirmRetry).toBeUndefined()
  await controller.confirmRetry()
  expect(data.calls).not.toContain("start")
  expect(saved.values.get("marker")).toBe(saved.raw)
})

test("a stale check that throws asks before the retry, as an old request does", async () => {
  const saved = marker()
  const admission = {
    ...saved.admission,
    stale: () => {
      throw new Error("The clock could not be read.")
    },
  }
  const { data, controller } = fixture(true, admission)
  await controller.refresh()
  data.start = async () => {
    throw new TypeError("The POST response was lost")
  }
  await controller.start()
  expect(controller.state.admissionUncertain).toBe(true)
  await controller.start(true)
  expect(controller.state.confirmRetry).toBe(true)
  expect(saved.value.holds).toEqual([false])
  expect(data.calls.filter((call) => call === "start")).toHaveLength(1)
  data.start = async () => data.run
  await controller.confirmRetry()
  expect(saved.value.holds).toEqual([false, true])
  expect(saved.value.confirms).toBe(1)
  expect(data.calls.filter((call) => call === "start")).toHaveLength(2)
  controller.dispose()
})
