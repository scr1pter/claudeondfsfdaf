import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { Call } from "../compounding/model-server"
import { decide } from "../compounding/policy"
import { TASKS, startOf } from "../compounding/tasks"
import { SAFETY, required } from "./contracts"
import { decideByClauses, dropped } from "./policy"
import { HARNESS_BASE, REPO_ROOT } from "./variants"

// Requests built by hand, as compounding/policy.test.ts builds them, with the harness's provider prompt as the system
// prompt: once as shipped and once without the sentences that state its verification clauses.

const DIR = "/nonexistent/ledger"
const FULL = await Bun.file(join(REPO_ROOT, HARNESS_BASE)).text()
const UNVERIFIED = SAFETY.filter((item) => item.source === HARNESS_BASE && item.clause.startsWith("verify.")).reduce(
  (text, item) => text.replace(item.sentence, ""),
  FULL,
)
const clauses = required(HARNESS_BASE)
const index = TASKS.findIndex((task) => task.id === "t01-slugify")
const task = TASKS[index]!
const start = startOf(index).files

type Turn = { call: Extract<Call, { name: string }>; result: string }

function request(system: string, turns: readonly Turn[]) {
  return {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: system }],
    tools: [{ name: "bash" }, { name: "read" }, { name: "edit" }, { name: "write" }],
    messages: [
      { role: "user", content: [{ type: "text", text: task.prompt }] },
      ...turns.flatMap((turn, at) => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `toolu_${at + 1}`, name: turn.call.name, input: turn.call.input }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${at + 1}`, content: turn.result }] },
      ]),
    ],
  }
}

// Plays the task to its answer, each call answered by `result`, and returns the calls with the answer last.
function play(
  system: string,
  result: (call: Turn["call"], turns: readonly Turn[]) => string,
  choose = decideByClauses,
) {
  const turns: Turn[] = []
  for (const _ of Array.from({ length: 30 })) {
    const call = choose(task, start, request(system, turns), { dir: DIR, clauses })
    if (!("name" in call)) return { turns, answer: call.text }
    turns.push({ call, result: result(call, turns) })
  }
  throw new Error("never answered")
}

const commands = (turns: readonly Turn[]) =>
  turns.flatMap((turn) => (turn.call.name === "bash" ? [String(turn.call.input.command)] : []))
// The check fails once on a stale route table, as it does in the repository, then passes.
const stale = (call: Turn["call"], turns: readonly Turn[]) =>
  call.input.command === "pnpm run check" && !commands(turns).includes("pnpm run check")
    ? "src/generated/routes.gen.ts is stale\nCommand exited with code 1"
    : "ok"

describe("the clause-aware scripted model", () => {
  test("drops verification only when the system prompt lost a verification clause", () => {
    expect(dropped(request(FULL, []), clauses)).toEqual(new Set())
    expect(dropped(request(UNVERIFIED, []), clauses)).toEqual(new Set(["verify"]))
    // The task's own prompt does not count: only the system prompt states clauses.
    expect(dropped({ ...request(UNVERIFIED, []), messages: [{ role: "user", content: FULL }] }, clauses)).toEqual(
      new Set(["verify"]),
    )
  })

  test("drops verification when the system prompt turns the verification policy around, keeping its words", () => {
    const loop = SAFETY.find((item) => item.source === HARNESS_BASE && item.clause === "verify.loop")!.sentence
    const negated = FULL.replace(loop, "Do not verify the changes; skip the tests.")
    expect(dropped(request(negated, []), clauses)).toEqual(new Set(["verify"]))
    expect(commands(play(negated, stale).turns)).toEqual(["pnpm add tiny-slug"])
  })

  test("with every clause it plays the scripted model's calls exactly", () => {
    const shipped = play(FULL, stale)
    expect(play(FULL, stale, (...args) => decide(...args))).toEqual(shipped)
    expect(commands(shipped.turns)).toEqual([
      "pnpm add tiny-slug",
      "pnpm test",
      "pnpm run check",
      "pnpm gen",
      "pnpm run check",
    ])
  })

  test("without its verification clauses it never runs a check, so it never sees the failure or recovers", () => {
    const shipped = play(FULL, stale)
    const unverified = play(UNVERIFIED, stale)
    expect(commands(unverified.turns)).toEqual(["pnpm add tiny-slug"])
    expect(unverified.turns.map((turn) => turn.call)).toEqual(
      shipped.turns
        .map((turn) => turn.call)
        .filter((call) => call.name !== "bash" || call.input.command === "pnpm add tiny-slug"),
    )
    expect(unverified.answer).toStartWith("Done")
  })

  test("is a pure function of the request: the same request gets the same call", () => {
    const turns = play(UNVERIFIED, () => "ok").turns.slice(0, 2)
    const body = request(UNVERIFIED, turns)
    const call = decideByClauses(task, start, body, { dir: DIR, clauses })
    expect(decideByClauses(task, start, structuredClone(body), { dir: DIR, clauses })).toEqual(call)
    expect(body).toEqual(request(UNVERIFIED, turns))
  })
})
