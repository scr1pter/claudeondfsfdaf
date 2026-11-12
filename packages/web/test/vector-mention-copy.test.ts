import { expect, test } from "bun:test"

const root = new URL("../../../", import.meta.url)
const page = () => Bun.file(new URL("packages/web/src/pages/docs/vectorscope.astro", root)).text()
const github = async () => (await page()).split('<h2 id="github">')[1]!.split('<h2 id="before-you-push">')[0]!

// These assertions protect the public contract rather than the unrelated local-review dollar-budget examples.
test("GitHub documentation keeps stable links and explains whose repository, model access and Actions minutes are used", async () => {
  const source = await page()
  for (const anchor of [
    "github",
    "github-codium",
    "github-own-key",
    "github-limits",
    "github-schedules",
    "github-run-in-github",
    "github-follow-ups",
    "github-privacy",
  ])
    expect(source).toContain(`id="${anchor}"`)
  const copy = (await github()).replace(/\s+/g, " ")
  expect(copy).toContain("in your own repo, on your own Actions minutes")
  expect(copy).toContain("GitHub's terms")
  expect(copy).toContain("model access")
  expect(copy).toContain("binder's plan")
  expect(copy).toContain("it is not GitHub minutes")
  expect(copy).toContain('href="/docs/codium#plans"')
  expect(copy).toContain("This path needs no Codium plan")
  expect(copy).toContain("60 days")
  expect(copy).toContain("best effort")
  expect(copy).toContain("logs are public on public repositories")
  expect(copy).toContain("do not start your other CI workflows")
  expect(copy).toContain("Explicitly opting in to Vector App publishing")
  expect(copy).not.toMatch(/[$€£]\s*\d|vector-(?:10|50|100|200)|\b(?:Plus|Pro|Max|Ultra)\s+plan/)
  expect(copy).not.toMatch(
    /\b(?:hosted|compute|cloud hours|cloud capacity|our cloud|exclusive|every PR|every pull request|guaranteed|24\/7|SLA)\b/i,
  )
  expect(copy).not.toMatch(/@vector\b|use a personal access token if you need CI/i)
  const redirects = await Bun.file(new URL("vercel.json", root)).json()
  expect(redirects.redirects).toContainEqual(
    expect.objectContaining({ source: "/docs/github", destination: "/docs/vectorscope#github" }),
  )
})

test("docs Codium and schedule sections require the build's listed perks and own-key instructions remain unconditional", async () => {
  const source = await page()
  expect(source).toContain('process.env.CODIUM_LISTED_PERKS ?? ""')
  expect(source).toContain('const githubCodium = listed.has("github-agents")')
  expect(source).toContain('const githubSchedules = githubCodium && listed.has("scheduled")')
  expect(source).toContain('const githubNoSecret = githubCodium && listed.has("github-no-secret")')
  expect(source).toMatch(/\{githubCodium && \([\s\S]*?id="github-codium"[\s\S]*?\)\}\s*<h3 id="github-own-key">/)
  expect(source).toMatch(/\{githubSchedules && \([\s\S]*?Codium schedules[\s\S]*?\)\}/)
  expect(source).toMatch(/\{githubNoSecret && [^\n]*no provider API key or model secret/)
  expect(source).not.toContain("reviews and GitHub runs need your own provider credentials")
})

test("owner acceptance retains default-off publication and actual runtime, artifact and erasure checks", async () => {
  const owner = await Bun.file(new URL("docs/vector/owner-actions/vector-mention.md", root)).text()
  for (const required of [
    "VECTOR_GITHUB_BRAIN_ENABLED",
    "CODIUM_LISTED_PERKS",
    "Register the `cloud-agents` repository handler",
    "private runner proof",
    "different newly approved Brain bytes",
    "already downloaded plaintext/keys cannot be retracted",
    "Passing fixtures do not establish",
  ])
    expect(owner).toContain(required)
  const app = await Bun.file(new URL("docs/vector/owner-actions/github-app.md", root)).text()
  for (const job of ["Vector agent", "Vector publish", "Vector review", "Vector bind"]) expect(app).toContain(job)
  expect(app).toContain("**no Actions write**")
  expect(app).toContain("pull_request_review_comment")
  expect(app).toContain("https://vectordev.ai/api/cloud-agents/mint")
  expect(app).toContain("https://vectordev.ai/api/cloud-agents/bind")
})
