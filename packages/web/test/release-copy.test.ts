import { expect, test } from "bun:test"
import { changelog } from "../src/data/docs-content"
import { publishedDesktopVersion, release199, upcomingRelease } from "../src/data/vector-releases"

// Desktop 1.99.112 was published from main dfc98974 by release run #96 on 2026-10-30 (UTC), so no later edit may
// present it, or anything before it, as upcoming. 1.99.111 was published by release run #95 on 2026-10-25, 1.99.110 on
// 2026-10-23, 1.99.109 on 2026-10-19 and 1.99.108 on 2026-10-17 by release run #88; 1.99.107 was skipped and never
// published.
const shipped = "1.99.112"
const web = new URL("..", import.meta.url).pathname
// The source repository is private, so its releases and files 404 for visitors. Installers come from the account
// download page, which needs a free Vector account.
const accountDownload = 'href="/download"'
const privateRepository = /github\.com\/scr1pter|githubusercontent\.com\/scr1pter|api\.github\.com\/repos\/scr1pter/i
const noAccountInstallers = /\b(installers?|download)\b.*\b(without an account|no account needed)\b/i

// Phrasings that called 1.99.99 unpublished or said Vector cannot update itself.
const stale = [
  /\b(cannot|can't|do not|don't) update (themselves|itself)\b/i,
  /\b(upcoming|next release)\W+1\.99\.99\b/i,
  /\b1\.99\.99,? the next (desktop )?release\b/i,
  /\b1\.99\.99 installers are not published\b/i,
  /\bnot published yet\b[^.]*\b1\.99\.(8|99|100|101|102|103|104|105|106|107|108|109|110|111|112)\b/i,
  /\b1\.99\.(10[89]|11[0-2])\b[^.]*\b(prepared|not (yet )?published|installers are not released)\b/i,
  /\b(remain|are still)( at)? (desktop )?\**1\.99\.(8|99)\b/i,
  /\bcurrently (published|downloadable)\b[^.]*\b1\.99\.[78]\b/i,
  /\bno standalone CLI release is published\b/i,
]

const sources = await Promise.all(
  [
    ...(await Array.fromAsync(new Bun.Glob("src/{pages,components,data}/**/*.{astro,ts,tsx}").scan({ cwd: web }))),
    "../../README.md",
  ].map(async (file) => ({ file, text: await Bun.file(`${web}${file}`).text() })),
)

test("the site marks the latest shipped desktop release as published", () => {
  expect(Bun.semver.order(publishedDesktopVersion, shipped)).toBeGreaterThanOrEqual(0)
  expect(
    release199
      .filter((release) => release.availability && Bun.semver.order(release.version, publishedDesktopVersion) <= 0)
      .map((release) => release.version),
  ).toEqual([])
  // The unversioned Upcoming entry leads the docs changelog; a version number there reads as upcoming.
  expect(upcomingRelease.summary).not.toMatch(/\b\d+\.\d+\.\d+\b/)
})

test("the docs changelog lists the current desktop download's notes word for word", () => {
  // The docs front page names publishedDesktopVersion as the current download and links to the changelog, whose
  // versioned entries are listed by hand, so advancing one without the other leaves the current release unlisted.
  const notes = release199.find((release) => release.version === publishedDesktopVersion)
  expect(notes).toBeDefined()
  expect(changelog.filter(([label]) => label.endsWith(` · ${publishedDesktopVersion}`))).toEqual([
    [expect.any(String), notes?.title, notes?.summary],
  ])
})

test("website and README copy no longer call 1.99.99 unpublished or say Vector cannot update itself", () => {
  expect(
    sources.flatMap((source) =>
      source.text
        .split("\n")
        .filter((line) => stale.some((pattern) => pattern.test(line)))
        .map((line) => `${source.file}: ${line.trim().slice(0, 120)}`),
    ),
  ).toEqual([])
})

test("release notes contain no unfinished placeholders", async () => {
  // The draft release job copies changelog.json word for word into the GitHub release notes, and the desktop's
  // What's new dialog reads it from vectordev.ai, which deploys from main before any desktop release ships.
  const notes = [
    ...sources.filter((source) => source.file.startsWith("src/data/")),
    { file: "public/changelog.json", text: await Bun.file(`${web}public/changelog.json`).text() },
  ]
  expect(
    notes.flatMap((source) =>
      (source.text.match(/\w*PLACEHOLDER\w*|\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b/g) ?? []).map(
        (match) => `${source.file}: ${match}`,
      ),
    ),
  ).toEqual([])
})

// The workspace layout writes data-vector-theme="dark" when it mounts, so on a normal launch with Light saved
// the light-theme --vx-* rules stay off until the scheme is switched in Settings, and a reload undoes that.
// A release note that calls something light in the light theme is not true for that launch.
const workspaceForcesDark = (await Bun.file(`${web}../app/src/pages/layout-new.tsx`).text()).includes(
  'root.dataset.vectorTheme = "dark"',
)

test.if(workspaceForcesDark)("release notes make no light-theme claim while the workspace mounts dark", () => {
  expect(
    release199.filter((release) => /light theme/i.test(release.summary)).map((release) => release.version),
  ).toEqual([])
})

test("copy does not hard-code which release is current", () => {
  // Releases ship on their own schedules, so "currently 1.99.99" goes stale without anyone touching the page.
  expect(
    sources
      .filter((source) =>
        /\bcurrently,? (the )?(CLI |desktop |npm )?v?\d+\.\d+\.\d+/i.test(source.text.replace(/\s+/g, " ")),
      )
      .map((source) => source.file),
  ).toEqual([])
})

test("Check for Updates is named only as the macOS menu item", () => {
  // Windows and Linux have no Check for Updates control (they use Check now in Settings → Updates & about),
  // so an unqualified "update with Check for Updates" sends them looking for a button that does not exist.
  // Shipped release notes under src/data keep the wording they were published with.
  expect(
    sources
      .filter((source) => !source.file.startsWith("src/data/"))
      .flatMap((source) =>
        source.text
          .replace(/\s+/g, " ")
          .split(/(?<=[.;])\s/)
          .filter((sentence) => sentence.includes("Check for Updates") && !sentence.includes("macOS"))
          .map((sentence) => `${source.file}: ${sentence.slice(0, 120)}`),
      ),
  ).toEqual([])
})

test("no page or README links to the private source repository or offers installers without an account", async () => {
  // Release notes keep their wording, but none may send readers to the private repository's releases.
  const notes = [...sources, { file: "public/changelog.json", text: await Bun.file(`${web}public/changelog.json`).text() }]
  expect(
    notes.flatMap((source) =>
      (source.text.match(/[^.]*\bGitHub releases?\b[^.]*/gi) ?? []).map((match) => `${source.file}: ${match.trim().slice(0, 120)}`),
    ),
  ).toEqual([])
  expect(
    sources.flatMap((source) =>
      source.text
        .split("\n")
        .filter((line) => privateRepository.test(line))
        .map((line) => `${source.file}: ${line.trim().slice(0, 120)}`),
    ),
  ).toEqual([])
  // Copy wraps across lines and links, so read it as plain sentences.
  expect(
    sources.flatMap((source) =>
      source.text
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .split(/(?<=[.;?!])\s/)
        .filter((sentence) => noAccountInstallers.test(sentence))
        .map((sentence) => `${source.file}: ${sentence.slice(0, 120)}`),
    ),
  ).toEqual([])
})

test("the download page points installed copies at Check for Updates and install docs offer the account download", async () => {
  const download = await Bun.file(`${web}src/components/marketing/download/FreeDownload.tsx`).text()
  expect(download).toContain("Check for Updates")
  expect(download).toContain("Updates & about")
  const install = await Bun.file(`${web}src/pages/docs/install.astro`).text()
  expect(install).toContain(accountDownload)
  expect(install).toContain("free Vector account")
})

test("the download page tells Mac users the keychain may ask once after an update and Always Allow stops it", async () => {
  // Read as rendered text: the note wraps across lines and markup.
  const download = (await Bun.file(`${web}src/components/marketing/download/FreeDownload.tsx`).text())
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
  const note = download.match(/After an update, macOS may ask[^]*?once after each update\./)?.[0] ?? ""
  expect(note).toContain("“Vector Safe Storage”")
  expect(note).toContain("Choose Always Allow and it stops asking.")
  expect(note).toContain("Until Vector is signed with an Apple Developer ID")
})

test("visitors without an account reach the installers from the footer and can sign up on the sign-in page", async () => {
  // /download and the footer's platform links send anonymous visitors to /login, where a free account is one
  // step away: the form's Sign up link switches it to creating one.
  expect(await Bun.file(`${web}src/components/marketing/SiteFooter.astro`).text()).toContain(
    '["All installers", "/download"]',
  )
  const signIn = await Bun.file(`${web}src/components/marketing/account/AuthPage.tsx`).text()
  expect(signIn).toContain("Don’t have an account?")
  expect(signIn).toContain('"Sign up"')
  expect(signIn).toContain('"Create account"')
})

test("troubleshooting explains in-app updates and their fallbacks", async () => {
  const page = await Bun.file(`${web}src/pages/docs/troubleshooting.astro`).text()
  const item = (title: string) => page.match(new RegExp(`<strong>${title}</strong><p>([\\s\\S]*?)</p>`))?.[1] ?? ""

  const offers = item("Vector never offers an update")
  expect(offers).toContain("Settings → Updates &amp; about and choose Check now")
  expect(offers).toContain("Check for Updates in the Vector menu on macOS")
  // Releases before 1.99.2 have no Updates & about page; their update control is in the sidebar.
  expect(offers).toContain("before 1.99.2")
  expect(offers).toContain("Update Vector at the bottom of the left sidebar")
  expect(offers).toContain("in-app updates only work when you run the AppImage")
  expect(offers).toContain(`${accountDownload}>vectordev.ai/download</a> with your free Vector account`)

  const mac = item("A macOS update does not install")
  // On macOS the menu's update dialog offers a plain Restart button, which hits the same unwritable-folder failure.
  expect(mac).toContain(
    "Restart to update (Restart in the Vector menu's update dialog, or Update Vector before 1.99.2) does nothing",
  )
  expect(mac).toMatch(
    /quit Vector[\s\S]*download the DMG[\s\S]*drag Vector to Applications[\s\S]*open it from Applications/,
  )
  expect(mac).toContain(`${accountDownload}>vectordev.ai/download</a> with your free Vector account`)

  const intel = item("Vector 1.99.99 does not open on an Intel Mac, Windows on Arm or Linux on Arm")
  expect(intel).toContain(`${accountDownload}>vectordev.ai/download</a> with your free Vector account`)
})
