import { describe, expect, test } from "bun:test"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import {
  buildReviewReceipt,
  reviewReceiptEnvelope,
  serializeReviewReceipt,
  verifyReviewReceiptEnvelope,
  withReviewReceipt,
  RECEIPT_LIMITS,
} from "@vectordevai/core/review/receipt"

const head = "a".repeat(40)
const runID = "review_fixture_1"
const unavailable = { state: "unavailable" as const, reason: "not-recorded" as const }
const observed = <T, const S extends string>(source: S, value: T) => ({
  state: "observed" as const,
  runID,
  head,
  source,
  value,
})
const route = (requestID = "request_1") => ({
  requestID,
  requestKind: "openai-chat",
  provider: "fixture",
  operator: "upstream-not-reported",
  decision: { allowed: true, kind: "standard" },
  sent: true,
  transport: "sync",
  cacheTtls: { state: "observed", value: ["5m", "1h"] },
  store: { state: "observed", value: false },
  zdr: unavailable,
  account: "byok",
  vendorStore: "none",
  upstreamRetention: "not-reported",
})
function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    head,
    base: "b".repeat(40),
    mode: "full",
    durationMs: 1,
    report: { summary: "MODEL_TEXT_MUST_NOT_ENTER_THE_RECEIPT", risk: "low", files: [], findings: [] },
    selection: {
      inline: [],
      outsideDiff: [],
      elsewhere: [],
      nits: [],
      overflow: [],
      stillOpen: [],
      fixed: [],
      dismissed: [],
      reappeared: [],
      raised: [],
      dropped: [],
      risk: "low",
    },
    skipped: [],
    unreviewed: [],
    specialists: [{ name: "review", status: "ok", steps: 1 }],
    sessions: ["fixture_helper"],
    stats: { files: 1, additions: 1, deletions: 1 },
    notes: [],
    ...overrides,
  }
}
const facts = () => ({
  runID,
  head,
  routes: observed("transport-observer", [route()]),
  context: observed("context-collector", [
    { source: "diff", state: "used", paths: ["src/a.ts"] },
    { source: "impact", state: "fallback", paths: [] },
  ]),
  checked: observed("run-observer", [{ kind: "pass", name: "review", status: "completed", files: ["src/a.ts"] }]),
  holdback: observed("holdback-collector", {
    redactions: [{ path: "src/a.ts", diff: 2, head: 1 }],
    ignoredCommitted: ["config/local.example"],
  }),
  suppression: observed("trusted-base-policy", {
    baseProtection: "unavailable",
    root: "not-applied",
    nested: "not-applied",
  }),
})

describe("VS-47 deterministic observation contract", () => {
  test("references outcome lists, computes the real verdict and never copies a model-written report", () => {
    for (const result of [
      outcome(),
      outcome({ partial: "timeout" }),
      outcome({ partial: "privacy" }),
      outcome({ unreviewed: ["src/a.ts"] }),
    ]) {
      const receipt = buildReviewReceipt(facts(), result)
      expect(receipt.verdict).toBe(reviewVerdict({ kind: "outcome", outcome: result }).verdict)
      expect(receipt.references).toEqual(["skipped", "unreviewed", "specialists", "passes"])
      for (const name of receipt.references) expect(Object.hasOwn(receipt, name)).toBe(false)
      expect(serializeReviewReceipt(receipt)).not.toContain(result.report.summary)
      expect(Object.hasOwn(receipt, "band")).toBe(false)
    }
    const first = buildReviewReceipt(facts(), outcome())
    const before = serializeReviewReceipt(first)
    expect(Object.isFrozen(first.references)).toBe(true)
    expect(Reflect.set(first.references, "0", "passes")).toBe(false)
    const second = buildReviewReceipt(facts(), outcome())
    expect(second.references).not.toBe(first.references)
    expect(second.references).toEqual(["skipped", "unreviewed", "specialists", "passes"])
    expect(serializeReviewReceipt(first)).toBe(before)
    expect(serializeReviewReceipt(second)).toBe(before)
  })

  test("off and unset preserve object identity and exact existing JSON without inspecting supplied evidence", () => {
    const result = outcome()
    const before = JSON.stringify(result)
    const unreadable = Object.defineProperty({}, "routes", {
      get: () => {
        throw new Error("Evidence must remain untouched")
      },
    })
    expect(withReviewReceipt(result, undefined, unreadable)).toBe(result)
    expect(withReviewReceipt(result, "off", unreadable)).toBe(result)
    expect(JSON.stringify(result)).toBe(before)
    expect(Object.hasOwn(result, "receipt")).toBe(false)
    const projected = withReviewReceipt(result, "json", facts())
    expect(projected).not.toBe(result)
    expect(Object.hasOwn(projected, "receipt")).toBe(true)
    expect(JSON.stringify(result)).toBe(before)
  })

  test("unavailable observations stay distinct from an actually inspected empty list or false wire flag", () => {
    const absent = buildReviewReceipt(
      {
        runID,
        head,
        routes: unavailable,
        context: unavailable,
        checked: unavailable,
        holdback: unavailable,
        suppression: unavailable,
      },
      outcome(),
    )
    expect(absent.routes).toEqual(unavailable)
    expect(absent.checked).toEqual(unavailable)
    expect(absent.verdict).toBe("clean-complete")
    const inspected = buildReviewReceipt({ ...facts(), routes: observed("transport-observer", []) }, outcome())
    expect(inspected.routes).toMatchObject({ state: "observed", value: [] })
    expect(serializeReviewReceipt(absent)).not.toBe(serializeReviewReceipt(inspected))
    const measured = buildReviewReceipt(facts(), outcome())
    if (measured.routes.state !== "observed") throw new Error("The explicit route facts were not preserved")
    expect(measured.routes.value[0].store).toEqual({ state: "observed", value: false })
    expect(measured.routes.value[0].zdr).toEqual(unavailable)
    expect(measured.routes.value[0].upstreamRetention).toBe("not-reported")
  })

  test("refuses cross-run/head or model-source provenance and completion claims unsupported by the supplied outcome", () => {
    expect(() =>
      buildReviewReceipt({ ...facts(), routes: { ...facts().routes, runID: "other_run" } }, outcome()),
    ).toThrow()
    expect(() =>
      buildReviewReceipt({ ...facts(), context: { ...facts().context, head: "c".repeat(40) } }, outcome()),
    ).toThrow()
    expect(() =>
      buildReviewReceipt({ ...facts(), checked: { ...facts().checked, source: "model-output" } }, outcome()),
    ).toThrow()
    expect(() => buildReviewReceipt(facts(), outcome({ head: "c".repeat(40) }))).toThrow()
    expect(() =>
      buildReviewReceipt(facts(), outcome({ specialists: [{ name: "review", status: "failed", steps: 1 }] })),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          checked: observed("run-observer", [
            { kind: "lens", name: "access", status: "completed", files: ["src/a.ts"] },
          ]),
        },
        outcome(),
      ),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          checked: observed("run-observer", [
            { kind: "strict-rule", name: "S1", status: "completed", files: ["src/a.ts"] },
          ]),
        },
        outcome(),
      ),
    ).toThrow()
  })

  test("does not invent suppression authority, provider storage or a sent request for a refused route", () => {
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          suppression: observed("trusted-base-policy", {
            baseProtection: "unavailable",
            root: "applied",
            nested: "not-applied",
          }),
        },
        outcome(),
      ),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        { ...facts(), routes: observed("transport-observer", [{ ...route(), account: "vector-codium" }]) },
        outcome(),
      ),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        { ...facts(), routes: observed("transport-observer", [{ ...route(), transport: "batch" }]) },
        outcome(),
      ),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          routes: observed("transport-observer", [{ ...route(), decision: { allowed: false, refusal: "batch" } }]),
        },
        outcome(),
      ),
    ).toThrow()
    const receipt = buildReviewReceipt(
      {
        ...facts(),
        routes: observed("transport-observer", [
          {
            ...route(),
            sent: false,
            transport: "not-sent",
            decision: { allowed: false, refusal: "batch" },
            store: unavailable,
            cacheTtls: unavailable,
          },
        ]),
      },
      outcome(),
    )
    expect(receipt.routes).toMatchObject({ state: "observed", value: [{ sent: false, transport: "not-sent" }] })
  })

  test("canonicalizes unordered observation sets without mutating input and rejects duplicate evidence", () => {
    const first = {
      ...facts(),
      routes: observed("transport-observer", [route("request_z"), route("request_A")]),
      checked: observed("run-observer", [
        { kind: "pass", name: "review", status: "completed", files: ["src/z.ts", "src/a.ts"] },
      ]),
    }
    const before = JSON.stringify(first)
    const second = {
      ...first,
      routes: observed("transport-observer", [...first.routes.value].reverse()),
      checked: observed("run-observer", [{ ...first.checked.value[0], files: ["src/a.ts", "src/z.ts"] }]),
    }
    expect(serializeReviewReceipt(buildReviewReceipt(first, outcome()))).toBe(
      serializeReviewReceipt(buildReviewReceipt(second, outcome())),
    )
    expect(JSON.stringify(first)).toBe(before)
    expect(() =>
      buildReviewReceipt({ ...facts(), routes: observed("transport-observer", [route(), route()]) }, outcome()),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        { ...facts(), context: observed("context-collector", [facts().context.value[0], facts().context.value[0]]) },
        outcome(),
      ),
    ).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          checked: observed("run-observer", [{ ...facts().checked.value[0], files: ["src/a.ts", "src/a.ts"] }]),
        },
        outcome(),
      ),
    ).toThrow()
  })

  test("strict bounds refuse unknown fields, malformed paths, oversized evidence and invalid counters instead of clipping", () => {
    expect(() => buildReviewReceipt({ ...facts(), band: "high" }, outcome())).toThrow()
    expect(() => buildReviewReceipt({ ...facts(), summary: "model instruction" }, outcome())).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          routes: observed(
            "transport-observer",
            Array.from({ length: RECEIPT_LIMITS.routes + 1 }, (_, i) => route(`request_${i}`)),
          ),
        },
        outcome(),
      ),
    ).toThrow()
    for (const path of ["../private.ts", "src\\a.ts", "src/\uD800.ts", "/outside.ts"])
      expect(() =>
        buildReviewReceipt(
          { ...facts(), context: observed("context-collector", [{ source: "head", state: "used", paths: [path] }]) },
          outcome(),
        ),
      ).toThrow()
    expect(() =>
      buildReviewReceipt(
        {
          ...facts(),
          holdback: observed("holdback-collector", {
            redactions: [{ path: "src/a.ts", diff: -1, head: 0 }],
            ignoredCommitted: [],
          }),
        },
        outcome(),
      ),
    ).toThrow()
    const context = Array.from({ length: RECEIPT_LIMITS.context }, (_, i) => ({
      source: "head",
      state: "used",
      paths: Array.from({ length: 64 }, (_, j) => `src/${i}/${j}/${"x".repeat(150)}.ts`),
    }))
    expect(() =>
      buildReviewReceipt({ ...facts(), context: observed("context-collector", context) }, outcome()),
    ).toThrow()
  })

  test("checks canonical tampering against a separately retained digest and recomputes verdict/identity on replay", async () => {
    const result = outcome()
    const receipt = buildReviewReceipt(facts(), result)
    const envelope = await reviewReceiptEnvelope(receipt)
    const expected = { runID, head, sha256: envelope.sha256, outcome: result }
    const verified = await verifyReviewReceiptEnvelope(envelope, expected)
    expect(verified).toEqual(receipt)
    if (!verified) throw new Error("The original receipt was not verified")
    expect(Object.isFrozen(verified.references)).toBe(true)
    expect(Reflect.set(verified.references, "0", "passes")).toBe(false)
    expect(
      await verifyReviewReceiptEnvelope(
        { ...envelope, canonical: envelope.canonical.replace('"diff":2', '"diff":3') },
        expected,
      ),
    ).toBeUndefined()
    expect(await verifyReviewReceiptEnvelope(envelope, { ...expected, runID: "other_run" })).toBeUndefined()
    expect(
      await verifyReviewReceiptEnvelope(envelope, { ...expected, outcome: outcome({ partial: "timeout" }) }),
    ).toBeUndefined()
    const falseVerdict = await reviewReceiptEnvelope({ ...receipt, verdict: "blocking" })
    expect(
      await verifyReviewReceiptEnvelope(falseVerdict, { ...expected, sha256: falseVerdict.sha256 }),
    ).toBeUndefined()
    expect(
      await verifyReviewReceiptEnvelope({ ...envelope, canonical: envelope.canonical + " " }, expected),
    ).toBeUndefined()
    const strict: NonNullable<ReviewOutcome["strict"]> = {
      version: 1,
      head,
      complete: true,
      findings: [],
      dropped: [],
      fixUnchecked: 0,
    }
    const strictFacts = {
      ...facts(),
      checked: observed("run-observer", [
        { kind: "strict-rule", name: "S1", status: "completed", files: ["src/a.ts"] },
      ]),
    }
    const current = outcome({ strict })
    const strictReceipt = buildReviewReceipt(strictFacts, current)
    const strictEnvelope = await reviewReceiptEnvelope(strictReceipt)
    expect(
      await verifyReviewReceiptEnvelope(strictEnvelope, {
        runID,
        head,
        sha256: strictEnvelope.sha256,
        outcome: current,
      }),
    ).toEqual(strictReceipt)
    const stale = outcome({ strict: { ...strict, head: "b".repeat(40) } })
    expect(() => buildReviewReceipt(strictFacts, stale)).toThrow()
    expect(
      await verifyReviewReceiptEnvelope(strictEnvelope, { runID, head, sha256: strictEnvelope.sha256, outcome: stale }),
    ).toBeUndefined()
  })

  test("real asynchronous hashing keeps the valid call-time binding when expectations or envelope are later mutated", async () => {
    const receipt = buildReviewReceipt(facts(), outcome())
    const envelope = await reviewReceiptEnvelope(receipt)
    const expected = { runID, head, sha256: envelope.sha256, outcome: outcome() }
    const pending = verifyReviewReceiptEnvelope(envelope, expected)
    expected.runID = "a_later_view"
    expected.head = "c".repeat(40)
    expected.sha256 = `sha256:${"0".repeat(64)}`
    expected.outcome.head = "d".repeat(40)
    expected.outcome.specialists[0].status = "failed"
    envelope.canonical = "{}"
    envelope.sha256 = `sha256:${"f".repeat(64)}`
    expect(await pending).toEqual(receipt)
  })

  test("an invalid call-time binding cannot become valid by retargeting expectations during the hashing race", async () => {
    const receipt = buildReviewReceipt(facts(), outcome())
    const envelope = await reviewReceiptEnvelope(receipt)
    const expected = {
      runID: "a_foreign_run",
      head: "c".repeat(40),
      sha256: envelope.sha256,
      outcome: outcome({ head: "c".repeat(40) }),
    }
    const pending = verifyReviewReceiptEnvelope(envelope, expected)
    expected.runID = runID
    expected.head = head
    expected.outcome = outcome()
    expect(await pending).toBeUndefined()
  })
})
