import { expect, test } from "bun:test"
import path from "node:path"
import { docsNav, docsOrder } from "../src/data/docs-nav"

// The first-launch guide is for people who have never used a coding tool, so it names every button as the site, the
// app and the desktop shell show it. Each name it quotes is pinned here to the source that renders it: when a label
// changes there, this test fails until the guide says what people now see.
const root = path.join(import.meta.dir, "../../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

// What a reader sees: markup dropped, entities decoded, whitespace folded.
const guide = (await read("packages/web/src/pages/docs/first-launch.astro"))
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")

const labels: [string, string[]][] = [
  // The site: logging in, then the download page and its first-launch notes.
  [
    "packages/web/src/components/marketing/account/AuthPage.tsx",
    ["Continue with Google", "Sign up", "Check your inbox to confirm your email"],
  ],
  ["packages/web/src/components/marketing/account/AccountPage.tsx", ["/login?returnTo="]],
  [
    "packages/web/src/components/marketing/download/FreeDownload.tsx",
    [
      "Download Vector",
      "Other platforms",
      "Open Anyway",
      "More info",
      "Run anyway",
      "chmod +x",
      "Always Allow",
      "Vector Safe Storage",
      "not yet notarized by Apple",
      "not yet code-signed",
      "Apple Developer ID",
    ],
  ],
  [
    "packages/web/src/components/marketing/download/download-target.ts",
    ['os: "macOS", note: "Apple silicon"', 'note: "Intel"', "AppImage"],
  ],
  // The desktop shell: the keychain item, what a refusal says, the folder picker's New Folder button.
  [
    "packages/desktop/src/main/secure-runtime.ts",
    ["Vector Safe Storage", "choose Always Allow", "Vector cannot open its credential vault", "libsecret, or KWallet"],
  ],
  ["packages/desktop/src/main/index.ts", ["Vector couldn't open its secure credential vault"]],
  ["packages/desktop/src/main/ipc.ts", ['"openDirectory"', '"createDirectory"']],
  // Signing in: Getting started, the message box, Settings → Account, and the page the browser opens.
  [
    "packages/app/src/pages/layout-new.tsx",
    ['title: "Connect a model"', 'cta: "Start free"', 'label: "Use my own API key"', "Getting started"],
  ],
  [
    "packages/app/src/i18n/en.ts",
    [
      '"Sign in to Vector"',
      '"Use my own API key"',
      "are unavailable right now",
      '"Continue"',
      '"Trust this repository?"',
      '"Trust this repository"',
      '"Not now"',
      '"Permission required"',
    ],
  ],
  ["packages/app/src/components/settings-v2/account.tsx", ["Sign in to Vector"]],
  ["packages/app/src/components/settings-v2/settings-registry.ts", ['label: "Account"', 'label: "Providers & keys"']],
  [
    "packages/web/src/components/marketing/account/CliTokenPage.tsx",
    ['"Continue in Vector."', "Open Vector", "expires in five minutes"],
  ],
  // Models: the free ones and their training notice, Codium, and the API key form.
  ["packages/core/src/free-model-choice.ts", ['"Free models inside of Vector"', '"May train on your prompts"']],
  ["packages/app/src/utils/free-model-policy-notice.ts", ['accept: "Accept and send"']],
  ["packages/core/src/model-plans.ts", ['PROVIDER_NAME = "Vector Codium"']],
  ["packages/app/src/context/local.tsx", ["Codium spends the account's credits, so it is never chosen automatically"]],
  ["packages/core/src/model-plan-status.ts", ["PURCHASE_URL = `${SITE}/codium`"]],
  ["packages/web/src/components/marketing/codium/CodiumPricing.tsx", ['"Coming soon"']],
  ["packages/app/src/components/dialog-connect-provider.tsx", ['language.t("common.continue")']],
  // The first task: Home, the composer's permission prompt, and what to do next.
  ["packages/app/src/pages/home.tsx", ['title: "Open repository"', "New session"]],
  [
    "packages/ui/src/i18n/en.ts",
    [
      '"ui.permission.deny": "Deny"',
      '"ui.permission.allowOnce": "Allow once"',
      '"ui.permission.allowAlways": "Allow always"',
    ],
  ],
  ["packages/app/src/features/onboarding/onboarding.tsx", ['title: "Review changes"', 'title: "Rewind code + chat"']],
]

test("the first-launch guide leads Get started, and the docs home and the Install page point at it", async () => {
  const start = docsNav.find((group) => group.label === "Get started")?.links.map((link) => link.id)
  expect(start).toEqual(["first-launch", "install", "first-task"])
  expect(docsOrder[0]?.title).toBe("First launch, step by step")
  expect(await read("packages/web/src/pages/docs/first-launch.astro")).toContain('<DocsPage id="first-launch">')
  expect(await read("packages/web/src/pages/docs/index.astro")).toContain(
    '["first-launch", "First launch, step by step"',
  )
  expect(await read("packages/web/src/pages/docs/install.astro")).toContain('href="/docs/first-launch"')
})

test("the guide covers each step a first launch takes, in order", () => {
  const order = ["Download Vector", "Open Vector the first time", "Sign in", "Pick a model", "Run a first task"]
  const at = order.map((heading) => guide.indexOf(` ${heading} `))
  expect(at.every((index) => index > -1)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
})

test("every label the guide quotes is the one the site, the app or the desktop shell shows", async () => {
  const missing: string[] = []
  for (const [file, needles] of labels) {
    const source = await read(file)
    for (const needle of needles) if (!source.includes(needle)) missing.push(`${file}: ${needle}`)
  }
  expect(missing).toEqual([])

  for (const label of [
    "Continue with Google",
    "Sign up",
    "Download Vector",
    "macOS · Apple silicon",
    "Other platforms",
    "Intel",
    "AppImage",
    "Open Anyway",
    "More info",
    "Run anyway",
    "chmod +x",
    "notarized by Apple",
    "not yet code-signed",
    "Apple Developer ID",
    "Vector Safe Storage",
    "Always Allow",
    "couldn't open its secure credential vault",
    "cannot open its credential vault",
    "KWallet",
    "New Folder",
    "Getting started",
    "Connect a model",
    "Start free",
    "Sign in to Vector",
    "Settings → Account",
    "Continue in Vector",
    "Open Vector",
    "five minutes",
    "Free models inside of Vector",
    "May train on your prompts",
    "Accept and send",
    "unavailable right now",
    "Use my own API key",
    "Settings → Providers & keys",
    "Continue",
    "Vector Codium",
    "vectordev.ai/codium",
    "Vector never chooses a Codium model for you",
    "Coming soon",
    "Open repository",
    "Trust this repository?",
    "Not now",
    "New session",
    "Enter",
    "Permission required",
    "Deny",
    "Allow once",
    "Allow always",
    "Review changes",
    "Rewind code + chat",
  ])
    expect(guide).toContain(label)
})

test("the guide says Vector has repositories, and sends readers to pages that exist", async () => {
  expect(guide).not.toMatch(/\bprojects?\b/i)
  const pages = (
    await Array.fromAsync(new Bun.Glob("*.astro").scan({ cwd: path.join(root, "packages/web/src/pages/docs") }))
  ).map((file) => file.replace(/\.astro$/, ""))
  const raw = await read("packages/web/src/pages/docs/first-launch.astro")
  const links = [...raw.matchAll(/href="\/docs\/([a-z0-9-]+)(?:#[a-z0-9-]+)?"/g)].map((match) => match[1]!)
  expect(links.length).toBeGreaterThan(0)
  expect(links.filter((link) => !pages.includes(link))).toEqual([])
})
