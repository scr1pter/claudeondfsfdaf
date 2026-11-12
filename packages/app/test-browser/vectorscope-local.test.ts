import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { localReviewCanStart, localReviewController, type LocalReviewState } from "@/features/vectorscope/local-review"

// This exercises Solid's real browser-condition store/memo graph, without a
// JSX transform. Rendering the actual view is qualified by Playwright instead.
test("Solid's real local review state reacts to admission and preserves owned Stop after global disable", async () => {
  const parentID = SessionID.make("ses_solid_review_parent")
  const runID = SessionID.make("ses_solid_review_run")
  const target: ReviewRun.Target = { kind: "working-tree", head: "a".repeat(40) }
  const request: ReviewRun.Start = { requestID: "request_solid_review_1", target }
  const info = (status: ReviewRun.Status): ReviewRun.Info => ({
    parentID,
    runID,
    request,
    startedAt: 1,
    status,
    canStop: status === "running",
  })
  const calls = { starts: 0, stops: 0 }
  const state = createRoot((dispose) => {
    const [store, setStore] = createStore<{ value: LocalReviewState }>({
      value: { runs: [], discovered: false, uncertain: false, error: "" },
    })
    const [enabled, setEnabled] = createSignal(true)
    const controller = localReviewController({
      scope: {
        identity: {},
        server: "solid-fixture",
        parentID,
        directory: "/repo",
        projectID: "project",
        api: {
          verify: async () => target,
          list: async () => ({ runs: [] }),
          start: async () => {
            calls.starts++
            return info("running")
          },
          get: async () => info("running"),
          stop: async () => {
            calls.stops++
            return info("cancelled")
          },
        },
      },
      enabled,
      changed: (value) => setStore("value", reconcile(value)),
      requestID: () => request.requestID,
    })
    const canStart = createMemo(() => localReviewCanStart(store.value, enabled()))
    const current = createMemo(() => store.value.current)
    return { dispose, controller, canStart, current, setEnabled }
  })
  try {
    expect(state.canStart()).toBe(false)
    await state.controller.check()
    expect(state.canStart()).toBe(true)
    expect(calls.starts).toBe(0)
    await state.controller.start("working-tree")
    expect(state.current()?.run.status).toBe("running")
    expect(state.canStart()).toBe(false)
    state.setEnabled(false)
    expect(state.canStart()).toBe(false)
    expect(state.current()?.run.canStop).toBe(true)
    await state.controller.stop()
    expect(state.current()?.run.status).toBe("cancelled")
    expect(state.current()?.run.canStop).toBe(false)
    expect(calls).toEqual({ starts: 1, stops: 1 })
  } finally {
    state.controller.dispose()
    state.dispose()
  }
})
