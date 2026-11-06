// Whether a change is trivial (VectorScope upgrade contract §1.2 and §4 VS-24 items 1 and 2): whitespace, docs,
// rename or comment-only under strict rules, never anything sensitive or behaviour-bearing. Pure and browser-safe.
// Nothing calls it yet: VS-24 wiring calls it inside Review.run under `trivial: "skip"`, and the GitHub skip waits for
// the @vector merge.
//
// A change is trivial only when every changed file matches a positive rule, and the first file that does not names
// why. The caller passes EVERY changed file, before classifyFiles' ignore rules, so lockfiles, ignored, generated and
// held-back paths still count. A rule that needs facts the diff does not carry asks the caller through a callback, and
// a missing callback refuses: without VS-25a's parser ranges no code file is trivial, without the docs' own text no doc
// is, and without the reference checks no rename or doc is. Zero bug cases may be classified trivial (VS-24's hard
// requirement), so every rule errs toward reviewing.

import { minimatch } from "minimatch"
import type { DiffFile, DiffHunk, DiffLine } from "./diff"
import { classifyPath, hasGeneratedHeader, isBinaryPath, isSensitivePath, LOCKFILES } from "./ignore"
import type { Side } from "./types"

export const TRIVIAL_KINDS = ["whitespace", "docs", "rename", "comment"] as const
export type TrivialKind = (typeof TRIVIAL_KINDS)[number]

// Why a change is not trivial.
export const TRIVIAL_REFUSALS = [
  "empty",
  "hidden-characters",
  "control-characters",
  "sensitive",
  "dot-path",
  "ci",
  "container",
  "infrastructure",
  "dependencies",
  "build",
  "config",
  "sql",
  "migration",
  "binary",
  "no-extension",
  "patch-incomplete",
  "long-line",
  "submodule",
  "generated-marker",
  "agent-instructions",
  "doc-code",
  "doc-code-unchecked",
  "doc-text-mismatch",
  "not-allowlisted-docs",
  "added-or-deleted",
  "rename-with-changes",
  "case-only-rename",
  "rename-into-ignored",
  "test-path",
  "routing-path",
  "rename-unsupported",
  "conventional-name",
  "rename-moved",
  "references-unchecked",
  "referenced-by-code",
  "still-referenced",
  "no-text-change",
  "language",
  "strings-unchecked",
  "comments-unchecked",
  "hunk-context",
  "line-continuation",
  "directive",
  "string-literal",
  "code",
  "comment-structure",
] as const
export type TrivialRefusal = (typeof TRIVIAL_REFUSALS)[number]

// Lines of one side of a file, 1-based. A string range runs from the line its literal opens on to the line its closing
// delimiter is on, and a changed line n is inside it when start <= n < end: whitespace at the end of the closing line
// comes after the literal, so a one-line string covers no line. Strings are every string, template, raw-string,
// text-block and JSX attribute string token (VS-25a).
export interface SourceRange {
  start: number
  end: number
}

// A comment token (VS-25a), inclusive: line n is inside it when start <= n <= end. `text` is the token exactly as the
// source has it, from its opening delimiter to its closing one, one text line per source line. Docstrings and other
// string literals are strings, never comments.
export interface CommentRange extends SourceRange {
  text: string
}

// `path` names the first file that refused; it is absent only for "empty".
export type TrivialDecision =
  | { trivial: true; kinds: TrivialKind[] } // distinct, in TRIVIAL_KINDS order
  | { trivial: false; because: TrivialRefusal; path?: string }

// Each callback that takes a side is asked about the path on that side: the old path for LEFT on a rename.
export interface TrivialInput {
  // Paths the caller also holds behaviour-bearing: isSensitivePath always applies, and this only adds to it. VS-24 wiring
  // passes the engine config's `instructions` globs, the repository's ignore globs and linguist attributes, and paths
  // whose git mode is a symlink, a submodule or executable, none of which DiffFile carries.
  sensitive: (path: string) => boolean
  // Every comment token of one side (VS-25a), or undefined when the file could not be parsed.
  comments?: (path: string, side: Side) => readonly CommentRange[] | undefined
  // Every string token of one side (VS-25a), or undefined when the file could not be parsed.
  strings?: (path: string, side: Side) => readonly SourceRange[] | undefined
  // A doc's whole text on one side, so code blocks, front matter and doctests that start outside a hunk are seen.
  docText?: (path: string, side: Side) => string | undefined
  // Whether any head file still names a renamed or deleted file's old path, its basename, or its basename without the
  // extension (a `git grep` of the head tree-ish, VS-24 wiring). It errs toward true.
  referencesOldPath?: (oldPath: string) => boolean
  // Whether a head file that is not itself an allowlisted doc names this doc's path or its basename, with or without the
  // extension: code that loads it (`import ... with { type: "text" }`, `include_str!`, a skill prompt), or a manifest
  // that ships it. It errs toward true.
  referencedByCode?: (path: string) => boolean
}

export function classifyTrivial(files: readonly DiffFile[], input: TrivialInput): TrivialDecision {
  if (!files.length) return { trivial: false, because: "empty" }
  const kinds = new Set<TrivialKind>()
  // A loop, so a refusal stops before the callbacks of later files run.
  for (const file of files) {
    const read = classifyFile(file, input)
    if (typeof read === "string") return { trivial: false, because: read, path: file.path }
    read.forEach((kind) => kinds.add(kind))
  }
  return { trivial: true, kinds: TRIVIAL_KINDS.filter((kind) => kinds.has(kind)) }
}

function classifyFile(file: DiffFile, input: TrivialInput): TrivialRefusal | TrivialKind[] {
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path]
  const byPath = paths.flatMap((path) => pathRefusal(path, file, input) ?? [])[0]
  if (byPath) return byPath
  const byLines = linesRefusal(file)
  if (byLines) return byLines
  if (paths.every((path) => DOC_EXTENSIONS.has(extension(path)))) return docsRefusal(file, paths, input) ?? ["docs"]
  if (paths.some((path) => OTHER_DOC_EXTENSIONS.has(extension(path)))) return "not-allowlisted-docs"
  if (file.status === "added" || file.status === "deleted") return "added-or-deleted"
  if (file.status === "renamed") return renameRefusal(file, input) ?? ["rename"]
  if (!file.hunks.length) return "no-text-change"
  return hunkKinds(file, input)
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

// Invisible and bidirectional characters (Trojan Source, invisible identifiers, tag-character and variation-selector
// smuggling), as code point ranges: soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul and Khmer
// fillers, Mongolian vowel separator, zero-width and directional marks, embeddings and isolates, invisible operators,
// Hangul and halfwidth fillers, variation selectors, the BOM, and Unicode tags.
const HIDDEN: readonly (readonly [number, number])[] = [
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]
// Control characters but the tab, so line terminators a parser and a runtime may read differently are refused: a lone
// "\r" (the diff parser drops only a trailing one), "\v", "\f", NEL, and the Unicode line and paragraph separators that
// JavaScript ends a line comment at.
const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/

const GLOB = { dot: true, nocase: true }

const CI = [
  "**/Jenkinsfile*",
  "**/azure-pipelines*",
  "**/bitbucket-pipelines.*",
  "**/appveyor.*",
  "**/cloudbuild*",
  "**/buildspec*",
  "**/codemagic.*",
  "**/bitrise.*",
]
const CONTAINER = [
  "**/Dockerfile*",
  "**/*.dockerfile",
  "**/Containerfile*",
  "**/docker-compose*",
  "**/compose.y*ml",
  "**/compose.*.y*ml",
]
const INFRASTRUCTURE_EXTENSIONS = new Set(
  "tf tfvars hcl bicep bicepparam nix nomad rego cue jsonnet libsonnet dhall".split(" "),
)
const INFRASTRUCTURE = [
  "**/*.tf.json",
  "**/Vagrantfile",
  "**/Pulumi.*",
  "**/serverless.*",
  "**/kustomization.*",
  "**/skaffold.*",
  "**/charts/**",
  "**/helm/**",
  "**/k8s/**",
  "**/kubernetes/**",
  "**/terraform/**",
  "**/ansible/**",
  "**/infra/**",
]
// Q11 is open; dependency manifests and lockfiles stay never-trivial, the stricter answer [GU22].
const DEPENDENCIES = [
  "**/package.json",
  "**/requirements*.txt",
  "**/requirements/**",
  "**/constraints*.txt",
  "**/Pipfile",
  "**/pyproject.toml",
  "**/setup.py",
  "**/setup.cfg",
  "**/go.mod",
  "**/go.work",
  "**/Cargo.toml",
  "**/Gemfile",
  "**/*.gemspec",
  "**/composer.json",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle",
  "**/settings.gradle.kts",
  "**/gradle.properties",
  "**/libs.versions.toml",
  "**/gradle/wrapper/**",
  "**/*.csproj",
  "**/*.fsproj",
  "**/*.vbproj",
  "**/*.sln",
  "**/packages.config",
  "**/Directory.Packages.props",
  "**/Directory.Build.props",
  "**/Directory.Build.targets",
  "**/global.json",
  "**/Package.swift",
  "**/Package.resolved",
  "**/Podfile",
  "**/Cartfile",
  "**/pubspec.yaml",
  "**/mix.exs",
  "**/rebar.config",
  "**/deno.json",
  "**/deno.jsonc",
  "**/bunfig.toml",
  "**/vcpkg.json",
  "**/conanfile.*",
  "**/environment.yml",
  "**/DESCRIPTION",
  "**/Project.toml",
  "**/Manifest.toml",
  "**/renv.lock",
]
const BUILD_EXTENSIONS = new Set("mk cmake bzl gradle sbt".split(" "))
const BUILD = [
  "**/Makefile",
  "**/makefile",
  "**/GNUmakefile",
  "**/CMakeLists.txt",
  "**/meson.build",
  "**/meson_options.txt",
  "**/BUILD",
  "**/BUILD.bazel",
  "**/WORKSPACE",
  "**/WORKSPACE.bazel",
  "**/MODULE.bazel",
  "**/build.xml",
  "**/SConstruct",
  "**/SConscript",
  "**/Rakefile",
  "**/Justfile",
  "**/Taskfile*",
  "**/Earthfile",
  "**/build.sc",
  "**/build.zig",
  "**/build.rs",
]
const CONFIG_EXTENSIONS = new Set(
  "json jsonc json5 yaml yml toml ini cfg conf properties plist xml env config".split(" "),
)
const SQL_EXTENSIONS = new Set("sql psql pgsql ddl dml prisma".split(" "))
const MIGRATION = [
  "**/migrations/**",
  "**/migration/**",
  "**/migrate/**",
  "**/alembic/**",
  "**/flyway/**",
  "**/liquibase/**",
  "**/schema.rb",
  "**/structure.sql",
  "**/*migration*",
]

// Why this path can never be trivial, whatever changed in it.
function pathRefusal(path: string, file: DiffFile, input: TrivialInput): TrivialRefusal | undefined {
  if (hidden(path) || CONTROL.test(path)) return "hidden-characters"
  if (isSensitivePath(path) || input.sensitive(path)) return "sensitive"
  // .github/**, .vector/**, .gitlab-ci.yml, .circleci, .husky, .devcontainer, .changeset, .cursorrules, .env*, .npmrc,
  // .gitignore, .gitattributes, .gitmodules, .editorconfig and every tool's rc file.
  if (path.split("/").some((segment) => segment.startsWith("."))) return "dot-path"
  const ext = extension(path)
  const name = basename(path)
  if (matches(path, CI)) return "ci"
  if (matches(path, CONTAINER)) return "container"
  if (INFRASTRUCTURE_EXTENSIONS.has(ext) || matches(path, INFRASTRUCTURE)) return "infrastructure"
  if (LOCKFILES.some((lock) => lock.toLowerCase() === name.toLowerCase()) || matches(path, DEPENDENCIES))
    return "dependencies"
  if (BUILD_EXTENSIONS.has(ext) || matches(path, BUILD)) return "build"
  if (CONFIG_EXTENSIONS.has(ext)) return "config"
  if (SQL_EXTENSIONS.has(ext)) return "sql"
  if (matches(path, MIGRATION)) return "migration"
  if (file.binary || isBinaryPath(path)) return "binary"
  if (!ext) return "no-extension"
  return undefined
}

// By code point, so a tag character (outside the BMP) is one character, not two surrogates.
function hidden(text: string) {
  return Array.from(text, (char) => char.codePointAt(0) ?? 0).some((code) =>
    HIDDEN.some((range) => code >= range[0] && code <= range[1]),
  )
}

// Longer than any line a trivial change needs. A hunk line past it is refused before any pattern reads the file's
// lines, so no pattern's work on a crafted line can stall the gate, which runs before packing and maxDiffChars. A
// minified file is reviewed anyway.
const MAX_LINE_CHARS = 2_000

// Why a file's lines refuse it, whatever kind of file it is: a patch that does not hold every changed line (GitHub
// omits large ones), a line past MAX_LINE_CHARS, context included, hidden or control characters in a changed line, a
// submodule pointer, or a generated-code marker, which would let later changes to the file be skipped as generated once
// the base agrees (ignore.ts).
function linesRefusal(file: DiffFile): TrivialRefusal | undefined {
  const lines = file.hunks.flatMap((hunk) => hunk.lines)
  const added = lines.filter((line) => line.kind === "add").length
  const deleted = lines.filter((line) => line.kind === "del").length
  if (added !== file.additions || deleted !== file.deletions) return "patch-incomplete"
  if (lines.some((line) => line.text.length > MAX_LINE_CHARS)) return "long-line"
  const changed = lines.filter((line) => line.kind !== "context")
  if (changed.some((line) => hidden(line.text))) return "hidden-characters"
  if (changed.some((line) => CONTROL.test(line.text))) return "control-characters"
  if (lines.some((line) => line.text.startsWith("Subproject commit "))) return "submodule"
  if (lines.some((line) => hasGeneratedHeader(line.text))) return "generated-marker"
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Docs: .md, .rst and .adoc only. Never .txt (requirements.txt, CMakeLists.txt) or .mdx (executable components).

const DOC_EXTENSIONS = new Set(["md", "rst", "adoc"])
const OTHER_DOC_EXTENSIONS = new Set(
  "txt mdx markdown mdown mkd mkdn mdc qmd rmd org textile pod rdoc asciidoc".split(" "),
)

// Files agents and the engine read as instructions (the engine's instruction loader also reads CONTEXT.md, BRAIN.md
// and MEMORY.md). Dotted ones (.cursorrules, .github/copilot-instructions.md) are refused as dot paths first.
const AGENT_FILES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  "SKILL.md",
  "CONVENTIONS.md",
  "CONTEXT.md",
  "BRAIN.md",
  "MEMORY.md",
  "RULES.md",
  "AGENTS.*.md",
  "WARP.md",
  "QWEN.md",
  "copilot-instructions.md",
  "*.instructions.md",
  "*.prompt.md",
  "*.chatmode.md",
]

// Lines that make a doc run or render code: fences and doctests (mdBook, pytest --doctest-glob and rustdoc through
// include_str! test them), HTML that runs or hides text, template tags, javascript: links and event handlers. Each
// pattern is linear in the line: no two unbounded runs can trade characters, and an event handler is looked for in
// each tag, read once from its `<` to its `>`, since one pattern for it rescans the rest of the line from every `<`.
const DOC_CODE = [
  /^\s*(`{3,}|~{3,})/,
  /^\s*(>>>|\.\.\.)(\s|$)/,
  /^\s*iex(\(\d+\))?>/,
  /<\s*(?:\/\s*)?(script|style|iframe|object|embed|form|svg|math|template|link|meta|base)\b/i,
  /<!--|-->/,
  /\{%|%\}|\{\{|\}\}/,
  /javascript:/i,
  (text: string) => Array.from(text.matchAll(/<[a-z][^>]*/gi)).some((tag) => /\son[a-z]+\s*=/i.test(tag[0])),
]
// Markdown that Docusaurus and other MDX pipelines read as code even in a .md file: ESM, a component, an expression.
const MDX_CODE = [
  /^\s*(import|export)\s/,
  /<\/?[A-Z][\w.]*/,
  (text: string) => /[{}]/.test(text.replace(/`[^`]*`/g, "")),
]
// reStructuredText directives, literal blocks and field lists; AsciiDoc delimiters, block attributes, macros and
// document attributes.
const RST_CODE = [/^\s*\.\.(\s|$)/, /::\s*$/, /^:[^:\s][^:]*:/]
const ADOC_CODE = [
  /^\s*(-{4,}|\.{4,}|\+{4,}|\/{4,}|={4,}|\*{4,}|_{4,}|\|===)\s*$/,
  /^\s*\[.*\]\s*$/,
  /^\s*[\w-]+::/,
  /^:[\w-]+!?:/,
  /^\/\//,
]

function docsRefusal(file: DiffFile, paths: readonly string[], input: TrivialInput): TrivialRefusal | undefined {
  if (paths.some((path) => AGENT_FILES.some((glob) => minimatch(basename(path), glob, GLOB))))
    return "agent-instructions"
  const exts = new Set(paths.map(extension))
  const atStart = file.hunks.some(
    (hunk) => (hunk.oldStart <= 1 || hunk.newStart <= 1) && /^(---|\+\+\+)\s*$/.test(hunk.lines[0]?.text ?? ""),
  )
  if (atStart || file.hunks.some((hunk) => hunk.lines.some((line) => docCodeLine(line.text, exts)))) return "doc-code"
  const whole = docTextRefusal(file, input)
  if (whole) return whole
  if (file.status === "renamed") {
    if (!file.oldPath) return "references-unchecked"
    if (caseOnly(file.oldPath, file.path)) return "case-only-rename"
    if (ignoredPath(file.path)) return "rename-into-ignored"
  }
  if (!input.referencedByCode) return "references-unchecked"
  const referenced = input.referencedByCode
  if (paths.some((path) => referenced(path))) return "referenced-by-code"
  if (file.status !== "renamed" && file.status !== "deleted") return undefined
  if (!input.referencesOldPath) return "references-unchecked"
  return input.referencesOldPath(file.oldPath ?? file.path) ? "still-referenced" : undefined
}

function docCodeLine(text: string, exts: ReadonlySet<string>) {
  const rules = [
    ...DOC_CODE,
    ...(exts.has("md") ? MDX_CODE : []),
    ...(exts.has("rst") ? RST_CODE : []),
    ...(exts.has("adoc") ? ADOC_CODE : []),
  ]
  return rules.some((rule) => (typeof rule === "function" ? rule(text) : rule.test(text)))
}

// The whole file on each side with changed lines: every line of a hunk must be the file's own, and no changed line may
// fall inside front matter, a fenced or delimited block, an indented block, a doctest, an MDX ESM or expression run, an
// HTML comment or a raw HTML block, which may start far outside the hunk.
function docTextRefusal(file: DiffFile, input: TrivialInput): TrivialRefusal | undefined {
  const sides = changedSides(file.hunks)
  if (!sides.length) return undefined
  const docText = input.docText
  if (!docText) return "doc-code-unchecked"
  for (const side of sides) {
    const path = sidePath(file, side)
    const text = docText(path, side)
    if (text === undefined) return "doc-code-unchecked"
    const lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
    const own = file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => onSide(line, side)))
    if (own.some((entry) => lines[entry.number - 1] !== entry.line.text)) return "doc-text-mismatch"
    const code = docCodeLines(lines, extension(path))
    if (own.some((entry) => entry.line.kind !== "context" && code.has(entry.number))) return "doc-code"
  }
  return undefined
}

// The lines of a doc that hold or hide code. Errs wide: an indented list paragraph counts as an indented block.
function docCodeLines(lines: readonly string[], ext: string): Set<number> {
  const fence = /^\s*(---|\+\+\+)\s*$/.exec(lines[0] ?? "")
  const front = fence ? lines.findIndex((line, index) => index > 0 && line.trim() === fence[1]) : -1
  const body = fence ? (front < 0 ? lines.length : front + 1) : 0
  // One pass with the state each format needs: an open block's closing test, and whether a run that a blank line ends
  // is open.
  return lines.reduce<DocState>(
    (state, line, index) => {
      const marked = (keep: boolean) => (keep ? state.code.add(index + 1) : state.code)
      if (index < body) return { ...state, code: marked(true) }
      if (state.close) return { close: state.close(line) ? undefined : state.close, run: state.run, code: marked(true) }
      const opened = openBlock(line, ext)
      if (opened) return { close: opened, run: state.run, code: marked(true) }
      if (!line.trim()) return { close: undefined, run: false, code: state.code }
      const run = state.run || startsRun(line, ext)
      return { close: undefined, run, code: marked(run || codeLine(line, ext)) }
    },
    { close: undefined, run: false, code: new Set<number>() },
  ).code
}

interface DocState {
  close: ((line: string) => boolean) | undefined
  run: boolean
  code: Set<number>
}

// The closing test of a block this line opens, if it opens one.
function openBlock(line: string, ext: string): ((line: string) => boolean) | undefined {
  const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
  if (fence) return (next) => new RegExp(`^\\s*\\${fence.charAt(0)}{${fence.length},}\\s*$`).test(next)
  if (ext === "adoc") {
    const delimiter = /^\s*(-{4,}|\.{4,}|\+{4,}|\/{4,}|={4,}|\*{4,}|_{4,}|\|===)\s*$/.exec(line)
    if (delimiter) return (next) => next.trim() === delimiter[1]
  }
  const comment = line.indexOf("<!--")
  if (comment >= 0 && !line.includes("-->", comment + 4)) return (next) => next.includes("-->")
  const tag = /<\s*(script|style|iframe|object|embed|form|svg|math|template)\b/i.exec(line)
  if (tag && !new RegExp(`</\\s*${tag[1]}\\s*>`, "i").test(line))
    return (next) => new RegExp(`</\\s*${tag[1]}\\s*>`, "i").test(next)
  return undefined
}

// A doctest, or in Markdown an MDX ESM block, expression or component, runs until the next blank line.
function startsRun(line: string, ext: string) {
  if (/^\s*(>>>|iex(\(\d+\))?>)/.test(line)) return true
  return ext === "md" && /^\s*(import\s|export\s|\{|<[A-Z])/.test(line)
}

function codeLine(line: string, ext: string) {
  if (/<!--|-->/.test(line)) return true
  if (ext === "md") return /^( {4}|\t)/.test(line)
  if (ext === "rst") return /^\s/.test(line) || RST_CODE.some((rule) => rule.test(line))
  return /^\s/.test(line) || ADOC_CODE.some((rule) => rule.test(line))
}

// ---------------------------------------------------------------------------------------------------------------------
// Renames of code: only a pure rename, in place, of a TypeScript, JavaScript or Python file that nothing imports by its
// old name and whose name no tool reads (tests, routes, conventional entry points). Java public classes, Go packages,
// Rust's module tree, PHP PSR-4, Rails autoloading and assets served by URL tie a name to behaviour, so their renames are
// never trivial.

const RENAME_EXTENSIONS = new Set("ts tsx mts cts js jsx mjs cjs py".split(" "))
const TEST_PATHS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/spec/**",
  "**/cypress/**",
  "**/conftest.py",
  "**/*.stories.*",
]
// Directories whose files a framework routes, registers or discovers by name.
const ROUTING_PATHS = [
  "**/pages/**",
  "**/app/**",
  "**/routes/**",
  "**/api/**",
  "**/functions/**",
  "**/netlify/**",
  "**/plugins/**",
  "**/middleware/**",
  "**/server/**",
  "**/commands/**",
  "**/locales/**",
  "**/i18n/**",
]
const CONVENTIONAL_NAMES = [
  "index.*",
  "main.*",
  "mod.*",
  "cli.*",
  "*.config.*",
  "*.d.ts",
  "*.d.mts",
  "*.d.cts",
  "*.server.*",
  "*.client.*",
  "*.worker.*",
  "+*",
  "middleware.*",
  "instrumentation.*",
  "setupTests.*",
  "jest.setup.*",
  "vitest.setup.*",
  "__init__.py",
  "__main__.py",
  "manage.py",
  "wsgi.py",
  "asgi.py",
  "settings.py",
  "urls.py",
  "models.py",
  "views.py",
  "admin.py",
  "apps.py",
  "tests.py",
  "signals.py",
  "tasks.py",
]

function renameRefusal(file: DiffFile, input: TrivialInput): TrivialRefusal | undefined {
  // GitHub omits a rename's patch, so its counts are read too.
  if (file.hunks.length || file.additions || file.deletions || file.patch.trim() || file.binary)
    return "rename-with-changes"
  const old = file.oldPath
  if (!old) return "references-unchecked"
  if (caseOnly(old, file.path)) return "case-only-rename"
  if (ignoredPath(file.path)) return "rename-into-ignored"
  const both = [old, file.path]
  if (both.some((path) => matches(path, TEST_PATHS))) return "test-path"
  if (both.some((path) => matches(path, ROUTING_PATHS))) return "routing-path"
  if (!RENAME_EXTENSIONS.has(extension(file.path)) || extension(old) !== extension(file.path))
    return "rename-unsupported"
  if (both.some((path) => CONVENTIONAL_NAMES.some((glob) => minimatch(basename(path), glob, GLOB))))
    return "conventional-name"
  if (dirname(old) !== dirname(file.path)) return "rename-moved"
  if (!input.referencesOldPath) return "references-unchecked"
  return input.referencesOldPath(old) ? "still-referenced" : undefined
}

// Case and Unicode normalization alone: case-insensitive file systems and git's core.ignorecase make these break
// imports on one machine and not another.
function caseOnly(a: string, b: string) {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase()
}

// A new path the default ignore rules would skip (build output, vendored, generated, snapshots), so every later change
// to the file would go unreviewed. The repository's own ignore globs come through `sensitive`.
function ignoredPath(path: string) {
  return classifyPath(path, { config: { ignore: [], ignoreDefaults: true } }) !== undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Whitespace and comments in a modified file, hunk by hunk. A hunk whose two sides hold the same lines once trailing
// spaces and tabs are stripped and blank lines dropped (leading whitespace kept) is a whitespace hunk; any other is
// read as a comment hunk.

// VS-25a's grammar set, minus the indentation-sensitive and the unparsed: Python, shell, PHP, markup and everything else
// are never whitespace-trivial.
const WHITESPACE_LANGUAGES = new Set("ts tsx mts cts js jsx mjs cjs go rs java".split(" "))
const COMMENT_LANGUAGES = new Set([...WHITESPACE_LANGUAGES, "py", "pyi"])

// Comments that change what tools, compilers or runtimes do: type checking, lint and format suppressions, build
// constraints and code generation, coverage, encodings and shebangs, licence headers bundlers keep, bundler and module
// hints, test environments and doctests. Matched anywhere in a line, case-insensitively: a false match only reviews.
const DIRECTIVES = [
  /@ts-/i,
  /eslint/i,
  /\/\*\s*(globals?|exported)\b/i,
  /prettier-ignore/i,
  /biome-ignore/i,
  /rome-ignore/i,
  /deno-(lint|fmt)-ignore/i,
  /dprint-ignore/i,
  /oxlint/i,
  /stylelint-/i,
  /jshint/i,
  /tslint:/i,
  /\/\/go:/i,
  /\/\/\s*\+build/i,
  /\/\/line /i,
  /nolint/i,
  /\/\/\s*lint:(file-)?ignore/i,
  /#\s*type:/i,
  /noqa/i,
  /pragma/i,
  /pylint:/i,
  /mypy:/i,
  /pyright:/i,
  /pyre-/i,
  /pytype:/i,
  /isort:/i,
  /fmt:\s*(off|on|skip)/i,
  /nosec/i,
  /yapf:/i,
  /rubocop:/i,
  /frozen_string_literal/i,
  /(istanbul|c8|v8)\s+ignore/i,
  /clang-format/i,
  /noinspection/i,
  /shellcheck/i,
  /nosemgrep/i,
  /nosonar/i,
  /lgtm/i,
  /codeql/i,
  /checkstyle/i,
  /spotless:/i,
  /ktlint/i,
  /detekt/i,
  /cspell/i,
  /^\s*#!/,
  /coding[:=]/i,
  /vim:/i,
  /-\*-/,
  /spdx-license-identifier/i,
  /copyright/i,
  /licen[cs]e/i,
  /@preserve/i,
  /__PURE__/,
  /__NO_SIDE_EFFECTS__/,
  /webpack/i,
  /turbopack/i,
  /@swc/i,
  /@vite-ignore/i,
  /\/\/\/\s*<(reference|amd-)/i,
  /@jsx/i,
  /@flow/i,
  /@internal/i,
  /@deprecated\b/i,
  /@refresh/i,
  /@(jest|vitest)-environment/i,
  /sourceMappingURL/i,
  /sourceURL/i,
  />>>/,
  /iex>/,
  /\/\/~/,
  /\/\/@/,
  /compile-flags/i,
]
// Rust doc comments, which rustdoc tests; JSDoc types, which checkJs reads in JavaScript; Java's unicode escapes, which
// turn comment text into code before lexing; cgo preambles and markers, Go linker and syscall directives, Example
// output, which `go test` compares, and Deprecated paragraphs, which staticcheck (SA1019) fails callers on. `@deprecated`
// (javac's deprecation lint under -Werror, `no-deprecated` lint rules) is in DIRECTIVES.
const RUST_DOC = /^\s*(\/\/\/(?!\/)|\/\/!|\/\*\*(?![*/])|\/\*!)/
const EXTRA_DIRECTIVES: Record<string, readonly RegExp[]> = {
  rs: [RUST_DOC],
  js: jsdoc(),
  jsx: jsdoc(),
  mjs: jsdoc(),
  cjs: jsdoc(),
  java: [/\\u+[0-9a-f]{4}/i],
  go: [
    /\bimport\s+"C"/,
    /^\s*"C"\s*$/,
    /#\s*(cgo|include|define)\b/,
    /\/\/\s*(unordered output|output):/i,
    /^\s*\/\/(export|extern|sys|sysnb)\b/,
    /\bDeprecated:/,
  ],
}

function jsdoc() {
  return [
    /@(type|typedef|template|satisfies|import|callback|enum|this|overload|extends|augments|implements)\b/,
    /@(param|returns?|property|prop|arg|argument)\s*\{/,
  ]
}

function directive(text: string, ext: string) {
  return (
    DIRECTIVES.some((rule) => rule.test(text)) ||
    (EXTRA_DIRECTIVES[ext] ?? []).some((rule) => rule.test(text)) ||
    hasGeneratedHeader(text)
  )
}

type Sides<T> = Record<Side, T | undefined>

// One side's comment ranges by line: the comment text each range covering a line puts on it, in source order, and the
// last line of the run of consecutive comment lines it is in. Built once per side, so every check below is a lookup
// and a file with many comments costs time linear in their text.
interface CommentIndex {
  pieces: Map<number, { range: CommentRange; text: string }[]>
  runEnd: Map<number, number>
}

function hunkKinds(file: DiffFile, input: TrivialInput): TrivialRefusal | TrivialKind[] {
  const ext = extension(file.path)
  // Ranges are asked for only in a language that can pass.
  const commentsOn = (side: Side) =>
    COMMENT_LANGUAGES.has(ext) ? indexComments(commentRanges(input.comments?.(sidePath(file, side), side))) : undefined
  const stringsOn = (side: Side) =>
    WHITESPACE_LANGUAGES.has(ext) ? stringCover(stringRanges(input.strings?.(sidePath(file, side), side))) : undefined
  const comments: Sides<CommentIndex> = { LEFT: commentsOn("LEFT"), RIGHT: commentsOn("RIGHT") }
  const strings: Sides<(line: number) => boolean> = { LEFT: stringsOn("LEFT"), RIGHT: stringsOn("RIGHT") }
  const kinds = new Set<TrivialKind>()
  for (const [index, hunk] of file.hunks.entries()) {
    if (!changedSides([hunk]).length) return "no-text-change"
    const whitespace = sameText(hunk)
    const refusal = whitespace
      ? whitespaceRefusal(file, hunk, index, ext, comments, strings)
      : commentRefusal(file, hunk, index, ext, comments)
    if (refusal) return refusal
    kinds.add(whitespace ? "whitespace" : "comment")
  }
  if (kinds.has("comment") && !sameStructure(file, comments)) return "comment-structure"
  return [...kinds]
}

function sameText(hunk: DiffHunk) {
  const side = (kind: DiffLine["kind"]) =>
    hunk.lines
      .filter((line) => line.kind === "context" || line.kind === kind)
      .map((line) => trimEnd(line.text))
      .filter((text) => text !== "")
  return JSON.stringify(side("del")) === JSON.stringify(side("add"))
}

function whitespaceRefusal(
  file: DiffFile,
  hunk: DiffHunk,
  index: number,
  ext: string,
  comments: Sides<CommentIndex>,
  strings: Sides<(line: number) => boolean>,
): TrivialRefusal | undefined {
  if (!WHITESPACE_LANGUAGES.has(ext)) return "language"
  const sides = changedSides([hunk])
  if (sides.some((side) => !strings[side])) return "strings-unchecked"
  // Go Example output and Rust doctests keep whitespace inside comments, and cgo reads Go comments, so those two need
  // the comment ranges too.
  const commented = ext === "go" || ext === "rs"
  if (commented && sides.some((side) => !comments[side])) return "comments-unchecked"
  if (!hasContext(file, hunk, index)) return "hunk-context"
  if (hunk.lines.some((line) => trimEnd(line.text).endsWith("\\"))) return "line-continuation"
  if (hunk.lines.some((line) => directive(line.text, ext))) return "directive"
  const changed = hunk.lines.flatMap((line) => (line.kind === "context" ? [] : sideLines(line)))
  if (changed.some((entry) => strings[entry.side]?.(entry.number))) return "string-literal"
  if (!commented) return undefined
  // Every hunk line, context included, on a side whose ranges are known, so a blank line beside a doc comment or an
  // Example's output counts too.
  const lines = hunk.lines.flatMap((line) => sideLines(line, comments))
  const covered = (entry: { side: Side; number: number }, test: (range: CommentRange) => boolean) =>
    (comments[entry.side]?.pieces.get(entry.number) ?? []).some((piece) => test(piece.range))
  if (ext === "rs" && lines.some((entry) => covered(entry, (range) => RUST_DOC.test(range.text)))) return "directive"
  if (goTest(file.path) && lines.some((entry) => covered(entry, () => true))) return "directive"
  if (ext === "go" && preambleUnseen(hunk, comments)) return "hunk-context"
  return undefined
}

function commentRefusal(
  file: DiffFile,
  hunk: DiffHunk,
  index: number,
  ext: string,
  comments: Sides<CommentIndex>,
): TrivialRefusal | undefined {
  if (!COMMENT_LANGUAGES.has(ext)) return "language"
  if (!comments.LEFT || !comments.RIGHT) return "comments-unchecked"
  if (!hasContext(file, hunk, index)) return "hunk-context"
  // A backslash at the end of a line continues it onto the next, which a comment line cannot be in Python (a syntax
  // error) and which a C or C++ line comment, a cgo preamble's included, swallows. hasContext shows the line before.
  if (hunk.lines.some((line) => trimEnd(line.text).endsWith("\\"))) return "line-continuation"
  // Example functions compare their output comments, so no comment in a Go test file is trivial.
  if (goTest(file.path)) return "directive"
  const changed = hunk.lines.flatMap((line) => (line.kind === "context" ? [] : sideLines(line)))
  if (changed.some((entry) => !commentOnly(entry.line.text, comments[entry.side], entry.number))) return "code"
  if (hunk.lines.some((line) => directive(line.text, ext))) return "directive"
  // Each range a changed line touches, read once however many of its lines changed.
  const touched = new Set(
    changed.flatMap((entry) => (comments[entry.side]?.pieces.get(entry.number) ?? []).map((piece) => piece.range)),
  )
  if ([...touched].some((range) => range.text.split("\n").some((text) => directive(text, ext)))) return "directive"
  if (ext === "go" && preambleUnseen(hunk, comments)) return "hunk-context"
  return undefined
}

// Whether a changed line is comment and nothing else: every non-blank character of it lies in the pieces of the
// comment ranges that cover it, in order. A blank line counts only inside a comment.
function commentOnly(text: string, comments: CommentIndex | undefined, number: number) {
  const pieces = (comments?.pieces.get(number) ?? []).map((piece) => piece.text)
  if (!text.trim()) return pieces.length > 0
  const end = pieces.reduce<number | undefined>((cursor, piece) => {
    if (cursor === undefined) return undefined
    const at = text.indexOf(piece, cursor)
    return at < 0 || text.slice(cursor, at).trim() ? undefined : at + piece.length
  }, 0)
  return pieces.length > 0 && end !== undefined && !text.slice(end).trim()
}

// cgo compiles the comment right above `import "C"` as C (its preamble), and a blank line ends a comment group. So in
// Go the line after each comment run that holds a changed line, or that a changed blank line borders, must be in the
// hunk, where `directive` sees an `import "C"`. A run's end comes from the whole file's ranges, so a change more than
// the context away from the end of a long doc comment is refused too: an error toward reviewing.
function preambleUnseen(hunk: DiffHunk, comments: Sides<CommentIndex>) {
  const shown: Record<Side, Set<number>> = {
    LEFT: new Set(hunk.lines.flatMap((line) => line.oldLine ?? [])),
    RIGHT: new Set(hunk.lines.flatMap((line) => line.newLine ?? [])),
  }
  return hunk.lines
    .flatMap((line) => (line.kind === "context" ? [] : sideLines(line)))
    .some((entry) => {
      const index = comments[entry.side]
      if (!index) return true
      // The run a changed comment line is in, or the runs a changed blank line outside a comment borders.
      const near = index.pieces.has(entry.number)
        ? [entry.number]
        : entry.line.text.trim()
          ? []
          : [entry.number - 1, entry.number + 1]
      return near.some((line) => {
        const end = index.runEnd.get(line)
        return end !== undefined && !shown[entry.side].has(end + 1)
      })
    })
}

// Every unchanged line holds the same comment text on both sides, over the whole file: a change that comments out or
// uncomments code, or closes a block comment early, changes some unchanged line's comment text.
function sameStructure(file: DiffFile, comments: Sides<CommentIndex>) {
  const left = comments.LEFT
  const right = comments.RIGHT
  if (!left || !right) return false
  const key = (side: CommentIndex, number: number) =>
    JSON.stringify((side.pieces.get(number) ?? []).map((piece) => piece.text))
  const toRight = otherSide(file, "LEFT")
  const toLeft = otherSide(file, "RIGHT")
  const forward = [...left.pieces.keys()].every((number) => {
    const to = toRight(number)
    return to === undefined || key(left, number) === key(right, to)
  })
  return (
    forward &&
    [...right.pieces.keys()].every((number) => {
      const from = toLeft(number)
      return from === undefined || key(left, from) === key(right, number)
    })
  )
}

// Where a line of one side is on the other, or undefined when the change removed it from there: mapLine (diff.ts) in
// either direction, with the hunk found by bisection and its lines read from a map, so mapping every commented line of
// a file with many hunks stays near linear.
function otherSide(file: DiffFile, from: Side): (line: number) => number | undefined {
  // A side with no lines names the line before the change, so its first line is start + 1.
  const span = (start: number, count: number) => ({
    first: count === 0 ? start + 1 : start,
    next: count === 0 ? start + 1 : start + count,
  })
  const spans = file.hunks.map((hunk) => {
    const old = span(hunk.oldStart, hunk.oldLines)
    const now = span(hunk.newStart, hunk.newLines)
    const own = from === "LEFT" ? old : now
    const other = from === "LEFT" ? now : old
    return { first: own.first, next: own.next, offset: other.next - own.next }
  })
  const firsts = spans.map((span) => span.first)
  const inside = new Map(
    file.hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => {
        const own = from === "LEFT" ? line.oldLine : line.newLine
        const other = from === "LEFT" ? line.newLine : line.oldLine
        return own === undefined ? [] : [[own, line.kind === "context" ? other : undefined] as const]
      }),
    ),
  )
  return (line) => {
    const at = lastAtOrBelow(firsts, line)
    if (at < 0) return line
    if (line < spans[at].next) return inside.get(line)
    return line + spans[at].offset
  }
}

// Each hunk shows at least one unchanged line before and after its change, so a directive next to it is seen: a hunk
// at the top of the file needs none before, and the last hunk none after when its first line proves the diff had
// context (or its last line ends the file). A diff made with -U0 is refused.
function hasContext(file: DiffFile, hunk: DiffHunk, index: number) {
  const first = hunk.lines[0]
  const last = hunk.lines.at(-1)
  const leading = first?.kind === "context" || (index === 0 && (hunk.oldStart <= 1 || hunk.newStart <= 1))
  const trailing =
    last?.kind === "context" ||
    (index === file.hunks.length - 1 && (first?.kind === "context" || last?.noNewline === true))
  return leading && trailing
}

function goTest(path: string) {
  return path.toLowerCase().endsWith("_test.go")
}

// A provider's ranges, or undefined when there are none or any range is malformed: whole lines from 1, an end at or
// after the start, and for a comment one text line per source line.
function stringRanges(ranges: readonly SourceRange[] | undefined) {
  if (!ranges || !ranges.every(validRange)) return undefined
  return ranges
}

function commentRanges(ranges: readonly CommentRange[] | undefined) {
  if (!ranges) return undefined
  const valid = ranges.every(
    (range) =>
      validRange(range) &&
      typeof range.text === "string" &&
      range.text.split("\n").length === range.end - range.start + 1,
  )
  return valid ? ranges : undefined
}

function validRange(range: SourceRange) {
  return Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 1 && range.end >= range.start
}

function indexComments(ranges: readonly CommentRange[] | undefined): CommentIndex | undefined {
  if (!ranges) return undefined
  const pieces = new Map<number, { range: CommentRange; text: string }[]>()
  ranges
    .toSorted((a, b) => a.start - b.start)
    .forEach((range) =>
      range.text.split("\n").forEach((text, offset) => {
        const list = pieces.get(range.start + offset) ?? []
        if (!list.length) pieces.set(range.start + offset, list)
        list.push({ range, text: text.replace(/\r$/, "") })
      }),
    )
  // From the last line up, so a line's successor is settled first.
  const runEnd = [...pieces.keys()]
    .toSorted((a, b) => b - a)
    .reduce((ends, line) => ends.set(line, ends.get(line + 1) ?? line), new Map<number, number>())
  return { pieces, runEnd }
}

// Whether a line is inside a string literal of one side (start <= line < end for some range), or undefined without
// ranges. Sorted once, with the furthest end reached so far, so each line is one bisection.
function stringCover(ranges: readonly SourceRange[] | undefined): ((line: number) => boolean) | undefined {
  if (!ranges) return undefined
  const sorted = ranges.toSorted((a, b) => a.start - b.start)
  const starts = sorted.map((range) => range.start)
  const reach = sorted.reduce<number[]>((ends, range) => {
    ends.push(Math.max(ends.at(-1) ?? 0, range.end))
    return ends
  }, [])
  return (line) => {
    const at = lastAtOrBelow(starts, line)
    return at >= 0 && line < reach[at]
  }
}

// The index of the last of `values`, sorted ascending, at or below `target`, or -1.
function lastAtOrBelow(values: readonly number[], target: number): number {
  const search = (low: number, high: number): number => {
    if (low > high) return high
    const middle = (low + high) >> 1
    return values[middle] <= target ? search(middle + 1, high) : search(low, middle - 1)
  }
  return search(0, values.length - 1)
}

// The text without its trailing spaces and tabs (and no other whitespace), walked back from its end: the pattern
// /[ \t]+$/ backtracks quadratically on a long run of them followed by another character.
function trimEnd(text: string) {
  return text.slice(0, text.split("").findLastIndex((char) => char !== " " && char !== "\t") + 1)
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function changedSides(hunks: readonly DiffHunk[]): Side[] {
  const lines = hunks.flatMap((hunk) => hunk.lines)
  return [
    ...(lines.some((line) => line.kind === "del") ? ["LEFT" as const] : []),
    ...(lines.some((line) => line.kind === "add") ? ["RIGHT" as const] : []),
  ]
}

// A diff line's place on a side: a deleted line on the left, an added one on the right, an unchanged one on both.
function onSide(line: DiffLine, side: Side): { line: DiffLine; number: number }[] {
  const number = side === "LEFT" ? line.oldLine : line.newLine
  return number === undefined ? [] : [{ line, number }]
}

// A diff line's side and number: its own side when it changed; an unchanged line on the right when `known` has that
// side's ranges, else on the left, when given.
function sideLines(line: DiffLine, known?: Sides<unknown>): { line: DiffLine; side: Side; number: number }[] {
  const side: Side =
    line.kind === "del" ? "LEFT" : line.kind === "add" ? "RIGHT" : known && !known.RIGHT ? "LEFT" : "RIGHT"
  return onSide(line, side).map((entry) => ({ ...entry, side }))
}

function sidePath(file: DiffFile, side: Side) {
  return side === "LEFT" ? (file.oldPath ?? file.path) : file.path
}

function matches(path: string, globs: readonly string[]) {
  return globs.some((glob) => minimatch(path, glob, GLOB))
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

function dirname(path: string) {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")))
}

// The text after a file name's last dot, lower-cased; none for a name with no dot after its first character.
function extension(path: string) {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}
