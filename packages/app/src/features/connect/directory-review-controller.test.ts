import { expect, test } from "bun:test"
import type { Connect } from "@vectordevai/schema/connect"
import type { PermissionRequest } from "@vectordevai/sdk/v2/client"
import {
  createDirectoryReviewController,
  directoryPermissionMatches,
  directoryRunMatches,
  type DirectoryReviewState,
} from "./directory-review-controller"
import { reviewRun } from "./test-fixture"

const target = { workspaceID: "workspace-fixture", directory: "/fixture/isolated", base: "a".repeat(40) }

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
