import { expect, test } from "bun:test"
import path from "node:path"
import { WorkflowLimits } from "@vectordevai/core/orchestration/limits"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { crew, faqs, spendRows, subagentKinds } from "../src/data/docs-content"
import { docsNav } from "../src/data/docs-nav"
import { release113 } from "../src/data/vector-releases"

// The docs for what the multi-agent parity build brings to desktop 1.99.113 (WP40a of
// docs/vector/build/multiagent-parity-spec.md). Every paragraph about it says the release is coming until the
// download page offers it, the numbers are the engine's own, and the owner notes name every work package.
const repo = path.join(import.meta.dir, "../../..")
const read = (file: string) => Bun.file(path.join(repo, file)).text()
const fold = (text: string) => text.replace(/\s+/g, " ")
// Without markup, as readers see it; a tag leaves no space, so "<code>vector run</code>," reads "vector run,".
const plain = (text: string) => fold(text.replace(/<[^>]+>/g, "")).trim()

const LISTED = [
  "subagents",
  "workflows",
  "desktop-app",
  "terminal-agent",
  "parallel-agents",
  "tokenomics",
  "models",
  "permissions",
  "checkpoints",
  "sdk",
] as const
type Page = (typeof LISTED)[number]
const pages = Object.fromEntries(
  await Promise.all(
    LISTED.map(async (name) => [name, fold(await read(`packages/web/src/pages/docs/${name}.astro`))] as const),
  ),
) as Record<Page, string>

const LABEL = "{release113.since}"
// The contract's list of what a 1.99.113 multi-agent paragraph talks about.
const FEATURE =
  /subagent limit|spend ceiling|budget\.subagents|per_request|Stop including helpers|ask_timeout|Move to background|task_manage report|siblings: ?true|Interrupted helpers|\bfork\b|output_schema|isolation: "worktree"|worktree|workflow run|budget\.workflow|background command|ordinary requests? (can|may) (hand|delegate)/i

// Paragraphs that shipped before 1.99.113 and match the list for older features: the worktrees of agent workspaces
// and the session --fork flag. They keep their text, unlabelled; each must still be on its page, once.
const SHIPPED: readonly [Page, string, string][] = [
  ["subagents", "Subagents are not agent workspaces.", "an agent workspace's own worktree"],
  ["terminal-agent", "It takes the same session flags as run", "the session --fork flag"],
  ["terminal-agent", "vector run sends one prompt and prints the result", "the session --fork flag"],
  ["parallel-agents", "Run separate lines of work as separate agents", "an agent workspace's own worktree"],
  ["parallel-agents", "An isolated agent gets a Git worktree on its own branch", "an agent workspace's own worktree"],
  ["permissions", "From desktop 1.99.108, a repository's own vector.json", "an agent workspace's own worktree"],
]

// Each paragraph or row of a page, as its source writes it. A command sample (doc-cmd) is not a paragraph.
const blocks = (page: string) =>
  [...page.matchAll(/<(p|dd)\b([^>]*)>(.*?)<\/\1>/g)]
    .filter((match) => !match[2]!.includes("doc-cmd"))
    .map((match) => match[3]!.trim())

// A section as readers see it: from its heading to the next heading of the same level.
function section(page: string, id: string, level = "h2") {
  const start = page.indexOf(`<${level} id="${id}">`)
  expect([id, start]).not.toEqual([id, -1])
  const end = page.indexOf(`<${level}`, start + 1)
  return page.slice(start, end === -1 ? undefined : end)
}

// A number constant as its engine source writes it, for modules this package does not depend on.
function constant(source: string, name: string) {
  const found = new RegExp(`export const ${name} = ([\\d_ *]+)\\n`).exec(source)
  if (!found) throw new Error(`${name} is not a number constant in its file`)
  return found[1]!
    .replaceAll("_", "")
    .split("*")
    .reduce((product, factor) => product * Number(factor.trim()), 1)
}

const limitsSource = await read("packages/engine/src/task/limits.ts")
const guestMatch =
  /export const GUEST = \{ running: (\d+), perRequest: (\d+), budget: \{ usd: (\d+) \} \} as const/.exec(limitsSource)
const DEFAULTS = ConfigV1.SubagentDefaults
const GUEST = { running: Number(guestMatch?.[1]), perRequest: Number(guestMatch?.[2]), usd: Number(guestMatch?.[3]) }
const notes = fold(await read("docs/vector/owner-actions/release-199113.md"))
const contract = await read("docs/vector/build/multiagent-parity-spec.md")

test("every paragraph about the multi-agent features starts with the release label", () => {
  for (const [name, phrase] of SHIPPED)
    expect([name, phrase, blocks(pages[name]).filter((block) => plain(block).includes(phrase)).length]).toEqual([
      name,
      phrase,
      1,
    ])
  const about = LISTED.flatMap((name) =>
    blocks(pages[name])
      .filter((block) => FEATURE.test(plain(block)))
      .filter((block) => !SHIPPED.some(([page, phrase]) => page === name && plain(block).includes(phrase)))
      .map((block) => [name, block.startsWith(LABEL), plain(block).slice(0, 90)] as const),
  )
  expect(about.length).toBeGreaterThan(40)
  expect(about.filter(([, labelled]) => !labelled)).toEqual([])
  // The workflows page is new, so every paragraph on it is.
  expect(blocks(pages.workflows).filter((block) => !block.startsWith(LABEL))).toEqual([])
  for (const name of LISTED)
    expect([
      name,
      /import \{[^}]*\brelease113\b[^}]*\} from "\.\.\/\.\.\/data\/vector-releases"/.test(pages[name]),
    ]).toEqual([name, true])
})

test("the workflows page is under Agents, and both blurbs carry the label", () => {
  const agents = docsNav.find((group) => group.label === "Agents")?.links ?? []
  const ids = agents.map((link) => link.id)
  expect(ids.indexOf("workflows")).toBe(ids.indexOf("subagents") + 1)
  for (const id of ["subagents", "workflows"])
    expect(agents.find((link) => link.id === id)?.blurb).toContain(release113.since)
  expect(agents.find((link) => link.id === "workflows")?.blurb.startsWith(release113.since)).toBe(true)
})

test("the subagent numbers on the pages are the engine's limits", async () => {
  // TaskLimits.DEFAULTS is the config's SubagentDefaults; GUEST and the ranges are the engine's own.
  expect(limitsSource).toContain("running: ConfigV1.SubagentDefaults.running,")
  expect(limitsSource).toContain("perRequest: ConfigV1.SubagentDefaults.per_request,")
  expect(limitsSource).toContain("budget: { usd: ConfigV1.SubagentDefaults.usd },")
  expect(guestMatch).not.toBeNull()
  const subagents = plain(section(pages.subagents, "limits"))
  expect(subagents).toContain(`at most ${DEFAULTS.running} subagents run at once in a conversation`)
  expect(subagents).toContain(`One request may start at most ${DEFAULTS.per_request} new subagents`)
  expect(subagents).toContain(`a $${DEFAULTS.usd} spend ceiling at catalog prices`)
  expect(subagents).toContain(
    `guests in a shared workspace get at most ${GUEST.running} running, ${GUEST.perRequest} per request and $${GUEST.usd}`,
  )
  expect(subagents).toContain(`each run up to ${DEFAULTS.running} at once`)
  expect(subagents).toContain(
    `running takes 1 to ${constant(limitsSource, "MAX_RUNNING")} and per_request 1 to ${constant(limitsSource, "MAX_PER_REQUEST")}`,
  )
  const line = `5 of ${DEFAULTS.running} running · 2 waiting · 12 of ${DEFAULTS.per_request} started this request · $3.10 of $${DEFAULTS.usd}.00 subagent spend`
  expect(subagents).toContain(line)
  expect(constant(limitsSource, "BUSY")).toBe(6)
  expect(plain(pages.subagents)).toContain("past six subagents running or waiting in a conversation")
  expect(plain(section(pages["parallel-agents"], "isolated-subagents"))).toContain(
    `${DEFAULTS.running} running at once, ${DEFAULTS.per_request} per request and one $${DEFAULTS.usd} spend ceiling`,
  )
  expect(plain(pages.tokenomics)).toContain(
    `$${DEFAULTS.usd} at catalog prices by default and $${GUEST.usd} for guests`,
  )
  expect(plain(pages["terminal-agent"])).toContain(
    `5 of ${DEFAULTS.running} running · 12 of ${DEFAULTS.per_request} started this request · $3.10 of $${DEFAULTS.usd}.00 subagent spend`,
  )

  const window = await read("packages/engine/src/task/note-window.ts")
  const quiet = constant(window, "QUIET") / 1000
  const hold = constant(window, "HOLD") / 1000
  expect(plain(pages.subagents)).toContain(`after ${quiet} seconds of quiet, held at most ${hold} seconds`)

  const attention = await read("packages/engine/src/task/attention.ts")
  expect(plain(pages.subagents)).toContain(
    `one quiet note per helper at most every ${constant(attention, "NOTE_EVERY") / 60_000} minutes`,
  )

  const shells = await read("packages/engine/src/task/shells.ts")
  const commands = plain(section(pages.subagents, "background-commands"))
  expect(commands).toContain(`at most ${constant(shells, "LIMIT")} run at once in a conversation`)
  expect(commands).toContain(`at most ${constant(shells, "MAX_TIMEOUT") / 3_600_000} hours`)
  expect(commands).toContain(`${constant(shells, "LOG_LIMIT") / 1024 / 1024} MiB`)

  const isolation = await read("packages/engine/src/task/isolation.ts")
  const kept = /sizing\?\.subagents\?\.isolation\?\.max_kept \?\? (\d+)/.exec(isolation)?.[1]
  expect(kept).toBeDefined()
  expect(plain(section(pages.subagents, "worktrees"))).toContain(
    `while ${kept} changed worktrees already wait for review`,
  )
})

test("the workflow numbers on the pages are WorkflowLimits", async () => {
  const defaults = WorkflowLimits.resolve({}, {}, 18)
  const perAgent = ConfigV1.WorkflowDefaults.steps_per_agent
  expect(defaults.steps).toBe(defaults.maxAgents * perAgent)
  const limits = plain(section(pages.workflows, "limits"))
  expect(limits).toContain(`by default a run starts at most ${WorkflowLimits.DEFAULTS.max_agents} agents`)
  expect(limits).toContain(`runs up to ${WorkflowLimits.DEFAULTS.concurrency} at once`)
  expect(limits).toContain(
    `takes ${perAgent} model steps per agent in all (${defaults.steps.toLocaleString("en-US")} for ${defaults.maxAgents} agents)`,
  )
  expect(limits).toContain(`${WorkflowLimits.DEFAULTS.per_agent_steps} steps for any one agent`)
  expect(limits).toContain(`and ${WorkflowLimits.DEFAULTS.minutes} minutes`)
  expect(WorkflowLimits.DEFAULTS.runs).toBe(1)
  expect(limits).toContain("One run works at a time in a conversation.")
  expect(limits).toContain(`$${DEFAULTS.usd} by default`)
  expect(limits).toContain(`one of the request's ${DEFAULTS.per_request} subagents`)
  // The maximums a config may raise them to, as the resolver accepts and refuses them.
  expect(limits).toContain("up to 1000 agents, 16 at once, 1440 minutes and 4 runs at once")
  expect(WorkflowLimits.resolve({ max_agents: 1000 }, { max_agents: 1000 }, 64).maxAgents).toBe(1000)
  expect(WorkflowLimits.resolve({}, { concurrency: 16 }, 64).concurrency).toBe(16)
  expect(WorkflowLimits.resolve({}, { concurrency: 16 }, 4).concurrency).toBe(2)
  expect(() => WorkflowLimits.resolve({ minutes: 1441 })).toThrow()
  expect(() => WorkflowLimits.resolve({}, { runs: 5 })).toThrow()
  expect(limits).toContain("processors minus two (at least one)")
  const grammar = plain(section(pages.workflows, "grammar"))
  expect(grammar).toContain(`A spec the agent writes is at most ${WorkflowSpec.BYTES.model / 1024} KiB`)
  expect(grammar).toContain(`at most ${WorkflowSpec.BYTES.saved / 1024} KiB`)
  expect(plain(pages.workflows)).toContain("https://vectordev.ai/workflow.json")
  const schema = (await Bun.file(path.join(repo, "packages/web/public/workflow.json")).json()) as { $id: string }
  expect(schema.$id).toBe("https://vectordev.ai/workflow.json")
})

test("the workflows page shows the guide's three examples, and says it is not Workflow insights", async () => {
  const guide = await read("packages/engine/src/orchestration/guide.txt")
  const expected = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!))
  const raw = await read("packages/web/src/pages/docs/workflows.astro")
  const shown = [...raw.matchAll(/<pre data-sample="workflow"><code>\{`([\s\S]*?)`\}<\/code><\/pre>/g)].map((match) =>
    JSON.parse(match[1]!),
  )
  expect(expected).toHaveLength(3)
  expect(shown).toEqual(expected)
  for (const example of shown) expect(WorkflowSpec.parse(example, { source: "model" }).ok).toBe(true)
  const text = plain(pages.workflows)
  expect(text).toContain("a workflow is not Workflow insights")
  expect(text).toContain("vector workflow is not vector memory workflow")
  expect(plain(pages["terminal-agent"])).toContain("vector workflow is not vector memory workflow")
})

test("the terminal copy says the next CLI release and what WSL servers keep", () => {
  const terminal = plain(section(pages["terminal-agent"], "cli-helpers"))
  expect(terminal.split("with the next CLI release").length - 1).toBeGreaterThanOrEqual(4)
  expect(terminal).toContain("Windows WSL servers keep the engine version the desktop requires")
  // Without --attach the engine runs in vector run, so Ctrl+C stops the run and its helpers at once (Phase 8 review).
  expect(terminal).toContain(
    "Without --attach the engine runs inside vector run, so Ctrl+C stops the run and its helpers at once",
  )
  for (const term of ["<leader>k", "/stop-all", "Esc also stops helpers", "Ctrl+B", "--stop-helpers", "/tasks"])
    expect(fold(section(pages["terminal-agent"], "cli-helpers"))).toContain(
      term.replace("<", "&lt;").replace(">", "&gt;"),
    )
  expect(plain(section(pages.workflows, "cli"))).toContain("with the next CLI release")
  expect(plain(section(pages.workflows, "older-versions"))).toContain("Windows WSL server")
})

test("docs-content says the new limits, labelled, and no longer that Vector sets no cap", async () => {
  expect(await read("packages/web/src/data/docs-content.ts")).not.toMatch(/Vector sets no cap/)
  for (const term of ["When Vector uses them", "How many", "While they run", "Where they work", "How deep"])
    expect([term, subagentKinds.find(([name]) => name === term)?.[1].includes(release113.since)]).toEqual([term, true])
  // The shipped answers that said subagents are for big tasks keep their text and gain a labelled one (5.J).
  for (const question of [
    "Can several agents work on one repository?",
    "What is the difference between a subagent and a subagent specialist?",
  ])
    expect([question, faqs.find((faq) => faq.question === question)?.answer.includes(release113.since)]).toEqual([
      question,
      true,
    ])
  const many = subagentKinds.find(([name]) => name === "How many")![1]
  expect(many).toContain(`at most ${DEFAULTS.running} subagents run at once in a conversation`)
  expect(many).toContain(`(${GUEST.running}, ${GUEST.perRequest} and $${GUEST.usd} for guests)`)
  // Only the at-once limit makes launches wait; past the per-request count they are refused (5.B.9).
  expect(many).toContain(
    "The main agent's launches past the at-once limit wait for a free slot; past the per-request count they are refused.",
  )
  expect(many).not.toContain("Further launches wait for a free slot")
  const limit = faqs.find((faq) => faq.question === "Is there a limit on how many subagents Vector runs?")
  expect(limit?.answer).toContain(`${release113.since} yes.`)
  expect(limit?.answer).toContain(`At most ${DEFAULTS.running} subagents run at once in a conversation`)
  expect(limit?.answer).toContain(`one request starts at most ${DEFAULTS.per_request}`)
  expect(limit?.answer).toContain(`$${DEFAULTS.usd} spend ceiling`)
  expect(crew.find((member) => member.label === "explore")?.role).toContain(release113.since)
  const ceiling = spendRows.find(([term]) => term === "Subagent spend ceiling")
  expect(ceiling?.[1].startsWith(release113.since)).toBe(true)
  expect(ceiling?.[1]).toContain(`$${DEFAULTS.usd} at catalog prices by default ($${GUEST.usd} for guests)`)
})

test("the subagents page says what the engine does where it once said more", () => {
  // TaskSize.withheld keeps task for a subagent the user named, on Light and after "no subagents" alike.
  const delegates = plain(section(pages.subagents, "when-vector-delegates"))
  expect(delegates).toContain(
    'Light requests, and requests where you said "no subagents", start only the subagents you name with @',
  )
  expect(delegates).not.toContain("Light requests start no new subagents")
  expect(subagentKinds.find(([name]) => name === "When Vector uses them")?.[1]).toContain(
    "start only the subagents you name with @",
  )
  // TaskManager.resume refuses a child that never started; only the agent relaunches it (D.3 step 6).
  const restart = plain(section(pages.subagents, "after-a-restart"))
  expect(restart).toContain("A helper that never started cannot be resumed")
  expect(restart).not.toContain("relaunched instead")
  // A linked folder is a symlink (a junction on Windows) to the checkout's own folder, outside merge and discard.
  const worktrees = plain(section(pages.subagents, "worktrees"))
  expect(worktrees).toContain("nothing outside linked folders reaches your files until you or the agent merges them")
  expect(worktrees).toContain("Review, Merge, Discard and checkpoints do not cover it")
  // Learned defaults' subagent split is read where the models page links to it.
  expect(plain(section(pages.tokenomics, "learned-defaults", "h3"))).toContain(
    "runs where the agent handed work to subagents are their own split",
  )
})

test("the desktop page names the queue dock's own controls", async () => {
  // session-followup-dock.tsx: Steer (Retry once a send failed) and Delete on each row, Resume while paused.
  const dock = await read("packages/app/src/pages/session/composer/session-followup-dock.tsx")
  const english = await read("packages/app/src/i18n/en.ts")
  const label = (key: string) => {
    expect(dock).toContain(`"${key}"`)
    return new RegExp(`"${key.replaceAll(".", "\\.")}": "([^"]+)"`).exec(english)![1]!
  }
  const desktop = blocks(pages["desktop-app"])
    .map(plain)
    .find((block) => block.includes("wait in a dock"))!
  expect(desktop).toBeDefined()
  const controls = [
    label("settings.general.row.followup.option.steer"),
    label("session.followupDock.delete"),
    label("session.followupDock.failed"),
    label("session.followupDock.retry"),
    label("session.followupDock.resume"),
  ]
  expect(controls).toEqual(["Steer", "Delete", "Not sent", "Retry", "Resume"])
  for (const control of controls) expect([control, desktop.includes(control)]).toEqual([control, true])
  // The dock has no Send now or Edit control.
  for (const key of ["session.followupDock.sendNow", "session.followupDock.edit"]) expect(dock).not.toContain(key)
  expect(desktop).not.toContain("Send now")
  expect(desktop).not.toMatch(/\bEdit\b/)
})

test("the 1.99.113 notes have a Multi-agent parity section that names every work package and its tests", () => {
  const raw = notes
  const start = raw.indexOf("## Multi-agent parity")
  expect(start).toBeGreaterThan(-1)
  const next = raw.indexOf(" ## ", start + 1)
  const parity = raw.slice(start, next === -1 ? undefined : next)
  const work = contract.slice(contract.indexOf("## 6. Work packages"), contract.indexOf("## 7. Open risks"))
  const ids = [...work.matchAll(/^\*\*(WP\d+[ab]?)\./gm)].map((match) => match[1]!)
  expect(ids).toContain("WP1")
  expect(ids).toContain("WP40a")
  expect(ids).toContain("WP40b")
  expect(ids.filter((id) => !parity.includes(`**${id},`))).toEqual([])
  const files = [
    ...new Set([...work.matchAll(/`(packages\/[^`\s]+\.(?:test|spec)\.tsx?)`/g)].map((match) => match[1]!)),
  ]
  expect(files.length).toBeGreaterThan(60)
  expect(files.filter((file) => !parity.includes(file))).toEqual([])
  for (const heading of [
    "### Release note (draft)",
    "### What blocks the publish",
    "### Decide what the build leaves open",
    "### Try it",
    "### CLI",
  ])
    expect(parity).toContain(heading)
  expect(parity).toContain(
    `${DEFAULTS.running} running, ${DEFAULTS.per_request} per request and $${DEFAULTS.usd} per request for subagents; guests ${GUEST.running}, ${GUEST.perRequest} and $${GUEST.usd}`,
  )
  expect(parity).toContain("reach the terminal with the next CLI release")
  expect(raw).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|PLACEHOLDER/)
})

test("the new copy keeps to the copy rules", () => {
  // The multi-agent copy only: the other 1.99.113 paragraphs (the prompt guard, learned skills) have tests of their own.
  const start = notes.indexOf("## Multi-agent parity")
  const labelled = [
    ...LISTED.flatMap((name) =>
      blocks(pages[name]).filter(
        (block) => block.startsWith(LABEL) && (name === "workflows" || FEATURE.test(plain(block))),
      ),
    ),
    ...[
      ...subagentKinds.map(([, detail]) => detail),
      ...faqs.map((faq) => faq.answer),
      ...spendRows.map(([, detail]) => detail),
      ...crew.map((member) => member.role),
      ...docsNav.flatMap((group) => group.links.map((link) => link.blurb)),
    ].filter((text) => text.includes(release113.since)),
    notes.slice(start),
  ].map(plain)
  expect(labelled.length).toBeGreaterThan(60)
  for (const text of labelled)
    for (const banned of [
      /(?<![\w\-./:#@$[{=])projects?(?![\w\-/\]=}(])(?!\.\w)(?!:\S)/i,
      /\bexactly\b/i,
      /\bguarantee/i,
      /never exceeds/i,
      /absolute privacy/i,
    ])
      expect([text.slice(0, 80), banned.test(text)]).toEqual([text.slice(0, 80), false])
})
