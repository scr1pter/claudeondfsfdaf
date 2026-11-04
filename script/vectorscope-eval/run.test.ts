import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReviewPrompt } from "../../packages/core/src/review/prompt"
import { REVIEW_REPORT_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import type { Entry } from "./budget"
import { fixtureView, loadFixture, promptInput } from "./fixture"
import { estimateCases, main, promptsFor, requestBodies } from "./run"

// The prompt harness under the budget ledger, with a fake fetch in place of any provider: nothing here opens a
// connection. The fake reads the ledger journal at the moment each request would leave, so the tests can see that
// every request was admitted first.

const root = mkdtempSync(join(tmpdir(), "vectorscope-run-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const FIXTURES = ["audit-log-pagination", "http-retry-refactor"]
const KEY = "test-key-not-a-real-one"
const MODEL = "test/model"
const PRICE = { input: 3, output: 15 }
const MAX_TOKENS = 1000
const report = JSON.stringify({ summary: "Looks fine.", risk: "low", files: [], findings: [] })

let counter = 0
function paths() {
  counter++
  return { ledger: join(root, `ledger-${counter}.jsonl`), out: join(root, `report-${counter}.json`) }
}

function journal(path: string): Entry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry)
}

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown>; entries: Entry[] }

// A provider stand-in. Each answer is a status and a JSON body; `hang` waits until the request is aborted.
function fakeFetch(ledger: string | undefined, answers: ({ status: number; body: unknown } | "hang")[]) {
  const calls: Call[] = []
  const respond = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      entries: ledger ? journal(ledger) : [],
    })
    const answer = answers[calls.length - 1] ?? answers.at(-1)!
    if (answer === "hang")
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason))
      })
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { fetch: respond, calls }
}

const ok = (cost?: number) => ({
  status: 200,
  body: {
    choices: [{ message: { content: report }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3000, completion_tokens: 200, ...(cost === undefined ? {} : { cost }) },
  },
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    deps: { stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text) },
  }
}

async function requestEstimate() {
  const fixtures = await Promise.all(FIXTURES.map(loadFixture))
  return estimateCases(promptsFor(fixtures), {
    model: MODEL,
    price: PRICE,
    maxTokens: MAX_TOKENS,
    repeat: 1,
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  })
}

function budgetArgs(total: number, perCase: number, files: { ledger: string; out: string }) {
  return [
    "--model",
    MODEL,
    "--fixture",
    FIXTURES.join(","),
    "--price",
    `${PRICE.input}:${PRICE.output}`,
    "--max-tokens",
    String(MAX_TOKENS),
    "--budget-usd",
    String(total),
    "--case-budget-usd",
    String(perCase),
    "--ledger",
    files.ledger,
    "--out",
    files.out,
    "--api-key-env",
    "EVAL_TEST_KEY",
  ]
}

describe("without a budget", () => {
  test("nothing is sent: the run is a dry run with an estimate", async () => {
    const fake = fakeFetch(undefined, [ok(0.01)])
    const io = capture()
    const code = await main(
      ["--model", MODEL, "--price", "3:15", "--max-tokens", "1000", "--fixture", FIXTURES.join(",")],
      { ...io.deps, fetch: fake.fetch, env: { OPENROUTER_API_KEY: KEY } },
    )
    expect(code).toBe(0)
    expect(fake.calls).toHaveLength(0)
    const text = io.out.join("")
    expect(text).toContain("Dry run: no requests were sent.")
    expect(text).toContain(`Estimate for ${MODEL}`)
    expect(text).toContain("Nothing is sent without a budget")
  })

  test("--dry-run prints the fixture report alone, as before the budget existed", async () => {
    const io = capture()
    const fake = fakeFetch(undefined, [ok(0.01)])
    expect(
      await main(["--dry-run", "--budget-usd", "5", "--case-budget-usd", "1"], { ...io.deps, fetch: fake.fetch }),
    ).toBe(0)
    const text = io.out.join("")
    expect(fake.calls).toHaveLength(0)
    expect(text.trimEnd().endsWith("Dry run: no requests were sent.")).toBe(true)
    expect(text).not.toContain("Estimate")
  })

  test("a budget without the price, token limit or case bound sends nothing", async () => {
    const fake = fakeFetch(undefined, [ok(0.01)])
    for (const argv of [
      ["--model", MODEL, "--budget-usd", "5", "--case-budget-usd", "1", "--max-tokens", "100"],
      ["--model", MODEL, "--budget-usd", "5", "--case-budget-usd", "1", "--price", "3:15"],
      ["--model", MODEL, "--budget-usd", "5", "--price", "3:15", "--max-tokens", "100"],
      ["--model", MODEL, "--budget-usd", "0", "--case-budget-usd", "1", "--price", "3:15", "--max-tokens", "100"],
      ["--model", MODEL, "--budget-usd", "5", "--case-budget-usd", "9", "--price", "3:15", "--max-tokens", "100"],
      ["--model", MODEL, "--budget-usd", "5", "--case-budget-usd", "1", "--price", "x", "--max-tokens", "100"],
    ]) {
      const io = capture()
      expect(await main(argv, { ...io.deps, fetch: fake.fetch, env: { OPENROUTER_API_KEY: KEY } })).toBe(2)
    }
    const io = capture()
    expect(await main(budgetArgs(5, 1, paths()), { ...io.deps, fetch: fake.fetch, env: {} })).toBe(2)
    expect(io.err.join("")).toContain("Set EVAL_TEST_KEY")
    expect(fake.calls).toHaveLength(0)
  })
})

describe("with a budget", () => {
  test("every request is admitted before it leaves and settles at the reported cost", async () => {
    const files = paths()
    const fake = fakeFetch(files.ledger, [ok(0.012), ok(0.008)])
    const io = capture()
    const code = await main(budgetArgs(5, 1, files), { ...io.deps, fetch: fake.fetch, env: { EVAL_TEST_KEY: KEY } })
    expect(code).toBe(0)
    expect(fake.calls).toHaveLength(2)
    for (const call of fake.calls) {
      // At the moment of sending, the journal's last two entries are this request's admission and its departure.
      const [admit, sent] = call.entries.slice(-2)
      expect(admit).toMatchObject({ type: "admit", kind: "provider", model: MODEL, note: "json_schema" })
      expect(sent).toMatchObject({ type: "sent", seq: admit?.type === "admit" ? admit.seq : -1 })
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    }
    const saved = JSON.parse(readFileSync(files.out, "utf8"))
    expect(saved.budget.spentUsd).toBeCloseTo(0.02)
    expect(saved.budget.uncertainUsd).toBe(0)
    expect(saved.budget.attempts).toMatchObject({ admitted: 2, settled: 2, uncertain: 0 })
    expect(saved.runs.map((run: { status: string }) => run.status)).toEqual(["scored", "scored"])
    // The key never reaches the report or the journal.
    expect(readFileSync(files.out, "utf8")).not.toContain(KEY)
    expect(readFileSync(files.ledger, "utf8")).not.toContain(KEY)
    expect(io.out.join("")).toContain("Spent $0.0200 as reported")
  })

  test("the requests are the ones the harness sent before the budget existed", async () => {
    const files = paths()
    const fake = fakeFetch(files.ledger, [ok(0.01)])
    await main(budgetArgs(5, 1, files), { ...capture().deps, fetch: fake.fetch, env: { EVAL_TEST_KEY: KEY } })
    for (const [index, name] of FIXTURES.entries()) {
      const prompt = buildReviewPrompt(promptInput(fixtureView(await loadFixture(name))))
      const body = fake.calls[index]!.body
      expect(Object.keys(body)).toEqual(["model", "messages", "max_tokens", "usage", "response_format"])
      expect(body.model).toBe(MODEL)
      expect(body.max_tokens).toBe(MAX_TOKENS)
      expect(body.usage).toEqual({ include: true })
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "review", schema: REVIEW_REPORT_JSON_SCHEMA },
      })
      const messages = body.messages as { role: string; content: string }[]
      expect(messages.map((message) => message.role)).toEqual(["system", "user"])
      expect(messages[0]!.content).toStartWith("This is an offline evaluation run of a code review prompt.")
      expect(messages[1]!.content).toBe(prompt)
      expect(body).toEqual(
        requestBodies(prompt, {
          model: MODEL,
          maxTokens: MAX_TOKENS,
          baseUrl: "https://openrouter.ai/api/v1/chat/completions",
        }).structured as unknown as Record<string, unknown>,
      )
    }
  })

  test("a provider that rejects the JSON schema is asked again only after a second admission", async () => {
    const files = paths()
    const rejected = { status: 400, body: { error: { message: "response_format json_schema is not supported" } } }
    const fake = fakeFetch(files.ledger, [rejected, ok(0.005), ok(0.005)])
    const code = await main(budgetArgs(5, 1, files), {
      ...capture().deps,
      fetch: fake.fetch,
      env: { EVAL_TEST_KEY: KEY },
    })
    expect(code).toBe(0)
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[1]!.body.response_format).toBeUndefined()
    expect(fake.calls[1]!.entries.at(-2)).toMatchObject({ type: "admit", note: "text retry" })
    const entries = journal(files.ledger)
    const first = entries.find((entry) => entry.type === "admit")!
    // The rejected request reported no usage, so its whole reservation stays as uncertain spend.
    const settled = entries.find((entry) => entry.type === "settle" && entry.seq === (first as { seq: number }).seq)
    expect(settled).toMatchObject({ basis: "none", uncertainUsd: (first as { reservedUsd: number }).reservedUsd })
  })

  test("what the budget cannot cover is not sent, and is reported as not sent", async () => {
    const estimate = await requestEstimate()
    const request = Math.max(...estimate.fixtures.map((item) => item.requestUsd))
    // Room for one request and not two; the first reports no usage, so its reservation is not given back.
    const total = (request * 1.5) / 0.9
    const files = paths()
    const fake = fakeFetch(files.ledger, [{ status: 200, body: { choices: [{ message: { content: report } }] } }])
    const io = capture()
    const code = await main(budgetArgs(total, request * 1.2, files), {
      ...io.deps,
      fetch: fake.fetch,
      env: { EVAL_TEST_KEY: KEY },
    })
    expect(code).toBe(1)
    expect(fake.calls).toHaveLength(1)
    const saved = JSON.parse(readFileSync(files.out, "utf8"))
    expect(saved.runs.map((run: { status: string }) => run.status)).toEqual(["scored", "not-sent"])
    expect(saved.runs[1].reason).toBe("budget")
    expect(saved.budget.uncertainUsd).toBeGreaterThan(0)
    expect(saved.budget.spentUsd).toBe(0)
    expect(io.out.join("")).toContain("1 not sent within the budget")
  })

  test("a retry the case's bound cannot cover is not sent", async () => {
    const estimate = await requestEstimate()
    const request = Math.max(...estimate.fixtures.map((item) => item.requestUsd))
    const files = paths()
    const rejected = { status: 422, body: { error: { message: "structured output is not supported" } } }
    const fake = fakeFetch(files.ledger, [rejected])
    const code = await main(budgetArgs(5, request * 1.5, files), {
      ...capture().deps,
      fetch: fake.fetch,
      env: { EVAL_TEST_KEY: KEY },
    })
    expect(code).toBe(1)
    // Each fixture's schema request went out; neither retry did.
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.every((call) => call.body.response_format !== undefined)).toBe(true)
    const saved = JSON.parse(readFileSync(files.out, "utf8"))
    expect(saved.runs.map((run: { status: string }) => run.status)).toEqual(["error", "error"])
    expect(saved.runs[0].detail).toContain("the request without it was not sent")
    expect(saved.budget.attempts.refused.case).toBe(2)
  })

  test("an interrupted run aborts the request in flight, keeps its reservation and sends nothing more", async () => {
    const files = paths()
    const fake = fakeFetch(files.ledger, ["hang"])
    const io = capture()
    const listeners = process.listenerCount("SIGINT")
    const running = main(budgetArgs(5, 1, files), { ...io.deps, fetch: fake.fetch, env: { EVAL_TEST_KEY: KEY } })
    while (fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    process.emit("SIGINT", "SIGINT")
    expect(await running).toBe(1)
    expect(fake.calls).toHaveLength(1)
    const saved = JSON.parse(readFileSync(files.out, "utf8"))
    expect(saved.budget.cancelled).toBe("interrupted")
    expect(saved.budget.uncertainUsd).toBeGreaterThan(0)
    expect(saved.runs.map((run: { status: string }) => run.status)).toEqual(["error", "not-sent"])
    expect(saved.runs[1].reason).toBe("cancelled")
    expect(process.listenerCount("SIGINT")).toBe(listeners)
  })

  test("successive runs with one journal share one budget", async () => {
    const files = paths()
    const estimate = await requestEstimate()
    const request = Math.max(...estimate.fixtures.map((item) => item.requestUsd))
    // Room for three requests with no usage reported: the first run takes two, the second run gets one.
    const total = (request * 3.5) / 0.9
    const silent = { status: 200, body: { choices: [{ message: { content: report } }] } }
    const first = fakeFetch(files.ledger, [silent])
    await main(budgetArgs(total, request * 1.5, files), {
      ...capture().deps,
      fetch: first.fetch,
      env: { EVAL_TEST_KEY: KEY },
    })
    const second = fakeFetch(files.ledger, [silent])
    const out = join(root, `second-${counter}.json`)
    const code = await main(
      budgetArgs(total, request * 1.5, { ledger: files.ledger, out }).map((arg) => arg.replace(MODEL, "test/other")),
      {
        ...capture().deps,
        fetch: second.fetch,
        env: { EVAL_TEST_KEY: KEY },
      },
    )
    expect(first.calls).toHaveLength(2)
    expect(second.calls).toHaveLength(1)
    expect(code).toBe(1)
    const saved = JSON.parse(readFileSync(out, "utf8"))
    expect(saved.budget.attempts.admitted).toBe(3)
    expect(saved.runs.map((run: { status: string }) => run.status)).toEqual(["scored", "not-sent"])
  })
})
