import { describe, expect, test } from "bun:test"
import {
  RETRY,
  createReadRetry,
  readErrorText,
  readFailure,
  retryDelay,
  retryText,
  transient,
  type ReadFailure,
  type RetryState,
} from "./read-retry"

const middle = () => 0.5
const RETRY_TRIES = Array.from({ length: RETRY.attempts })

describe("what failed when Vector could not read from its engine", () => {
  test("no answer at all may pass, unless the engine answered with something that is not JSON", () => {
    expect(readFailure("status", { error: new TypeError("Failed to fetch") })).toEqual({
      target: "status",
      reason: "unreachable",
    })
    expect(readFailure("status", { error: {} }).reason).toBe("unreachable")
    expect(readFailure("status", {}).reason).toBe("unreachable")
    expect(readFailure("servers", { error: new DOMException("timed out", "TimeoutError") })).toEqual({
      target: "servers",
      reason: "slow",
    })
    expect(readFailure("status", { error: new SyntaxError("Unexpected token <") }).reason).toBe("unreadable")
  })

  test("the engine's HTTP status says whether it was slow, busy, broken or refused", () => {
    const reason = (status: number) => readFailure("status", { status }).reason
    expect([408, 504].map(reason)).toEqual(["slow", "slow"])
    expect([425, 429, 503].map(reason)).toEqual(["busy", "busy", "busy"])
    expect([500, 502, 507].map(reason)).toEqual(["broken", "broken", "broken"])
    expect([400, 409, 422, 501].map(reason)).toEqual(["refused", "refused", "refused", "refused"])
    expect(reason(302)).toBe("unreadable")
    expect(readFailure("status", { status: 503 })).toEqual({ target: "status", reason: "busy", code: 503 })
  })

  test("a refusal keeps the engine's own reason when it gave one", () => {
    expect(
      readFailure("servers", { status: 400, error: { name: "LocalError", data: { code: "invalid", message: "No." } } }),
    ).toEqual({ target: "servers", reason: "refused", code: 400, message: "No." })
    expect(readFailure("servers", { status: 400, error: { message: "Bad request" } }).message).toBe("Bad request")
    expect(readFailure("servers", { status: 400, error: "<html>" })).toEqual({
      target: "servers",
      reason: "refused",
      code: 400,
    })
    expect(readFailure("servers", { status: 400, error: { data: { message: "  " } } }).message).toBeUndefined()
  })

  test("only a failure that may pass is tried again on its own", () => {
    const of = (reason: ReadFailure["reason"]) => transient({ target: "status", reason })
    expect(of("unreachable")).toBe(true)
    expect(of("slow")).toBe(true)
    expect(of("busy")).toBe(true)
    expect(of("broken")).toBe(true)
    expect(of("refused")).toBe(false)
    expect(of("unreadable")).toBe(false)
  })
})

describe("the error's words", () => {
  test("it names what Vector could not read, and on which computer when the engine is elsewhere", () => {
    const status: ReadFailure = { target: "status", reason: "unreachable" }
    const servers: ReadFailure = { target: "servers", reason: "unreachable" }
    expect(readErrorText(status).title).toBe("Vector could not read Vector Local's status from its engine.")
    expect(readErrorText(status, "build-box").title).toBe(
      "Vector could not read Vector Local's status from its engine on build-box.",
    )
    expect(readErrorText(servers).title).toBe("Vector could not look for model servers on this computer.")
    expect(readErrorText(servers, "build-box").title).toBe("Vector could not look for model servers on build-box.")
  })

  test("it says why in plain words, with the engine's error number when it answered", () => {
    const reason = (failure: Omit<ReadFailure, "target">) => readErrorText({ target: "status", ...failure }).reason
    expect(reason({ reason: "unreachable" })).toBe(
      "The engine did not answer. It may still be starting, or the connection to it dropped.",
    )
    expect(reason({ reason: "slow" })).toBe("The engine took too long to answer.")
    expect(reason({ reason: "slow", code: 504 })).toBe("The engine took too long to answer (error 504).")
    expect(reason({ reason: "busy", code: 503 })).toBe("The engine was too busy to answer (error 503).")
    expect(reason({ reason: "broken", code: 500 })).toBe("Something went wrong inside the engine (error 500).")
    expect(reason({ reason: "refused", code: 400 })).toBe("The engine turned the request down (error 400).")
    expect(reason({ reason: "refused", code: 400, message: "Vector Local is locked" })).toBe(
      "The engine said: Vector Local is locked.",
    )
    expect(reason({ reason: "refused", code: 400, message: "Locked by your company. " })).toBe(
      "The engine said: Locked by your company.",
    )
    expect(reason({ reason: "unreadable" })).toBe(
      "Vector did not understand the engine's answer. Vector and its engine may be different versions.",
    )
  })

  test("the line under it says when Vector tries again, or that it stopped", () => {
    const failure: ReadFailure = { target: "status", reason: "unreachable" }
    expect(retryText(failure, { attempt: 1, wait: 2_000 }, true)).toBe("Trying again…")
    expect(retryText(failure, { attempt: 0, wait: 1_000 }, false)).toBe("Trying again in 1 second.")
    expect(retryText(failure, { attempt: 0, wait: 800 }, false)).toBe("Trying again in 1 second.")
    expect(retryText(failure, { attempt: 0, wait: 200 }, false)).toBe("Trying again in 1 second.")
    expect(retryText(failure, { attempt: 2, wait: 4_100 }, false)).toBe("Trying again in 4 seconds.")
    expect(retryText(failure, { attempt: RETRY.attempts, wait: undefined }, false)).toBe(
      "Vector tried again 4 times and stopped trying on its own. Press Try again in a moment.",
    )
    expect(retryText(failure, { attempt: 0, wait: undefined }, false)).toBeUndefined()
    expect(
      retryText({ target: "servers", reason: "refused", code: 400 }, { attempt: 0, wait: undefined }, false),
    ).toBeUndefined()
  })
})

describe("the waits between automatic tries", () => {
  const failure: ReadFailure = { target: "status", reason: "unreachable" }

  test("each wait is about twice the last, and Vector stops after four tries", () => {
    expect([0, 1, 2, 3, 4].map((attempt) => retryDelay(failure, attempt, middle))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      undefined,
    ])
  })

  test("each wait is spread by up to a fifth either way", () => {
    expect(retryDelay(failure, 0, () => 0)).toBe(800)
    expect(retryDelay(failure, 0, () => 1)).toBe(1_200)
    expect(retryDelay(failure, 3, () => 0)).toBe(6_400)
    expect(retryDelay(failure, 3, () => 1)).toBe(9_600)
  })

  test("a refusal or an answer Vector did not understand is not tried again on its own", () => {
    expect(retryDelay({ target: "status", reason: "refused", code: 400 }, 0, middle)).toBeUndefined()
    expect(retryDelay({ target: "status", reason: "unreadable" }, 0, middle)).toBeUndefined()
  })
})

describe("trying a read again on its own", () => {
  function setup() {
    const timers = new Map<number, { run: () => void; ms: number }>()
    const states: RetryState[] = []
    let next = 0
    let runs = 0
    const retry = createReadRetry({
      run: () => {
        runs += 1
      },
      onChange: (state) => states.push(state),
      random: middle,
      timer: {
        set: (run, ms) => {
          next += 1
          timers.set(next, { run, ms })
          return next
        },
        clear: (handle) => timers.delete(handle as number),
      },
    })
    const fire = () => {
      const [id, timer] = [...timers][0]!
      timers.delete(id)
      timer.run()
    }
    return { retry, timers, states, fire, runs: () => runs }
  }
  const failure: ReadFailure = { target: "status", reason: "unreachable" }

  test("a failure that may pass is read again after each wait, four times, then Vector stops", () => {
    const at = setup()
    const waits: number[] = []
    at.retry.settled(failure)
    RETRY_TRIES.forEach(() => {
      waits.push([...at.timers.values()][0]!.ms)
      at.fire()
      at.retry.settled(failure)
    })
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(at.runs()).toBe(4)
    expect(at.timers.size).toBe(0)
    expect(at.states.at(-1)).toEqual({ attempt: 4, wait: undefined })
  })

  test("the state says the wait before the next try, then the try", () => {
    const at = setup()
    at.retry.settled(failure)
    at.fire()
    expect(at.states).toEqual([
      { attempt: 0, wait: 1_000 },
      { attempt: 1, wait: undefined },
    ])
  })

  test("a read that works starts the count over and cancels a waiting try", () => {
    const at = setup()
    at.retry.settled(failure)
    at.fire()
    at.retry.settled(failure)
    expect(at.timers.size).toBe(1)
    at.retry.settled(undefined)
    expect(at.timers.size).toBe(0)
    expect(at.states.at(-1)).toEqual({ attempt: 0, wait: undefined })
    at.retry.settled(failure)
    expect([...at.timers.values()][0]!.ms).toBe(1_000)
  })

  test("Try again reads at once and starts the waits over", () => {
    const at = setup()
    at.retry.settled(failure)
    at.fire()
    at.retry.settled(failure)
    at.fire()
    at.retry.settled(failure)
    expect(at.runs()).toBe(2)
    at.retry.now()
    expect(at.runs()).toBe(3)
    expect(at.timers.size).toBe(0)
    expect(at.states.at(-1)).toEqual({ attempt: 0, wait: undefined })
    at.retry.settled(failure)
    expect([...at.timers.values()][0]!.ms).toBe(1_000)
  })

  test("Try again still reads after Vector stopped trying on its own", () => {
    const at = setup()
    at.retry.settled(failure)
    RETRY_TRIES.forEach(() => {
      at.fire()
      at.retry.settled(failure)
    })
    expect(at.timers.size).toBe(0)
    at.retry.now()
    expect(at.runs()).toBe(5)
    at.retry.settled(failure)
    expect(at.timers.size).toBe(1)
  })

  test("a refusal is not read again on its own", () => {
    const at = setup()
    at.retry.settled({ target: "servers", reason: "refused", code: 400 })
    expect(at.timers.size).toBe(0)
    expect(at.runs()).toBe(0)
    expect(at.states).toEqual([{ attempt: 0, wait: undefined }])
  })

  test("stop cancels a waiting try, and the next read that fails waits again", () => {
    const at = setup()
    at.retry.settled(failure)
    at.retry.stop()
    expect(at.timers.size).toBe(0)
    expect(at.runs()).toBe(0)
    at.retry.settled(failure)
    expect(at.timers.size).toBe(1)
  })

  test("after the page closes, nothing waits and nothing reads again", () => {
    const at = setup()
    at.retry.settled(failure)
    at.retry.dispose()
    expect(at.timers.size).toBe(0)
    // A read that was still running when the page closed finishes afterwards.
    at.retry.settled(failure)
    at.retry.now()
    expect(at.timers.size).toBe(0)
    expect(at.runs()).toBe(0)
  })
})
