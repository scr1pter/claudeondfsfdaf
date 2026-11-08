import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { cspProblems, phoneBuildId } from "./build"
import { PHONE_BASE, PHONE_ORIGIN, PHONE_SW_SCOPE, PHONE_SW_URL, PHONE_VERSION_URL } from "./config"

// WP A38: the phone app's sources stay within what the phone origin's strict CSP allows, its manifest keeps every
// surface on one origin and one scope, its copy keeps the honesty rules, and it bundles nothing from Node or Bun.

const DIR = import.meta.dir
const APP = path.resolve(DIR, "../..")

async function sources() {
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (/\.(tsx?|html|css|webmanifest)$/.test(entry.name) && !entry.name.includes(".test.")) files.push(file)
    }
  }
  await walk(DIR)
  // Named with "/" on every system: on Windows path.relative gives "routes\cloud-runs.tsx", which the checks below miss.
  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(DIR, file).split(path.sep).join("/"),
      text: await readFile(file, "utf8"),
    })),
  )
}

describe("CSP", () => {
  test("the build refuses inline scripts, styles and handlers", () => {
    expect(cspProblems('<script type="module" crossorigin src="/phone/assets/index-a1.js"></script>')).toEqual([])
    expect(cspProblems("<script>alert(1)</script>")).toEqual(["an inline script"])
    expect(cspProblems('<div style="color:red"></div>')).toEqual(["an inline style attribute"])
    expect(cspProblems("<style>p{}</style>")).toEqual(["an inline style element"])
    expect(cspProblems('<img src="x" onerror="go()">')).toEqual(["an inline event handler"])
  })

  test("the page source passes, and no component writes a style attribute", async () => {
    expect(cspProblems(await readFile(path.join(DIR, "index.html"), "utf8"))).toEqual([])
    for (const { file, text } of await sources()) {
      if (!file.endsWith(".tsx")) continue
      expect({ file, style: /\sstyle=/.test(text) }).toEqual({ file, style: false })
      expect({ file, innerHTML: /innerHTML/.test(text) }).toEqual({ file, innerHTML: false })
    }
  })
})

test("one origin, one scope: the manifest, worker and pages all live under /phone/ with scope /", async () => {
  const manifest = JSON.parse(await readFile(path.join(DIR, "phone.webmanifest"), "utf8"))
  expect(PHONE_ORIGIN).toBe("https://remote.vectordev.ai")
  expect(manifest.start_url).toBe(PHONE_BASE)
  expect(manifest.id).toBe(PHONE_BASE)
  expect(manifest.scope).toBe(PHONE_SW_SCOPE)
  expect(manifest.display).toBe("standalone")
  for (const icon of manifest.icons) expect(icon.src.startsWith(PHONE_BASE)).toBe(true)
  expect(PHONE_SW_URL.startsWith(PHONE_BASE)).toBe(true)
  expect(PHONE_VERSION_URL.startsWith(PHONE_BASE)).toBe(true)
  const html = await readFile(path.join(DIR, "index.html"), "utf8")
  for (const href of html.matchAll(/\shref="([^"]+)"/g)) expect(href[1].startsWith(PHONE_BASE)).toBe(true)
})

test("the build id comes from the commit, or a name given, never anything else", () => {
  expect(phoneBuildId({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123" }, "1.17.14")).toBe("1.17.14-0123456789ab")
  expect(phoneBuildId({ VECTOR_PHONE_BUILD: "preview-7" }, "1.17.14")).toBe("preview-7")
  expect(phoneBuildId({ VECTOR_PHONE_BUILD: "bad id!" }, "1.17.14")).toBe("1.17.14-local")
  expect(phoneBuildId({ GITHUB_SHA: "not-hex" }, "1.17.14")).toBe("1.17.14-local")
})

test("phone copy keeps the honesty rules (H2, H3, H4)", async () => {
  const all = await sources()
  const copy = all.filter(
    ({ file }) => file.startsWith("routes/") || ["app.tsx", "status.ts", "push.ts"].includes(file),
  )
  for (const { file, text } of copy) {
    for (const banned of [
      /\bsoon\b/i,
      /24\/7/,
      /guarantee/i,
      /exclusive/i,
      /every (PR|pull request)/i,
      /\bSLA\b/,
      /uptime/i,
    ])
      expect({ file, banned: banned.source, found: banned.test(text) }).toMatchObject({ found: false })
    expect({ file, found: /\b(credits?|top-?ups?)\b/i.test(text) }).toMatchObject({ found: false })
  }
  // JSX wraps long lines; read the copy as a browser would.
  const text = (file: string) => all.find((item) => item.file === file)!.text.replace(/\s+/g, " ")
  const runs = text("routes/cloud-runs.tsx")
  expect(runs).toContain("in your own repo, on your own Actions minutes")
  for (const word of [/hosted/i, /compute/i, /cloud hours/i, /our cloud/i]) expect(word.test(runs)).toBe(false)
  const computer = text("routes/computer.tsx")
  expect(/GitHub|Actions/.test(computer)).toBe(false)
  expect(computer).toContain("Vector runs for you")
  const ops = text("routes/ops.tsx")
  expect(ops).toContain("Vector's agent is on call, not a person")
})

test("approvals never offer to allow always (S6)", async () => {
  const text = (await readFile(path.join(DIR, "routes", "approvals.tsx"), "utf8")).replace(/\s+/g, " ")
  expect(text).toContain("allow it once or deny it")
  expect(/allow always|always allow/i.test(text)).toBe(false)
})

test("the page and the worker bundle no Node or Bun module", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(APP, "script", "browser-imports.ts"),
      path.join(DIR, "entry.tsx"),
      path.join(DIR, "sw.ts"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  const result = JSON.parse(stdout) as { modules: string[]; runtime: string[] }
  expect(result.modules).toEqual(
    expect.arrayContaining([
      "packages/app/src/phone/entry.tsx",
      "packages/app/src/phone/sw.ts",
      "packages/app/src/phone/alerts.ts",
    ]),
  )
  // The build helper runs in Node at build time and is never part of either bundle.
  expect(result.modules).not.toContain("packages/app/src/phone/build.ts")
  expect(result.runtime).toEqual([])
  expect(code).toBe(0)
}, 60_000)
