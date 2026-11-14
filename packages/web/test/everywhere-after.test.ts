import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { after, afterCount, drainAfter } from "../../../api/_lib/everywhere/after"
import { ApiError } from "../../../api/_lib/http"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()

/*
 * VE-03: work after the response (3.2 step 6). It never delays the caller, registers with Vercel's request context
 * when there is one, runs in this process when there is not, and logs a failure by step name and code only.
 */

const CONTEXT = Symbol.for("@vercel/request-context")

afterEach(async () => {
  await drainAfter()
  Reflect.deleteProperty(globalThis, CONTEXT)
})

describe("after", () => {
  test("the work starts only after the caller's current step, and the caller is never delayed", async () => {
    const order: string[] = []
    const done = after("intake", async () => {
      order.push("work")
    })
    order.push("response")
    await done
    expect(order).toEqual(["response", "work"])
  })

  test("without a request context the work still runs in this process", async () => {
    let ran = false
    await after("intake", () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test("with a request context the work is registered with waitUntil", async () => {
    const registered: Promise<unknown>[] = []
    Reflect.set(globalThis, CONTEXT, { get: () => ({ waitUntil: (promise: Promise<unknown>) => registered.push(promise) }) })
    const done = after("offer-window", async () => undefined)
    expect(registered).toEqual([done])
    await done
  })

  test("a failure is caught and logged by step and code only, never its message", async () => {
    const logged: unknown[][] = []
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    try {
      await after("post-result", async () => {
        throw new Error("token xoxb-secret-value and the user's message")
      })
      await after("post-result", async () => {
        throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "store")
      })
    } finally {
      spy.mockRestore()
    }
    expect(logged).toEqual([
      ["Vector everywhere: a background step failed", { step: "post-result", code: "error" }],
      ["Vector everywhere: a background step failed", { step: "post-result", code: "PERSISTENT_STORE_UNAVAILABLE" }],
    ])
    expect(JSON.stringify(logged)).not.toContain("xoxb")
  })

  test("drainAfter waits for steps that steps started", async () => {
    const order: string[] = []
    after("first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push("first")
      after("second", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push("second")
      })
    })
    expect(afterCount()).toBe(1)
    await drainAfter()
    expect(order).toEqual(["first", "second"])
    expect(afterCount()).toBe(0)
  })

  test("a step name is a fixed slug, so nothing else reaches the log", () => {
    for (const step of ["", "Intake", "has space", "x".repeat(65), "user: hello"])
      expect(() => after(step, () => undefined)).toThrow(RangeError)
  })
})
