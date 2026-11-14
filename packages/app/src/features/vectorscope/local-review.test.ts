import { describe, expect, test } from "bun:test"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { hash } from "@vectordevai/core/util/encode"
import { localReviewController, localReviewTransport, type LocalReviewAPI, type LocalReviewState } from "./local-review"

const parentID = SessionID.make("ses_local_app_parent")
const runID = SessionID.make("ses_local_app_run")
const head = "a".repeat(40)
const target: ReviewRun.Target = { kind: "working-tree", head }
const request: ReviewRun.Start = { requestID: "request_local_app_1", target }
const info = (input = request, status: ReviewRun.Status = "running"): ReviewRun.Info => ({
  runID,
  parentID,
  request: input,
  status,
  canStop: status === "running",
  startedAt: 1,
})
const summary = (value = info()): ReviewRun.Summary => ({ ...value, hasResult: false })
const pause = () => Promise.withResolvers<unknown>()

function fixture(extra: Partial<LocalReviewAPI> = {}, identity = {}) {
  const calls = {
    start: [] as ReviewRun.Start[],
    get: [] as string[],
    stop: [] as string[],
    list: [] as (string | undefined)[],
  }
  let enabled = true
  let state!: LocalReviewState
  const api: LocalReviewAPI = {
    verify: async () => target,
    list: async (cursor) => {
      calls.list.push(cursor)
      return { runs: [] }
    },
    start: async (value) => {
      calls.start.push(structuredClone(value))
      return info(value)
    },
    get: async (id) => {
      calls.get.push(id)
      return info()
    },
    stop: async (id) => {
      calls.stop.push(id)
      return info(request, "cancelled")
    },
    ...extra,
  }
  const controller = localReviewController({
    scope: { identity, server: "owner-server", parentID, directory: "/repo", projectID: "project", api },
    enabled: () => enabled,
    changed: (value) => {
      state = value
    },
    requestID: () => request.requestID,
  })
  return {
    controller,
    calls,
    api,
    state: () => state,
    enabled: (value: boolean) => {
      enabled = value
    },
  }
}

describe("engine-owned local review controller", () => {
  test("discovery does no model work and explicit Start submits only the exact public DTO once", async () => {
    const gate = pause()
    const f = fixture({
      start: async (value) => {
        f.calls.start.push(structuredClone(value))
        return gate.promise
      },
    })
    await f.controller.check()
    expect(f.calls.start).toEqual([])
    expect(f.controller.canStart()).toBe(true)
    const started = f.controller.start("staged", 0.25)
    await Promise.resolve()
    await Promise.resolve()
    await f.controller.start("working-tree", 5)
    expect(f.calls.start).toEqual([{ ...request, target: { ...target, kind: "staged" }, maxCost: 0.25 }])
    gate.resolve(info(f.calls.start[0]!))
    await started
    expect(f.state().current?.run.status).toBe("running")
    expect(f.controller.canStart()).toBe(false)
    f.controller.dispose()
  })

  test("a lost response survives close; reconnect discovers and reads without automatically resubmitting", async () => {
    const identity = {},
      f = fixture(
        {
          start: async (value) => {
            f.calls.start.push(value)
            throw new Error("untrusted upstream secret")
          },
        },
        identity,
      )
    await f.controller.check()
    await f.controller.start("working-tree")
    expect(f.state().uncertain).toBe(true)
    expect(f.state().error).not.toContain("secret")
    f.controller.dispose()
    const next = fixture({ list: async () => ({ runs: [summary()] }) }, identity)
    expect(next.state().intent).toEqual(request)
    await next.controller.check()
    expect(next.calls.start).toEqual([])
    expect(next.calls.get).toEqual([runID])
    expect(next.state().current?.run.runID).toBe(runID)
    expect(next.state().uncertain).toBe(false)
    next.controller.dispose()
  })

  test("an explicit retry keeps its key, kind, head and cost even if HEAD changed after a lost response", async () => {
    const f = fixture({
      start: async (value) => {
        f.calls.start.push(structuredClone(value))
        if (f.calls.start.length === 1) throw new Error("lost")
        return info(value)
      },
    })
    await f.controller.check()
    await f.controller.start("staged", 0.1)
    f.api.verify = async () => ({ ...target, head: "b".repeat(40) })
    await f.controller.retry()
    expect(f.calls.start).toHaveLength(2)
    expect(f.calls.start[1]).toEqual(f.calls.start[0])
    expect(f.calls.start[1]).toEqual({ ...request, target: { kind: "staged", head }, maxCost: 0.1 })
    f.controller.dispose()
  })

  test("a moved head refuses a fresh start before POST and invalid ceilings never enter transport", async () => {
    const f = fixture()
    await f.controller.check()
    for (const cost of [0, -1, NaN, Infinity]) await f.controller.start("working-tree", cost)
    f.api.verify = async () => ({ ...target, head: "b".repeat(40) })
    await f.controller.start("working-tree")
    expect(f.calls.start).toEqual([])
    expect(f.state().error).toContain("Git head changed")
    f.controller.dispose()
  })

  test("navigation aborts observations, rejects a late response, and never calls Stop", async () => {
    const gate = pause(),
      f = fixture({
        get: async (id, signal) => {
          f.calls.get.push(id)
          expect(signal.aborted).toBe(false)
          return gate.promise
        },
      })
    await f.controller.check()
    const reading = f.controller.read(summary())
    await Promise.resolve()
    const before = f.state()
    f.controller.dispose()
    gate.resolve(info())
    await reading
    expect(f.state()).toBe(before)
    expect(f.state().current).toBeUndefined()
    expect(f.calls.stop).toEqual([])
  })

  test("a late target proof after navigation cannot submit model work", async () => {
    const gate = Promise.withResolvers<ReviewRun.Target>(),
      f = fixture()
    await f.controller.check()
    f.api.verify = async (signal) => {
      signal.addEventListener("abort", () => expect(signal.aborted).toBe(true))
      return gate.promise
    }
    const starting = f.controller.start("working-tree")
    f.controller.dispose()
    gate.resolve(target)
    await starting
    expect(f.calls.start).toEqual([])
  })

  test("disabled new work still allows exact owned Stop; unknown or foreign leases cannot be stopped", async () => {
    const f = fixture()
    await f.controller.check()
    await f.controller.start("working-tree")
    f.enabled(false)
    expect(f.controller.canStart()).toBe(false)
    await f.controller.stop()
    expect(f.calls.stop).toEqual([runID])
    expect(f.state().current?.run.status).toBe("cancelled")
    f.api.get = async () => ({ ...info(), status: "unknown", canStop: false })
    await f.controller.read(summary())
    await f.controller.stop()
    expect(f.calls.stop).toEqual([runID])
    f.controller.dispose()
  })

  test("bounded summary discovery cannot accept another parent, duplicate pages, or silently skip remaining history", async () => {
    const f = fixture({ list: async () => ({ runs: [summary()], next: "ses_history_next" }) })
    await f.controller.check()
    expect(f.controller.canStart()).toBe(false)
    await f.controller.check(true)
    expect(f.state().error).toContain("cursor")
    f.api.list = async () => ({ runs: [{ ...summary(), parentID: "ses_other_parent" }] })
    await f.controller.check()
    expect(f.state().error).toContain("another conversation")
    expect(f.calls.start).toEqual([])
    f.controller.dispose()
  })

  test("a corrupt artifact, parent, request, or exact run cannot become a retained clean result", async () => {
    const json = JSON.stringify({
      exitCode: 2,
      error: "Provider refused",
      verdict: reviewVerdict({ kind: "failure", stage: "review" }),
    })
    const artifact: ReviewRun.Artifact = {
      version: 1,
      json,
      bytes: new TextEncoder().encode(json).byteLength,
      sha256: await hash(json),
    }
    const value = { ...info(request, "failed"), artifact }
    const f = fixture({ get: async () => value })
    await f.controller.check()
    await f.controller.read(summary())
    expect(f.state().current?.run.status).toBe("failed")
    expect(f.state().current?.verdict.verdict).not.toBe("clean-complete")
    for (const broken of [
      { ...value, artifact: { ...artifact, sha256: "0".repeat(64) } },
      { ...value, parentID: "ses_other_parent" },
      { ...value, runID: "ses_other_run" },
      { ...value, request: { ...request, maxCost: 99 } },
    ]) {
      f.api.get = async () => broken
      await f.controller.read(summary())
      expect(f.state().current).toBeUndefined()
      expect(f.state().error).toContain("could not be verified")
    }
    f.controller.dispose()
  })

  test("a different SDK identity never inherits an uncertain retry descriptor", async () => {
    const f = fixture({
      start: async () => {
        throw new Error("lost")
      },
    })
    await f.controller.check()
    await f.controller.start("working-tree")
    f.controller.dispose()
    const other = fixture()
    expect(other.state().intent).toBeUndefined()
    expect(other.state().current).toBeUndefined()
    expect(other.calls.start).toEqual([])
    other.controller.dispose()
  })
})

describe("actual generated SDK local review transport", () => {
  test("fresh main-session placement precedes the owner target and strict exact mutation DTO", async () => {
    const requests: { method: string; path: string; body?: unknown }[] = []
    let session = {
      id: parentID,
      projectID: "project",
      directory: "/repo",
      parentID: undefined as string | undefined,
      internal: undefined as string | undefined,
    }
    const client = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (input) => {
        const value = input instanceof Request ? input : new Request(input)
        const path = new URL(value.url).pathname
        requests.push({ method: value.method, path, ...(value.method === "POST" ? { body: await value.json() } : {}) })
        return Response.json(path.endsWith("/target") ? target : path.endsWith("/review") ? info() : session)
      },
    })
    const api = localReviewTransport(client, { parentID, directory: "/repo", projectID: "project" })
    const signal = new AbortController().signal
    expect(await api.verify(signal)).toEqual(target)
    await api.start(request, signal)
    expect(requests.map((value) => value.path)).toEqual([
      `/session/${parentID}`,
      `/experimental/session/${parentID}/review/target`,
      `/session/${parentID}`,
      `/experimental/session/${parentID}/review`,
    ])
    expect(requests.at(-1)?.body).toEqual(request)
    for (const invalid of [
      { ...session, parentID: "ses_child_of_other" },
      { ...session, internal: "vectorscope.run" },
      { ...session, directory: "/other" },
      { ...session, projectID: "other" },
    ]) {
      session = invalid
      const count = requests.length
      await expect(api.verify(signal)).rejects.toThrow("own checkout")
      await expect(api.stop(runID, signal)).rejects.toThrow("own checkout")
      expect(requests.slice(count).every((value) => value.path === `/session/${parentID}`)).toBe(true)
    }
    expect(requests.some((value) => value.method === "POST" && value.path.endsWith("/session"))).toBe(false)
  })

  test("HTTP errors and malformed owner target never establish authorization", async () => {
    for (const mode of ["guest", "html", "malformed"] as const) {
      const client = createVectorClient({
        baseUrl: "http://fixture.invalid",
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname
          if (!path.endsWith("/target"))
            return Response.json({ id: parentID, projectID: "project", directory: "/repo" })
          return mode === "guest"
            ? Response.json({ message: "private upstream detail" }, { status: 403 })
            : mode === "html"
              ? new Response("<html>login</html>", { headers: { "content-type": "text/html" } })
              : Response.json({ ...target, permissions: "forged" })
        },
      })
      await expect(
        localReviewTransport(client, { parentID, directory: "/repo", projectID: "project" }).verify(
          new AbortController().signal,
        ),
      ).rejects.toThrow()
    }
  })
})
