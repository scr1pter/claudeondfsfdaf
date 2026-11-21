import { expect, test } from "bun:test"
import path from "node:path"
import { docsMoved } from "../src/data/docs-nav"

// The owner asked for a setting that sends each finished task to Vectorscope, after LLM-as-a-judge when that is on,
// and for its diagram on the site before it is built (21 November 2026). Until the setting ships, the homepage and the
// docs show it labelled Coming soon, in the order it will run: the task, the judge, then the review. The pull request
// that ships it replaces the label with its release label and updates this file in the same change.
const web = path.join(import.meta.dir, "..")
// Template text wraps across lines, so the copy is compared with its whitespace folded.
const read = async (file: string) => (await Bun.file(path.join(web, file)).text()).replace(/\s+/g, " ")
const component = await read("src/components/marketing/ReviewPipeline.astro")
const lander = await read("src/components/Lander.astro")
const verified = await read("src/pages/docs/verified-completion.astro")
const vectorscope = await read("src/pages/docs/vectorscope.astro")
const docsPage = await read("src/layouts/DocsPage.astro")

// What the component renders: its frontmatter and its styles left out.
const diagram = component.replace(/^--- .*? ---/, "").replace(/<style>.*<\/style>/, "")
const home = lander.slice(
  lander.indexOf('<section id="code-review"'),
  lander.indexOf("</section>", lander.indexOf('<section id="code-review"')),
)
const docs = verified.slice(verified.indexOf('<h2 id="then-code-review">'), verified.indexOf("</DocsPage>"))
const pointer = vectorscope.slice(
  vectorscope.indexOf('<h2 id="after-every-task">'),
  vectorscope.indexOf('<h2 id="cli-github">'),
)
// What a reader sees, without markup.
const words = (text: string) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

test("the diagram shows the task, then the judge, then Vectorscope, with the judge marked optional", () => {
  const titles = Array.from(diagram.matchAll(/<h3 class="rp-title">([^<]*)<\/h3>/g), (match) => match[1])
  expect(titles).toEqual(["Vector does the task", "LLM-as-a-judge checks", "Vectorscope reviews the code"])
  expect(diagram).toContain('<ol class="rp-steps" role="list">')
  expect(diagram.match(/<li class="rp-step">/g)).toHaveLength(3)
  // The judge's card alone is dashed and says it runs only when it is on.
  expect(diagram.match(/rp-optional/g)).toHaveLength(1)
  const judge = diagram.indexOf('<div class="rp-card rp-optional">')
  expect(judge).toBeGreaterThan(diagram.indexOf("Vector does the task"))
  expect(judge).toBeLessThan(diagram.indexOf("LLM-as-a-judge checks"))
  expect(words(diagram)).toContain("If you turned it on LLM-as-a-judge checks")
  // The repair loop, the judge-off path and where the findings go.
  expect(diagram).toContain("On a FAIL, Vector repairs the work and the judge looks again, up to three rounds.")
  expect(diagram).toContain("FAIL: repair, then judge again · up to 3 rounds")
  expect(diagram).toContain("Judge off: straight to review")
  expect(diagram).toContain('<p class="rp-skip">Judge off? Step 2 is skipped.</p>')
  expect(diagram).toContain("reports its findings. It doesn't edit your files.")
  expect(words(diagram)).toContain(" Findings in Local reviews ")
  expect(diagram).toContain(
    "With both settings on, Vector finishes the task, the judge checks it, then Vectorscope reviews the code as the judge's last round left it. With the judge off, the review follows the task directly.",
  )
})

test("the diagram is real text labelled by its caption, and its arrows are hidden from screen readers", () => {
  expect(diagram).toContain('role="group" aria-labelledby={`${Astro.props.id}-caption`}')
  expect(diagram).toContain('<figcaption id={`${Astro.props.id}-caption`} class="rp-caption">')
  expect(diagram).not.toMatch(/<img\b|<text\b/)
  const svgs = Array.from(diagram.matchAll(/<svg\b[^>]*>/g), (match) => match[0])
  expect(svgs.length).toBeGreaterThanOrEqual(6)
  expect(svgs.filter((svg) => !svg.includes('aria-hidden="true"'))).toEqual([])
  expect(diagram).toContain('<div class="rp-bypass" aria-hidden="true">')
  expect(diagram).toContain('<div class="rp-loop" aria-hidden="true">')
  // Its colours come from the page it sits in: the landing tokens, else the docs ones.
  expect(component).toContain("--rp-accent: var(--landing-accent, var(--d-accent));")
  expect(component).toContain("--rp-title: var(--landing-title, var(--d-heading));")
})

test("the homepage section sits between Privacy and Trust and is labelled Coming soon", () => {
  const privacy = lander.indexOf('<section id="privacy"')
  const section = lander.indexOf('<section id="code-review"')
  expect(privacy).toBeGreaterThan(-1)
  expect(section).toBeGreaterThan(lander.indexOf("</section>", privacy))
  expect(lander.indexOf('<section id="trust"')).toBeGreaterThan(section)
  expect(home).toContain('data-chapter="Review"')
  expect(home).toContain('<p class="story-kicker" data-reveal>Coming soon</p>')
  expect(home).toContain(
    '<h2 id="code-review-title" class="story-title" data-reveal>Done, judged, then&nbsp;reviewed.</h2>',
  )
  expect(home).toContain(
    "Turn on code review in the desktop app's settings, and each task you send there that changes files goes to Vectorscope, Vector's code review agent, once the work is done. With LLM-as-a-judge on, the judge checks the work first.",
  )
  expect(home).toContain('<ReviewPipeline id="code-review-diagram" tone="landing" />')
  expect(home).toContain(
    '<a class="landing-pill" href="/docs/verified-completion#then-code-review">See how it will work</a>',
  )
  // Neither the hero nor the self-evolving section carries it.
  expect(lander.slice(lander.indexOf('<section id="ch-start"'), lander.indexOf("<AppShots />"))).not.toContain(
    "ReviewPipeline",
  )
})

test("the docs describe it under Verified completion, labelled Coming soon, with a pointer from Vectorscope", () => {
  expect(docs).toStartWith(
    '<h2 id="then-code-review">Then code review</h2> <p class="note">Coming soon. This describes a desktop setting that is being built.</p> <ReviewPipeline id="then-code-review-diagram" tone="docs" />',
  )
  expect(docs).toContain("With the judge on, the review waits until the judge's last round is done")
  expect(docs).toContain("If you stop the judge, nothing is reviewed.")
  expect(docs).toContain("The review reports and doesn't fix.")
  // The pointer follows Before you push, outside the GitHub section another test reads, and keeps an id of its own:
  // review-pipeline is the old address of How a review runs.
  const at = vectorscope.indexOf('<h2 id="after-every-task">After every task</h2>')
  expect(at).toBeGreaterThan(vectorscope.indexOf('<h2 id="before-you-push">'))
  expect(at).toBeLessThan(vectorscope.indexOf('<h2 id="cli-github">'))
  expect(vectorscope.split('<h2 id="github">')[1]!.split('<h2 id="before-you-push">')[0]).not.toContain(
    "after-every-task",
  )
  expect(vectorscope.match(/id="review-pipeline"/g)).toHaveLength(1)
  expect(docsMoved["review-pipeline"]).toBe("vectorscope#review-pipeline")
  expect(pointer).toContain("Coming soon: a desktop setting that sends each finished task's changes to Vectorscope")
  expect(pointer).toContain('<a href="/docs/verified-completion#then-code-review">Verified completion</a>')
  // The diagram's step headings stay out of the page's On this page rail.
  expect(docsPage).toContain('.filter((heading) => !heading.closest("figure"))')
})

test("the copy says both checks are opt-in, off by default and cost extra model calls", () => {
  expect(diagram).toContain(
    "Both checks are opt-in and off by default, and each one costs extra model calls. Code review needs Vectorscope local reviews turned on and covers all uncommitted changes in the repository, yours included.",
  )
  expect(diagram).toContain("Greetings, questions, plan mode and tasks that change no files aren't reviewed.")
  expect(docs).toContain("It is off by default and appears once Vectorscope local reviews are turned on.")
  expect(docs).toContain("It covers all uncommitted changes in the repository, your own included")
  expect(docs).toContain("Each review costs extra model calls.")
})

test("the copy keeps to the site's wording rules", () => {
  for (const text of [diagram, home, docs, pointer].map(words)) {
    expect(text).not.toMatch(
      /\bprojects?\b|\bexactly\b|guaranteed|\bfully\b|verifies (?:its work )?before|every task where|never exceeds|Run Guard|is sized|stops a run/i,
    )
    expect(text).not.toMatch(/\bpackages\/[a-z]/)
    // The site's spelling of the reviewer.
    expect(text).not.toContain("VectorScope")
  }
})
