import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultLimits,
  estimateUsd,
  formatSummary,
  Ledger,
  LedgerError,
  limitProblems,
  parsePrice,
  type Entry,
  type Limits,
  type Ticket,
} from "./budget"

// The eval budget ledger with no provider at all: attempts are admitted, sent and settled by hand, in parallel where
// it matters, and the journal is written to a temporary directory.

const root = mkdtempSync(join(tmpdir(), "vectorscope-budget-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// $10 total, $1 held in reserve, so $9 admissible; $2 per case.
const LIMITS: Limits = { totalUsd: 10, caseUsd: 2, reserveUsd: 1 }

function admitted(ledger: Ledger, request: { case: string; estimateUsd: number; kind?: "provider" | "judge" }): Ticket {
  const admission = ledger.admit({ kind: "provider", model: "test/model", ...request })
  if (!admission.admitted) throw new Error(`refused: ${admission.reason}: ${admission.detail}`)
  return admission.ticket
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("limits and estimates", () => {
  test("a budget is a finite positive total with a per-case bound inside what it admits", () => {
    expect(limitProblems(LIMITS)).toEqual([])
    expect(limitProblems(defaultLimits(50, 0.75))).toEqual([])
    expect(defaultLimits(50, 0.75).reserveUsd).toBeCloseTo(5)
    expect(limitProblems({ ...LIMITS, totalUsd: 0 })).not.toEqual([])
    expect(limitProblems({ ...LIMITS, totalUsd: Number.POSITIVE_INFINITY })).not.toEqual([])
    expect(limitProblems({ ...LIMITS, totalUsd: Number.NaN })).not.toEqual([])
    expect(limitProblems({ ...LIMITS, caseUsd: -1 })).not.toEqual([])
    expect(limitProblems({ ...LIMITS, reserveUsd: 10 })).not.toEqual([])
    expect(limitProblems({ ...LIMITS, caseUsd: 9.5 })).not.toEqual([])
    expect(() => Ledger.open({ limits: { ...LIMITS, totalUsd: 0 } })).toThrow(LedgerError)
  })

  test("an estimate counts the body at two characters per token and every output token allowed", () => {
    // 4,000 characters is 2,000 input tokens at $3 per million; 1,000 output tokens at $15 per million.
    expect(estimateUsd({ chars: 4_000, maxTokens: 1_000, price: { input: 3, output: 15 } })).toBeCloseTo(0.006 + 0.015)
    expect(estimateUsd({ chars: 1, maxTokens: 1, price: { input: 0, output: 0 } })).toBe(0)
    expect(estimateUsd({ chars: 10, maxTokens: 0, price: { input: 3, output: 15 } })).toBeNaN()
    expect(estimateUsd({ chars: 10, maxTokens: 10, price: { input: Number.NaN, output: 15 } })).toBeNaN()
    expect(parsePrice("3:15")).toEqual({ input: 3, output: 15 })
    expect(parsePrice("0.25:2")).toEqual({ input: 0.25, output: 2 })
    for (const bad of ["3", "3:", ":15", "-1:2", "1e3:2", "3:15:1", "abc"]) expect(parsePrice(bad)).toBeUndefined()
  })
})

describe("admission", () => {
  test("parallel attempts never reserve more than the budget admits", async () => {
    const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
    let inFlight = 0
    let peak = 0
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        await tick()
        const admission = ledger.admit({ case: `case-${index}`, kind: "provider", model: "test/model", estimateUsd: 1 })
        if (!admission.admitted) return admission.reason
        inFlight++
        peak = Math.max(peak, inFlight)
        expect(ledger.summary().committedUsd).toBeLessThanOrEqual(9 + 1e-9)
        await tick()
        inFlight--
        admission.ticket.settle({ costUsd: 1 })
        return "admitted"
      }),
    )
    // $9 admissible at $1 each: nine run, and the other sixteen are refused rather than sharing the remainder.
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(9)
    expect(outcomes.filter((outcome) => outcome === "budget")).toHaveLength(16)
    expect(peak).toBeLessThanOrEqual(9)
    const summary = ledger.close()
    expect(summary.spentUsd).toBeCloseTo(9)
    expect(summary.remainingUsd).toBeCloseTo(0)
    expect(summary.attempts.refused.budget).toBe(16)
  })

  test("capacity freed by a cheap settlement is admitted again, but never twice", async () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const held = Array.from({ length: 4 }, (_, index) => admitted(ledger, { case: `held-${index}`, estimateUsd: 2 }))
    // $8 reserved of $9: a $2 attempt does not fit, a $1 one does.
    expect(ledger.admit({ case: "late", kind: "provider", model: "test/model", estimateUsd: 2 })).toMatchObject({
      admitted: false,
      reason: "budget",
    })
    held[0]!.settle({ costUsd: 0.5 })
    // $0.50 spent and $6 reserved leave $2.50, which two parallel $2 attempts cannot both take.
    const racing = await Promise.all(
      [0, 1].map(async (index) => {
        await tick()
        return ledger.admit({ case: `race-${index}`, kind: "provider", model: "test/model", estimateUsd: 2 }).admitted
      }),
    )
    expect(racing.filter(Boolean)).toHaveLength(1)
  })

  test("every retry of a case needs its own admission inside the case's bound", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const first = admitted(ledger, { case: "fixture#1", estimateUsd: 1.2 })
    first.sent()
    first.settle({ costUsd: 0.9, basis: "reported" })
    // $0.90 spent: a $1.20 retry would take the case to $2.10, over its $2 bound.
    const retry = ledger.admit({ case: "fixture#1", kind: "provider", model: "test/model", estimateUsd: 1.2 })
    expect(retry).toMatchObject({ admitted: false, reason: "case" })
    // Another case is not affected, and a smaller retry fits.
    expect(ledger.admit({ case: "fixture#2", kind: "provider", model: "test/model", estimateUsd: 1.2 }).admitted).toBe(
      true,
    )
    const smaller = admitted(ledger, { case: "fixture#1", estimateUsd: 1 })
    smaller.settle({ costUsd: 0.4 })
    const summary = ledger.summary()
    expect(summary.cases.find((item) => item.case === "fixture#1")).toMatchObject({ admitted: 2, refused: 1 })
    expect(summary.cases.find((item) => item.case === "fixture#1")!.spentUsd).toBeCloseTo(1.3)
    expect(
      ledger.entries.filter((entry) => entry.type === "admit" && entry.case === "fixture#1").map((entry) => entry.type),
    ).toEqual(["admit", "admit"])
  })

  test("judge calls are admitted against the same budget and case as the review they judge", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    admitted(ledger, { case: "fixture#1", estimateUsd: 1.5 }).settle({ costUsd: 1.5 })
    const judge = ledger.admit({ case: "fixture#1", kind: "judge", model: "judge/model", estimateUsd: 1 })
    expect(judge).toMatchObject({ admitted: false, reason: "case" })
    expect(admitted(ledger, { case: "fixture#1", kind: "judge", estimateUsd: 0.5 }).reservedUsd).toBe(0.5)
  })
})

describe("unknown cost", () => {
  test("an attempt that settles with no usage keeps its whole reservation, never zero", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const ticket = admitted(ledger, { case: "fixture#1", estimateUsd: 1.5 })
    ticket.sent()
    expect(ticket.settle()).toEqual({ uncertainUsd: 1.5, overshootUsd: 0, basis: "none" })
    const summary = ledger.summary()
    expect(summary.spentUsd).toBe(0)
    expect(summary.uncertainUsd).toBe(1.5)
    expect(summary.remainingUsd).toBeCloseTo(7.5)
    expect(summary.attempts).toMatchObject({ admitted: 1, settled: 0, uncertain: 1 })
    // The uncertain charge counts against its case too.
    expect(ledger.admit({ case: "fixture#1", kind: "provider", model: "test/model", estimateUsd: 1 })).toMatchObject({
      admitted: false,
      reason: "case",
    })
  })

  test("a model whose price cannot bound an attempt is refused, and nothing further is admitted", () => {
    for (const estimateUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const ledger = Ledger.open({ limits: LIMITS })
      expect(ledger.admit({ case: "a", kind: "provider", model: "unpriced/model", estimateUsd })).toMatchObject({
        admitted: false,
        reason: "unpriced",
      })
      expect(ledger.admit({ case: "b", kind: "provider", model: "priced/model", estimateUsd: 0.1 })).toMatchObject({
        admitted: false,
        reason: "halted",
      })
      expect(ledger.summary().halted).toContain("unpriced/model")
    }
  })

  test("usage that cannot be read keeps the reservation and stops new work", () => {
    for (const usage of [{ costUsd: Number.NaN }, { costUsd: -0.2 }, { costUsd: 0.1, uncertainUsd: Number.NaN }]) {
      const ledger = Ledger.open({ limits: LIMITS })
      const ticket = admitted(ledger, { case: "a", estimateUsd: 1 })
      expect(ticket.settle(usage)).toMatchObject({ uncertainUsd: 1, basis: "invalid" })
      expect(ledger.summary().halted).toContain("could not be read")
      expect(ledger.admit({ case: "b", kind: "provider", model: "test/model", estimateUsd: 0.1 }).admitted).toBe(false)
    }
  })

  test("a settlement with known cost and further uncertain exposure keeps both", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const ticket = admitted(ledger, { case: "replay", estimateUsd: 2 })
    expect(ticket.settle({ costUsd: 0.7, uncertainUsd: 0.3, basis: "replay" })).toEqual({
      costUsd: 0.7,
      uncertainUsd: 0.3,
      overshootUsd: 0,
      basis: "replay",
    })
    expect(ledger.summary()).toMatchObject({ spentUsd: 0.7, uncertainUsd: 0.3 })
  })

  test("an attempt is settled once", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const ticket = admitted(ledger, { case: "a", estimateUsd: 1 })
    ticket.settle({ costUsd: 0.2 })
    expect(() => ticket.settle({ costUsd: 0.2 })).toThrow(LedgerError)
    expect(ledger.summary().spentUsd).toBeCloseTo(0.2)
  })
})

describe("cancellation", () => {
  test("a cancelled run admits nothing new and aborts its signal; attempts in flight still settle", async () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const inFlight = admitted(ledger, { case: "a", estimateUsd: 1 })
    inFlight.sent()
    const queued = admitted(ledger, { case: "b", estimateUsd: 1 })
    const aborted = new Promise<string>((resolve) =>
      ledger.signal.addEventListener("abort", () => resolve(String(ledger.signal.reason))),
    )
    ledger.cancel("interrupted")
    expect(await aborted).toContain("interrupted")
    expect(ledger.admit({ case: "c", kind: "provider", model: "test/model", estimateUsd: 0.1 })).toMatchObject({
      admitted: false,
      reason: "cancelled",
    })
    // Never sent: the reservation comes back. Sent and aborted: kept, since the provider may still bill it.
    expect(queued.release()).toBeUndefined()
    expect(inFlight.release()).toEqual({ uncertainUsd: 1, overshootUsd: 0, basis: "unsettled" })
    const summary = ledger.close()
    expect(summary).toMatchObject({ cancelled: "interrupted", uncertainUsd: 1, outstandingUsd: 0 })
    expect(summary.attempts).toMatchObject({ admitted: 2, released: 1, uncertain: 1, open: 0 })
    expect(summary.attempts.refused.cancelled).toBe(1)
  })

  test("closing with attempts still open keeps their reservations as uncertain", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    admitted(ledger, { case: "a", estimateUsd: 0.6 })
    admitted(ledger, { case: "b", estimateUsd: 0.4 }).sent()
    const summary = ledger.close()
    expect(summary.uncertainUsd).toBeCloseTo(1)
    expect(summary.attempts).toMatchObject({ uncertain: 2, open: 0 })
    expect(() => ledger.admit({ case: "c", kind: "provider", model: "test/model", estimateUsd: 0.1 })).toThrow(
      LedgerError,
    )
  })
})

describe("overshoot", () => {
  test("a cost above its reservation is reported and stops new work", () => {
    const ledger = Ledger.open({ limits: LIMITS })
    const ticket = admitted(ledger, { case: "a", estimateUsd: 0.5 })
    const settlement = ticket.settle({ costUsd: 0.8, basis: "reported" })
    expect(settlement).toMatchObject({ costUsd: 0.8, basis: "reported" })
    expect(settlement.overshootUsd).toBeCloseTo(0.3)
    const summary = ledger.summary()
    expect(summary.overshootUsd).toBeCloseTo(0.3)
    expect(summary.halted).toContain("over its $0.5000 reservation")
    expect(ledger.admit({ case: "b", kind: "provider", model: "test/model", estimateUsd: 0.1 })).toMatchObject({
      admitted: false,
      reason: "halted",
    })
    expect(formatSummary(summary)).toContain("Overshoot: $0.3000")
  })

  test("spend reported beyond the total budget is shown, not hidden", async () => {
    const ledger = Ledger.open({ limits: { totalUsd: 2, caseUsd: 1.8, reserveUsd: 0.2 } })
    const tickets = [
      admitted(ledger, { case: "a", estimateUsd: 0.9 }),
      admitted(ledger, { case: "b", estimateUsd: 0.9 }),
    ]
    await Promise.all(tickets.map(async (ticket) => (await tick(), ticket.settle({ costUsd: 1.5 }))))
    const summary = ledger.close()
    expect(summary.spentUsd).toBeCloseTo(3)
    expect(summary.overshootUsd).toBeCloseTo(1.2)
    expect(summary.overBudgetUsd).toBeCloseTo(1)
    expect(summary.remainingUsd).toBe(0)
    expect(formatSummary(summary)).toContain("Over budget: $1.0000 above the total.")
  })
})

describe("the journal", () => {
  test("successive processes share one budget, and a stopped process's open attempt is counted", () => {
    const journal = join(root, "shared.jsonl")
    const first = Ledger.open({ limits: LIMITS, journal })
    admitted(first, { case: "model-a fixture#1", estimateUsd: 2 }).settle({ costUsd: 1.5 })
    first.close()
    expect(existsSync(`${journal}.lock`)).toBe(false)

    const second = Ledger.open({ limits: LIMITS, journal })
    expect(second.summary().spentUsd).toBeCloseTo(1.5)
    const lost = admitted(second, { case: "model-b fixture#1", estimateUsd: 2 })
    lost.sent()
    // The process is killed here: no settlement, no close, and the lock stays.
    expect(() => Ledger.open({ limits: LIMITS, journal })).toThrow(/in use/)
    expect(Ledger.inspect(journal)).toMatchObject({ spentUsd: 1.5, uncertainUsd: 2, outstandingUsd: 0 })

    rmSync(`${journal}.lock`)
    const third = Ledger.open({ limits: LIMITS, journal })
    const summary = third.summary()
    expect(summary).toMatchObject({ spentUsd: 1.5, uncertainUsd: 2, outstandingUsd: 0 })
    expect(summary.remainingUsd).toBeCloseTo(5.5)
    expect(third.entries.at(-1)).toMatchObject({ type: "settle", seq: lost.seq, basis: "unsettled", uncertainUsd: 2 })
    // A new admission continues the numbering instead of reusing the lost attempt's.
    expect(admitted(third, { case: "model-c fixture#1", estimateUsd: 1 }).seq).toBe(lost.seq + 1)
    third.close()
  })

  test("each admission is written before its ticket is handed out", () => {
    const journal = join(root, "order.jsonl")
    const ledger = Ledger.open({ limits: LIMITS, journal })
    const ticket = admitted(ledger, { case: "a", estimateUsd: 1 })
    const written = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Entry)
    expect(written.map((entry) => entry.type)).toEqual(["open", "admit"])
    expect(written[1]).toMatchObject({ seq: ticket.seq, reservedUsd: 1, case: "a", kind: "provider" })
    ledger.close()
  })

  test("a journal is reopened only with its own limits", () => {
    const journal = join(root, "limits.jsonl")
    Ledger.open({ limits: LIMITS, journal }).close()
    expect(() => Ledger.open({ limits: { ...LIMITS, totalUsd: 20 }, journal })).toThrow(/different limits/)
    expect(existsSync(`${journal}.lock`)).toBe(false)
  })

  test("a cancellation or a stop carries over to the next process", () => {
    const journal = join(root, "stopped.jsonl")
    const first = Ledger.open({ limits: LIMITS, journal })
    admitted(first, { case: "a", estimateUsd: 0.5 }).settle({ costUsd: 0.9 })
    first.close()
    const second = Ledger.open({ limits: LIMITS, journal })
    expect(second.admit({ case: "b", kind: "provider", model: "test/model", estimateUsd: 0.1 })).toMatchObject({
      admitted: false,
      reason: "halted",
    })
    second.cancel("interrupted")
    second.close()
    const third = Ledger.open({ limits: LIMITS, journal })
    expect(third.signal.aborted).toBe(true)
    expect(third.admit({ case: "c", kind: "provider", model: "test/model", estimateUsd: 0.1 })).toMatchObject({
      admitted: false,
      reason: "cancelled",
    })
    third.close()
  })

  test("a line cut off by a killed process is ignored only at the end", () => {
    const journal = join(root, "torn.jsonl")
    const ledger = Ledger.open({ limits: LIMITS, journal })
    admitted(ledger, { case: "a", estimateUsd: 1 }).settle({ costUsd: 0.25 })
    ledger.close()
    writeFileSync(journal, readFileSync(journal, "utf8") + '{"type":"admit","at":"2026-11-03T00:00:00.000Z","se')
    expect(Ledger.inspect(journal).spentUsd).toBeCloseTo(0.25)
    writeFileSync(journal, readFileSync(journal, "utf8") + '\n{"type":"halt","at":"x","reason":"later"}\n')
    expect(() => Ledger.inspect(journal)).toThrow(/not a ledger entry/)
  })
})
