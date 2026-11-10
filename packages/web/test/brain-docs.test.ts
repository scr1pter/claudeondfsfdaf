import { expect, test } from "bun:test"
import path from "node:path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { TaskSize } from "@vectordevai/core/task-size"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import {
  brainBudgetRows,
  brainCommandRows,
  documentCommandRows,
  knowledgeEval,
  modelCommandRows,
} from "../src/data/docs-content"
import { brainRelease, publishedDesktopVersion } from "../src/data/vector-releases"
import { docsMoved, docsNav } from "../src/data/docs-nav"

// The brain's docs pages (desktop 1.99.110) describe what this tree does: the budgets are the engine's, the commands
// are the CLI's, and every number comes from the dated knowledge eval. The README no longer has a section on the brain
// (owner, 24 October 2026), so the pages carry what it said and are held to it here.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
const read = async (file: string) => (await Bun.file(path.join(repo, file)).text()).replace(/\s+/g, " ")
const brain = await read("packages/web/src/pages/docs/brain.astro")
const documents = await read("packages/web/src/pages/docs/documents.astro")
const meaning = await read("packages/web/src/pages/docs/search-by-meaning.astro")
const report = await Bun.file(path.join(repo, `${knowledgeEval.report}/report.json`)).json()
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

// Desktop 1.99.109 and earlier still have local memory, so its page stays until the download page offers 1.99.110; from
// then on the page is gone and /docs/local-memory and /docs#local-memory land on the brain page.
const brainPublished = Bun.semver.order(publishedDesktopVersion, "1.99.110") >= 0
const features = docsNav.find((group) => group.label === "Features")?.links.map((link) => link.id) ?? []
const localMemory = Bun.file(path.join(web, "src/pages/docs/local-memory.astro"))
const vercel = (await Bun.file(path.join(repo, "vercel.json")).json()) as {
  redirects: { source: string; destination: string }[]
}
const localMemoryRedirect = vercel.redirects.find((redirect) => redirect.source === "/docs/local-memory")

test.skipIf(brainPublished)(
  "until desktop 1.99.110 is published, local memory keeps its page, beside the brain's",
  async () => {
    expect(features.indexOf("local-memory")).toBe(features.indexOf("brain") - 1)
    expect(docsNav.flatMap((group) => group.links).find((link) => link.id === "local-memory")?.blurb).toStartWith(
      "Desktop 1.99.109 and earlier:",
    )
    expect(await localMemory.exists()).toBe(true)
    const page = (await localMemory.text()).replace(/\s+/g, " ")
    expect(page).toContain('<DocsPage id="local-memory">')
    expect(page).toContain('{brainRelease.since} <a href="/docs/brain">Vector Brain</a> replaces local memory.')
    expect(brainRelease.since).toBe("Coming in desktop 1.99.110:")
    expect(brain).toContain('see <a href="/docs/local-memory">Local memory</a>')
    // A permanent redirect would be cached by browsers, so neither it nor the /docs#local-memory shim may move readers on.
    expect(localMemoryRedirect).toBeUndefined()
    expect(docsMoved["local-memory"]).toBeUndefined()
  },
)

test.if(brainPublished)(
  "once desktop 1.99.110 is published, local memory's page is gone and its links land on the brain",
  async () => {
    expect(features).not.toContain("local-memory")
    expect(await localMemory.exists()).toBe(false)
    expect(brain).not.toContain('href="/docs/local-memory"')
    expect(docsMoved["local-memory"]).toBe("brain")
    expect(localMemoryRedirect?.destination).toBe("/docs/brain")
  },
)

test("Vector Brain and Documents and code links are pages of their own", async () => {
  expect(features).toContain("brain")
  expect(features).toContain("documents")
  expect(brain).toContain('<DocsPage id="brain">')
  expect(documents).toContain('<DocsPage id="documents">')
  // Every link between the two pages lands on a heading that exists.
  const links = Array.from(`${brain} ${documents}`.matchAll(/href="\/docs\/(brain|documents)#([\w-]+)"/g), (match) => ({
    page: match[1] === "brain" ? brain : documents,
    anchor: match[2]!,
  }))
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(link.page).toContain(`<h2 id="${link.anchor}">`)
})

test("both pages and their sidebar entries name desktop 1.99.110, and the brain page says what leaves the computer", async () => {
  for (const id of ["brain", "documents"])
    expect(docsNav.flatMap((group) => group.links).find((link) => link.id === id)?.blurb).toStartWith(
      "From desktop 1.99.110:",
    )
  expect(brain).toContain("From desktop 1.99.110, Vector keeps a brain for each repository")
  expect(documents).toContain("From desktop 1.99.110, you can give Vector a repository's specs")
  // The fixed part goes with every request but a greeting, so the privacy line names it before "only the few lines".
  expect(brain).toContain(
    "All of it is stored and searched on this computer. Beyond your rules, the start of <code>MEMORY.md</code> and the entries you pinned, which go with every request but a greeting, Vector sends your model only the few lines that bear on each request. Private documents never go to a free model labelled <strong>May train on your prompts</strong>, or to a session a guest is in.",
  )
  // Redaction is pattern-based, and a kept copy is the file as added, as the app's Keep copies toggle says.
  for (const page of [brain, documents]) {
    expect(page).toContain("Vector removes what looks like a secret from what it reads")
    expect(page).toContain("is the file as you added it, secrets included")
    expect(page).not.toMatch(/secrets (in a document )?are removed/)
  }
  expect(await read("packages/app/src/components/settings-v2/memory-documents-model.ts")).toContain(
    "The copy is the file as you added it, secrets included",
  )
  // Readers still on 1.99.109 are told what they have.
  expect(brain).toContain("Desktop 1.99.109 and earlier keep one <code>MEMORY.md</code> file")
})

test("the budgets the brain page gives are the ones recall uses", () => {
  const rows = Object.fromEntries(brainBudgetRows)
  expect(Object.keys(rows)).toEqual(["Chat", "Light", "Standard", "Thorough"])
  expect(Brain.recallBudget("chat")).toBe(0)
  expect(BrainKnowledge.budget("chat", { documents: true, tight: false })).toBe(0)
  expect(rows.Chat).toContain("Nothing")
  for (const tier of ["light", "standard", "thorough"] as const) {
    const row = rows[`${tier[0]!.toUpperCase()}${tier.slice(1)}`]
    expect(row).toContain(
      `Up to ${Brain.recallBudget(tier)} tokens, or ${BrainKnowledge.budget(tier, { documents: true, tight: false })} in a repository with documents.`,
    )
  }
  expect(brain).toContain(
    `Every request but a greeting carries your rules, the start of <code>MEMORY.md</code> (about ${Brain.BUDGET.memory} tokens of it), the entries you pinned (about ${Brain.BUDGET.pinned} tokens) and one line saying what else the brain holds.`,
  )
  // What the page says about the cached part, a file read and a subagent's brief.
  expect(brain).toContain(`about ${Brain.BUDGET.memory} tokens of it`)
  expect(brain).toContain(`(about ${Brain.BUDGET.pinned} tokens)`)
  expect(brain).toContain(`up to about ${Brain.BUDGET.attach} tokens of memory about that file`)
  expect(brain).toContain(`up to ${BrainKnowledge.BRIEF.tokens} tokens of the cards and memory`)
  expect(brain).toContain(`for up to ${words[BrainKnowledge.BRIEF.subagents]} subagents a request`)
})

// "hi" and "ok" cost nothing only when nothing waits on them; the page says when they are sized as work instead.
test("the page sizes a greeting or a bare acknowledgement as TaskSize does", () => {
  expect(brain).toContain(
    'A greeting or a bare acknowledgement, such as "hi" or "ok", is sized Chat unless work is waiting on you: one that answers a question the agent asked, follows a run that did not finish, or approves a plan from Plan mode is sized as the work it carries on.',
  )
  for (const text of ["hi", "ok"]) expect(TaskSize.classify({ text }).tier).toBe("chat")
  for (const text of ["hi", "ok"])
    expect(TaskSize.classify({ text, open: true, previous: "standard" }).tier).not.toBe("chat")
  expect(TaskSize.classify({ text: "ok", plan: true, previous: "standard" }).tier).not.toBe("chat")
  expect(TaskSize.classify({ text: "hi", plan: true, previous: "standard" }).tier).toBe("chat")
})

// Only `vector review` reads the brain's requirements; the desktop's Vectorscope does not yet, and the page says so.
test("the page gives linked requirements to the terminal's Vectorscope review only, with the next CLI release", async () => {
  const review = await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/review.ts")).text()
  const desktop = await Bun.file(path.join(repo, "packages/app/src/features/pull-requests/ai-review.ts")).text()
  expect(review).toContain("ReviewContext.requirements(")
  expect(desktop).not.toMatch(/ReviewContext|requirements/)
  expect(brain).toContain(
    'With the next CLI release, a <a href="/docs/vectorscope">Vectorscope</a> review you run in the terminal with <code>vector review</code> gets the requirements',
  )
  expect(brain).toContain("Vectorscope reviews in the desktop app do not get them yet.")
  expect(brain).not.toMatch(/(?<!run in the terminal with <code>vector review<\/code> )gets the requirements/)
})

test("every terminal command the pages list is one the CLI has", async () => {
  const cli = [
    await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/memory.ts")).text(),
    await Bun.file(path.join(repo, "packages/engine/src/cli/cmd/memory-doc.ts")).text(),
  ].join("\n")
  const commands = [...brainCommandRows, ...documentCommandRows, ...modelCommandRows].map(([command]) => command!)
  expect(commands.every((command) => command.startsWith("vector memory "))).toBe(true)
  const missing = commands
    .map((command) => command.replace(/^vector memory (doc )?/, "").split(" ")[0]!)
    .filter((name) => !new RegExp(`command: (?:\\[\\s*)?"${name}[ "]|simple\\(\\s*"${name}"`).test(cli))
  expect(missing).toEqual([])
})

test("the eval figures in the docs are the dated report's", () => {
  const working = report.found.working
  const hops = report.found.hops
  const requests = report.fixture.working + report.fixture.hops + report.fixture.irrelevant
  expect(report.date).toBe("2026-10-19")
  expect(report.dirty).toBe(false)
  expect(knowledgeEval.date).toBe("19 October 2026")
  expect(knowledgeEval.summary).toContain(
    `On the knowledge eval of 19 October 2026, recall through code links brought in the governing requirement for ${working.pagerank} of ${working.tasks} tasks that named the files they touch, against ${working.keywords} of ${working.tasks} by keywords alone, and for ${hops.pagerank} of ${hops.tasks} tasks that edited a file which only imports the governed one, where spreading activation over code links found ${hops.activation} of ${hops.tasks}.`,
  )
  expect(knowledgeEval.summary).toContain(
    `A Light request carried ${Math.round(report.tokens.light.mean)} tokens on average, and ${report.fixture.irrelevant} unrelated requests, "hi" among them, carried none at any size.`,
  )
  expect([...report.irrelevant.pagerank, report.tokens.chat.max]).toEqual(Array.from({ length: 11 }, () => 0))
  expect(knowledgeEval.caveat).toContain(
    `The eval is ${words[report.fixture.documents]} short specs for a small invented repository and ${requests} requests, written alongside the feature, with no language model call. It is not an independent benchmark.`,
  )
  // Readers of the docs cannot open Vector's repository, so the caveat does not point to where the report sits in it.
  expect(knowledgeEval.caveat).not.toMatch(/docs\/benchmarks|Vector's repository/)
  expect(documents).toContain("{knowledgeEval.summary}")
  expect(documents).toContain("{knowledgeEval.caveat}")
})

test("the brain's copy keeps to the owner's wording rules", () => {
  for (const text of [
    brain,
    documents,
    meaning,
    knowledgeEval.summary,
    knowledgeEval.caveat,
    knowledgeEval.meaning,
    knowledgeEval.floor,
  ]) {
    expect(text).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|guaranteed/i)
    expect(text).not.toMatch(/\bprojects?\b/i)
    expect(text).not.toMatch(/(cheaper|faster) than Codex|Codex[^.]*(cheaper|faster)/i)
    // Only the eval's figures: no timings, which change with the machine.
    expect(text).not.toMatch(/\d\s?ms\b|\d+(\.\d+)? s\b/)
  }
  // OCR is explicit machine-level opt-in in development builds, not a promise about the published installer.
  expect(documents).toContain("In development builds: scanned PDF pages can be read with Tesseract and Poppler")
  expect(documents).toContain("VECTOR_OCR_TESSERACT")
  expect(documents).toContain("VECTOR_OCR_PDFTOPPM")
  expect(documents).toContain("Pages beyond those limits or that recognition cannot read remain listed as unread")
})

test("Search by meaning has its own page, from desktop 1.99.110, with the manifest's model, size, license and revision", async () => {
  const features = docsNav.find((group) => group.label === "Features")?.links ?? []
  const page = features.find((link) => link.id === "search-by-meaning")
  expect(page?.title).toBe("Search by meaning")
  expect(page?.blurb).toStartWith("From desktop 1.99.110:")
  expect(meaning).toContain('<DocsPage id="search-by-meaning">')
  expect(meaning).toContain("From desktop 1.99.110, Vector can also search your")
  // Sizes and pins come from the manifest itself, so the page cannot drift from what Vector downloads.
  expect(meaning).toContain("BrainEmbedManifest.size(arctic)")
  expect(meaning).toContain("arctic.revision.slice(0, 12)")
  expect(meaning).toContain("const graph = arctic.files.model.sha256")
  expect(meaning).toContain("{graph.slice(0, 16)}")
  expect(BrainEmbedManifest.megabytes(BrainEmbedManifest.size(BrainEmbedManifest.MODELS["arctic-embed-xs-q8"]))).toBe(
    "24 MB",
  )
  expect(meaning).toContain("Nothing is downloaded until you ask")
  expect(meaning).toContain("Until you do, Vector searches documents by keywords and code links")
  expect(meaning).toContain(
    "never for a free model labelled <strong>May train on your prompts</strong>, or in a session a guest is in",
  )
  expect(documents).toContain('<a href="/docs/search-by-meaning">Search by meaning</a>')
  expect(documents).toContain("With the optional local search model, a one-time download you ask for")
  // Only the preview's two tokenizer files have no pinned sha256, and every place that promises the hash says so.
  const unpinned = Object.values(BrainEmbedManifest.MODELS).flatMap((model) =>
    Object.values(model.files).flatMap((file) => (file && !file.sha256 ? [`${model.id}/${file.name}`] : [])),
  )
  expect(unpinned).toEqual(["granite-small-r2-q8/tokenizer.json", "granite-small-r2-q8/tokenizer_config.json"])
  expect(meaning).toContain(
    "except the Code-aware preview's <code>tokenizer.json</code> and <code>tokenizer_config.json</code>, whose hashes are not pinned yet: they are checked by size and taken only from Hugging Face at the preview's pinned revision.",
  )
  const notices = await read("THIRD_PARTY_NOTICES.md")
  expect(notices).toContain(
    "except the Code-aware preview's `tokenizer.json` and `tokenizer_config.json`, which are pinned by size only for now and taken only from Hugging Face at the preview's pinned revision.",
  )
  const api = await read("packages/engine/src/server/routes/instance/httpapi/groups/memory.ts")
  expect(api).toContain(
    "Each file is used only at its pinned size and sha256, except the Code-aware preview's tokenizer.json and tokenizer_config.json, which are checked by size and taken only from Hugging Face at the preview's pinned revision.",
  )
  // The full-precision fallback has never been run with this build, so the page and the command say so.
  expect(meaning).toContain(
    "Not yet verified: it has not been run in this release, and the check it must pass on your computer has not been measured on it.",
  )
  expect(meaning).toContain("Settings offers the full-precision one instead, which is not yet verified.")
  expect(modelCommandRows.find(([command]) => command === "vector memory model download")?.[1]).toContain(
    "--full-precision the full-precision model, which is not yet verified.",
  )
})

test("the meaning figures are the dated report's, run with the pinned model", () => {
  const working = report.found.working
  const hops = report.found.hops
  expect(report.dense.model).toBe(
    `${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].repo}@${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].revision.slice(0, 12)} int8`,
  )
  expect(knowledgeEval.meaning).toBe(
    `With the search model, the same requests found the governing requirement for ${working.meaning} of ${working.tasks} tasks by keywords and meaning alone, with no code links, against ${working.keywords} of ${working.tasks} by keywords alone; with every channel at once, for ${working.all} of ${working.tasks}, and ${hops.all} of ${hops.tasks} through an import. The ${report.fixture.irrelevant} unrelated requests carried no tokens with it either.`,
  )
  expect(report.dense.irrelevant).toEqual(Array.from({ length: report.fixture.irrelevant }, () => 0))
  expect(meaning).toContain("{knowledgeEval.meaning}")
  expect(meaning).toContain("{knowledgeEval.floor} {knowledgeEval.caveat}")
})

// The floor was tuned on the eval it is quoted from, so the page gives the margin the report's sweep measured, not a
// claim of room to spare.
test("the meaning floor's margin is the one the dated report's sweep measured", async () => {
  const dense = report.dense
  expect(dense.floor).toBe(BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].floor)
  expect(dense.sweep.map((row: { floor: number }) => row.floor)).toContain(dense.floor)
  expect(knowledgeEval.floor).toBe(
    `The least score a match by meaning needs, ${dense.floor}, was set on this same eval. There the unrelated requests carried no cards from ${dense.clear.toFixed(2)} up, and at ${dense.leak.floor.toFixed(2)} ${words[dense.leak.requests]} of them carried ${dense.leak.tokens} tokens, so the floor sits ${(dense.floor - dense.clear).toFixed(2)} above the least that kept them out, and these figures are not an out-of-sample result.`,
  )
  const manifest = await Bun.file(path.join(repo, "packages/core/src/brain/embed-manifest.ts")).text()
  const archive = await Bun.file(path.join(repo, `${knowledgeEval.report}/README.md`)).text()
  for (const text of [knowledgeEval.floor, manifest, archive]) expect(text).not.toContain("room to spare")
  expect(archive).toContain("## The meaning floor")
  // The review only checks for free models labelled May train on your prompts, so no page claims more.
  expect(await Bun.file(`${import.meta.dir}/../src/pages/docs/brain.astro`).text()).not.toMatch(
    /may not train on prompts/,
  )
})
