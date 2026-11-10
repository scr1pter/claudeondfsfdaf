import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionID } from "@vectordevai/schema/session-id"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { testEffect } from "./lib/effect"

describe("SpendGuard cost kind and price", () => {
  test("costKindOf puts free before plan before priced", () => {
    expect(SpendGuard.costKindOf({ free: true, oauthPlan: true, listed: true })).toBe("free")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: true, listed: true })).toBe("plan")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: true })).toBe("priced")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: false })).toBe("unknown")
  })

  test("costKindOf counts a local server as local unless a price is configured for it", () => {
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: false, local: true })).toBe("local")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: true, local: true })).toBe("priced")
    expect(SpendGuard.costKindOf({ free: true, oauthPlan: false, listed: false, local: true })).toBe("free")
    // An unpriced company endpoint on the internet is not local, so the unpriced-step stop still covers it.
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: false, local: false })).toBe("unknown")
  })

  test("priceOf has no price for all-zero rates", () => {
    expect(SpendGuard.priceOf({ input: 0, output: 0, cache: { read: 0.5, write: 1 } })).toBeUndefined()
    expect(SpendGuard.priceOf({ input: 0, output: 0 })).toBeUndefined()
  })

  test("priceOf keeps cache rates only when they are listed", () => {
    expect(SpendGuard.priceOf({ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } })).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    })
    expect(SpendGuard.priceOf({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })
})

const root = SessionID.make("ses_root")
const child = SessionID.make("ses_child")
const sibling = SessionID.make("ses_sibling")

const step = (input: Partial<SpendGuard.Step> = {}): SpendGuard.Step => ({
  costKind: "priced",
  contextTokens: 1_000,
  cachedTokens: 0,
  continues: false,
  tools: [],
  patched: false,
  ...input,
})

// Applies steps in order and returns the final run and every verdict. `sessions[i]` took step i, else the root.
const play = (budget: RunBudget.Info, steps: SpendGuard.Step[], sessions: SessionID[] = []) =>
  steps.reduce(
    (acc, item, index) => {
      const next = SpendGuard.afterStep(acc.run, item, sessions[index])
      return { run: next.run, verdicts: [...acc.verdicts, next.verdict] }
    },
    { run: SpendGuard.start(root, budget), verdicts: [] as SpendGuard.Verdict[] },
  )

const bash = (input: string, error?: string) => ({ tool: "bash", input, ...(error === undefined ? {} : { error }) })
// A call with what it returned, for the loop rules.
const call = (tool: string, input: string, output: string) => step({ tools: [{ tool, input, output }] })
const reads = (count: number) =>
  Array.from({ length: count }, (_, index) => step({ tools: [{ tool: "read", input: `src/${index}.ts` }] }))

describe("SpendGuard.afterStep", () => {
  test("Codium ignores dollar pricing and the unpriced step cap while counting its steps", () => {
    expect(SpendGuard.costKindOf({ codium: true, free: true, oauthPlan: true, listed: true })).toBe("codium")
    const result = play(
      { usd: 1 },
      Array.from({ length: 45 }, () => step({ costKind: "codium", costUsd: 100 })),
    )
    expect(result.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.run).toMatchObject({ spentUsd: 0, steps: 45, unpricedSteps: 0, codiumSteps: 45 })
  })

  test("Codium still stops on step and loop limits", () => {
    const capped = play(
      { usd: 1, steps: 3 },
      Array.from({ length: 3 }, () => step({ costKind: "codium" })),
    )
    expect(capped.verdicts[2]?.reason).toBe("steps")
    const looped = play(
      { usd: 1 },
      Array.from({ length: 3 }, () => step({ costKind: "codium", tools: [bash("pwd")] })),
    )
    expect(looped.verdicts[2]?.reason).toBe("loop")
  })

  test("mixed Codium and own-key runs stop on own spend", () => {
    const result = play({ usd: 1 }, [step({ costKind: "codium", costUsd: 99 }), step({ costUsd: 1.1 })])
    expect(result.run).toMatchObject({ spentUsd: 1.1, codiumSteps: 1, unpricedSteps: 0 })
    expect(result.verdicts[1]?.reason).toBe("cap")
  })

  test("Codium with incomplete usage adds no dollars and no unpriced or incomplete step", () => {
    const result = play({ usd: 1, unpricedSteps: 1 }, [step({ costKind: "codium", costUsd: 5, unpriced: true })])
    expect(result.verdicts[0]).toEqual({ state: "ok" })
    expect(result.run).toMatchObject({ spentUsd: 0, steps: 1, unpricedSteps: 0, codiumSteps: 1 })
  })

  test("warns once at 80% of the cap", () => {
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.1 })])
    expect(result.verdicts[0]).toEqual({
      state: "warn",
      message: "Approaching the spend cap: $4.10 of $5.00 spent on this run.",
    })
    expect(result.verdicts[1]).toEqual({ state: "ok" })
  })

  test("stops with cap on the step that crosses it", () => {
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.92, continues: true })])
    expect(result.verdicts[1]).toEqual({
      state: "stopped",
      reason: "cap",
      message:
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
    })
    expect(result.run.stopped?.reason).toBe("cap")
  })

  test("says a final answer that crosses the cap stands", () => {
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.92 })])
    expect(result.verdicts[1]).toEqual({
      state: "stopped",
      reason: "cap",
      message:
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run, on a step that ended its turn. Its answer stands, and Vector starts no further step under this cap.",
    })
    expect(result.run.stopped?.reason).toBe("cap")
  })

  test("says the run stopped after a subagent's final answer that crosses the cap", () => {
    // The subagent's answer goes back to its root, whose next step is then cut short.
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.92 })], [root, child])
    expect(result.verdicts[1]).toEqual({
      state: "stopped",
      reason: "cap",
      message:
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
    })
  })

  test("stops before a next step estimated to cross the cap", () => {
    // 320k tokens of next-step input at $3/M, 207k of them cached at $0.30/M, plus 600 output tokens at $15/M.
    const predicted = step({
      costUsd: 4.62,
      continues: true,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15, cacheRead: 0.3 },
    })
    const verdict = play({ usd: 5 }, [predicted]).verdicts[0]
    expect(verdict?.state).toBe("stopped")
    expect(verdict?.reason).toBe("predicted")
    expect(verdict?.message).toBe(
      "Stopped before the next step: $4.62 spent of a $5.00 cap, and the next step was estimated at $0.41–$0.97 at catalog list prices.",
    )
    expect(verdict?.estimate?.lowUsd).toBeLessThanOrEqual(verdict?.estimate?.highUsd ?? 0)
  })

  test("shows one figure when the estimate has no cache-read range", () => {
    const predicted = step({
      costUsd: 4.62,
      continues: true,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15 },
    })
    expect(play({ usd: 5 }, [predicted]).verdicts[0]?.message).toBe(
      "Stopped before the next step: $4.62 spent of a $5.00 cap, and the next step was estimated at $0.97 at catalog list prices.",
    )
  })

  test("warns once when the high estimate would cross the cap below 80%", () => {
    // 500k tokens of next-step input at $3/M, 400k of them cached at $0.30/M: low $0.43, high $1.51.
    const near = (costUsd: number) =>
      step({
        costUsd,
        continues: true,
        contextTokens: 497_000,
        cachedTokens: 400_000,
        price: { input: 3, output: 15, cacheRead: 0.3 },
      })
    const result = play({ usd: 5 }, [near(3.9), near(0.01)])
    expect(result.verdicts[0]).toMatchObject({
      state: "warn",
      message: "Approaching the spend cap: $3.90 of $5.00 spent on this run.",
    })
    expect(result.verdicts[0]?.estimate?.lowUsd).toBeCloseTo(0.429, 6)
    expect(result.verdicts[0]?.estimate?.highUsd).toBeCloseTo(1.509, 6)
    expect(result.verdicts[1]?.state).toBe("ok")
    expect(result.verdicts[1]?.estimate?.highUsd).toBeCloseTo(1.509, 6)
  })

  test("does not predict when no step follows", () => {
    const last = step({
      costUsd: 4.62,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15, cacheRead: 0.3 },
    })
    const verdict = play({ usd: 5 }, [last]).verdicts[0]
    expect(verdict?.state).toBe("warn")
    expect(verdict?.estimate).toBeUndefined()
  })

  test("stops an unpriced model after 40 steps while spending nothing", () => {
    const result = play(
      { usd: 5 },
      Array.from({ length: 40 }, () => step({ costKind: "unknown" })),
    )
    expect(result.verdicts.slice(0, 39).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[39]).toEqual({
      state: "stopped",
      reason: "unpriced",
      message:
        "Stopped after 40 unpriced or incomplete steps: Vector cannot fully measure their cost against your $5.00 cap. Without a dollar cap, step and loop limits still apply.",
    })
    expect(result.run.spentUsd).toBe(0)
  })

  test("never stops a local model on dollars, however many steps it takes, but does on steps", () => {
    const local = Array.from({ length: 100 }, () => step({ costKind: "local", costUsd: 3, unpriced: true }))
    const capped = play({ usd: 1 }, local)
    expect(capped.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    expect(capped.run).toMatchObject({ steps: 100, spentUsd: 0, unpricedSteps: 0, costKind: "local" })

    const limited = play({ usd: 1, steps: 100 }, local)
    expect(limited.verdicts.slice(0, 99).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(limited.verdicts[99]).toEqual({
      state: "stopped",
      reason: "steps",
      message: "Step limit reached: 100 of 100 steps used for this run.",
    })
  })

  test("still pauses a local model's loops", () => {
    const repeated = step({ costKind: "local", tools: [{ tool: "read", input: "a.ts", output: "same" }] })
    const result = play({ usd: 1 }, [repeated, repeated, repeated])
    expect(result.verdicts.at(-1)).toMatchObject({ state: "stopped", reason: "loop" })
  })

  test("never stops plan or free models on dollars, but does on steps", () => {
    const kinds = Array.from({ length: 60 }, (_, index) =>
      step({ costKind: index % 2 ? "plan" : "free", costUsd: 10, unpriced: true }),
    )
    const result = play({ usd: 1, steps: 60 }, kinds)
    expect(result.verdicts.slice(0, 59).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[59]).toEqual({
      state: "stopped",
      reason: "steps",
      message: "Step limit reached: 60 of 60 steps used for this run.",
    })
    expect(result.run.spentUsd).toBe(0)
  })

  test("counts priced dollars and unpriced steps separately in a mixed run", () => {
    const result = play({ usd: 5 }, [
      step({ costUsd: 0.5 }),
      step({ costKind: "unknown", costUsd: 2 }),
      step({ costUsd: 0.25 }),
    ])
    expect(result.run.spentUsd).toBe(2.75)
    expect(result.run.unpricedSteps).toBe(1)
    expect(result.run.steps).toBe(3)
  })

  test("counts steps by cost kind, which no limit reads", () => {
    expect(SpendGuard.start(root, {}).kinds).toEqual({})
    const steps = [
      step({ costUsd: 0.5 }),
      step({ costKind: "local" }),
      step({ costKind: "plan" }),
      step({ costKind: "free" }),
      step({ costKind: "unknown" }),
      step({ costUsd: 0.25 }),
    ]
    const counted = play({ usd: 5 }, steps)
    expect(counted.run.kinds).toEqual({ priced: 2, local: 1, plan: 1, free: 1, unknown: 1 })
    // The same verdicts and spend as before kinds were counted: the unknown step reports no cost, so only priced steps
    // add dollars.
    expect(counted.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    expect(counted.run).toMatchObject({ spentUsd: 0.75, steps: 6, unpricedSteps: 1 })
    const capped = play({ usd: 0.7 }, steps)
    expect(capped.verdicts.map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok", "ok", "ok", "stopped"])
    expect(capped.run.kinds).toEqual(counted.run.kinds)
  })

  test("keeps a partial known subtotal and stops on incomplete usage even with a catalog price", () => {
    const result = play({ usd: 5, unpricedSteps: 1 }, [step({ costUsd: 0.2, unpriced: true })])
    expect(result.run.spentUsd).toBe(0.2)
    expect(result.run.unpricedSteps).toBe(1)
    expect(result.verdicts[0]).toMatchObject({ state: "stopped", reason: "unpriced" })
  })

  test("pauses the same input three times with no file change in between", () => {
    const repeated = play({}, [
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
    ])
    expect(repeated.verdicts[2]).toEqual({
      state: "stopped",
      reason: "loop",
      message:
        "Paused a repeating loop: `bash` returned the same result for the same input 3 times, with no new results or file changes in between.",
    })

    const patched = play({}, [
      step({ tools: [bash("bun test")] }),
      step({ tools: [{ tool: "edit", input: "src/a.ts" }], patched: true }),
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
    ])
    expect(patched.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("a run with loop rules off never pauses a loop, but still stops on its cap", () => {
    const quiet = [
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.5 }),
    ].reduce(
      (acc, item) => {
        const next = SpendGuard.afterStep(acc.run, item)
        return { run: next.run, verdicts: [...acc.verdicts, next.verdict] }
      },
      { run: SpendGuard.start(root, { usd: 1 }, false), verdicts: [] as SpendGuard.Verdict[] },
    )
    expect(quiet.verdicts.slice(0, 3).map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
    expect(quiet.verdicts[3]).toMatchObject({ state: "stopped", reason: "cap" })
  })

  test("lets a page observed between clicks run on", () => {
    const observe = (page: string) => call("browser", JSON.stringify({ action: "observe" }), page)
    const click = (selector: string) => call("browser", JSON.stringify({ action: "click", selector }), "clicked")
    const changing = play({}, [observe("home"), click("#a"), observe("form"), click("#b"), observe("done")])
    expect(changing.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // Different clicks that leave the page as it was are still different calls.
    const unchanged = play({}, [observe("home"), click("#a"), observe("home"), click("#b"), observe("home")])
    expect(unchanged.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // The same click on Next with a new page each time is a walk through the pages, not a loop.
    const pages = play({}, [
      observe("page 1"),
      click("#next"),
      observe("page 2"),
      click("#next"),
      observe("page 3"),
      click("#next"),
      observe("page 4"),
    ])
    expect(pages.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    const stuck = play({}, [observe("home"), observe("home"), observe("home")])
    expect(stuck.verdicts[2]).toMatchObject({ state: "stopped", reason: "loop" })
  })

  test("lets git status run between add and commit", () => {
    const git = (command: string, output: string) => call("bash", JSON.stringify({ command }), output)
    const result = play({}, [
      git("git status", "modified: src/a.ts"),
      git("git add -A", ""),
      git("git status", "staged: src/a.ts"),
      git("git commit -m fix", "[main 1a2b3c] fix"),
      git("git status", "nothing to commit, working tree clean"),
    ])
    expect(result.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("pauses a cycle of calls that keep getting the same answers", () => {
    const read = call("read", "src/a.ts", "same")
    const test = call("bash", "bun test", "1 fail")
    const result = play({}, [read, test, read, test, read, test])
    expect(result.verdicts.slice(0, 5).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[5]).toMatchObject({ state: "stopped", reason: "loop" })

    // A call that returns something new between the repeats is progress.
    const learning = play({}, [
      test,
      call("read", "src/a.ts", "a"),
      test,
      call("read", "src/b.ts", "b"),
      test,
      call("read", "src/c.ts", "c"),
      test,
    ])
    expect(learning.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("treats a call last seen more than 8 calls back as new", () => {
    const cycle = (length: number, rounds: number) =>
      Array.from({ length: length * rounds }, (_, index) => call("read", `src/${index % length}.ts`, "same"))
    expect(play({}, cycle(9, 3)).verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    expect(play({}, cycle(3, 3)).verdicts.at(-1)?.reason).toBe("loop")
  })

  test("detects loops per session, not across the lineage", () => {
    // Three subagents each read the same file once.
    const read = () => step({ tools: [{ tool: "read", input: "src/a.ts" }] })
    const parallel = play({}, [read(), read(), read()], [root, child, sibling])
    expect(parallel.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // A patch in one session does not clear another session's repeats.
    const stuck = play(
      {},
      [
        step({ tools: [bash("bun test")] }),
        step({ tools: [bash("bun test")] }),
        step({ tools: [{ tool: "edit", input: "src/a.ts" }], patched: true }),
        step({ tools: [bash("bun test")] }),
      ],
      [child, child, sibling, child],
    )
    expect(stuck.verdicts.at(-1)?.reason).toBe("loop")

    // Failures in another session neither break nor build a session's streak.
    const built = play(
      {},
      [
        step({ tools: [bash("bun run a", "exit 1")] }),
        step({ tools: [bash("bun run b", "exit 1")] }),
        step({ tools: [bash("bun run c", "exit 1")] }),
      ],
      [child, sibling, child],
    )
    expect(built.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    const unbroken = play(
      {},
      [
        step({ tools: [bash("bun run a", "exit 1")] }),
        step({ tools: [bash("bun run b", "exit 1")] }),
        step({ tools: [bash("bun run c")] }),
        step({ tools: [bash("bun run d", "exit 1")] }),
      ],
      [child, child, sibling, child],
    )
    expect(unbroken.verdicts.at(-1)?.message).toBe(
      "Paused a repeating loop: `bash` failed with the same error 3 times in a row.",
    )
  })

  test("pauses the same error three times in a row", () => {
    const result = play({}, [
      step({ tools: [bash("bun run a", "exit 1")] }),
      step({ tools: [bash("bun run b", "exit 1")] }),
      step({ tools: [bash("bun run c", "exit 1")] }),
    ])
    expect(result.verdicts[2]).toEqual({
      state: "stopped",
      reason: "loop",
      message: "Paused a repeating loop: `bash` failed with the same error 3 times in a row.",
    })

    const broken = play({}, [
      step({ tools: [bash("bun run a", "exit 1")] }),
      step({ tools: [bash("bun run b")] }),
      step({ tools: [bash("bun run c", "exit 1"), bash("bun run d", "exit 1")] }),
    ])
    expect(broken.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("lets parallel subagents finish the steps they had in flight when the run stopped", () => {
    // The root spends $0.70 of a $1.00 cap and starts three subagents, whose first steps of $0.25 run side by side.
    const price = { input: 3, output: 15 }
    const sub = () => step({ costUsd: 0.25, continues: true, contextTokens: 20_000, price })
    const third = SessionID.make("ses_third")
    const result = play(
      { usd: 1 },
      [step({ costUsd: 0.7, continues: true, price }), sub(), sub(), sub()],
      [root, child, sibling, third],
    )
    // The first of them to finish leaves too little for its next step, so the run stops. The other two were already
    // running, so they finish and count: the run ends past the cap by up to one step for each of them.
    expect(result.verdicts.map((verdict) => verdict.state)).toEqual(["ok", "stopped", "stopped", "stopped"])
    expect(result.run.stopped?.reason).toBe("predicted")
    expect(result.run.spentUsd).toBeCloseTo(1.45, 6)
    expect(result.run.steps).toBe(4)
  })

  test("answers stop to every step after a stop, and keeps counting spend", () => {
    const result = play({ usd: 1 }, [step({ costUsd: 1.5 }), step({ costKind: "free" }), step({ costUsd: 0.25 })])
    expect(result.verdicts.map((verdict) => verdict.state)).toEqual(["stopped", "stopped", "stopped"])
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual(["cap", "cap", "cap"])
    expect(result.run.spentUsd).toBe(1.75)
  })

  test("tighter keeps the stricter of each limit and never loosens one", () => {
    expect(SpendGuard.tighter({ usd: 2, steps: 50 }, { usd: 100_000, steps: 100_000 })).toEqual({ usd: 2, steps: 50 })
    expect(SpendGuard.tighter({ usd: 2, steps: 50 }, { usd: 1 })).toEqual({ usd: 1, steps: 50 })
    expect(SpendGuard.tighter({ usd: 2, steps: 50 }, {})).toEqual({ usd: 2, steps: 50 })
    // A limit the base leaves out is still a new limit, so it applies.
    expect(SpendGuard.tighter(undefined, { usd: 5, unpricedSteps: 10 })).toEqual({ usd: 5, unpricedSteps: 10 })
    expect(SpendGuard.tighter({}, {})).toEqual({})
    // The warning share and the unpriced-step limit compare with the defaults a side runs with when it sets none.
    expect(SpendGuard.tighter({ usd: 2 }, { warnAt: 1, unpricedSteps: 1_000 })).toEqual({
      usd: 2,
      warnAt: SpendGuard.WARN_AT,
      unpricedSteps: SpendGuard.UNPRICED_STEPS,
    })
    expect(SpendGuard.tighter({ warnAt: 0.5 }, { warnAt: 0.9 })).toEqual({ warnAt: 0.5 })
    expect(SpendGuard.tighter({ warnAt: 0.9 }, { warnAt: 0.5 })).toEqual({ warnAt: 0.5 })
  })

  test("formats money with two decimals, or <$0.01 for less than a cent", () => {
    expect(SpendGuard.formatUsd(0.004)).toBe("<$0.01")
    expect(SpendGuard.formatUsd(0)).toBe("$0.00")
    expect(SpendGuard.formatUsd(25)).toBe("$25.00")
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([SpendGuard.node, EventV2.node])))

describe("SpendGuard service", () => {
  it.effect("captured ancillary usage settles each attempt once in its launching root, child and batch scopes", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root, { budget: { usd: 0.05 }, batch: { id: "capture-batch", budget: { usd: 0.2 } } })
      const captured = yield* guard.capture(child)
      const result = yield* captured.record("paid-attempt", step({ costUsd: 0.06 }))
      yield* captured.record("paid-attempt", step({ costUsd: 0.06 }))
      expect(result).toMatchObject({ state: "stopped", reason: "cap" })
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0.06)
      expect((yield* guard.snapshot(root))?.steps).toBe(1)
      const scopes = yield* guard.scopes(child)
      expect(scopes).toHaveLength(3)
      expect(scopes.every((scope) => scope.spentUsd === 0.06 && scope.steps === 1)).toBe(true)
      expect(yield* guard.stopped(root)).toBeUndefined()
      yield* captured.release
      yield* captured.release
    }),
  )

  it.effect("late ancillary callbacks keep the old run and cannot overwrite or bill the new run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const events = yield* EventV2.Service
      const posted: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          posted.push(event)
        }),
      )
      yield* guard.begin(root, { usd: 0.1 })
      yield* guard.record(root, step({ costUsd: 0.09 }))
      const captured = yield* guard.capture(root)
      yield* guard.end(root)
      // Reusing the root replaces its last-run pointer. The in-flight capture must keep the earlier ledger alive.
      for (let index = 0; index < SpendGuard.LAST_RUNS + 1; index++) {
        yield* guard.begin(root, { usd: 1 })
        yield* guard.end(root)
      }
      yield* guard.begin(root, { usd: 1 })
      const previousEvents = posted.length
      expect(yield* captured.record("late-title", step({ costUsd: 0.03 }))).toMatchObject({
        state: "stopped",
        reason: "cap",
      })
      expect((yield* captured.stopped)?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0)
      expect(yield* guard.stopped(root)).toBeUndefined()
      expect(posted).toHaveLength(previousEvents)
      yield* captured.release
      yield* captured.record("callback-after-release", step({ costUsd: 0.9 }))
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0)
      yield* unsubscribe
    }),
  )

  it.effect("counts a linked child against its root, raises a cap on arm, and keeps the last run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const events = yield* EventV2.Service
      const published = yield* events
        .subscribe(SessionStatusEvent.Spend)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* guard.arm(root, { usd: 1 })
      yield* guard.begin(root)
      yield* guard.link(child, root)
      expect(yield* guard.rootOf(child)).toBe(root)

      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0.5)
      expect([...(yield* Fiber.join(published))][0]?.data).toMatchObject({
        sessionID: root,
        state: "ok",
        spentUsd: 0.5,
        capUsd: 1,
        costKind: "priced",
      })

      yield* guard.arm(child, { usd: 10 })
      expect((yield* guard.record(root, step({ costUsd: 0.6 }))).state).toBe("ok")
      expect(yield* guard.stopped(child)).toBeUndefined()

      yield* guard.end(root)
      const last = yield* guard.snapshot(root)
      expect(last?.spentUsd).toBe(1.1)
      expect(last?.budget.usd).toBe(10)
      expect((yield* guard.record(root, step({ costUsd: 5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(1.1)
    }),
  )

  it.effect("unlinks a session so its steps count against a run of its own", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const owner = SessionID.make("ses_unlink_root")
      const helper = SessionID.make("ses_unlink_helper")
      yield* guard.begin(owner, { usd: 1 })
      yield* guard.link(helper, owner)
      yield* guard.record(owner, step({ costUsd: 2 }))
      yield* guard.end(owner)
      expect((yield* guard.stopped(helper))?.reason).toBe("cap")

      yield* guard.unlink(helper)
      expect(yield* guard.rootOf(helper)).toBe(helper)
      expect(yield* guard.stopped(helper)).toBeUndefined()
      yield* guard.begin(helper, { usd: 3 })
      expect((yield* guard.record(helper, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(helper))?.spentUsd).toBe(0.5)
      expect((yield* guard.snapshot(owner))?.spentUsd).toBe(2)
      yield* guard.end(helper)
    }),
  )

  it.effect("turns the loop rules off for a root marked before or during its run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const before = SessionID.make("ses_quiet_before")
      yield* guard.ignoreLoops(before)
      yield* guard.begin(before)
      const during = SessionID.make("ses_quiet_during")
      yield* guard.begin(during)
      yield* guard.ignoreLoops(during)
      for (const id of [before, during]) {
        const verdicts = yield* Effect.forEach([1, 2, 3], () => guard.record(id, step({ tools: [bash("git diff")] })))
        expect(verdicts.map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
      }
      yield* guard.begin(root)
      const looping = yield* Effect.forEach([1, 2, 3], () => guard.record(root, step({ tools: [bash("git diff")] })))
      expect(looping[2]).toMatchObject({ state: "stopped", reason: "loop" })
    }),
  )

  it.effect("exempts a linked session that polices its own loops, while the rest of its run is still checked", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const reviewer = SessionID.make("ses_quiet_child")
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(reviewer, root)
      yield* guard.ignoreLoops(reviewer)
      const quiet = yield* Effect.forEach([1, 2, 3], () =>
        guard.record(reviewer, step({ costUsd: 0.1, tools: [bash("cat src/a.ts")] })),
      )
      expect(quiet.map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
      // Its spend still counts against the run it is linked to.
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(0.3, 6)
      const looping = yield* Effect.forEach([1, 2, 3], () =>
        guard.record(root, step({ tools: [bash("cat src/a.ts")] })),
      )
      expect(looping[2]).toMatchObject({ state: "stopped", reason: "loop" })
    }),
  )

  it.effect("waits for a step's real file change only when the guess would pause it as a loop", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const asked: number[] = []
      const confirm = (index: number, changed: boolean) => Effect.sync(() => asked.push(index)).pipe(Effect.as(changed))
      yield* guard.begin(root)
      // A command that writes a file each time is not a loop, but nothing in the step says so until its patch lands.
      for (const index of [1, 2, 3])
        expect(
          (yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(index, true))).state,
        ).toBe("ok")
      expect(asked).toEqual([3])
      // Once it changes nothing, the call that changed the files and the two after it are a loop.
      expect((yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(4, false))).state).toBe(
        "ok",
      )
      const verdict = yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(5, false))
      expect(verdict).toMatchObject({ state: "stopped", reason: "loop" })
      expect(asked).toEqual([3, 5])
    }),
  )

  it.effect("forgets a session's loop memory when its files change after its step was counted", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root)
      yield* guard.record(child, step({ tools: [bash("bun test")] }))
      yield* guard.record(child, step({ tools: [bash("bun test")] }))
      yield* guard.record(root, step({ tools: [bash("bun test")] }))
      yield* guard.record(root, step({ tools: [bash("bun test")] }))
      yield* guard.changed(child)
      expect((yield* guard.record(child, step({ tools: [bash("bun test")] }))).state).toBe("ok")
      // Another session's change leaves the root's memory alone.
      expect((yield* guard.record(root, step({ tools: [bash("bun test")] }))).reason).toBe("loop")
    }),
  )

  it.effect("says whether the root of a session has a run going", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root)
      expect(yield* guard.running(child)).toBe(false)
      yield* guard.begin(root)
      expect(yield* guard.running(child)).toBe(true)
      expect(yield* guard.running(root)).toBe(true)
      yield* guard.end(root)
      expect(yield* guard.running(child)).toBe(false)
    }),
  )

  it.effect("resets only the prompted Session's loop memory without renewing accounting scopes", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 10, steps: 20 })
      yield* guard.link(child, root, { budget: { usd: 4 }, batch: { id: "reset-batch", budget: { usd: 5 } } })
      for (const sessionID of [root, child])
        for (const index of [1, 2])
          yield* guard.record(sessionID, step({ costUsd: 0.1, tools: [bash(`attempt-${index}`, "same failure")] }))
      const before = yield* guard.snapshot(root)
      const scopes = yield* guard.scopes(child)

      yield* guard.resetLoops(child)

      const after = yield* guard.snapshot(root)
      expect(after && { ...after, loops: before?.loops }).toEqual(before)
      expect(after?.loops.get(root)).toEqual(before?.loops.get(root))
      expect(after?.loops.has(child)).toBe(false)
      expect(yield* guard.scopes(child)).toEqual(scopes)
      expect((yield* guard.record(child, step({ tools: [bash("attempt-3", "same failure")] }))).state).toBe("ok")
      expect((yield* guard.record(root, step({ tools: [bash("attempt-3", "same failure")] }))).reason).toBe("loop")
    }),
  )

  it.effect("resetting loop memory preserves an existing stop and its counters", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.arm(root, { usd: 1, steps: 2 })
      yield* guard.begin(root)
      yield* guard.record(root, step({ costUsd: 0.2, tools: [bash("attempt", "same failure")] }))
      yield* guard.record(root, step({ costUsd: 0.2 }))
      const before = yield* guard.snapshot(root)
      expect(before?.loops.has(root)).toBe(true)

      yield* guard.resetLoops(root)

      const after = yield* guard.snapshot(root)
      expect(after && { ...after, loops: before?.loops }).toEqual(before)
      expect(after?.loops.size).toBe(0)
      expect(yield* guard.stopped(root)).toEqual(before?.stopped)
      expect((yield* guard.record(root, step())).reason).toBe("steps")
    }),
  )

  it.effect("resets a late linked Session in its launch run without changing a new root run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root)
      yield* guard.record(child, step({ tools: [bash("recheck")] }))
      yield* guard.record(child, step({ tools: [bash("recheck")] }))
      yield* guard.end(root)
      yield* guard.begin(root)
      yield* guard.record(root, step({ tools: [bash("recheck")] }))
      yield* guard.record(root, step({ tools: [bash("recheck")] }))
      const current = yield* guard.snapshot(root)

      yield* guard.resetLoops(child)

      expect(yield* guard.snapshot(root)).toEqual(current)
      expect((yield* guard.snapshot(child))?.loops.has(child)).toBe(false)
      expect((yield* guard.record(child, step({ tools: [bash("recheck")] }))).state).toBe("ok")
      expect((yield* guard.record(root, step({ tools: [bash("recheck")] }))).reason).toBe("loop")
    }),
  )

  it.effect("keeps a background child on its launch budget when the parent begins a new run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root)
      expect((yield* guard.record(root, step({ costUsd: 1.2 }))).state).toBe("stopped")
      yield* guard.end(root)

      // A background child keeps the finished run's stop and has its spend counted.
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.record(child, step({ costUsd: 0.3 }))).state).toBe("stopped")
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(1.5, 6)
      // The root itself only ever steps inside a run of its own.
      expect(yield* guard.stopped(root)).toBeUndefined()

      yield* guard.begin(root, { usd: 1 })
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.record(child, step({ costUsd: 0.1 }))).state).toBe("stopped")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0)
      expect((yield* guard.snapshot(child))?.spentUsd).toBeCloseTo(1.6, 6)
    }),
  )

  it.effect("holds a linked child to its root's finished run with no stop, and counts its spend there", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root)
      yield* guard.end(root)
      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.record(child, step({ costUsd: 0.6 }))).state).toBe("stopped")
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(1.1, 6)
    }),
  )

  it.effect("publishes a stop to the lineage with its reason and message", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const events = yield* EventV2.Service
      const published = yield* events
        .subscribe(SessionStatusEvent.Spend)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* guard.begin(root, { usd: 5 })
      yield* guard.link(child, root)
      yield* guard.record(root, step({ costUsd: 4.1 }))
      expect((yield* guard.record(child, step({ costUsd: 0.92 }))).state).toBe("stopped")

      const message =
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it."
      expect([...(yield* Fiber.join(published))].map((event) => event.data)).toMatchObject([
        { sessionID: root, state: "warn", message: "Approaching the spend cap: $4.10 of $5.00 spent on this run." },
        { sessionID: root, state: "stopped", reason: "cap", message, spentUsd: 5.02, capUsd: 5 },
      ])
      expect(yield* guard.stopped(child)).toEqual({ reason: "cap", message })
    }),
  )

  it.effect("warns again only when a new cap is armed", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 5 })
      expect((yield* guard.record(root, step({ costUsd: 4.1 }))).state).toBe("warn")
      yield* guard.arm(root, { usd: 5 })
      expect((yield* guard.record(root, step({ costUsd: 0.01 }))).state).toBe("ok")
      yield* guard.arm(root, { usd: 4.5 })
      expect(yield* guard.record(root, step({ costUsd: 0.01 }))).toEqual({
        state: "warn",
        message: "Approaching the spend cap: $4.12 of $4.50 spent on this run.",
      })
    }),
  )

  it.effect("tightens an active run's budget without loosening any limit", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const owner = SessionID.make("ses_tighten_active")
      yield* guard.begin(owner, { usd: 2, steps: 50 })
      yield* guard.tighten(owner, {})
      expect((yield* guard.snapshot(owner))?.budget).toEqual({ usd: 2, steps: 50 })
      yield* guard.tighten(owner, { usd: 100, steps: 10 })
      expect((yield* guard.snapshot(owner))?.budget).toEqual({ usd: 2, steps: 10 })
      // The owner can still replace it.
      yield* guard.arm(owner, { usd: 100 })
      expect((yield* guard.snapshot(owner))?.budget).toEqual({ usd: 100 })
      yield* guard.end(owner)
    }),
  )

  it.effect("holds a budget armed only by tighten to begin's fallback, and to a budget the owner armed", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const fresh = SessionID.make("ses_tighten_fresh")
      yield* guard.tighten(fresh, { usd: 100, steps: 10 })
      yield* guard.begin(fresh, { usd: 2, steps: 50 })
      expect((yield* guard.snapshot(fresh))?.budget).toEqual({ usd: 2, steps: 10 })
      yield* guard.end(fresh)

      // An empty budget lifts nothing: the run keeps the fallback's limits.
      const empty = SessionID.make("ses_tighten_empty")
      yield* guard.tighten(empty, {})
      yield* guard.begin(empty, { usd: 2, steps: 50 })
      expect((yield* guard.snapshot(empty))?.budget).toEqual({ usd: 2, steps: 50 })
      yield* guard.end(empty)

      // On top of a budget the owner armed, which replaces the fallback, the stricter limits of the two apply.
      const armed = SessionID.make("ses_tighten_armed")
      yield* guard.arm(armed, { usd: 5 })
      yield* guard.tighten(armed, { usd: 50, steps: 20 })
      yield* guard.begin(armed, { usd: 2 })
      expect((yield* guard.snapshot(armed))?.budget).toEqual({ usd: 5, steps: 20 })
      yield* guard.end(armed)
    }),
  )

  it.effect("moves a run from one fallback to another only while no owner armed a budget over it", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const focused = { usd: 1, steps: 80 }
      const deep = { usd: 3, steps: 240 }

      const plain = SessionID.make("ses_fallback_plain")
      yield* guard.begin(plain, focused)
      yield* guard.replaceFallback(plain, deep)
      expect((yield* guard.snapshot(plain))?.budget).toEqual(deep)
      yield* guard.end(plain)

      // A budget the owner armed before the run began, or while it runs, stays, even one equal to the fallback.
      const before = SessionID.make("ses_fallback_before")
      yield* guard.arm(before, focused)
      yield* guard.begin(before, focused)
      yield* guard.replaceFallback(before, deep)
      expect((yield* guard.snapshot(before))?.budget).toEqual(focused)
      yield* guard.end(before)
      const during = SessionID.make("ses_fallback_during")
      yield* guard.begin(during, focused)
      yield* guard.arm(during, { usd: 0.5 })
      yield* guard.replaceFallback(during, deep)
      expect((yield* guard.snapshot(during))?.budget).toEqual({ usd: 0.5 })
      yield* guard.end(during)

      // A guest's limits, held before the run or given during it, hold the new fallback too.
      const held = SessionID.make("ses_fallback_held")
      yield* guard.tighten(held, { usd: 2 })
      yield* guard.begin(held, focused)
      expect((yield* guard.snapshot(held))?.budget).toEqual(focused)
      yield* guard.replaceFallback(held, deep)
      expect((yield* guard.snapshot(held))?.budget).toEqual({ usd: 2, steps: 240 })
      yield* guard.end(held)
      const given = SessionID.make("ses_fallback_given")
      yield* guard.begin(given, focused)
      yield* guard.tighten(given, { steps: 100 })
      yield* guard.replaceFallback(given, deep)
      expect((yield* guard.snapshot(given))?.budget).toEqual({ usd: 3, steps: 100 })
      yield* guard.end(given)

      // No run going: nothing to move, and nothing is held for the next one.
      const idle = SessionID.make("ses_fallback_idle")
      yield* guard.replaceFallback(idle, deep)
      yield* guard.begin(idle, focused)
      expect((yield* guard.snapshot(idle))?.budget).toEqual(focused)
      yield* guard.end(idle)
    }),
  )

  it.effect("carries a stopped run's budget on, the owner's staying the owner's and a fallback staying movable", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const focused = { usd: 1, steps: 80 }
      const deep = { usd: 3, steps: 240 }
      const priced = (costUsd: number): SpendGuard.Step => ({
        costUsd,
        costKind: "priced",
        contextTokens: 1_000,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      })
      // Stops the run at its cap and returns it, as a successor drain reads it before it begins.
      const stopped = (id: SessionID, costUsd: number) =>
        Effect.gen(function* () {
          expect((yield* guard.record(id, priced(costUsd))).state).toBe("stopped")
          yield* guard.end(id)
          return (yield* guard.snapshot(id))!
        })

      // The owner's cap: no fallback replaces it in the run that carries on.
      const owned = SessionID.make("ses_carry_owned")
      yield* guard.arm(owned, { usd: 0.25 })
      yield* guard.begin(owned)
      yield* guard.begin(owned, undefined, yield* stopped(owned, 0.3))
      yield* guard.replaceFallback(owned, focused)
      expect((yield* guard.snapshot(owned))?.budget).toEqual({ usd: 0.25 })
      // A guest's tighter limit given for the successor joins the owner's cap, and still no fallback moves it.
      yield* guard.end(owned)
      yield* guard.tighten(owned, { steps: 10 })
      yield* guard.begin(owned, undefined, (yield* guard.snapshot(owned))!)
      yield* guard.replaceFallback(owned, deep)
      expect((yield* guard.snapshot(owned))?.budget).toEqual({ usd: 0.25, steps: 10 })
      yield* guard.end(owned)

      // A fallback stays one, held to what a guest gave the run it carries on from.
      const fallback = SessionID.make("ses_carry_fallback")
      yield* guard.begin(fallback, focused)
      yield* guard.tighten(fallback, { usd: 2 })
      yield* guard.begin(fallback, undefined, yield* stopped(fallback, 1.2))
      expect((yield* guard.snapshot(fallback))?.budget).toEqual(focused)
      yield* guard.replaceFallback(fallback, deep)
      expect((yield* guard.snapshot(fallback))?.budget).toEqual({ usd: 2, steps: 240 })
      yield* guard.end(fallback)

      // A budget the owner arms before the successor begins replaces the carried one.
      const rearmed = SessionID.make("ses_carry_rearmed")
      yield* guard.begin(rearmed, focused)
      const before = yield* stopped(rearmed, 1.5)
      yield* guard.arm(rearmed, { usd: 5 })
      yield* guard.begin(rearmed, undefined, before)
      yield* guard.replaceFallback(rearmed, deep)
      expect((yield* guard.snapshot(rearmed))?.budget).toEqual({ usd: 5 })
      yield* guard.end(rearmed)
    }),
  )

  it.effect("drops a budget armed for a run that never began", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.arm(root, { usd: 1 })
      yield* guard.end(root)
      yield* guard.begin(root, { usd: 9 })
      expect((yield* guard.snapshot(root))?.budget.usd).toBe(9)
    }),
  )

  it.effect("keeps the last 200 finished runs, and drops the links of older ones", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root)
      yield* guard.end(root)
      const others = Array.from({ length: SpendGuard.LAST_RUNS - 1 }, (_, index) => SessionID.make(`ses_run_${index}`))
      yield* Effect.forEach(others, (id) => Effect.andThen(guard.begin(id), guard.end(id)), { discard: true })
      expect(yield* guard.snapshot(child)).toBeDefined()

      yield* guard.release(child)
      yield* guard.begin(sibling)
      yield* guard.end(sibling)
      expect(yield* guard.snapshot(root)).toBeUndefined()
      expect(yield* guard.rootOf(child)).toBe(child)
      expect(yield* guard.snapshot(SessionID.make("ses_run_0"))).toBeDefined()
    }),
  )
})

describe("SpendGuard task scopes", () => {
  it.effect("Codium propagates to root, batch and child scopes without unknown spend", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root, { budget: { usd: 0.1 }, batch: { id: "codium-batch", budget: { usd: 0.2 } } })
      yield* guard.record(child, step({ costKind: "codium", costUsd: 100 }))
      expect(yield* guard.snapshot(root)).toMatchObject({ codiumSteps: 1, unpricedSteps: 0, spentUsd: 0 })
      const scopes = yield* guard.scopes(child)
      expect(scopes.map((scope) => scope.kind)).toEqual(["run", "batch", "child"])
      expect(
        scopes.every((scope) => scope.codiumSteps === 1 && scope.unpricedSteps === 0 && scope.spentUsd === 0),
      ).toBe(true)
      expect(yield* guard.stopped(child)).toBeUndefined()
    }),
  )

  it.effect("checks child, batch and root ceilings while recording each step once per applicable scope", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 10 })
      yield* guard.link(child, root, { budget: { usd: 1 }, batch: { id: "batch-a", budget: { usd: 3 } } })
      yield* guard.link(sibling, root, { budget: { usd: 2 }, batch: { id: "batch-a", budget: { usd: 9 } } })
      yield* guard.record(child, step({ costUsd: 0.7 }))
      yield* guard.record(sibling, step({ costUsd: 0.6 }))
      expect((yield* guard.scopes(child)).map((scope) => [scope.kind, scope.spentUsd, scope.budget.usd])).toEqual([
        ["run", 1.2999999999999998, 10],
        ["batch", 1.2999999999999998, 3],
        ["child", 0.7, 1],
      ])
      expect((yield* guard.record(child, step({ costUsd: 0.4 }))).reason).toBe("cap")
      expect(yield* guard.stopped(root)).toBeUndefined()
      expect(yield* guard.stopped(sibling)).toBeUndefined()
      yield* guard.record(sibling, step({ costUsd: 1.4 }))
      expect((yield* guard.stopped(sibling))?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(3.1, 6)
      expect((yield* guard.scopes(sibling)).find((scope) => scope.kind === "batch")?.spentUsd).toBeCloseTo(3.1, 6)
      expect((yield* guard.snapshot(root))?.steps).toBe(4)
    }),
  )

  it.effect("nested children inherit ancestor and batch ceilings without counting a shared batch twice", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const nested = SessionID.make("ses_nested")
      yield* guard.begin(root, { usd: 10 })
      yield* guard.link(child, root, { budget: { usd: 1 }, batch: { id: "shared", budget: { usd: 2 } } })
      yield* guard.link(nested, child, { budget: { usd: 5 }, batch: { id: "shared", budget: { usd: 9 } } })
      expect((yield* guard.record(nested, step({ costUsd: 1.1 }))).reason).toBe("cap")
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect(yield* guard.stopped(root)).toBeUndefined()
      const scopes = yield* guard.scopes(nested)
      expect(scopes.map((scope) => scope.kind)).toEqual(["run", "batch", "child", "child"])
      expect(scopes.every((scope) => scope.steps === 1 && scope.spentUsd === 1.1)).toBe(true)
    }),
  )

  it.effect("follow-ups tighten limits without resetting spend, explicit renewal starts a new attempt", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 10 })
      yield* guard.link(child, root, { budget: { usd: 1 } })
      yield* guard.record(child, step({ costUsd: 0.9 }))
      yield* guard.end(root)
      yield* guard.begin(root, { usd: 20 })
      yield* guard.link(child, root, { budget: { usd: 100 } })
      expect((yield* guard.record(child, step({ costUsd: 0.2 }))).reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0)
      yield* guard.release(child)
      yield* guard.link(child, root, { budget: { usd: 2 }, renew: true })
      expect(yield* guard.stopped(child)).toBeUndefined()
      yield* guard.record(child, step({ costUsd: 0.5 }))
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0.5)
      expect((yield* guard.scopes(child)).find((scope) => scope.kind === "child")?.spentUsd).toBe(0.5)
    }),
  )

  it.effect("a released old attempt never inherits the next completed parent run after pruning", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root, { budget: { usd: 0.5 } })
      yield* guard.record(child, step({ costUsd: 0.1 }))
      yield* guard.release(child)
      yield* guard.end(root)
      yield* guard.begin(root, { usd: 20 })
      yield* guard.record(root, step({ costUsd: 2 }))
      yield* guard.end(root)
      expect(yield* guard.rootOf(child)).toBe(child)
      expect(yield* guard.scopes(child)).toEqual([])
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(2)
    }),
  )

  it.effect("simultaneous siblings retain in-flight usage after their shared cap is crossed", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 10 })
      yield* guard.link(child, root, { batch: { id: "concurrent", budget: { usd: 1 } } })
      yield* guard.link(sibling, root, { batch: { id: "concurrent", budget: { usd: 1 } } })
      yield* Effect.all([guard.record(child, step({ costUsd: 0.7 })), guard.record(sibling, step({ costUsd: 0.7 }))], {
        concurrency: "unbounded",
      })
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.stopped(sibling))?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(1.4)
      expect((yield* guard.scopes(child)).find((scope) => scope.kind === "batch")?.steps).toBe(2)
    }),
  )

  it.effect("pins a live child's launch cap beyond the finished-run history until release", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { steps: 1 })
      yield* guard.link(child, root, { budget: { steps: 2 } })
      yield* guard.end(root)
      yield* Effect.forEach(
        Array.from({ length: SpendGuard.LAST_RUNS + 1 }, (_, index) => SessionID.make(`ses_other_${index}`)),
        (id) => Effect.andThen(guard.begin(id), guard.end(id)),
      )
      expect((yield* guard.record(child, step())).reason).toBe("steps")
      expect((yield* guard.scopes(child)).length).toBe(2)
      yield* guard.release(child)
      expect(yield* guard.scopes(child)).toEqual([])
    }),
  )
})

describe("SpendGuard delegated ledger", () => {
  const third = SessionID.make("ses_third_child")
  const fourth = SessionID.make("ses_fourth_child")
  const grandchild = SessionID.make("ses_grandchild")
  const delegated = (
    id: string,
    budget: RunBudget.Info,
    seed?: { spentUsd: number; steps: number; unpricedSteps: number; codiumSteps?: number },
  ) => ({
    delegated: { id, budget, ...(seed ? { seed } : {}) },
  })
  const ceiling = "ceiling for this request's subagents"

  it.effect("1. children of two runs of one root, linked with one id, share its spend", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 100 })
      yield* guard.link(child, root, delegated("req-1", { usd: 25 }))
      yield* guard.record(child, step({ costUsd: 2 }))
      yield* guard.end(root)
      yield* guard.begin(root, { usd: 100 })
      yield* guard.link(sibling, root, delegated("req-1", { usd: 25 }))
      yield* guard.record(sibling, step({ costUsd: 3 }))
      expect(yield* guard.delegated("req-1")).toMatchObject({ kind: "delegated", spentUsd: 5, steps: 2 })
      expect((yield* guard.scopes(child)).find((scope) => scope.kind === "delegated")?.spentUsd).toBe(5)
      // Each run of the root still counts only its own child.
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(3)
    }),
  )

  it.effect("2. a grandchild inherits its parent's delegated ledger, with or without a root run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root, delegated("req-2", { usd: 25 }))
      yield* guard.link(grandchild, child)
      expect((yield* guard.scopes(grandchild)).map((scope) => scope.kind)).toEqual([
        "run",
        "delegated",
        "child",
        "child",
      ])
      yield* guard.record(grandchild, step({ costUsd: 1.5 }))
      expect((yield* guard.delegated("req-2"))?.spentUsd).toBe(1.5)
      yield* guard.end(root)

      const idle = SessionID.make("ses_idle_root")
      const nested = SessionID.make("ses_idle_nested")
      yield* guard.link(sibling, idle, delegated("req-2-idle", { usd: 25 }))
      yield* guard.link(nested, sibling)
      expect((yield* guard.scopes(nested)).map((scope) => scope.kind)).toEqual(["delegated", "child", "child"])
      yield* guard.record(nested, step({ costUsd: 0.5 }))
      expect((yield* guard.delegated("req-2-idle"))?.spentUsd).toBe(0.5)
    }),
  )

  it.effect("3. crossing the ceiling stops every child at its next step, never the root", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root, delegated("req-3", { usd: 1 }))
      yield* guard.link(sibling, root, delegated("req-3", { usd: 1 }))
      expect((yield* guard.record(child, step({ costUsd: 0.5, continues: true }))).state).toBe("ok")
      expect(yield* guard.record(sibling, step({ costUsd: 0.75, continues: true }))).toMatchObject({
        state: "stopped",
        reason: "cap",
      })
      expect(yield* guard.record(child, step({ costUsd: 0.25 }))).toMatchObject({ state: "stopped", reason: "cap" })
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.stopped(sibling))?.reason).toBe("cap")
      expect(yield* guard.stopped(root)).toBeUndefined()
      expect((yield* guard.record(root, step({ costUsd: 5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(root))?.stopped).toBeUndefined()
      expect((yield* guard.delegated("req-3"))?.spentUsd).toBe(1.5)
    }),
  )

  it.effect("4. the cap, predicted and step stops, and the warning, name the subagent ceiling", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root, delegated("req-4-cap", { usd: 1 }))
      expect(yield* guard.record(child, step({ costUsd: 1.25, continues: true }))).toEqual({
        state: "stopped",
        reason: "cap",
        message:
          "Subagent spend ceiling reached: $1.25 spent against a $1.00 ceiling for this request's subagents. Vector stopped this subagent after the step that crossed it; what it did is kept, and the main agent carries on.",
      })

      yield* guard.link(sibling, root, delegated("req-4-predicted", { usd: 5 }))
      const predicted = step({
        costUsd: 4.62,
        continues: true,
        contextTokens: 317_000,
        cachedTokens: 207_000,
        price: { input: 3, output: 15, cacheRead: 0.3 },
      })
      expect(yield* guard.record(sibling, predicted)).toMatchObject({
        state: "stopped",
        reason: "predicted",
        message:
          "Subagent spend ceiling: $4.62 spent of a $5.00 ceiling for this request's subagents, and this subagent's next step was estimated at $0.41–$0.97 at catalog list prices. Vector stopped it before that step; what it did is kept, and the main agent carries on.",
      })

      yield* guard.link(third, root, delegated("req-4-steps", { steps: 2 }))
      expect((yield* guard.record(third, step())).state).toBe("ok")
      expect(yield* guard.record(third, step())).toEqual({
        state: "stopped",
        reason: "steps",
        message:
          "Subagent step limit reached: this request's subagents used 2 of their 2 steps. Vector stopped this subagent; what it did is kept, and the main agent carries on.",
      })

      yield* guard.link(fourth, root, delegated("req-4-warn", { usd: 5 }))
      expect(yield* guard.record(fourth, step({ costUsd: 4.25 }))).toEqual({
        state: "warn",
        message: "Subagents in this request have spent $4.25 of their $5.00 ceiling.",
      })
    }),
  )

  it.effect("5. unknown-cost steps never stop on the unpriced rule unless unpricedSteps is set", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root, delegated("req-5", { usd: 5 }))
      const open = yield* Effect.forEach(Array.from({ length: 45 }), () =>
        guard.record(child, step({ costKind: "unknown" })),
      )
      expect(open.every((verdict) => verdict.state === "ok")).toBe(true)
      expect(yield* guard.delegated("req-5")).toMatchObject({ unpricedSteps: 45, spentUsd: 0, stopped: undefined })

      yield* guard.link(sibling, root, delegated("req-5-limited", { usd: 5, unpricedSteps: 3 }))
      const limited = yield* Effect.forEach([1, 2, 3], () => guard.record(sibling, step({ costKind: "unknown" })))
      expect(limited.map((verdict) => verdict.state)).toEqual(["ok", "ok", "stopped"])
      expect(limited[2]?.reason).toBe("unpriced")
      expect(limited[2]?.message).toContain(ceiling)
    }),
  )

  it.effect("6. delegated(id) returns the ledger with kind delegated", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      expect(yield* guard.delegated("req-6")).toBeUndefined()
      yield* guard.link(child, root, delegated("req-6", { usd: 25 }))
      expect(yield* guard.delegated("req-6")).toEqual({
        kind: "delegated",
        id: "req-6",
        budget: { usd: 25 },
        spentUsd: 0,
        steps: 0,
        unpricedSteps: 0,
        codiumSteps: 0,
      })
    }),
  )

  it.effect("7. scopes(child) lists the run, the delegated ledger and the child", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 100 })
      yield* guard.link(child, root, { budget: { usd: 2 }, ...delegated("req-7", { usd: 25 }) })
      yield* guard.link(sibling, root, { batch: { id: "batch-7" }, ...delegated("req-7", { usd: 25 }) })
      yield* guard.record(child, step({ costUsd: 0.5 }))
      expect((yield* guard.scopes(child)).map((scope) => [scope.kind, scope.spentUsd])).toEqual([
        ["run", 0.5],
        ["delegated", 0.5],
        ["child", 0.5],
      ])
      expect((yield* guard.scopes(sibling)).map((scope) => scope.kind)).toEqual(["run", "delegated", "batch", "child"])
    }),
  )

  it.effect("8. prune keeps the last 200 delegated ledgers, and one a live child counts on", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const pinned = SessionID.make("ses_pinned")
      yield* guard.link(pinned, root, delegated("req-8-pinned", { usd: 25 }))
      const ids = Array.from({ length: SpendGuard.LAST_RUNS + 1 }, (_, index) => `req-8-${index}`)
      const use = (id: string, name: string) =>
        Effect.gen(function* () {
          const helper = SessionID.make(name)
          yield* guard.link(helper, root, delegated(id, { usd: 25 }))
          yield* guard.record(helper, step({ costUsd: 0.25 }))
          yield* guard.release(helper)
        })
      yield* Effect.forEach(ids, (id, index) => use(id, `ses_helper_${index}`), { discard: true })
      expect(yield* guard.delegated(ids[0]!)).toBeUndefined()
      expect((yield* guard.delegated(ids[1]!))?.spentUsd).toBe(0.25)
      expect((yield* guard.delegated(ids.at(-1)!))?.spentUsd).toBe(0.25)
      expect(yield* guard.delegated("req-8-pinned")).toBeDefined()
      yield* guard.release(pinned)
      expect(yield* guard.delegated("req-8-pinned")).toBeUndefined()

      // Linking an id again makes it the most recent, so the next one out is the oldest after it.
      yield* use(ids[1]!, "ses_helper_again")
      yield* use("req-8-extra", "ses_helper_extra")
      expect((yield* guard.delegated(ids[1]!))?.spentUsd).toBe(0.5)
      expect(yield* guard.delegated(ids[2]!)).toBeUndefined()
    }),
  )

  it.effect("9. linking with no active root run binds the child, and record counts its steps", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      // The root's last run stopped at its cap; a child linked after it ended is not held to it.
      yield* guard.begin(root, { usd: 1 })
      expect((yield* guard.record(root, step({ costUsd: 1.5 }))).state).toBe("stopped")
      yield* guard.end(root)
      yield* guard.link(child, root, delegated("req-9", { usd: 25 }))
      expect(yield* guard.rootOf(child)).toBe(root)
      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.record(child, step({ costUsd: 0.25 }))).state).toBe("ok")
      expect(yield* guard.delegated("req-9")).toMatchObject({ spentUsd: 0.75, steps: 2 })
      expect((yield* guard.scopes(child)).map((scope) => [scope.kind, scope.spentUsd])).toEqual([
        ["delegated", 0.75],
        ["child", 0.75],
      ])
      expect((yield* guard.snapshot(child))?.spentUsd).toBe(0.75)
      expect(yield* guard.stopped(child)).toBeUndefined()
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(1.5)

      // A root that never had a run, as after a restart.
      const fresh = SessionID.make("ses_never_ran")
      yield* guard.link(sibling, fresh, delegated("req-9-fresh", { usd: 25 }))
      expect((yield* guard.record(sibling, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.delegated("req-9-fresh"))?.spentUsd).toBe(0.5)
      expect(yield* guard.snapshot(fresh)).toBeUndefined()
      expect(yield* guard.running(sibling)).toBe(false)
    }),
  )

  it.effect("10. re-arming with a higher ceiling after a stop clears it and keeps the spend", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root, delegated("req-10", { usd: 1 }))
      expect((yield* guard.record(child, step({ costUsd: 1.25 }))).reason).toBe("cap")
      // The same budget again, as at the next launch, keeps the stop.
      yield* guard.link(sibling, root, delegated("req-10", { usd: 1 }))
      expect((yield* guard.delegated("req-10"))?.stopped?.reason).toBe("cap")
      expect((yield* guard.record(sibling, step({ costUsd: 0.25 }))).state).toBe("stopped")
      // A raised ceiling clears it and keeps what was spent; the warning comes again under it.
      yield* guard.link(sibling, root, delegated("req-10", { usd: 5 }))
      expect(yield* guard.delegated("req-10")).toMatchObject({ spentUsd: 1.5, steps: 2, budget: { usd: 5 } })
      expect((yield* guard.delegated("req-10"))?.stopped).toBeUndefined()
      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.record(child, step({ costUsd: 2 }))).state).toBe("warn")
      // A ceiling lowered below the spend stops it at once, before any step.
      yield* guard.link(sibling, root, delegated("req-10", { usd: 2 }))
      expect((yield* guard.delegated("req-10"))?.stopped?.reason).toBe("cap")
      expect((yield* guard.delegated("req-10"))?.stopped?.message).toContain(ceiling)

      // A predicted stop estimated the next step of the child that made it, which has stopped: re-arming under the
      // same ceiling clears it while the spend is below it (4.8), so the next launch is admitted.
      const big = step({
        costUsd: 4.62,
        continues: true,
        contextTokens: 317_000,
        cachedTokens: 207_000,
        price: { input: 3, output: 15, cacheRead: 0.3 },
      })
      yield* guard.link(third, root, delegated("req-10-predicted", { usd: 5 }))
      expect((yield* guard.record(third, big)).reason).toBe("predicted")
      expect((yield* guard.delegated("req-10-predicted"))?.stopped?.reason).toBe("predicted")
      yield* guard.link(fourth, root, delegated("req-10-predicted", { usd: 5 }))
      expect(yield* guard.delegated("req-10-predicted")).toMatchObject({ spentUsd: 4.62, stopped: undefined })
      expect((yield* guard.record(fourth, step({ costUsd: 0.1 }))).state).not.toBe("stopped")
    }),
  )

  it.effect("12. a child linked with no root run is paused by its own loop, and its sibling carries on", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const idle = SessionID.make("ses_loop_root")
      yield* guard.link(child, idle, delegated("req-12", { usd: 25 }))
      yield* guard.link(sibling, idle, delegated("req-12", { usd: 25 }))
      const verdicts: SpendGuard.Verdict[] = []
      for (let index = 0; index < SpendGuard.LOOP_REPEATS; index++)
        verdicts.push(yield* guard.record(child, step({ costUsd: 0.01, tools: [bash("bun test")] })))
      expect(verdicts.slice(0, -1).map((verdict) => verdict.state)).toEqual(["ok", "ok"])
      expect(verdicts.at(-1)).toMatchObject({ state: "stopped", reason: "loop" })
      expect((yield* guard.stopped(child))?.reason).toBe("loop")
      // The shared ledger takes no loop stop, so the sibling, and the next launch, go on.
      expect((yield* guard.delegated("req-12"))?.stopped).toBeUndefined()
      expect(yield* guard.stopped(sibling)).toBeUndefined()
      expect((yield* guard.record(sibling, step({ costUsd: 0.01, tools: [bash("bun test")] }))).state).toBe("ok")
      // A nested child's calls are watched on its own ledger, not again on its parent's.
      const nested = SessionID.make("ses_loop_nested")
      yield* guard.link(nested, sibling, delegated("req-12", { usd: 25 }))
      for (let index = 0; index < SpendGuard.LOOP_REPEATS; index++)
        yield* guard.record(nested, step({ costUsd: 0.01, tools: [bash("git status")] }))
      expect((yield* guard.stopped(nested))?.reason).toBe("loop")
      expect(yield* guard.stopped(sibling)).toBeUndefined()
    }),
  )

  it.effect("11. a seed starts a new ledger at the seeded spend, and an existing one ignores it", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root, delegated("req-11", { usd: 25 }, { spentUsd: 3, steps: 7, unpricedSteps: 2 }))
      expect(yield* guard.delegated("req-11")).toMatchObject({ spentUsd: 3, steps: 7, unpricedSteps: 2 })
      yield* guard.record(child, step({ costUsd: 1 }))
      yield* guard.link(sibling, root, delegated("req-11", { usd: 25 }, { spentUsd: 0, steps: 0, unpricedSteps: 0 }))
      expect(yield* guard.delegated("req-11")).toMatchObject({ spentUsd: 4, steps: 8, unpricedSteps: 2 })
      // A request that already spent its ceiling before a restart starts stopped, so the next launch is refused.
      yield* guard.link(
        third,
        root,
        delegated("req-11-spent", { usd: 25 }, { spentUsd: 26, steps: 40, unpricedSteps: 0 }),
      )
      expect((yield* guard.delegated("req-11-spent"))?.stopped?.reason).toBe("cap")
      expect((yield* guard.record(third, step({ costKind: "free" }))).state).toBe("stopped")
    }),
  )

  it.effect("restored Codium activity stays separate from the delegated unknown-step limit", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const budget = { usd: 25, unpricedSteps: 3 }
      yield* guard.link(
        child,
        root,
        delegated("req-codium", budget, { spentUsd: 0, steps: 52, unpricedSteps: 2, codiumSteps: 50 }),
      )
      expect(yield* guard.stopped(child)).toBeUndefined()
      expect((yield* guard.record(child, step({ costKind: "codium" }))).state).toBe("ok")
      expect(yield* guard.delegated("req-codium")).toMatchObject({
        spentUsd: 0,
        steps: 53,
        unpricedSteps: 2,
        codiumSteps: 51,
      })
      // A later link must retain the live count rather than replacing it with an older seed.
      yield* guard.link(
        sibling,
        root,
        delegated("req-codium", budget, { spentUsd: 0, steps: 0, unpricedSteps: 0, codiumSteps: 0 }),
      )
      expect((yield* guard.scopes(sibling)).find((scope) => scope.kind === "delegated")?.codiumSteps).toBe(51)
      expect(yield* guard.record(sibling, step({ costKind: "unknown" }))).toMatchObject({
        state: "stopped",
        reason: "unpriced",
      })
    }),
  )

  it.effect("a subagent's reported unknown cost and incomplete usage count through its run and delegated ledger", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 100 })
      yield* guard.link(child, root, delegated("req-uncertain", { usd: 25, unpricedSteps: 2 }))
      expect((yield* guard.record(child, step({ costKind: "unknown", costUsd: 1.5 }))).state).toBe("ok")
      const stopped = yield* guard.record(child, step({ costUsd: 0.5, unpriced: true }))
      expect(stopped).toMatchObject({ state: "stopped", reason: "unpriced" })
      expect(stopped.message).toContain(ceiling)
      expect(stopped.message).toContain("unpriced or incomplete")
      expect(yield* guard.delegated("req-uncertain")).toMatchObject({ spentUsd: 2, steps: 2, unpricedSteps: 2 })
      expect(yield* guard.snapshot(root)).toMatchObject({ spentUsd: 2, steps: 2, unpricedSteps: 2 })
      expect(yield* guard.stopped(root)).toBeUndefined()
    }),
  )
})
