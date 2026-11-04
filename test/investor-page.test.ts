import { expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_REVIEW_CONFIG } from "../packages/core/src/review/types"
import summary from "../docs/benchmarks/vector-efficiency-2026-10/summary.json"
import { brainCopy, brainRelease, publishedDesktopVersion } from "../packages/web/src/data/vector-releases"

const root = path.join(import.meta.dir, "..")
const source = await Bun.file(path.join(root, "packages/web/src/pages/investors.astro")).text()
// The page as it is built: the brain's release labels filled in from the published desktop version.
const page = source.replace(
  /\$?\{brainRelease\.(\w+)\}/g,
  (_, key: string) => brainRelease[key as keyof typeof brainRelease] ?? `{missing ${key}}`,
)
const markup = page.slice(0, page.indexOf("<style"))
const section = (pattern: RegExp) => markup.match(pattern)?.[0] ?? ""
const milestone = (title: string) =>
  section(
    new RegExp(
      `<div class="ip-milestone[^"]*">\\s*<span class="ip-stage[^"]*">[^<]+</span>\\s*<h3>${title}</h3>\\s*<p>[^<]*</p>`,
    ),
  )

// The page quotes one benchmark: the integrated HTTP cells of the checked-in efficiency archive, Vector on the Messages
// API against Claude Code, priced at the same rates.
const cell = (runtime: string, scenario: string, session: number) =>
  summary.cells.find(
    (item) =>
      item.state === "integrated" &&
      item.transport === "http" &&
      item.runtime === runtime &&
      item.scenario === scenario &&
      item.session === session,
  )
// long-loop is left out: at every harness revision in the archive it scripts a read of src/args.ts, which its fixture
// (discipline-single-file-fix, with src/parse-args.ts) does not have, so both agents get an error result for that step.
const scenarios = Array.from(new Set(summary.cells.map((item) => item.scenario))).filter(
  (scenario) =>
    scenario !== "long-loop" &&
    [1, 2].every(
      (session) => cell("vector", scenario, session)?.requests === cell("claude-code", scenario, session)?.requests,
    ),
)
const saving = (scenario: string, session: number) =>
  Math.round(
    (1 - (cell("vector", scenario, session)?.costUsd ?? 0) / (cell("claude-code", scenario, session)?.costUsd ?? 1)) *
      100,
  )
const range = (session: number) => {
  const savings = scenarios.map((scenario) => saving(scenario, session))
  if (Math.min(...savings) === Math.max(...savings)) return `${savings[0]}%`
  return `${Math.min(...savings)}–${Math.max(...savings)}%`
}

test("the one-pager stays one page", () => {
  // Visible words outside the collapsed sources list. The page is read in a couple of minutes; grow it only by
  // cutting something else. The owner added the markets section on 19 October 2026.
  const text = markup
    .slice(markup.indexOf('<div class="ip-page">'))
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ")
  expect(text.split(/\s+/).filter((word) => /\w/.test(word)).length).toBeLessThan(880)
  expect(markup).not.toMatch(/<table/)
})

test("the investor page quotes the efficiency archive's first- and second-session results against Claude Code", () => {
  expect(scenarios).toEqual(["solo-fix", "delegate-explore", "delegate-general"])
  expect(markup).toContain(
    `<strong class="ip-num">${range(1)}</strong><span>less modelled spend than Claude Code in a first session, offline*</span>`,
  )
  expect(markup).toContain(`a second session, run as a new process, came out ${range(2)} lower`)
  // The saving comes from what each agent sends: the archived first request of a new session, rounded to thousands.
  const thousands = (tokens: number) => `${Math.round(tokens / 1000)}K`
  expect(markup).toContain(
    `<strong class="ip-num">${thousands(cell("vector", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)}</strong><span>tokens in Vector's first request, against about ${thousands(cell("claude-code", "solo-fix", 1)?.firstPrimaryInputTokens ?? 0)} for Claude Code, offline*</span>`,
  )
  // Only spend is quoted: the archive's wall time and memory, where Claude Code wins, stay out, and so does Codex.
  expect(markup).not.toMatch(/MiB|peak memory|wall[- ]time|faster|Codex [^,]*cheaper/i)
})

// The footnote dates the runtime it measured rather than naming a commit or where the archive sits in Vector's
// repository: readers of the public page cannot open either.
test("the benchmark footnote keeps its caveats", () => {
  const method = markup.match(/<strong>\* Benchmark method\.<\/strong>([^<]*)<\/p>/)?.[1] ?? ""
  ;[
    "Vector's runtime as of 11 October 2026",
    "Claude Code 2.1.215",
    "identical scripted tool steps against a local fake model server",
    "the same number of model requests",
    "Medians of three repetitions",
    "$3 per million input tokens, $3.75 cache write, $0.30 cache read, $15 output",
    "characters ÷ 4",
    "not the quality of answers",
    "does not show that Vector is cheaper than other agents in general",
  ].forEach((caveat) => expect(method).toContain(caveat))
  expect(markup.slice(markup.indexOf('<div class="ip-page">'))).not.toMatch(
    /docs\/benchmarks|\b(?:commit|revision) [0-9a-f]{7,40}\b/,
  )
})

test("the investor page counts the built-in subagents that ship and describes Vectorscope's verify pass", async () => {
  const agents = (await Bun.file(path.join(root, "packages/engine/src/agent/agent.ts")).text())
    .split(/\n\s+name: "/)
    .slice(1)
  const subagents = agents
    .filter((agent) => agent.includes('mode: "subagent"'))
    .map((agent) => agent.slice(0, agent.indexOf('"')))
  const words = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
  ]
  expect(milestone("Subagent system")).toContain(`${words[subagents.length]} built-in subagents`)
  ;["explore", "migration"].forEach((name) => expect(subagents).toContain(name))
  expect(milestone("Subagent system")).toContain("from explore to migration")
  expect(DEFAULT_REVIEW_CONFIG.verify).toBe("blocking")
  expect(milestone("Vectorscope")).toContain("verify pass that re-checks blocking findings")
})

test("every technology carries its status, and only the shipped ones say Today", () => {
  const items = Array.from(
    markup.matchAll(
      /<div class="ip-milestone[^"]*">\s*<span class="ip-stage[^"]*">([^<]+)<\/span>\s*<h3>([^<]+)<\/h3>/g,
    ),
    (match) => [match[2], match[1]],
  )
  expect(items.length).toBe(markup.match(/<div class="ip-milestone/g)?.length)
  expect(Object.fromEntries(items)).toEqual({
    "Vector Brain": brainRelease.stage,
    "Memory of you in every agent": "In development",
    "Tokenomics engine": "Today",
    "Subagent system": "Today",
    Vectorscope: "Today",
    "Vector Velocity": "Planned",
    "Vector Cloud": "Today · desktop",
    "Vector Codium": "Built in, not on sale",
  })
  // The software factory inside Vector Cloud is a plan, and many more cloud services are an intent.
  expect(milestone("Vector Cloud")).toContain(
    "The software factory, issue to reviewed preview in the cloud, is planned.",
  )
  expect(markup).toContain("many more cloud services of its own (intent)")
  expect(markup).not.toMatch(/next release/i)
})

// The brain ships in desktop 1.99.110, built in this tree, so its card names that release instead of saying it is in
// development: coming in it until the download page offers it, then new in it. The card keeps the owner's description.
test("Vector Brain names desktop 1.99.110 and keeps the owner's description", async () => {
  expect(await Bun.file(path.join(root, "packages/core/src/brain/knowledge.ts")).exists()).toBe(true)
  expect(brainCopy("1.99.109").stage).toBe("Coming in 1.99.110")
  expect(brainCopy("1.99.110").stage).toBe("Desktop 1.99.110")
  expect(source).toContain('<span class="ip-stage">{brainRelease.stage}</span>')
  expect(page).not.toContain("{missing")
  const brain = milestone("Vector Brain")
  expect(brain).toContain(
    Bun.semver.order(publishedDesktopVersion, "1.99.110") < 0 ? "Coming in 1.99.110" : "Desktop 1.99.110",
  )
  expect(brain).not.toContain("In development")
  expect(markup).not.toContain("in development for desktop 1.99.110")
  expect(brain).toContain(
    "A local graph of each repository's rules, decisions, lessons and failures, plus the PDFs and docs a team feeds it, turned from unstructured text into structured knowledge linked to the code.",
  )
  expect(brain).toContain(
    "Offline RAG gives each task only the facts it needs, and the agent adds to the graph as it works.",
  )
})

test("the investor page describes planned Vector Velocity with 550B+ parameters and no performance promise", () => {
  const velocity = milestone("Vector Velocity")
  expect(velocity).toContain("A planned model with 550B+ parameters for Vector's own coding loop")
  expect(velocity).not.toMatch(/significantly less|cheaper|faster|launches? (?:in|on)|release date/i)
  expect(velocity).toContain("No weights or benchmarks yet")
  expect(velocity).not.toMatch(
    /\b(?:built on|based on|base model|fine-tun\w*|distill\w*)\b|\bGPUs?\b|\bcompute\b|credits|Nebius/i,
  )
  expect(markup).not.toMatch(
    /\bactive (?:per token|param\w*)|parameters active|\bactivated\b|under \d+B|\d+B (?:active|per token|for every token)|parameters (?:per|for every) token|total parameters|\d+B total|billion parameters/i,
  )
  expect(new Set(Array.from(markup.matchAll(/(\d+B\+?)(?:-parameter| parameters)/g), (match) => match[1]))).toEqual(new Set(["550B+"]))
  expect(markup).not.toMatch(/Velocity (is|costs|runs) (significantly )?(cheaper|less)/i)
})

// The README may leave Vector Velocity out (the owner keeps it to a line since 24 October 2026); where it names the
// model, it gives the investor page's status and size and no active size.
test("the README gives Vector Velocity the investor page's status and size, and no active size", async () => {
  const text = await Bun.file(path.join(root, "README.md")).text()
  const readme = text.match(/\*\*Vector Velocity\*\*[^\n]*/)?.[0]
  if (readme === undefined) return expect(text).not.toMatch(/Velocity|\d+B-parameter/)
  expect(readme).toContain("**Vector Velocity** (Planned): Vector's own model with 550B+ parameters")
  expect(readme).toContain("there are no weights or benchmarks yet")
  expect(readme).not.toMatch(/active|under \d+B|\d+ billion|total parameters|\d+B total/i)
})

test("the brain is labelled wherever the page opens with it", () => {
  // The lede is what investors read first, so the brain's release sits in it too, not only in its card.
  const label = Bun.semver.order(publishedDesktopVersion, "1.99.110") < 0 ? "coming in" : "from"
  expect(markup).toContain(`Its brain, ${label} desktop 1.99.110, learns about you, your company and each repository`)
  expect(page).toContain(`Its brain is ${brainRelease.kicker} and its own model is in development.`)
  // Every mention of the release on the page is one of the labels, so none says it shipped before it has.
  const built = source.slice(source.indexOf("---", 3), source.indexOf("<style"))
  expect(built.replace(/\$?\{brainRelease\.\w+\}/g, "")).not.toMatch(/1\.99\.110/)
  // Prompts go to the model provider the user picks, so control is described, never claimed as total.
  expect(markup).toContain("The brain lives on your computer, and you choose who runs the model for each request.")
  expect(page).not.toMatch(/controlled only by you|only you control|never leaves your (computer|machine)/i)
})

// The owner's control line and moat (20 October 2026). The line is backed by what the code does: the brain is stored
// on this computer (packages/core/src/brain/database.ts keeps brain.db in Vector's data folder), the model is the one
// the user picks, and the Privacy footnote names the free models that may train on prompts. Memory of you in every
// agent is only begun in this tree: the brain reaches the coding agent and a Thorough request's subagents, desktop
// Vectorscope reviews get none of it yet, and Deep research is not on main, so the card says In development.
test("the investor page says whose prompts and data they are, and labels memory in every agent as in development", async () => {
  expect(await Bun.file(path.join(root, "packages/core/src/brain/database.ts")).text()).toContain(
    "BrainPaths.directory(Global.Path.data)",
  )
  expect(markup).toContain(
    "Your prompts, your data, your Vector. The brain lives on your computer, and you choose who runs the model for each request.",
  )
  expect(markup).toMatch(/free models whose providers may train are labelled May train on your prompts/)
  expect(markup).not.toMatch(/\bfully\b|controlled only by you|your prompts never|never sees? your prompts/i)
  const moat = milestone("Memory of you in every agent")
  expect(moat).toContain('<span class="ip-stage">In development</span>')
  expect(moat).toContain(
    "The moat: coding agents, subagents, Vectorscope reviews and Deep research act on what Vector has learned about you.",
  )
})

// The owner's positioning (19 October 2026), held so that taking the brain branch's older page back fails.
test("the investor page leads with the self-evolving AI agentic harness that builds and ships applications", () => {
  expect(markup).toContain('<h1 id="thesis-title">The self-evolving AI <em>agentic harness</em>.</h1>')
  expect(markup).toContain("<strong>Vector is the neutral harness designed to build and ship applications:</strong>")
  expect(page).toContain(
    "Vector, the self-evolving AI agentic harness: designed to build and ship applications and to learn about you and your company, with your data in your control.",
  )
  expect(markup).toContain(
    "Vector runs three of their agents and its own on any model, so if one door closes the work moves.",
  )
  expect(markup).toContain('Vector plans to earn on <strong class="ip-ink">Codium</strong> credits, then its own model')
  expect(markup).not.toMatch(/a brain that learns each repository it works in|each lab's own CLI/)
})

test("the markets the brain serves are labelled as not yet products, and say what the brain does, not how", () => {
  const markets = section(/<section class="ip-section" aria-labelledby="markets-title">[\s\S]*?<\/section>/)
  expect(markets).toContain("None of these is a separate product or on sale yet.")
  expect(markets.match(/<div class="ip-reason">/g)).toHaveLength(6)
  // How the brain checks documents against code stays off the public page.
  expect(markup).not.toMatch(/\bdrift|mismatch|spec says|datasheet says|code says/i)
})

test("the investor page names the outside agents Vector runs and the business it plans", () => {
  expect(markup).not.toMatch(/every (lab's|vendor's) agent|any vendor's agents/i)
  expect(markup).toContain("its own lean agent beside Claude Code, Codex and Cursor CLI")
  ;["$10", "$50", "$100", "$200"].forEach((price) => expect(markup).toContain(`<b>${price}</b>`))
  expect(markup).not.toMatch(/markup/i)
})

test("the investor page keeps to the owner's wording and disclosure rules", () => {
  expect(markup).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|no matter which model/i)
  expect(markup).not.toMatch(/\bprojects?\b/i)
  // Any privacy line must hold after free models that may train on prompts arrive.
  expect(markup).toContain("Vector itself never trains on prompts or code")
  expect(markup).not.toMatch(/No-training free models|prompts are not used for training/)
  // No contact address, team, traction or raise figures.
  expect(markup).not.toMatch(/mailto:|@vectordev\.ai|\bARR\b|\bMRR\b|pre-money|founder/i)
})
