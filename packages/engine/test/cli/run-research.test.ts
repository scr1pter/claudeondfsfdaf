// `vector run --research` (section 5.1): the research agent runs the message, the plan prints in full, each step of the
// run streams as a line, researchers' steps included, and --report writes the report with its sources to a Markdown
// file. --research is the user's consent to read public pages for its run; every other approval still needs --auto.
// --depth is the request's size, and --search and --scope hold the run to what the command line says, whatever the
// model plans. Subprocess tests against the fake LLM server and the fake web on this computer; nothing else is reached.
import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { RETIRED_SEARCH_NOTICE, runPermissionReply } from "../../src/cli/cmd/run"
import { cliIt } from "../lib/cli-process"
import { FakeWeb } from "../../../core/test/lib/fake-web"

// The fake web, which the CLI reads in strict mode: its names are pinned to this computer and read as public there,
// and any other connection off this computer is refused.
const web = FakeWeb.start({ sites: FakeWeb.sites() })
afterAll(() => web.close())
const strict = { [EgressGuard.ENVIRONMENT.strict]: "strict", [EgressGuard.ENVIRONMENT.names]: FakeWeb.DOMAIN }

const PLAN = {
  question: "How much do heat pumps cut heating bills in cold climates?",
  subquestions: ["What did field studies measure?", "How large were the savings?"],
  // The model asks for the web; --scope brain holds the run to the brain and files.
  scope: "web",
  depth: "focused",
}

test("--research answers the run's read approval, and nothing else without --auto", () => {
  expect(runPermissionReply(false, "research_read", [], undefined, true)).toBe("once")
  expect(runPermissionReply(false, "private_network", ["http://127.0.0.1:9"], undefined, true)).toBe("reject")
  expect(runPermissionReply(false, "bash", ["*"], undefined, true)).toBe("reject")
  expect(runPermissionReply(false, "research_read", [])).toBe("reject")
  // An ask that asks every time is never answered for the user, --research or not.
  expect(
    runPermissionReply(false, "research_read", [], [`${PermissionPolicy.AFTER_WEB}https://example.com/`], true),
  ).toBe("reject")
})

describe("vector run --research", () => {
  for (const format of ["docx", "pdf"] as const)
    cliIt.concurrent(
      `writes a binary ${format} research report chosen by the file extension`,
      ({ home, llm, vector }) =>
        Effect.gen(function* () {
          const file = path.join(home, "out", `research.${format}`)
          yield* llm.tool("research_plan", PLAN)
          yield* llm.tool("research_report", {
            title: "Heat pump evidence review",
            answer: "The brain has no evidence for this question, so no measured result could be checked.",
            sections: [],
            open_questions: ["What do field studies measure?"],
          })
          yield* llm.text("The report identifies the missing evidence.")
          const result = yield* vector.run("Research heat pump savings", {
            extraArgs: ["--research", "--depth", "focused", "--scope", "brain", "--search", "none", "--report", file],
          })
          vector.expectExit(result, 0)
          const bytes = yield* Effect.promise(() => Bun.file(file).arrayBuffer())
          expect(new TextDecoder().decode(new Uint8Array(bytes).slice(0, format === "docx" ? 2 : 5))).toBe(
            format === "docx" ? "PK" : "%PDF-",
          )
          expect(result.stderr).toContain("Report written to")
        }),
      90_000,
    )

  cliIt.concurrent(
    "reads the pages the message names, streams a researcher's steps and writes the report",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const file = path.join(home, "out", "heat-pumps.md")
        const article = web.url("article", "/")
        const before = web.count("article", "/")
        yield* llm.tool("research_plan", { ...PLAN, subquestions: ["What did field studies measure?"] })
        yield* llm.tool("task", {
          description: "Field studies",
          prompt: "What did field studies measure?",
          subagent_type: "researcher",
          background: false,
        })
        // The researcher reads the page the user typed and saves what it says.
        yield* llm.tool("research_read", { url: article })
        yield* llm.tool("research_note", {
          subquestion: "What did field studies measure?",
          claim: "The study followed 412 homes through two winters",
          source: "S1",
          quote: "The study followed 412 homes through two winters.",
        })
        yield* llm.text("The study followed 412 homes. Notes: N1.")
        yield* llm.tool("research_report", {
          title: "Heat pump savings in cold climates",
          answer: "A field study followed 412 homes through two winters [N1].",
          sections: [],
          open_questions: ["How large were the savings?"],
        })
        yield* llm.text("A field study followed 412 homes [N1].")
        const result = yield* vector.run(`Research how much heat pumps save in cold climates: ${article}`, {
          extraArgs: ["--research", "--depth", "focused", "--search", "none", "--report", file],
          env: strict,
        })
        vector.expectExit(result, 0)
        // Nothing was rejected: --research approved the run's reads.
        expect(result.stderr).not.toContain("auto-rejecting")
        expect(web.count("article", "/")).toBeGreaterThan(before)
        // The researcher's steps stream under the lead's.
        expect(result.stderr).toContain("researcher · S1: ")
        expect(result.stderr).toContain("researcher · N1: The study followed 412 homes")
        expect(result.stderr).toContain("Report: Heat pump savings in cold climates")
        expect(result.stdout).toBe("A field study followed 412 homes [N1].\n")
        const written = yield* Effect.promise(() => Bun.file(file).text())
        expect(written).toContain("The study followed 412 homes through two winters.")
        expect(written).toContain(article)
      }),
    90_000,
  )

  cliIt.concurrent(
    "prints the plan, streams the run and writes the report to --report",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const file = path.join(home, "out", "heat-pumps.md")
        yield* llm.tool("research_plan", PLAN)
        yield* llm.tool("research_search", { query: "heat pump field study savings" })
        yield* llm.tool("research_report", {
          title: "Heat pump savings in cold climates",
          answer: "This repository's brain holds nothing on heat pump savings, so no claim could be checked.",
          sections: [],
          open_questions: ["What do field studies of cold climates find?"],
        })
        yield* llm.text("The brain had nothing on heat pumps.")
        const result = yield* vector.run("Research how much heat pumps save in cold climates", {
          extraArgs: ["--research", "--depth", "focused", "--scope", "brain", "--search", "none", "--report", file],
        })
        vector.expectExit(result, 0)
        // The plan in full, then each step, on stderr; the answer alone on stdout.
        expect(result.stderr).toContain("Research plan")
        expect(result.stderr).toContain("focused · brain")
        expect(result.stderr).toContain(PLAN.question)
        expect(result.stderr).toContain("1. What did field studies measure?")
        expect(result.stderr).toContain("2. How large were the savings?")
        expect(result.stderr).toContain("Not searched")
        expect(result.stderr).toContain("Report: Heat pump savings in cold climates")
        expect(result.stderr).toContain(`Report written to ${file}`)
        expect(result.stdout).toBe("The brain had nothing on heat pumps.\n")
        const written = yield* Effect.promise(() => Bun.file(file).text())
        expect(written).toContain("Heat pump savings in cold climates")
        expect(written).toContain("What do field studies of cold climates find?")
        // The research lead ran it, told what the command line chose.
        const [first] = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
        expect(first).toContain("You are Vector's Deep research lead")
        expect(first).toContain(
          "Research settings for this run, from the command line: scope this repository's brain and files only; no web search.",
        )
      }),
    90_000,
  )

  cliIt.concurrent(
    "--depth deep runs a Thorough request, so the plan no one can answer goes deep",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.tool("research_plan", PLAN)
        yield* llm.text("Planned.")
        const result = yield* vector.run("Research how much heat pumps save", {
          extraArgs: ["--research", "--depth", "deep", "--scope", "brain"],
        })
        vector.expectExit(result, 0)
        expect(result.stderr).toContain("deep · brain")
      }),
    90_000,
  )

  cliIt.concurrent(
    "a search service an earlier version's --search named is ignored, once, with a notice; another name is refused",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.tool("research_plan", PLAN)
        yield* llm.text("Planned.")
        const result = yield* vector.run("Research how much heat pumps save", {
          extraArgs: ["--research", "--depth", "focused", "--scope", "brain", "--search", "exa"],
        })
        vector.expectExit(result, 0)
        expect(result.stderr.split(`--search exa is ignored: ${RETIRED_SEARCH_NOTICE}`)).toHaveLength(2)
        // It reads as the default, the research browser.
        const [first] = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
        expect(first).toContain("search the web in the research browser")
        const unknown = yield* vector.run("Research heat pumps", { extraArgs: ["--research", "--search", "bing"] })
        vector.expectExit(unknown, 1)
        expect(unknown.stderr).toContain("Invalid values")
      }),
    90_000,
  )

  cliIt.concurrent(
    "the research options need --research, and --research runs the research agent alone",
    ({ vector }) =>
      Effect.gen(function* () {
        const alone = yield* vector.run("Research heat pumps", { extraArgs: ["--depth", "deep"] })
        vector.expectExit(alone, 1)
        expect(alone.stderr).toContain("--depth, --search, --scope and --report need --research")
        const agent = yield* vector.run("Research heat pumps", { agent: "build", extraArgs: ["--research"] })
        vector.expectExit(agent, 1)
        expect(agent.stderr).toContain("--research runs the research agent")
        const sized = yield* vector.run("Research heat pumps", {
          extraArgs: ["--research", "--depth", "deep", "--size", "standard"],
        })
        vector.expectExit(sized, 1)
        expect(sized.stderr).toContain("--depth and --size cannot be used together")
      }),
    90_000,
  )
})
