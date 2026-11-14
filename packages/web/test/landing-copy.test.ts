import { expect, test } from "bun:test"
import path from "node:path"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { brainCopy, brainRelease, publishedDesktopVersion } from "../src/data/vector-releases"

// The landing page is the product tour. Every claim on it has to hold for the desktop release it ships with, and
// everything that is not live yet has to say so.
const web = path.join(import.meta.dir, "..")
const repo = path.join(web, "../..")
// Template text wraps across lines, so the copy is compared with its whitespace folded.
const read = async (file: string) => (await Bun.file(path.join(web, file)).text()).replace(/\s+/g, " ")
const lander = await read("src/components/Lander.astro")
const index = await read("src/pages/index.astro")
const footer = await read("src/components/marketing/SiteFooter.astro")
const shots = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("src/components/marketing/shots/*.astro").scan({ cwd: web }))).map(
    async (file) => ({ file, text: await read(file) }),
  ),
)
const page = [lander, index, footer].join("\n")
// Link targets are left out: a model card's address can name an active size, though no page text does.
const visible = [page, ...shots.map((shot) => shot.text)].map((text) => text.replace(/href(?:: |=)"[^"]*"/g, ""))

// The brain ships in desktop 1.99.110, built in this tree, and the site deploys from main. The hero deck and the memory
// card name that release, and say it is coming until the download page offers it, then that it is new in it.
test("the brain's release labels say coming in desktop 1.99.110 until that release is published, then new in it", () => {
  for (const version of ["1.99.108", "1.99.109"])
    expect(brainCopy(version)).toMatchObject({ kicker: "coming in desktop 1.99.110", since: "Coming in desktop 1.99.110:" })
  for (const version of ["1.99.110", "1.99.111", "1.100.0", "2.0.0"])
    expect(brainCopy(version)).toMatchObject({ kicker: "new in desktop 1.99.110", since: "From desktop 1.99.110," })
  expect(brainRelease).toEqual(brainCopy(publishedDesktopVersion))
  for (const version of ["1.99.109", "1.99.110"])
    for (const label of Object.values(brainCopy(version))) expect(label).not.toMatch(/\bexactly\b|\bprojects?\b/i)
})

test("the hero deck and the memory card name desktop 1.99.110, the release the brain ships in", async () => {
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/brain.ts")).exists()).toBe(true)
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/knowledge.ts")).exists()).toBe(true)
  // The self-evolving section carries no kicker of its own (owner, 27 October 2026).
  expect(lander).not.toContain("brainRelease.kicker")
  expect(lander).toContain('data-chapter="Self-evolving"')
  // The owner's title for the section (19 October 2026): the brain learns the people and the company, not only the code.
  expect(lander).toContain(
    '<h2 id="evolving-title" class="story-title" data-reveal>An agent that learns you and your&nbsp;company.</h2>',
  )
  expect(lander).not.toContain("An agent that learns your&nbsp;repository.")
  expect(lander).toContain(
    "`${brainRelease.since} rules, memory and the documents you add are stored and searched on your computer",
  )
  // Nothing else on the page calls the release out, shipped or coming, on its own.
  const labels = lander.replace(/\$?\{brainRelease\.\w+\}/g, "")
  expect(labels).not.toMatch(/(new|coming) in (desktop )?1\.99\.110|From desktop 1\.99\.110/)
  expect(lander).toContain('href: "/docs/brain"')
  expect(lander).not.toContain("/docs/local-memory")
  expect(lander).not.toMatch(/Vector (now )?(learns|remembers)[^.]*today/i)
})

// Every number the section gives comes from the dated knowledge eval, with its date and what it is not.
test("the self-evolving section quotes the dated knowledge eval and keeps its caveat", async () => {
  const report = await Bun.file(path.join(repo, "docs/benchmarks/vector-knowledge-2026-10-19/report.json")).json()
  const working = report.found.working
  const section = lander.slice(
    lander.indexOf('<section id="evolving"'),
    lander.indexOf("</section>", lander.indexOf('<section id="evolving"')),
  )
  expect(report.date).toBe("2026-10-19")
  expect(report.dirty).toBe(false)
  expect(section).toContain(
    `On Vector's knowledge eval of 19 October 2026, recall through code links brought in the governing requirement for ${working.pagerank} of ${working.tasks} tasks, against ${working.keywords} of ${working.tasks} by keywords alone, at ${Math.round(report.tokens.light.mean)} tokens a request on average.`,
  )
  expect(section).toContain(
    `The eval is ${["zero", "one", "two", "three", "four", "five", "six"][report.fixture.documents]} short specs and ${report.fixture.working + report.fixture.hops + report.fixture.irrelevant} requests written alongside the feature, not an independent benchmark.`,
  )
  // The only figures in the section are the eval's, and none of them is a time.
  const words = section.replace(/<[^>]+>/g, " ").replace(/1\.99\.110|19 October 2026/g, "")
  const figures = Array.from(words.matchAll(/\d[\d,.]*/g), (match) => match[0])
  expect(figures.toSorted()).toEqual(
    [
      working.pagerank,
      working.tasks,
      working.keywords,
      working.tasks,
      Math.round(report.tokens.light.mean),
      report.fixture.working + report.fixture.hops + report.fixture.irrelevant,
    ]
      .map(String)
      .toSorted(),
  )
  expect(section).not.toMatch(/\bms\b|seconds|faster|cheaper|Codex/i)
})

// The owner's control line (20 October 2026), said only as far as the code backs it: brain.db sits in Vector's data
// folder on this computer, the user picks the model, Settings → Memory lists what was learned with Undo and Tidy and
// erase, and free models that may train carry their label. Memory in every agent is not built yet, so it stays off.
test("the self-evolving section says whose prompts and data they are, and no more", async () => {
  const section = lander.slice(
    lander.indexOf('<section id="evolving"'),
    lander.indexOf("</section>", lander.indexOf('<section id="evolving"')),
  )
  expect(await Bun.file(path.join(repo, "packages/core/src/brain/database.ts")).text()).toContain(
    "BrainPaths.directory(Global.Path.data)",
  )
  const memory = await Bun.file(path.join(repo, "packages/app/src/components/settings-v2/memory.tsx")).text()
  expect(memory).toContain('action: "undo"')
  expect(memory).toContain("current.memory.erase(")
  expect(section).toContain(
    "Your prompts, your data, your Vector: the brain lives on your computer, you choose who runs the model for each request, and you can see, undo or erase what it learned. Free models labelled May train on your prompts are the exception.",
  )
  expect(page).not.toMatch(/\bfully\b|controlled only by you|only you control|your prompts never/i)
  expect(section).not.toMatch(/every agent|Deep research|Vectorscope/i)
})

// The owner's emphasis (22 October 2026): Vector is the self-evolving, low-cost AI agentic harness, built on technology
// of its own. The hero stays as short as it was on main: it says plainly what Vector is, with one emphasis line that
// labels the brain from brainRelease, since the brain is what makes it self-evolving and is not out until desktop
// 1.99.110. The detail sits in the sections below. The README said it too until it was reduced to one word (owner,
// 24 October 2026); the hero deck and the title carry it now.
test("the hero and the title call Vector the self-evolving, low-cost AI agentic harness", async () => {
  const source = await Bun.file(path.join(web, "src/pages/index.astro")).text()
  const hero = lander.slice(lander.indexOf('<section id="ch-start"'), lander.indexOf('<section id="evolving"'))
  const deck = hero.slice(hero.indexOf('<p class="hero-deck simple-deck">'), hero.indexOf("</p>", hero.indexOf("hero-deck")))
  expect(lander).toContain('<span class="headline-lead">The self-evolving AI agentic harness&nbsp;that</span>')
  expect(lander).toContain('<span class="sr-only">The self-evolving AI agentic harness that has an agent of its own,')
  expect(deck).toContain(
    "An AI agentic harness for the repository on your computer: plan, edit, run and ship with Vector's own agent. Low-cost by design, and self-evolving with Vector Brain, {brainRelease.lede}.",
  )
  // About as tall as the hero on main: one deck of a few lines and one note, with the detail left to the sections.
  expect(deck.replace(/<[^>]+>/g, "").trim().length).toBeLessThan(220)
  expect(hero.match(/class="hero-note"/g)).toHaveLength(1)
  expect(hero).not.toMatch(/Low cost, measured|Run Guard|tokenomics|proprietary/i)
  expect(source).toContain('title="Vector — the self-evolving, low-cost AI agentic harness"')
  // A search result shows about 160 characters of the description, whichever label the brain carries.
  const description = source.match(/description=\{`([^`]*)`\}/)?.[1] ?? ""
  for (const version of ["1.99.109", "1.99.110"]) {
    const text = description.replace("${brainRelease.kicker}", brainCopy(version).kicker)
    expect(text).not.toContain("${")
    expect(text.length).toBeLessThanOrEqual(160)
    expect(text).toContain(`Vector Brain is ${brainCopy(version).kicker}.`)
    expect(text).toContain("Free with a Vector account")
  }
  // The brain's own name, everywhere: never the owner's slip for it, which is built here so this file does not spell it.
  const slip = new RegExp(["g", "brain"].join(""), "i")
  expect(page).not.toMatch(slip)
})

// Request sizing and the Run Guard are in the desktop app; the terminal gets them with the next CLI release. Every
// sentence on the page that names one says so, and no headline phrase, which cannot, names either.
test("request sizing and the Run Guard are called desktop features wherever the page names them", () => {
  const sentences = page
    .replace(/<[^>]+>/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /Run Guard|is sized|sizes each request|stops a run/i.test(sentence))
  expect(sentences.filter((sentence) => !/desktop/i.test(sentence))).toEqual([])
  const phrases = lander.slice(lander.indexOf("const phrases = ["), lander.indexOf("]", lander.indexOf("const phrases = [")))
  expect(phrases).not.toMatch(/cap|Run Guard|sized|budget/i)
  expect(lander).not.toMatch(/sr-only">[^<]*(stops a run|cap you set)/)
})

// "Low-cost" rests on one published benchmark: the integrated HTTP cells of the efficiency archive, Vector on the
// Messages API against Claude Code at the same rates. The README quoted it until it was reduced to one word (owner,
// 24 October 2026); the investor page's footnote quotes it now, and test/investor-page.test.ts holds its range and
// caveats to the archive.
test("the investor page's cost claim dates the runtime the efficiency archive froze, and no page goes past it", async () => {
  const investors = await read("src/pages/investors.astro")
  // The archive freezes one revision of the runtime, committed on 11 October 2026. The footnote gives that date, not
  // the commit or the archive's place in Vector's repository, which readers of the public page cannot open. The
  // landing page no longer carries the note (owner, 27 October 2026).
  const archive = await Bun.file(path.join(repo, "docs/benchmarks/vector-efficiency-2026-10/README.md")).text()
  const revision = archive.match(/integrated command-line runtime is frozen at `([0-9a-f]{40})`/)?.[1]
  expect(revision).toBeDefined()
  expect(lander).not.toContain("Low cost, measured")
  expect(investors).toContain("Vector's runtime as of 11 October 2026 and Claude Code 2.1.215")
  // The frontmatter's comment may point at the archive; the page it renders does not.
  const rendered = investors.slice(investors.indexOf("---", 3) + 3)
  expect(rendered).not.toContain(revision!.slice(0, 7))
  expect(rendered).not.toContain("docs/benchmarks")
  // Never a bare superlative, and nothing from the archive where Claude Code or Codex comes out ahead.
  expect(
    [page, investors].filter((text) => /\bcheapest\b|\blowest[- ]cost\b|MiB|wall[- ]time|Codex [^,.]*cheaper/i.test(text)),
  ).toEqual([])
})

test("Vector Velocity is planned with 550B+ parameters and no availability or performance claim", () => {
  expect(lander).toContain('"is planning Vector Velocity, a 550B+ parameter model."')
  expect(lander).toContain("and is planning Vector Velocity, a model with 550B+ parameters.")
  expect(lander).toContain("Vector Velocity, our planned model with 550B+ parameters")
  expect(lander).not.toMatch(/is building a 550B|550B-parameter model we're building/)
  // One planned size, and nothing about how many of its parameters run per token.
  expect(
    new Set(
      visible.flatMap((text) =>
        Array.from(text.matchAll(/(\d+B\+?)(?:[- ]parameter| parameters| model)/g), (match) => match[1]),
      ),
    ),
  ).toEqual(new Set(["550B+"]))
  expect(
    visible.filter((text) =>
      /\bactive (?:per token|param\w*)|parameters active|\bactivated\b|\bA\d+B\b|\bunder \d+B\b|\d+B (?:active|per token|for every token)|parameters (?:per|for every) token|300B|300 billion/i.test(
        text,
      ),
    ),
  ).toEqual([])
  // No base model and no compute provider.
  expect(page).not.toMatch(/Velocity[^.]*\b(?:built on|based on|fine-tun\w*|base model)\b|compute credits|Nebius/i)
})

test("what is not live when the page ships is labelled, and what ships with it is not", () => {
  // Free models provided by Vector, with may-train models labelled and a one-time question, ship in desktop 1.99.109
  // with this page. The owner's wording (19 October 2026) says Vector provides them, never a shared allowance.
  expect(lander).toContain("Sign in to Vector and its free models are provided by Vector at no cost to you")
  expect(lander).toContain("every free OpenRouter model that can use tools and whose terms allow Vector to provide it")
  expect(page).not.toMatch(/shared allowance|allow shared use/i)
  expect(lander).not.toMatch(/connect a free OpenRouter account|your own OpenRouter account/i)
  expect(lander).toContain("sent only after you accept that once")
  expect(page).toContain("May train on your prompts")
  expect(page).not.toContain("Models included with Vector")
  expect(page).not.toMatch(/no matter which model|whichever model/i)
  // Codium sales are closed.
  expect(lander).toContain("Codium, coming soon")
  // Eight is the batch size, not a limit on subagents running together, and nothing says subagents have no cap.
  expect(lander).toContain('"runs subagents in batches of up to eight."')
  expect(page).not.toMatch(/eight subagents at once|subagents[^."]*no cap|no cap[^."]*subagents/i)
  // Only Vector's own agent's runs are priced, and a spend cap is never a promise to the cent.
  expect(page).not.toMatch(/\bexactly\b|never exceeds|guaranteed|holds a run to|every chat priced|prices every chat/i)
  expect(page).not.toMatch(/cost of every run|economics of every run|absolute privacy|really cost|all of it stays/i)
  // The judge is off by default and checks only large tasks; there is no hosted agent; inviting is a terminal command.
  expect(page).not.toMatch(/verifies (?:its work )?before|from the cloud|invites your team/i)
  // No redrawn session shows a dollar figure of zero for tokens it spent; a plan session reads as the app shows it.
  expect(shots.filter((shot) => shot.text.includes("$0.00")).map((shot) => shot.file)).toEqual([])
  expect(shots.some((shot) => shot.text.includes("<b>ChatGPT plan</b>"))).toBe(true)
})

test("no picture of the session view shows a Publish button", () => {
  // From desktop 1.99.109, publishing lives in Vector Cloud, reached from Home; the session's browser has no
  // Publish button (session-side-panel.tsx), so the redrawn session and its browser don't either.
  expect(shots.filter((shot) => /data-browser-publish|\bPublish\b/.test(shot.text)).map((shot) => shot.file)).toEqual([])
})

// The page ships with desktop 1.99.109 and describes or draws two things due in that release: free models labelled
// "May train on your prompts" behind a one-time question, and the sidebar's "Repository tools" label (its group
// header became "Agents" on 20 Oct). Once the published desktop version reaches 1.99.109, the app in the same tree must have both; if either
// slipped, put back the free models' status label or the old sidebar labels in the redraw.
test.skipIf(Bun.semver.order(publishedDesktopVersion, "1.99.109") < 0)(
  "once desktop 1.99.109 is published, the app has what the page says that release brings",
  async () => {
    const source = async (dir: string) =>
      Promise.all(
        (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(repo, dir) }))).map((file) =>
          Bun.file(path.join(repo, dir, file)).text(),
        ),
      )
    const app = [...(await source("packages/app/src")), ...(await source("packages/core/src"))]
    expect(app.some((text) => text.includes("May train on your prompts"))).toBe(true)
    expect(app.some((text) => text.includes("Repository tools"))).toBe(true)
    const nav = await Bun.file(path.join(repo, "packages/app/src/components/workspace-navigation.tsx")).text()
    expect(nav).not.toMatch(/>\s*Projects\s*<|Project tools/)
  },
)

test("the landing page says repository, never project, for Vector's own idea", () => {
  expect([lander, index, footer].filter((text) => /\bprojects?\b/i.test(text))).toEqual([])
  // The redrawn sidebar, dashboard and terminal name things the way the copy does.
  const named = shots.flatMap((shot) =>
    [
      />Projects</,
      /"Project tools"/,
      /under (Project|Repository) tools/,
      /at a project on your disk/,
      /deploys the open project/,
      /untrusted project cannot/,
      /"project policy cannot/,
      /"project MCP servers/,
    ]
      .filter((pattern) => pattern.test(shot.text))
      .map((pattern) => `${shot.file}: ${pattern}`),
  )
  expect(named).toEqual([])
})

test("the landing page names neither the upstream project nor Cloud Services", () => {
  // The upstream name is derived from its MIT notice, so it is never written here either.
  expect(legacyName).toBeTruthy()
  expect([page, ...shots.map((shot) => shot.text)].filter((text) => text.toLowerCase().includes(legacyName!))).toEqual(
    [],
  )
  expect(page).not.toMatch(/Cloud [Ss]ervices/)
})

// The pictures of the app work in a sample repository, the same ~/code/myapp the terminal docs use, never in the
// folder on the owner's computer that Vector itself is built in.
test("the app pictures show a sample repository, not the owner's folder", () => {
  const traces = /~\/Vectordev|>\s*Vectordev\.ai\s*<|\/Users\/|\/home\/[a-z]|\.codex\/worktrees/
  expect(shots.filter((shot) => traces.test(shot.text)).map((shot) => shot.file)).toEqual([])
  const named = (file: string) => shots.find((shot) => shot.file.endsWith(file))?.text ?? ""
  expect(named("ShotSession.astro")).toContain('<span class="ss-prompt">~/code/myapp (')
  expect(named("ShotTasksPanel.astro")).toContain("the currently staged patch in ~/code/myapp on branch")
  expect(named("ShotSidebar.astro")).toContain('<span class="sb-project-name">myapp</span>')
})
