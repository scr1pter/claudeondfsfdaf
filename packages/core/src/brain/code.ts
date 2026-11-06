export * as BrainCode from "./code"

import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { Minimatch } from "minimatch"
import { BrainAnchor } from "./anchor"

// What code says about itself, read without running it: the symbols a file declares, what it imports and which files
// those imports are, the routes it registers, the environment variables it reads and the constants it gives a value.
// Regular expressions per language rather than a parser of each one: fast enough for 20,000 files, and wrong only in
// ways that cost a link, never a crash. The desktop's file ranking and the brain's code graph read code the same way.

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "struct"
  | "trait"
  | "module"

/** A name a file declares, with its kind and line. */
export type Declaration = {
  name: string
  kind: SymbolKind
  line: number
  exported: boolean
}

export type Language =
  | "typescript"
  | "markup"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "php"
  | "c"
  | "css"
  | "text"

/** A value code gives in a literal: a route it registers, an environment variable it reads, a constant it defines. */
export type Literal = {
  readonly kind: "route" | "env" | "constant"
  /** The route's shape (`/v1/users/*`), the variable's name, or the constant's name. */
  readonly value: string
  /** A route's method, when the registration gives one. */
  readonly method?: string
  readonly line: number
}

export const LIMIT = {
  /** A file larger than this is generated or data, not code anyone reads. */
  bytes: 768 * 1024,
  symbols: 400,
  imports: 200,
  dependencies: 256,
  literals: 200,
  /** Commits of history co-change reads. */
  commits: 400,
  // A thousand-file refactor commit says nothing about which files belong together, so wide commits are dropped
  // rather than diluting every pair.
  commitFiles: 32,
  neighbours: 16,
} as const

// The trailing entries are additions to the usual set: "out" holds bundled electron-vite output in this repository,
// and a bundle restates every symbol its sources declare, so reading it buries the sources it was built from.
export const EXCLUDED: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  ".dart_tool",
  ".gradle",
  ".mypy_cache",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".svelte-kit",
  ".tox",
  ".venv",
  "__pycache__",
  "bower_components",
  "out",
  "venv",
])

const LANGUAGES = new Map<string, Language>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "typescript"],
  [".jsx", "typescript"],
  [".mjs", "typescript"],
  [".cjs", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".vue", "markup"],
  [".svelte", "markup"],
  [".astro", "markup"],
  [".html", "markup"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "java"],
  [".kts", "java"],
  [".rb", "ruby"],
  [".php", "php"],
  [".c", "c"],
  [".cc", "c"],
  [".cpp", "c"],
  [".cxx", "c"],
  [".h", "c"],
  [".hpp", "c"],
  [".m", "c"],
  [".mm", "c"],
  [".cs", "java"],
  [".swift", "typescript"],
  [".css", "css"],
  [".scss", "css"],
  [".sass", "css"],
  [".less", "css"],
  [".md", "text"],
  [".mdx", "text"],
  [".json", "text"],
  [".yaml", "text"],
  [".yml", "text"],
  [".toml", "text"],
  [".sql", "text"],
  [".sh", "text"],
])

const NAMED = new Set(["Dockerfile", "Makefile", "Procfile"])

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
  ".astro",
  ".json",
]

export const INDEX_FILES = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "__init__.py",
  "mod.rs",
  "lib.rs",
  "index.php",
]

const RESERVED = new Set([
  "case",
  "catch",
  "class",
  "const",
  "default",
  "do",
  "else",
  "enum",
  "for",
  "function",
  "if",
  "return",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "while",
  "with",
])

type SymbolRule = {
  pattern: RegExp
  kind: SymbolKind
  name: number
  exported?: number
  exportedWhenBlank?: boolean
  exportedWhenCapitalised?: boolean
}

const TYPESCRIPT_SYMBOLS: SymbolRule[] = [
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    kind: "function",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    kind: "class",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
    kind: "interface",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
    kind: "type",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
    kind: "enum",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    kind: "constant",
    name: 2,
    exported: 1,
  },
  {
    pattern:
      /^[ \t]{2,}(?:(?:public|private|protected|static|readonly|override|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*[:{]/gm,
    kind: "method",
    name: 1,
  },
]

const SYMBOL_RULES: Record<Language, SymbolRule[]> = {
  typescript: TYPESCRIPT_SYMBOLS,
  markup: TYPESCRIPT_SYMBOLS,
  python: [
    { pattern: /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: "function", name: 2, exportedWhenBlank: true },
    { pattern: /^([ \t]*)class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 2, exportedWhenBlank: true },
    { pattern: /^()([A-Z_][A-Z0-9_]{2,})\s*(?::[^=]+)?=/gm, kind: "constant", name: 2, exportedWhenBlank: true },
  ],
  go: [
    {
      pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
      kind: "function",
      name: 1,
      exportedWhenCapitalised: true,
    },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm, kind: "struct", name: 1, exportedWhenCapitalised: true },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm, kind: "interface", name: 1, exportedWhenCapitalised: true },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+(?!struct\b|interface\b)/gm, kind: "type", name: 1, exportedWhenCapitalised: true },
    { pattern: /^(?:var|const)\s+([A-Za-z_]\w*)/gm, kind: "constant", name: 1, exportedWhenCapitalised: true },
  ],
  rust: [
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: "function", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm, kind: "struct", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm, kind: "trait", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm, kind: "enum", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/gm, kind: "type", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/gm, kind: "module", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Za-z_]\w*)/gm, kind: "constant", name: 2, exported: 1 },
  ],
  java: [
    {
      pattern: /^[ \t]*(public\s+)?(?:static\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm,
      kind: "class",
      name: 2,
      exported: 1,
    },
    {
      pattern:
        /^[ \t]+(public\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w.<>,\[\]]+\s+([A-Za-z_]\w*)\s*\([^()]*\)\s*[{;]/gm,
      kind: "method",
      name: 2,
      exported: 1,
    },
  ],
  ruby: [
    { pattern: /^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm, kind: "function", name: 1 },
    { pattern: /^[ \t]*class\s+([A-Z][\w:]*)/gm, kind: "class", name: 1, exportedWhenCapitalised: true },
    { pattern: /^[ \t]*module\s+([A-Z][\w:]*)/gm, kind: "module", name: 1, exportedWhenCapitalised: true },
  ],
  php: [
    {
      pattern: /^[ \t]*(?:(public|private|protected)\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)/gm,
      kind: "function",
      name: 2,
    },
    { pattern: /^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 1 },
    { pattern: /^[ \t]*interface\s+([A-Za-z_]\w*)/gm, kind: "interface", name: 1 },
    { pattern: /^[ \t]*trait\s+([A-Za-z_]\w*)/gm, kind: "trait", name: 1 },
  ],
  c: [
    { pattern: /^[ \t]*(?:typedef\s+)?(?:struct|union)\s+([A-Za-z_]\w*)/gm, kind: "struct", name: 1 },
    { pattern: /^[ \t]*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/gm, kind: "enum", name: 1 },
    { pattern: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 1 },
    { pattern: /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;()]*\)\s*\{/gm, kind: "function", name: 1 },
    { pattern: /^[ \t]*#define\s+([A-Z_][A-Z0-9_]*)/gm, kind: "constant", name: 1 },
  ],
  css: [{ pattern: /^[ \t]*(?:\.|#)([A-Za-z][\w-]{2,})/gm, kind: "constant", name: 1 }],
  text: [{ pattern: /^#{1,4}\s+([A-Za-z][\w -]{2,})/gm, kind: "module", name: 1 }],
}

const TYPESCRIPT_IMPORTS = [
  /(?:^|[\s;}])(?:import|export)\s[^;'"]{0,240}?from\s*["']([^"']+)["']/g,
  /(?:^|[\s;=(,])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[\s;=(,])require\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^[ \t]*import\s+["']([^"']+)["']/gm,
]

const IMPORT_PATTERNS: Record<Language, RegExp[]> = {
  typescript: TYPESCRIPT_IMPORTS,
  markup: [...TYPESCRIPT_IMPORTS, /(?:src|href)\s*=\s*["']([^"'#?]+)["']/g, /@import\s+["']([^"']+)["']/g],
  python: [/^[ \t]*from\s+([.\w]+)\s+import\s/gm, /^[ \t]*import\s+([.\w]+)/gm],
  go: [],
  rust: [/^[ \t]*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm, /^[ \t]*(?:pub\s+)?use\s+([\w:]+)/gm],
  java: [/^[ \t]*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
  ruby: [/^[ \t]*require(?:_relative)?\s*\(?\s*["']([^"']+)["']/gm],
  php: [/^[ \t]*use\s+([\w\\]+)/gm, /(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g],
  c: [/^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm],
  css: [/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g],
  text: [],
}

// Environment reads by language. Deno's `Deno.env.get("X")` is its own form, so `Deno.env.get` is never read as a
// variable called "get".
const ENV_READS = [
  /(?:process\.env|Bun\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
  /(?:process\.env|Bun\.env|import\.meta\.env|Deno\.env)\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
  /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /\b(?:getenv|env::var)\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
]

// A line holding a string that starts with a path, the only kind of line that can register a route.
const ROUTE_LINE = /^.*["'`](?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?\/.*$/gm

/** The language a file is read as, or undefined when it is not one Vector reads as code. */
export function language(file: string): Language | undefined {
  const name = path.posix.basename(file.replaceAll("\\", "/"))
  return LANGUAGES.get(path.extname(name).toLowerCase()) ?? (NAMED.has(name) ? "text" : undefined)
}

/** Whether a repository path sits in a folder of dependencies, build output or caches. */
export function excluded(file: string) {
  return file.split("/").slice(0, -1).some((segment) => EXCLUDED.has(segment))
}

/** The symbols a file declares, at most `LIMIT.symbols`, in line order; one per kind and name. */
export function symbols(text: string, language: Language) {
  const offsets = lineOffsets(text)
  const found = new Map<string, Declaration>()
  for (const rule of SYMBOL_RULES[language]) {
    for (const match of text.matchAll(rule.pattern)) {
      if (found.size >= LIMIT.symbols) break
      const name = match[rule.name]
      if (!name || name.length < 2 || RESERVED.has(name)) continue
      const key = `${rule.kind}:${name}`
      if (found.has(key)) continue
      found.set(key, {
        name,
        kind: rule.kind,
        line: lineAt(offsets, match.index ?? 0),
        exported: rule.exportedWhenCapitalised
          ? /^[A-Z]/.test(name)
          : rule.exportedWhenBlank
            ? !match[rule.exported ?? 1]
            : Boolean(rule.exported && match[rule.exported]),
      })
    }
  }
  return [...found.values()].sort((left, right) => left.line - right.line)
}

/** What a file imports, as written: module specifiers, include paths, `use` paths. */
export function imports(text: string, language: Language) {
  const found = new Set<string>()
  // Go groups its imports in a parenthesised block whose entries are bare strings, so the block has to be isolated
  // before the strings inside it can be told apart from any other quoted literal in the file.
  if (language === "go") {
    for (const block of text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
      for (const entry of block[1]!.matchAll(/"([^"]+)"/g)) found.add(entry[1]!)
    }
    for (const single of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) found.add(single[1]!)
    return [...found].slice(0, LIMIT.imports)
  }
  for (const pattern of IMPORT_PATTERNS[language]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) found.add(value)
    }
  }
  return [...found].slice(0, LIMIT.imports)
}

/**
 * The 1-based lines of the import statements `imports` reads (VS-25b), so a whole-word match can tell an import from a
 * use: every line a match spans, from the statement's keyword. A TypeScript `import … from` match can run on from an
 * earlier `export` line that has no quote or semicolon, so it starts at its last `import` or `export`; Python's
 * parenthesised `from X import (…)` list spans its lines.
 */
export function importLines(text: string, language: Language) {
  const offsets = lineOffsets(text)
  const patterns =
    language === "go"
      ? GO_IMPORT_LINES
      : language === "python"
        ? [...IMPORT_PATTERNS.python, PYTHON_LIST]
        : IMPORT_PATTERNS[language]
  return new Set(
    patterns.flatMap((pattern) =>
      [...text.matchAll(pattern)].flatMap((match) => {
        const at = (match.index ?? 0) + statementStart(match[0])
        const first = lineAt(offsets, at)
        const last = lineAt(offsets, (match.index ?? 0) + Math.max(0, match[0].length - 1))
        return Array.from({ length: last - first + 1 }, (_, index) => first + index)
      }),
    ),
  )
}

const GO_IMPORT_LINES = [/^import\s*\(([\s\S]*?)^\)/gm, /^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm]
const PYTHON_LIST = /^[ \t]*from\s+[.\w]+\s+import\s*\([^)]*\)/gm

// Where a match's statement starts: at its last `import` or `export` keyword, else at its first character that is not
// the delimiter its pattern allows before the keyword.
function statementStart(match: string) {
  const last = [...match.matchAll(/(?:^|[\s;}])(import|export)\s/g)].at(-1)
  if (last) return (last.index ?? 0) + last[0].indexOf(last[1] ?? "")
  return Math.max(0, match.search(/[^\s;}=(,]/))
}

/**
 * The routes a file registers, the environment variables it reads and the constants it gives a plain numeric value,
 * each with its line: what a document names that a symbol table does not hold.
 */
export function literals(text: string, declared: readonly Declaration[]): Literal[] {
  const offsets = lineOffsets(text)
  const found = new Map<string, Literal>()
  const add = (literal: Literal) => {
    const key = `${literal.kind}\0${literal.method ?? ""}\0${literal.value}\0${literal.line}`
    if (found.size < LIMIT.literals && !found.has(key)) found.set(key, literal)
  }
  for (const match of text.matchAll(ROUTE_LINE))
    for (const route of BrainAnchor.routes(match[0]))
      add({ kind: "route", value: route.route, ...(route.method ? { method: route.method } : {}), line: lineAt(offsets, match.index) })
  for (const pattern of ENV_READS)
    for (const match of text.matchAll(pattern)) add({ kind: "env", value: match[1]!, line: lineAt(offsets, match.index) })
  for (const symbol of declared) {
    if (symbol.kind !== "constant") continue
    const line = text.slice(offsets[symbol.line - 1], offsets[symbol.line] ?? text.length).replace(/\r?\n$/, "")
    if (BrainAnchor.value(line, symbol.name)) add({ kind: "constant", value: symbol.name, line: symbol.line })
  }
  return [...found.values()].sort((left, right) => left.line - right.line || left.value.localeCompare(right.value))
}

export type Lookup = {
  readonly paths: ReadonlySet<string>
  readonly byStem: ReadonlyMap<string, readonly string[]>
  readonly byDirectory: ReadonlyMap<string, readonly string[]>
}

/** The files of a repository by path, by name without extension, and by the folder they sit in. */
export function lookup(files: readonly string[]): Lookup {
  const byStem = new Map<string, string[]>()
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const name = file.split("/").at(-1)!
    const stem = name.slice(0, name.length - path.extname(name).length).toLowerCase()
    const stems = byStem.get(stem) ?? []
    stems.push(file)
    byStem.set(stem, stems)
    const directory = path.posix.dirname(file).split("/").at(-1)!.toLowerCase()
    const siblings = byDirectory.get(directory) ?? []
    siblings.push(file)
    byDirectory.set(directory, siblings)
  }
  return { paths: new Set(files), byStem, byDirectory }
}

/**
 * A package of the repository's JavaScript workspace (VS-25b): its `name`, its folder (repository-relative, "" for the
 * root), and the subpaths its `exports` maps, each with its targets in the order they are tried. `encapsulated` is
 * whether the manifest has an `exports` field: without one, any subpath is a file under the folder, and "." is `main`,
 * then `module`, then the folder's index file. `dependencies` names every package its manifest depends on.
 */
export type WorkspacePackage = {
  readonly name: string
  readonly directory: string
  readonly encapsulated: boolean
  readonly exports: readonly (readonly [subpath: string, targets: readonly string[]])[]
  readonly dependencies: readonly string[]
}

/**
 * The `compilerOptions.paths` of one tsconfig.json or jsconfig.json (VS-25b), for the files under its `directory`.
 * `base` is where its targets and, with `baseUrl`, bare specifiers are read from: its baseUrl, or its own folder.
 */
export type PathAliases = {
  readonly directory: string
  readonly base: string
  readonly baseUrl: boolean
  readonly paths: readonly (readonly [pattern: string, targets: readonly string[]])[]
}

/**
 * What a repository's manifests say about how its TypeScript and JavaScript files name each other: the workspace
 * packages and the path aliases. `ambiguous` holds names more than one member manifest claims, which resolve no import.
 * `truncated` is whether a WORKSPACE_LIMIT cap or the deadline left something out.
 */
export type Workspace = {
  readonly packages: readonly WorkspacePackage[]
  readonly aliases: readonly PathAliases[]
  readonly ambiguous: readonly string[]
  readonly truncated: boolean
}

/**
 * Bounds on what a repository's manifests can make `workspace` and `resolve` do (VS-25b). On a fork pull request the
 * manifests are the head's, so their author writes them. Past a cap the first entries in path order are kept and
 * `Workspace.truncated` is set. A member glob is compiled once, without extglobs and with at most `expansions` brace
 * expansions, and is dropped when it is longer than `globChars` or a segment other than `**` holds more than one `*`:
 * minimatch's patterns backtrack, and `*a*a*c` took 28 s against a folder name of 1,000 characters. A folder whose
 * path is longer than `directoryChars`, or has a name longer than `nameChars`, is not a member.
 */
export const WORKSPACE_LIMIT = {
  globs: 64,
  globChars: 256,
  expansions: 16,
  directoryChars: 1_024,
  nameChars: 255,
  manifests: 5_000, // package.json files outside the root matched against the globs
  packages: 2_000, // member manifests read
  aliases: 2_000, // tsconfig.json and jsconfig.json files read
  entries: 256, // `paths` patterns of one tsconfig, `exports` subpaths of one package
} as const

/**
 * The workspace a repository's manifests describe, read from their texts by repository path: every `package.json`,
 * `tsconfig.json` and `jsconfig.json`, and the root's `pnpm-workspace.yaml`. A manifest in an excluded folder
 * (node_modules, build output), over `LIMIT.bytes`, or that does not parse as a JSON object is skipped. When the root
 * `package.json` names `workspaces` (a list, or `{ packages }`) or `pnpm-workspace.yaml` lists `packages`, only the
 * root and the folders those globs match are members; otherwise every manifest is. A tsconfig's `extends` is not
 * followed. Packages are sorted by name, then folder; aliases by folder. Bounded by WORKSPACE_LIMIT, and deterministic
 * unless `deadline` (a `performance.now()` time) passes first: then what is left is not read, and `truncated` is set.
 */
export function workspace(
  manifests: readonly { readonly path: string; readonly text: string }[],
  options: { readonly deadline?: number } = {},
): Workspace {
  const texts = new Map(
    manifests
      .filter((manifest) => !excluded(manifest.path) && manifest.text.length <= LIMIT.bytes)
      .map((manifest) => [manifest.path, manifest.text] as const)
      .toSorted((a, b) => compare(a[0], b[0])),
  )
  const clock = { expired: false }
  const within = () => {
    if (!clock.expired && options.deadline !== undefined && performance.now() >= options.deadline) clock.expired = true
    return !clock.expired
  }
  const declared = memberGlobs(texts)
  const globs = declared?.filter(safeGlob).slice(0, WORKSPACE_LIMIT.globs).map(compileGlob)
  const nested = [...texts.keys()].filter(
    (file) => file !== "package.json" && path.posix.basename(file) === "package.json",
  )
  const examined = nested.slice(0, WORKSPACE_LIMIT.manifests)
  const matched = examined.filter(
    (file) => within() && (!globs || (safeDirectory(directoryOf(file)) && isMember(directoryOf(file), globs, within))),
  )
  const read = matched.slice(0, WORKSPACE_LIMIT.packages)
  const members = [...(texts.has("package.json") ? ["package.json"] : []), ...read].flatMap((file) =>
    within() ? packageOf(file, texts.get(file) ?? "") : [],
  )
  const claims = members.reduce(
    (count, item) => count.set(item.name, (count.get(item.name) ?? 0) + 1),
    new Map<string, number>(),
  )
  const ambiguous = [...claims].flatMap(([name, count]) => (count > 1 ? [name] : [])).toSorted()
  const configs = [...texts.keys()].filter((file) => {
    const name = path.posix.basename(file)
    if (name !== "tsconfig.json" && name !== "jsconfig.json") return false
    // TypeScript reads a folder's jsconfig.json only when it has no tsconfig.json.
    return name === "tsconfig.json" || !texts.has(path.posix.join(path.posix.dirname(file), "tsconfig.json"))
  })
  const aliases = configs
    .slice(0, WORKSPACE_LIMIT.aliases)
    .flatMap((file) => (within() ? aliasesOf(file, texts.get(file) ?? "") : []))
  return {
    packages: members
      .filter((item) => claims.get(item.name) === 1)
      .toSorted((a, b) => compare(a.name, b.name) || compare(a.directory, b.directory)),
    aliases: aliases.toSorted((a, b) => compare(a.directory, b.directory)),
    ambiguous,
    truncated:
      clock.expired ||
      (declared?.length ?? 0) > (globs?.length ?? 0) ||
      nested.length > examined.length ||
      (globs !== undefined && examined.some((file) => !safeDirectory(directoryOf(file)))) ||
      matched.length > read.length ||
      configs.length > WORKSPACE_LIMIT.aliases,
  }
}

/** The repository files a file's imports name, at most `LIMIT.dependencies`, never the file itself. */
export function dependencies(
  file: string,
  specifiers: readonly string[],
  language: Language,
  files: Lookup,
  workspace?: Workspace,
) {
  return [...new Set(specifiers.flatMap((specifier) => resolve(file, specifier, language, files, workspace)))]
    .filter((dependency) => dependency !== file)
    .slice(0, LIMIT.dependencies)
}

/**
 * The repository files one import specifier names. With a `workspace` (VS-25b), a TypeScript, JavaScript or markup
 * specifier that is neither relative nor a sibling is read first through the tsconfig or jsconfig path aliases of the
 * folder the file is in and then through the workspace's package names and their `exports`; whatever those leave
 * unresolved (a target outside the tree, a subpath the package does not export, a name two packages claim) falls
 * through to the suffix match below, exactly as without one. Without a workspace nothing changes.
 */
export function resolve(file: string, specifier: string, language: Language, files: Lookup, workspace?: Workspace) {
  const normalised = language === "python" && specifier.startsWith(".") ? pythonSpecifier(specifier) : specifier
  // A relative attempt runs first for every language because `require_relative`, `#include "util.h"` and a sibling
  // Python module all name a neighbouring file without any leading dot to mark them as relative.
  if (!normalised.includes("::") && !normalised.includes("\\")) {
    const direct = matchFile(
      path.posix.normalize(path.posix.join(path.posix.dirname(file), normalised)).replace(/^\.\//, ""),
      files,
    )
    if (direct.length) return direct
  }
  if (normalised.startsWith(".")) return []
  if (workspace && (language === "typescript" || language === "markup")) {
    const named = resolveAlias(file, normalised, files, workspace)
    if (named.length) return named
    const packaged = resolvePackage(normalised, files, workspace)
    if (packaged.length) return packaged
  }

  const segments = specifierSegments(normalised, language)
  if (!segments.length) return []
  // Go names a package directory; the other languages name a module path whose trailing segments may be items inside
  // the module rather than files.
  const attempts =
    language === "go"
      ? [segments.slice(-3), segments.slice(-2), segments.slice(-1)]
      : [segments, segments.slice(0, -1), segments.slice(0, -2)]
  for (const attempt of attempts) {
    if (!attempt.length) continue
    const matched = matchSuffix(attempt, files)
    if (matched.length) return matched
  }
  return []
}

/**
 * Which files history changed together: for each file, the files committed with it in the recent commits of `git log
 * --format=%H --name-only`, counted, its `LIMIT.neighbours` most frequent. `known` maps a logged path to the
 * repository's own, or drops it.
 */
export function coChange(log: string, known: (file: string) => string | undefined) {
  const pairs = new Map<string, Map<string, number>>()
  const counted = { commits: 0 }
  const commit = (files: readonly string[]) => {
    if (files.length < 2 || files.length > LIMIT.commitFiles) return
    counted.commits += 1
    for (const left of files) {
      for (const right of files) {
        if (left === right) continue
        const neighbours = pairs.get(left) ?? new Map<string, number>()
        neighbours.set(right, (neighbours.get(right) ?? 0) + 1)
        pairs.set(left, neighbours)
      }
    }
  }
  const current: string[] = []
  for (const line of log.split("\n")) {
    const value = line.trim()
    if (!value) continue
    if (/^[0-9a-f]{40}$/.test(value)) {
      commit(current.splice(0))
      continue
    }
    const file = known(value)
    if (file) current.push(file)
  }
  commit(current)
  return {
    pairs: new Map(
      [...pairs].map(([file, neighbours]) => [
        file,
        new Map([...neighbours].sort((left, right) => right[1] - left[1]).slice(0, LIMIT.neighbours)),
      ]),
    ),
    commits: counted.commits,
  }
}

function lineOffsets(text: string) {
  const offsets = [0]
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) offsets.push(index + 1)
  return offsets
}

function lineAt(offsets: readonly number[], position: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (offsets[mid]! <= position) {
      low = mid
      continue
    }
    high = mid - 1
  }
  return low + 1
}

function pythonSpecifier(specifier: string) {
  const level = specifier.match(/^\.+/)![0].length
  const rest = specifier.slice(level).replaceAll(".", "/")
  return `${"../".repeat(level - 1)}./${rest}`
}

function specifierSegments(specifier: string, language: Language) {
  if (language === "rust") return specifier.replace(/^(?:crate|self|super)::/, "").split("::").filter(Boolean)
  if (language === "php") return specifier.split(/[\\/]/).filter(Boolean)
  if (language === "python" || language === "java") return specifier.split(".").filter(Boolean)
  return specifier.split("/").filter(Boolean)
}

function matchFile(base: string, files: Lookup) {
  if (!base || base.startsWith("..")) return []
  if (files.paths.has(base)) return [base]
  const direct = EXTENSIONS.map((extension) => `${base}${extension}`).find((candidate) => files.paths.has(candidate))
  if (direct) return [direct]
  const indexed = INDEX_FILES.map((name) => `${base}/${name}`).find((candidate) => files.paths.has(candidate))
  return indexed ? [indexed] : []
}

function matchSuffix(segments: readonly string[], files: Lookup) {
  // A C include carries its extension inside the last segment; a dotted module path never does, so stripping an
  // extension that is not there is a no-op.
  const parts = [...segments.slice(0, -1), segments.at(-1)!.replace(/\.[A-Za-z0-9]{1,5}$/, "")]
  const stem = parts.at(-1)!.toLowerCase()
  const named = files.byStem.get(stem) ?? []
  const directories = files.byDirectory.get(stem) ?? []
  // A namespace prefix rarely maps onto a directory one for one, so the longest suffix that exists on disk wins and a
  // bare module name is the last resort.
  for (let start = 0; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/").toLowerCase()
    const matched = named.filter((file) => {
      const withoutExtension = file.slice(0, file.length - path.extname(file).length).toLowerCase()
      return withoutExtension === suffix || withoutExtension.endsWith(`/${suffix}`)
    })
    if (matched.length) return matched.slice(0, 8)
    const inDirectory = directories.filter((file) => {
      const parent = path.posix.dirname(file).toLowerCase()
      return parent === suffix || parent.endsWith(`/${suffix}`)
    })
    if (inDirectory.length) return inDirectory.slice(0, 8)
  }
  return []
}

// ---------------------------------------------------------------------------------------------------------------------
// Workspace resolution (VS-25b)

const CONDITIONS = ["import", "default", "require", "node", "browser", "types"]

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function directoryOf(file: string) {
  const directory = path.posix.dirname(file)
  return directory === "." ? "" : directory
}

function jsonObject(text: string) {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  return errors.length || !isRecord(value) ? undefined : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

// The member globs the root declares, as written, or undefined when it declares none. pnpm-workspace.yaml is read for
// its `packages` list only, in block or flow form, which is all pnpm reads from it here.
function memberGlobs(texts: ReadonlyMap<string, string>) {
  const root = jsonObject(texts.get("package.json") ?? "")
  const declared = root?.workspaces
  const fromPackage = Array.isArray(declared)
    ? strings(declared)
    : isRecord(declared)
      ? strings(declared.packages)
      : undefined
  const pnpm = texts.get("pnpm-workspace.yaml")
  const fromPnpm = pnpm === undefined ? undefined : pnpmPackages(pnpm)
  if (fromPackage === undefined && fromPnpm === undefined) return undefined
  return [...(fromPackage ?? []), ...(fromPnpm ?? [])]
}

// pnpm's `packages` list, with comments and quotes cut by plain string searches: the patterns they replace,
// `\s+#.*$` and `(.+?)\s*(?:#.*)?$`, take quadratic time on a long run of spaces. On a line without a lone carriage
// return the results are the same.
function pnpmPackages(text: string) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^packages\s*:/.test(line))
  if (start < 0) return undefined
  const inline = uncomment(lines[start].replace(/^packages\s*:\s*/, ""))
  if (inline.startsWith("["))
    return inline
      .slice(1, inline.endsWith("]") ? -1 : undefined)
      .split(",")
      .map(unquote)
      .filter(Boolean)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^\S/.test(line) && !line.startsWith("#"))
  return (end < 0 ? rest : rest.slice(0, end)).flatMap((line) => {
    const dash = /^\s*-/.exec(line)
    const content = dash ? line.slice(dash[0].length).trimStart() : ""
    if (!content) return []
    const hash = content.indexOf("#", 1)
    return [unquote((hash < 0 ? content : content.slice(0, hash)).trimEnd())]
  })
}

// What `value.replace(/\s+#.*$/, "")` gives.
function uncomment(value: string) {
  const at = value.search(/\s#/)
  return at < 0 ? value : value.slice(0, at + 1).trimEnd()
}

// What `value.trim().replace(/^(["'])(.*)\1$/, "$2")` gives.
function unquote(value: string) {
  const trimmed = value.trim()
  const quote = trimmed[0]
  return (quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1)
    : trimmed
}

// Whether a declared glob is one WORKSPACE_LIMIT lets minimatch run: short, and with at most one "*" in any segment
// other than "**".
function safeGlob(glob: string) {
  if (glob.length > WORKSPACE_LIMIT.globChars) return false
  return glob.split("/").every((segment) => segment === "**" || segment.split("*").length <= 2)
}

function safeDirectory(directory: string) {
  return (
    directory.length <= WORKSPACE_LIMIT.directoryChars &&
    directory.split("/").every((name) => name.length <= WORKSPACE_LIMIT.nameChars)
  )
}

function compileGlob(glob: string) {
  const negated = glob.startsWith("!")
  const pattern = (negated ? glob.slice(1) : glob).replace(/^\.\//, "").replace(/\/+$/, "")
  return {
    negated,
    matcher: new Minimatch(pattern, { dot: true, noext: true, braceExpandMax: WORKSPACE_LIMIT.expansions }),
  }
}

function isMember(directory: string, globs: readonly ReturnType<typeof compileGlob>[], within: () => boolean) {
  return (
    globs.some((glob) => within() && !glob.negated && glob.matcher.match(directory)) &&
    !globs.some((glob) => within() && glob.negated && glob.matcher.match(directory))
  )
}

function packageOf(file: string, text: string): WorkspacePackage[] {
  const manifest = jsonObject(text)
  if (!manifest || typeof manifest.name !== "string" || !manifest.name) return []
  const encapsulated = Object.hasOwn(manifest, "exports") && manifest.exports !== undefined
  const main = [manifest.main, manifest.module].filter((item): item is string => typeof item === "string")
  const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (field) => {
      const value = manifest[field]
      return isRecord(value) ? Object.keys(value) : []
    },
  )
  return [
    {
      name: manifest.name,
      directory: directoryOf(file),
      encapsulated,
      exports: encapsulated
        ? exportsOf(manifest.exports).slice(0, WORKSPACE_LIMIT.entries)
        : main.length
          ? [[".", main.map((target) => (target.startsWith("./") ? target : `./${target}`))]]
          : [],
      dependencies: [...new Set(dependencies)].toSorted(),
    },
  ]
}

// `exports` as [subpath, targets] pairs: a string, a list or a condition object stands for "."; a map whose keys all
// start with "." names subpaths.
function exportsOf(value: unknown): [string, string[]][] {
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length && keys.every((key) => key.startsWith(".")))
      return Object.entries(value).map(([subpath, target]) => [subpath, targetsOf(target)])
  }
  return [[".", targetsOf(value)]]
}

// The targets of one `exports` value, in the order they are tried: a string; a fallback list in its order; a condition
// object's CONDITIONS in that order, then its other conditions as written. Only "./" targets are package files.
function targetsOf(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : []
  if (Array.isArray(value)) return [...new Set(value.flatMap(targetsOf))]
  if (!isRecord(value)) return []
  const keys = [
    ...CONDITIONS.filter((key) => Object.hasOwn(value, key)),
    ...Object.keys(value).filter((key) => !CONDITIONS.includes(key)),
  ]
  return [...new Set(keys.flatMap((key) => targetsOf(value[key])))]
}

function aliasesOf(file: string, text: string): PathAliases[] {
  const options = jsonObject(text)?.compilerOptions
  if (!isRecord(options)) return []
  const directory = directoryOf(file)
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined
  const paths = isRecord(options.paths)
    ? Object.entries(options.paths)
        .flatMap(([pattern, targets]) =>
          // TypeScript allows at most one "*" in a pattern and in each target.
          pattern.split("*").length > 2
            ? []
            : [[pattern, strings(targets).filter((target) => target.split("*").length <= 2)] as const],
        )
        .slice(0, WORKSPACE_LIMIT.entries)
    : []
  if (!paths.length && baseUrl === undefined) return []
  const base = path.posix.normalize(path.posix.join(directory, baseUrl ?? ".")).replace(/^\.$/, "")
  return [{ directory, base, baseUrl: baseUrl !== undefined, paths }]
}

// A workspace's packages by name and aliases by folder, built once per workspace, so a resolution costs the
// specifier's segments and one entry's patterns, not every package or alias.
const INDEXES = new WeakMap<
  Workspace,
  { packages: ReadonlyMap<string, WorkspacePackage | undefined>; aliases: ReadonlyMap<string, PathAliases> }
>()

function indexOf(workspace: Workspace) {
  const known = INDEXES.get(workspace)
  if (known) return known
  // An ambiguous name maps to undefined: it is the longest owner, and resolves nothing.
  const index = {
    packages: new Map<string, WorkspacePackage | undefined>([
      ...workspace.ambiguous.map((name) => [name, undefined] as const),
      ...workspace.packages.map((item) => [item.name, item] as const),
    ]),
    aliases: new Map(workspace.aliases.map((entry) => [entry.directory, entry] as const)),
  }
  INDEXES.set(workspace, index)
  return index
}

// TypeScript's rule: the aliases of the nearest tsconfig around the file; an exact pattern, else the "*" pattern with the
// longest prefix; each of its targets in order, then, with baseUrl, the specifier under the base.
function resolveAlias(file: string, specifier: string, files: Lookup, workspace: Workspace) {
  const aliases = indexOf(workspace).aliases
  const folders = directoryOf(file)
    .split("/")
    .map((_, at, parts) => parts.slice(0, parts.length - at).join("/"))
  const scope = [...folders, ""].map((folder) => aliases.get(folder)).find((entry) => entry !== undefined)
  if (!scope) return []
  const exact = scope.paths.find(([pattern]) => !pattern.includes("*") && pattern === specifier)
  const wild = exact ? undefined : bestPattern(scope.paths, specifier)
  const targets = exact ? exact[1] : wild ? wild.targets.map((target) => target.replace("*", wild.capture)) : []
  for (const target of targets) {
    const found = matchTarget(path.posix.join(scope.base, target), files)
    if (found.length) return found
  }
  return scope.baseUrl ? matchTarget(path.posix.join(scope.base, specifier), files) : []
}

// The package whose name is the specifier or its first segments, the longest such name; a name several manifests claim
// resolves nothing. Its exports map the subpath (exact, else the "*" key with the longest prefix); an unencapsulated
// package maps it to the file under its folder.
function resolvePackage(specifier: string, files: Lookup, workspace: Workspace) {
  const packages = indexOf(workspace).packages
  const owner = specifier
    .split("/")
    .map((_, at, parts) => parts.slice(0, parts.length - at).join("/"))
    .find((name) => packages.has(name))
  const item = owner === undefined ? undefined : packages.get(owner)
  if (owner === undefined || !item) return []
  const subpath = specifier === owner ? "." : `./${specifier.slice(owner.length + 1)}`
  const exact = item.exports.find(([key]) => key === subpath)
  const wild = exact ? undefined : bestPattern(item.exports, subpath)
  const targets = exact ? exact[1] : wild ? wild.targets.map((target) => target.replaceAll("*", wild.capture)) : []
  for (const target of targets) {
    const found = matchTarget(path.posix.join(item.directory, target), files)
    if (found.length) return found
  }
  return item.encapsulated ? [] : matchTarget(path.posix.join(item.directory, subpath), files)
}

function bestPattern(entries: readonly (readonly [string, readonly string[]])[], specifier: string) {
  return entries
    .flatMap(([pattern, targets]) => {
      const star = pattern.indexOf("*")
      if (star < 0) return []
      const prefix = pattern.slice(0, star)
      const suffix = pattern.slice(star + 1)
      if (specifier.length < prefix.length + suffix.length) return []
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return []
      return [{ prefix, targets, capture: specifier.slice(prefix.length, specifier.length - suffix.length) }]
    })
    .reduce<{ prefix: string; targets: readonly string[]; capture: string } | undefined>(
      (best, entry) => (best && best.prefix.length >= entry.prefix.length ? best : entry),
      undefined,
    )
}

function matchTarget(target: string, files: Lookup) {
  const normalised = path.posix.normalize(target).replace(/^\.\//, "")
  if (normalised === "." || normalised.startsWith("../")) return []
  return files.paths.has(normalised) ? [normalised] : matchFile(normalised, files)
}
