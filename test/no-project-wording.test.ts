import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"
import { changelog } from "../packages/web/src/data/docs-content"
import { release199, upcomingRelease } from "../packages/web/src/data/vector-releases"

// Owner rule (17 Oct 2026): Vector has no "projects". What a user reads says repository, or names the agents in the
// workspace. "Project" stays only as another product's own noun (a Vercel, Supabase or GitLab project), in code
// identifiers, keys, paths and anchors, and in release notes that already shipped.
const root = path.resolve(import.meta.dir, "..")
const lastShipped = [1, 99, 112]

// The word on its own, not part of an identifier, key, path, CSS class or anchor such as project.id or #project-rules.
const word = /(?<![\w\-./:#@$[{=])projects?(?![\w\-/\]=}(])(?!\.\w)(?!:\S)/gi
// Another product's project, named as such: "the linked Vercel project", "Vercel or Supabase projects".
const thirdParty = /(Vercel|Supabase|GitLab|Google Cloud|Atlassian)\s+$/

// Each of these was read and kept on purpose.
const reviewed: Record<string, string[]> = {
  // Third-party plugins described in their own words.
  "packages/app/src/components/plugins/catalog.tsx": [
    "Deployments, projects, logs and environment config.",
    "Tasks, projects and status updates.",
    "Project documentation, specs and databases.",
    "Project ID",
    "Projects, merge requests and pipelines on gitlab.com.",
    "Search projects, run analyses and start agent threads.",
  ],
  // A search keyword for people who still say "project settings". It is matched, never shown.
  "packages/app/src/components/settings-v2/settings-registry.ts": ["project settings"],
  // New clones go to ~/Projects, a folder on disk.
  "packages/desktop/src/main/github-clone.ts": ["Projects"],
  // The heading older versions wrote into .vector/RULES.md, still recognised so those files migrate.
  "packages/desktop/src/main/repo-rules-model.ts": ["Project rules"],
  // The terminal UI's context name, never shown.
  "packages/tui/src/context/project.tsx": ["Project"],
}

const sources = [
  "api/help",
  "packages/app/src",
  "packages/ui/src/i18n/en.ts",
  "packages/session-ui/src",
  "packages/desktop/src/main",
  "packages/desktop/src/renderer",
  "packages/tui/src",
  "packages/engine/src/cli",
  "packages/web/src",
]
// Release notes are history and keep the words they shipped with; entries newer than the last shipped release are
// checked below. Legal text changes only with the owner's sign-off.
const skipped = [
  "packages/app/src/i18n/",
  "packages/web/src/data/vector-releases.ts",
  "packages/web/src/pages/legal/",
  "packages/web/src/content/",
]

test("no user-facing English text calls Vector's own concept a project", async () => {
  const files = (
    await Promise.all(
      sources.map(async (source) => {
        const entries = source.includes(".")
          ? [source]
          : (await readdir(path.join(root, source), { recursive: true })).map((file) => path.join(source, file))
        return entries.filter(
          (file) =>
            /\.(tsx?|astro)$/.test(file) &&
            !/\.(test|spec|stories|d)\.tsx?$/.test(file) &&
            !file.split(path.sep).includes("node_modules"),
        )
      }),
    )
  )
    .flat()
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file === "packages/app/src/i18n/en.ts" || !skipped.some((prefix) => file.startsWith(prefix)))

  const found = (
    await Promise.all(
      files.map(async (file) => {
        const source = await Bun.file(path.join(root, file)).text()
        if (!/projects?/i.test(source)) return []
        return userText(file, source).flatMap((text) =>
          offending(text) && !reviewed[file]?.includes(text) ? [`${file}: ${JSON.stringify(text)}`] : [],
        )
      }),
    )
  ).flat()

  const web = await Bun.file(path.join(root, "packages/web/src/content/i18n/en.json")).json()
  const notes = [
    `${upcomingRelease.title} ${upcomingRelease.summary} ${upcomingRelease.status}`,
    ...release199.filter((release) => unshipped(release.version)).map((r) => `${r.title} ${r.summary}`),
    ...changelog.filter(([label]) => unshipped(label)).map((entry) => entry.join(" ")),
  ]
  const data = [...Object.values(web).filter((value): value is string => typeof value === "string"), ...notes].flatMap(
    (text) => (offending(text) ? [`data: ${JSON.stringify(text)}`] : []),
  )

  // The scan has to reach the sources it guards, or an empty result would mean nothing.
  expect(files.length).toBeGreaterThan(900)
  expect([...found, ...data]).toEqual([])
})

test("the wording check tells Vector's concept from other products' projects and from code", () => {
  for (const text of [
    "Open a project first",
    "Recent projects",
    "Project tools",
    "this project's .env",
    "LF Projects, LLC owns this project",
  ])
    expect(offending(text)).toBe(true)
  for (const text of [
    "Link a Vercel project",
    "the linked Vercel project's variables",
    "Vercel or Supabase projects",
    "Create a new GitLab project",
    "goose is a trademark of LF Projects, LLC",
    "project.id",
    "vector-home-project-card",
    "#project-rules",
    "{{project}}",
  ])
    expect(offending(text)).toBe(false)
})

function offending(text: string) {
  // The trademark owner's registered name is not Vector's repository terminology.
  const prose = text.replaceAll("LF Projects, LLC", "LF trademark holder")
  return [...prose.matchAll(word)].some((match) => !thirdParty.test(prose.slice(0, match.index)))
}

// A release note for a version after the last shipped one. Entries with no version, such as "August 2026", are history.
function unshipped(label: string) {
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(label)?.slice(1).map(Number)
  if (!version) return false
  const index = version.findIndex((part, i) => part !== lastShipped[i])
  return index >= 0 && (version[index] ?? 0) > (lastShipped[index] ?? 0)
}

function userText(file: string, source: string) {
  if (!file.endsWith(".astro")) return scriptText(file, source)
  const parts = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source)
  const body = (parts?.[2] ?? source)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
  return [...scriptText(`${file}.ts`, parts?.[1] ?? ""), body]
}

// String literals, template text and JSX text, leaving out imports, property names, identifier-like keys and the
// mock source code shown in marketing screenshots.
function scriptText(file: string, source: string) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const texts: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isVariableDeclaration(node) && node.name.getText() === "changelog") return
    const parent = node.parent
    const named = parent && ts.isPropertyAssignment(parent) && parent.name === node
    const imported = parent && ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) &&
      !named &&
      !imported
    )
      texts.push(node.text)
    if (ts.isJsxText(node)) texts.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => !/^[a-z][\w.\-:/]*$/.test(text) && !/^(@@|[+-]\s)|export function|=>/.test(text))
}
