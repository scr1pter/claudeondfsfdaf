import { readFile, stat } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { Language, Query, type Node, type Parser, type Tree, type TreeCursor } from "web-tree-sitter"
import type { CommentRange, SourceRange } from "@vectordevai/core/review/trivial"
import { lazy } from "@/util/lazy"
import { TreeSitter } from "@/util/tree-sitter"

// VS-25a: one file's definitions, reference sites, comment and string ranges, read with a pinned tree-sitter grammar.
// No runner calls this yet (VS-25b wires it, contract §5). Per the extractor decision (contract VS-25) it adds only
// what regular expressions cannot do well: enclosing-definition spans, reference sites and comment ranges. The
// file-level import graph stays with BrainCode, and review/symbols.ts stays the fallback for every other language.
//
// Safety (addendum A VS-38 item 5): every failure becomes an UnparsedFile record, never a thrown review error. Inputs
// over 1 MiB, grammars over 4 MiB, trees deeper than 16,384 levels and parses or extractions past their time box are
// refused, and every tree and cursor is deleted after extraction. A wasm trap or abort poisons the shared runtime for
// the process (TreeSitter.poison), because the memory it leaves behind cannot be trusted: this parser refuses every
// later file, and the shell tool's command parser, which shares the runtime, refuses every later command.
//
// Every exported table is frozen all the way down, so no caller can change the caps or the rules for later callers.

export const PARSE_LANGUAGES = frozen(["typescript", "tsx", "javascript", "python", "go", "rust", "java"] as const)
export type ParseLanguage = (typeof PARSE_LANGUAGES)[number]

// Languages that addendum A VS-38 reports separately in the impact artifact (VOI13), so they can be counted. They are
// not the only languages that fall back: every file outside PARSE_LANGUAGES falls back to changedSymbols plus git grep
// (VS-25b step 6). A C grammar (69% error trees on kernel-style C, G1-8) is a separate owner decision.
export const REPORTED_LANGUAGES = frozen(["c", "cpp", "csharp", "php"] as const)
export type ReportedLanguage = (typeof REPORTED_LANGUAGES)[number]

// Lower-case extensions, read like trivial.ts's `extension`: the text after a file name's last dot, when that dot is
// not its first character. `.d.ts` is TypeScript; `.jsx` is JavaScript, whose grammar reads JSX.
export const PARSE_EXTENSIONS: Readonly<Record<string, ParseLanguage>> = frozen({
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
})

export const REPORTED_EXTENSIONS: Readonly<Record<string, ReportedLanguage>> = frozen({
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  php: "php",
})

export interface Grammar {
  readonly package: string
  readonly version: string
  readonly wasm: string
  readonly abi: 13 | 14 | 15
}

// Exact pins (engine package.json), each grammar's ABI as measured under web-tree-sitter 0.25.10 (which reads ABI 13
// to 15). tree-sitter-javascript stays on 0.23.1 because tree-sitter-typescript 0.23.2 depends on ^0.23.1, so one copy
// is installed and the two grammars share their 0.23 node names. A future fact cache keys on (blob, grammar, queries).
export const GRAMMARS = frozen({
  typescript: { package: "tree-sitter-typescript", version: "0.23.2", wasm: "tree-sitter-typescript.wasm", abi: 14 },
  tsx: { package: "tree-sitter-typescript", version: "0.23.2", wasm: "tree-sitter-tsx.wasm", abi: 14 },
  javascript: { package: "tree-sitter-javascript", version: "0.23.1", wasm: "tree-sitter-javascript.wasm", abi: 14 },
  python: { package: "tree-sitter-python", version: "0.25.0", wasm: "tree-sitter-python.wasm", abi: 15 },
  go: { package: "tree-sitter-go", version: "0.25.0", wasm: "tree-sitter-go.wasm", abi: 15 },
  rust: { package: "tree-sitter-rust", version: "0.24.0", wasm: "tree-sitter-rust.wasm", abi: 14 },
  java: { package: "tree-sitter-java", version: "0.23.5", wasm: "tree-sitter-java.wasm", abi: 14 },
} as const satisfies Record<ParseLanguage, Grammar>)

// Bumped whenever RULES or the extraction below changes what a file yields by default. ParseInput.statements adds a field
// only when asked, so it does not bump it.
export const QUERY_VERSION = 1

// Static specifiers, so the bundler resolves each grammar from this package's own dependencies and embeds it: no path
// from the reviewed repository, the working directory or the input ever reaches a module or file load (I-8).
const WASM: Record<ParseLanguage, () => Promise<{ default: string }>> = {
  typescript: () => import("tree-sitter-typescript/tree-sitter-typescript.wasm" as string, { with: { type: "wasm" } }),
  tsx: () => import("tree-sitter-typescript/tree-sitter-tsx.wasm" as string, { with: { type: "wasm" } }),
  javascript: () => import("tree-sitter-javascript/tree-sitter-javascript.wasm" as string, { with: { type: "wasm" } }),
  python: () => import("tree-sitter-python/tree-sitter-python.wasm" as string, { with: { type: "wasm" } }),
  go: () => import("tree-sitter-go/tree-sitter-go.wasm" as string, { with: { type: "wasm" } }),
  rust: () => import("tree-sitter-rust/tree-sitter-rust.wasm" as string, { with: { type: "wasm" } }),
  java: () => import("tree-sitter-java/tree-sitter-java.wasm" as string, { with: { type: "wasm" } }),
}

export interface ParseLimits {
  readonly inputBytes: number // UTF-8 bytes of one file
  readonly grammarBytes: number // bytes of one grammar's .wasm file
  readonly parseMs: number // the parse itself
  readonly extractMs: number // the depth walk, the query and everything read from it
  readonly depth: number // tree levels below the root
}

// The parse box is G1-8's: no parse over 290 ms in about 30,000 files at 4 to 10 MB/s. The extraction box is ten times
// the slowest real file of 256 KiB or more measured for VS-25a (202 ms, under Bun), and still lets a 1 MiB numeric array
// (1.4 s) through (vectorscope-deviations.md, VS-25a). The depth limit is four times under the 65,536 levels past which
// 0.25.10's query cursor silently drops captures (G1-15; PR #6038 came later).
export const PARSE_LIMITS: ParseLimits = frozen({
  inputBytes: 1_048_576,
  grammarBytes: 4_194_304,
  parseMs: 1_000,
  extractMs: 2_000,
  depth: 16_384,
})

export const DEFINITION_KINDS = frozen([
  "class",
  "enum",
  "function",
  "interface",
  "macro",
  "method",
  "module",
  "struct",
  "trait",
  "type",
  "variable",
] as const)
export type DefinitionKind = (typeof DEFINITION_KINDS)[number]

export const REFERENCE_KINDS = frozen(["call", "type", "import", "value"] as const)
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

// "capture-count": the query returned a different number of captures than the tree holds nodes of those types, so
// something was dropped (G1-15's failure, whatever its cause). There is no match-limit refusal: every pattern is one
// bare node, which never leaves a match in progress, so the query cursor's match limit cannot be reached.
export const PARSE_REFUSALS = frozen([
  "language",
  "binary",
  "too-large",
  "grammar",
  "timeout",
  "nesting",
  "capture-count",
  "parser-error",
] as const)
export type ParseRefusal = (typeof PARSE_REFUSALS)[number]

export interface ParsedDefinition {
  name: string
  kind: DefinitionKind
  start: number // 1-based, inclusive, from the first decorator, attribute or export wrapper
  end: number // 1-based, inclusive
  exported: boolean // reachable from another file of the same program or package
  // Whitespace collapsed, at most 240 UTF-16 units. Never a variable's value: a variable, constant, static or field
  // stops before its initialiser, and every parameter default in a TS, JS or Python head reads `…`.
  signature: string
  container?: string // the class, interface, namespace, module, impl or trait it is directly declared in
  aliases?: string[] // other names other files import it by: "default", or an export clause's `as` name
}

export interface ParsedReference {
  name: string
  line: number // 1-based
  column: number // 0-based, UTF-16 units
  kind: ReferenceKind
  enclosing?: string // the innermost definition around it
  // Only with ParseInput.statements (VS-37a): the 1-based lines of the innermost simple statement around it, or a
  // compound statement's (an `if`, a loop) first line through this reference's line; absent outside every statement.
  statement?: { start: number; end: number }
}

export interface ParseInput {
  path: string // a label: it picks the language and names the record, and is never read
  text: string
  names?: ReadonlySet<string> // keep only references to these names (a filter on the output)
  deadline?: number // a performance.now() time after which this file is refused (VS-38's time box)
  // VS-37a: also give each reference its statement (STATEMENTS). Off by default, so every other caller's records are
  // unchanged; a future fact cache keys on it as well as on QUERY_VERSION.
  statements?: boolean
}

export interface ParsedFile {
  parsed: true
  path: string
  language: ParseLanguage
  grammar: string // "tree-sitter-go@0.25.0"
  queries: number // QUERY_VERSION
  hasError: boolean
  errors: { start: number; end: number }[] // ERROR nodes, 1-based inclusive lines
  definitions: ParsedDefinition[]
  references: ParsedReference[]
  comments: CommentRange[] // VS-24c's comments callback
  strings: SourceRange[] // VS-24c's strings callback
  depth: number
  parseMs: number
  walkMs: number // the depth walk, part of extractMs
  extractMs: number
}

// The unsupported-file record (VS-38 item 5).
export interface UnparsedFile {
  parsed: false
  path: string
  language?: ParseLanguage
  reported?: ReportedLanguage
  because: ParseRefusal
  detail?: string // at most 200 characters, never source text
  ms: number
}

export type ParseResult = ParsedFile | UnparsedFile

export class ReviewParseError extends Schema.TaggedErrorClass<ReviewParseError>()("ReviewParseError", {
  message: Schema.String,
}) {}

export function languageOf(path: string): ParseLanguage | undefined {
  const ext = extension(path)
  return Object.hasOwn(PARSE_EXTENSIONS, ext) ? PARSE_EXTENSIONS[ext] : undefined
}

export function reportedOf(path: string): ReportedLanguage | undefined {
  const ext = extension(path)
  return Object.hasOwn(REPORTED_EXTENSIONS, ext) ? REPORTED_EXTENSIONS[ext] : undefined
}

// One language's grammar, loaded once per process: where its .wasm file is, how large it is and its ABI.
export const grammar = Effect.fn("ReviewParse.grammar")(function* (language: ParseLanguage) {
  const file = yield* fileOf(language)
  const loaded = yield* loadedOf(language)
  return { path: file.path, bytes: file.bytes, abi: loaded.language.abiVersion }
})

export const parse = Effect.fn("ReviewParse.parse")(function* (input: ParseInput, limits: ParseLimits = PARSE_LIMITS) {
  const started = performance.now()
  return yield* attempt(input, limits, started).pipe(
    Effect.catchDefect((defect) => Effect.sync(() => crashed(input, defect, started))),
  )
})

const attempt = Effect.fnUntraced(function* (input: ParseInput, limits: ParseLimits, started: number) {
  const refuse = (because: ParseRefusal, extra: Partial<UnparsedFile> = {}): UnparsedFile => ({
    parsed: false,
    path: input.path,
    because,
    ...extra,
    ms: performance.now() - started,
  })
  if (TreeSitter.poisoned()) return refuse("parser-error", { detail: "runtime-disabled" })
  const language = languageOf(input.path)
  if (!language) {
    const reported = reportedOf(input.path)
    return refuse("language", reported ? { reported } : {})
  }
  if (input.text.slice(0, 8_000).includes("\0")) return refuse("binary", { language })
  if (Buffer.byteLength(input.text, "utf8") > limits.inputBytes) return refuse("too-large", { language })
  const file = yield* fileOf(language).pipe(Effect.catch((error) => Effect.succeed(error)))
  if (file instanceof ReviewParseError) return refuse("grammar", { language, detail: file.message })
  if (file.bytes > limits.grammarBytes) return refuse("grammar", { language, detail: "too-large" })
  const loaded = yield* loadedOf(language).pipe(Effect.catch((error) => Effect.succeed(error)))
  if (loaded instanceof ReviewParseError) return refuse("grammar", { language, detail: loaded.message })
  const parseDeadline = Math.min(performance.now() + limits.parseMs, input.deadline ?? Infinity)
  if (performance.now() > parseDeadline) return refuse("timeout", { language })
  // Each parse() and each query call is synchronous, and a finished tree no longer depends on its parser, so fibers
  // that interleave between these steps never share a parser in mid-parse. parseMs times the parse alone, not the
  // checks or the grammar load before it.
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      loaded.parser.reset()
      const begun = performance.now()
      const tree = loaded.parser.parse(input.text, null, { progressCallback: () => performance.now() > parseDeadline })
      return { tree, parseMs: performance.now() - begun }
    }),
    (parsed) => {
      const tree = parsed.tree
      if (!tree) return Effect.succeed<ParseResult>(refuse("timeout", { language }))
      return Effect.acquireUseRelease(
        Effect.sync(() => tree.walk()),
        (cursor) =>
          Effect.sync(() =>
            extract({
              input,
              language,
              loaded,
              tree,
              cursor,
              limits,
              parseMs: parsed.parseMs,
              deadline: Math.min(performance.now() + limits.extractMs, input.deadline ?? Infinity),
              refuse,
            }),
          ),
        (cursor) => Effect.sync(() => cursor.delete()),
      )
    },
    // A timed-out parse returns no tree, so there is nothing to delete.
    (parsed) => Effect.sync(() => parsed.tree?.delete()),
  )
})

// A thrown error anywhere in one file's work. A wasm trap or abort (WebAssembly.RuntimeError) leaves the shared runtime
// unusable, so it is poisoned: every later file and every later shell command is refused rather than parsed with it.
function crashed(input: ParseInput, defect: unknown, started: number): UnparsedFile {
  const trap = defect instanceof WebAssembly.RuntimeError
  if (trap) TreeSitter.poison()
  const path = typeof input?.path === "string" ? input.path : ""
  const language = path ? languageOf(path) : undefined
  return {
    parsed: false,
    path,
    ...(language ? { language } : {}),
    because: "parser-error",
    detail: trap ? "runtime-disabled" : defect instanceof Error ? defect.name.slice(0, 200) : typeof defect,
    ms: performance.now() - started,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Grammars. The .wasm path and size are cached once found; a failed import, stat or read is retried on the next file,
// so one transient error never refuses a language for the life of the process. A grammar that loads but fails its
// ABI pin or query compile stays refused: that is deterministic.

interface Loaded {
  language: Language
  parser: Parser
  query: Query
  anchors: Uint8Array // 1 for every node type id the query captures
  statements: Uint8Array // 1 for a simple statement's node type id, 2 for a compound one's (STATEMENTS)
}

const ERROR_ID = 65_535

function cache(language: ParseLanguage) {
  const file = lazy(() =>
    WASM[language]()
      .then(async ({ default: asset }) => {
        const path = TreeSitter.resolveWasm(asset)
        // An asset embedded in a compiled binary (`/$bunfs/...`) may not stat; its read length is its size all the same.
        const bytes = await stat(path).then(
          (found) => found.size,
          () => readFile(path).then((read) => read.length),
        )
        return { path, bytes }
      })
      .catch((cause: unknown) => {
        file.reset()
        throw cause
      }),
  )
  const loaded = lazy(() =>
    Promise.all([TreeSitter.runtime(), file()])
      .then(async ([Runtime, found]) => {
        const bytes = await readFile(found.path)
        if (bytes.length !== found.bytes) throw new Error("grammar file changed size")
        return { Runtime, bytes }
      })
      .catch((cause: unknown) => {
        loaded.reset()
        throw cause
      })
      .then(({ Runtime, bytes }) => compile(language, Runtime, bytes)),
  )
  return { file, loaded }
}

const CACHE: Record<ParseLanguage, ReturnType<typeof cache>> = {
  typescript: cache("typescript"),
  tsx: cache("tsx"),
  javascript: cache("javascript"),
  python: cache("python"),
  go: cache("go"),
  rust: cache("rust"),
  java: cache("java"),
}

const fileOf = (language: ParseLanguage) =>
  Effect.tryPromise({
    try: () => CACHE[language].file(),
    catch: (cause) => new ReviewParseError({ message: describe(cause) }),
  })

const loadedOf = (language: ParseLanguage) =>
  Effect.tryPromise({
    try: () => CACHE[language].loaded(),
    catch: (cause) => new ReviewParseError({ message: describe(cause) }),
  })

async function compile(language: ParseLanguage, Runtime: typeof Parser, bytes: Uint8Array): Promise<Loaded> {
  const grammar = await Language.load(bytes)
  if (grammar.abiVersion !== GRAMMARS[language].abi) throw new Error(`unexpected ABI ${grammar.abiVersion}`)
  const parser = new Runtime()
  parser.setLanguage(grammar)
  const roles = RULES[language].roles
  const query = new Query(grammar, querySource(roles))
  const anchors = new Uint8Array(ERROR_ID + 1)
  Array.from({ length: grammar.nodeTypeCount }, (_, id) => id)
    .filter((id) => grammar.nodeTypeIsNamed(id) && Object.hasOwn(roles, grammar.nodeTypeForId(id) ?? ""))
    .forEach((id) => {
      anchors[id] = 1
    })
  anchors[ERROR_ID] = 1
  const statements = new Uint8Array(ERROR_ID + 1)
  Array.from({ length: grammar.nodeTypeCount }, (_, id) => id)
    .filter((id) => grammar.nodeTypeIsNamed(id))
    .forEach((id) => {
      const type = grammar.nodeTypeForId(id) ?? ""
      if (STATEMENTS[language].simple.includes(type)) statements[id] = 1
      if (STATEMENTS[language].compound.includes(type)) statements[id] = 2
    })
  return { language: grammar, parser, query, anchors, statements }
}

// One bare pattern per node type, named by its role: a bare pattern completes on the node it starts on, so the query
// keeps no match in progress, and the captures can be counted against the tree (see "capture-count").
export function querySource(roles: Readonly<Record<string, Role>>) {
  return [...Object.entries(roles).map(([type, role]) => `(${type}) @${role}`), "(ERROR) @error"].join("\n")
}

function describe(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 200)
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules per language. Every node type appears once, under the role its captures play:
// - definition: a definition anchor, refined by `define` (kinds in RULES[language].kinds);
// - comment, string: VS-24c's ranges. Docstrings, f-strings, text blocks, raw, byte and C strings and JSX attribute
//   strings are strings; char and rune literals and regular expressions are not;
// - reference: an identifier-like leaf;
// - call: a call whose callee field ends where its callee identifier does (`foo()`, `a.b.foo()`, `new Foo()`);
// - import: a region whose references are imports;
// - wrapper: a node that opens a definition's span (export, declare, a declaration list, a Python decorator wrapper);
// - scope: a body that ends module scope (a block, a class or interface body, a TS type literal);
// - container: a container that is not a definition (a Rust impl);
// - decorator: a sibling that opens the next definition's span (a TS member decorator, a Rust attribute);
// - assignment: a JavaScript `exports.x =` or `module.exports =` candidate;
// - default: a parameter or pattern whose default value (RULES[language].defaults) a signature reads as `…`.

export const ROLES = frozen([
  "definition",
  "comment",
  "string",
  "reference",
  "call",
  "import",
  "wrapper",
  "scope",
  "container",
  "decorator",
  "assignment",
  "default",
  "error",
] as const)
export type Role = (typeof ROLES)[number]

function isRole(name: string): name is Role {
  return (ROLES as readonly string[]).includes(name)
}

export interface Rules {
  readonly roles: Readonly<Record<string, Role>>
  readonly kinds: Readonly<Record<string, DefinitionKind>>
  readonly callee: Readonly<Record<string, string>> // call node type -> the field that holds the callee
  readonly defaults: Readonly<Record<string, string>> // parameter or pattern node type -> the field of its default
}

const SCRIPT_KINDS = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  method_definition: "method",
  variable_declarator: "variable",
} as const satisfies Record<string, DefinitionKind>

const TYPESCRIPT_KINDS = {
  ...SCRIPT_KINDS,
  function_signature: "function",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_signature: "method",
  abstract_method_signature: "method",
  internal_module: "module",
  module: "module",
  public_field_definition: "variable",
} as const satisfies Record<string, DefinitionKind>

const JAVASCRIPT_KINDS = { ...SCRIPT_KINDS, field_definition: "variable" } as const satisfies Record<
  string,
  DefinitionKind
>

const SCRIPT_ROLES = {
  comment: "comment",
  html_comment: "comment",
  string: "string",
  template_string: "string",
  identifier: "reference",
  property_identifier: "reference",
  shorthand_property_identifier: "reference",
  call_expression: "call",
  new_expression: "call",
  import_statement: "import",
  export_statement: "wrapper",
  lexical_declaration: "wrapper",
  variable_declaration: "wrapper",
  statement_block: "scope",
  class_body: "scope",
  switch_body: "scope",
  for_statement: "scope",
  for_in_statement: "scope",
  decorator: "decorator",
} as const satisfies Record<string, Role>

const SCRIPT_CALLEE = { call_expression: "function", new_expression: "constructor" }

// `function f(a = 1, { b = 2 } = {}, [c = 3])`: JavaScript's parameter and destructuring defaults.
const SCRIPT_DEFAULTS = { assignment_pattern: "right", object_assignment_pattern: "right" }

// TypeScript reads a parameter's default (and a constructor parameter property's initialiser) as its `value` field.
const TYPESCRIPT_DEFAULTS = { ...SCRIPT_DEFAULTS, required_parameter: "value", optional_parameter: "value" }

const TYPESCRIPT: Rules = {
  roles: {
    ...SCRIPT_ROLES,
    ...each(TYPESCRIPT_KINDS, "definition"),
    ...each(TYPESCRIPT_DEFAULTS, "default"),
    template_literal_type: "string",
    type_identifier: "reference",
    ambient_declaration: "wrapper",
    interface_body: "scope",
    object_type: "scope",
  },
  kinds: TYPESCRIPT_KINDS,
  callee: SCRIPT_CALLEE,
  defaults: TYPESCRIPT_DEFAULTS,
}

const PYTHON_KINDS = {
  function_definition: "function",
  class_definition: "class",
  assignment: "variable",
} as const satisfies Record<string, DefinitionKind>

const PYTHON_DEFAULTS = { default_parameter: "value", typed_default_parameter: "value" }

const GO_KINDS = {
  function_declaration: "function",
  method_declaration: "method",
  type_spec: "type",
  type_alias: "type",
  const_spec: "variable",
  var_spec: "variable",
} as const satisfies Record<string, DefinitionKind>

const RUST_KINDS = {
  function_item: "function",
  function_signature_item: "function",
  struct_item: "struct",
  union_item: "struct",
  enum_item: "enum",
  type_item: "type",
  trait_item: "trait",
  mod_item: "module",
  macro_definition: "macro",
  const_item: "variable",
  static_item: "variable",
} as const satisfies Record<string, DefinitionKind>

const JAVA_KINDS = {
  class_declaration: "class",
  record_declaration: "class",
  interface_declaration: "interface",
  annotation_type_declaration: "interface",
  enum_declaration: "enum",
  method_declaration: "method",
  constructor_declaration: "method",
  compact_constructor_declaration: "method",
  field_declaration: "variable",
  constant_declaration: "variable",
} as const satisfies Record<string, DefinitionKind>

export const RULES: Readonly<Record<ParseLanguage, Rules>> = frozen({
  typescript: TYPESCRIPT,
  tsx: TYPESCRIPT,
  javascript: {
    roles: {
      ...SCRIPT_ROLES,
      ...each(JAVASCRIPT_KINDS, "definition"),
      ...each(SCRIPT_DEFAULTS, "default"),
      assignment_expression: "assignment",
    },
    kinds: JAVASCRIPT_KINDS,
    callee: SCRIPT_CALLEE,
    defaults: SCRIPT_DEFAULTS,
  },
  python: {
    roles: {
      ...each(PYTHON_KINDS, "definition"),
      ...each(PYTHON_DEFAULTS, "default"),
      comment: "comment",
      string: "string",
      identifier: "reference",
      call: "call",
      import_statement: "import",
      import_from_statement: "import",
      future_import_statement: "import",
      decorated_definition: "wrapper",
      block: "scope",
    },
    kinds: PYTHON_KINDS,
    callee: { call: "function" },
    defaults: PYTHON_DEFAULTS,
  },
  go: {
    roles: {
      ...each(GO_KINDS, "definition"),
      comment: "comment",
      interpreted_string_literal: "string",
      raw_string_literal: "string",
      identifier: "reference",
      type_identifier: "reference",
      field_identifier: "reference",
      package_identifier: "reference",
      call_expression: "call",
      import_declaration: "import",
      block: "scope",
    },
    kinds: GO_KINDS,
    callee: { call_expression: "function" },
    defaults: {},
  },
  rust: {
    roles: {
      ...each(RUST_KINDS, "definition"),
      line_comment: "comment",
      block_comment: "comment",
      string_literal: "string",
      raw_string_literal: "string",
      identifier: "reference",
      type_identifier: "reference",
      field_identifier: "reference",
      call_expression: "call",
      macro_invocation: "call",
      use_declaration: "import",
      extern_crate_declaration: "import",
      impl_item: "container",
      block: "scope",
      attribute_item: "decorator",
    },
    kinds: RUST_KINDS,
    callee: { call_expression: "function", macro_invocation: "macro" },
    defaults: {},
  },
  java: {
    roles: {
      ...each(JAVA_KINDS, "definition"),
      line_comment: "comment",
      block_comment: "comment",
      string_literal: "string",
      identifier: "reference",
      type_identifier: "reference",
      method_invocation: "call",
      object_creation_expression: "call",
      import_declaration: "import",
      block: "scope",
      constructor_body: "scope",
    },
    kinds: JAVA_KINDS,
    callee: { method_invocation: "name", object_creation_expression: "type" },
    defaults: {},
  },
})

// VS-37a's statements per language, read only when ParseInput.statements asks: a simple statement's span is a call
// site's window, and a compound statement (whose body holds other statements) gives its header through the
// reference's line, for a call in an `if` condition or a loop head. Declarations that hold a body (a class, a
// function) are neither, so a type in a signature has no statement. Rust's `if` and `match` are expressions inside an
// expression statement, and its tail expressions are in no statement.
const SCRIPT_SIMPLE = [
  "expression_statement",
  "lexical_declaration",
  "variable_declaration",
  "return_statement",
  "throw_statement",
]
const SCRIPT_COMPOUND = [
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "switch_case",
  "with_statement",
]

export const STATEMENTS: Readonly<Record<ParseLanguage, { simple: readonly string[]; compound: readonly string[] }>> =
  frozen({
    typescript: { simple: [...SCRIPT_SIMPLE, "public_field_definition"], compound: SCRIPT_COMPOUND },
    tsx: { simple: [...SCRIPT_SIMPLE, "public_field_definition"], compound: SCRIPT_COMPOUND },
    javascript: { simple: [...SCRIPT_SIMPLE, "field_definition"], compound: SCRIPT_COMPOUND },
    python: {
      simple: ["expression_statement", "return_statement", "raise_statement", "assert_statement", "delete_statement"],
      compound: [
        "if_statement",
        "elif_clause",
        "for_statement",
        "while_statement",
        "with_statement",
        "match_statement",
        "case_clause",
        "except_clause",
      ],
    },
    go: {
      simple: [
        "expression_statement",
        "short_var_declaration",
        "assignment_statement",
        "inc_statement",
        "dec_statement",
        "send_statement",
        "go_statement",
        "defer_statement",
        "return_statement",
        "var_spec",
        "const_spec",
      ],
      compound: [
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
        "expression_case",
        "communication_case",
      ],
    },
    rust: { simple: ["expression_statement", "let_declaration", "const_item", "static_item"], compound: [] },
    java: {
      simple: [
        "expression_statement",
        "local_variable_declaration",
        "return_statement",
        "throw_statement",
        "yield_statement",
        "assert_statement",
        "explicit_constructor_invocation",
        "field_declaration",
        "constant_declaration",
      ],
      compound: [
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "switch_expression",
        "try_with_resources_statement",
        "synchronized_statement",
      ],
    },
  })

// Every node type of a table, under one role.
function each(table: Readonly<Record<string, unknown>>, role: Role) {
  return Object.fromEntries(Object.keys(table).map((type) => [type, role]))
}

// ---------------------------------------------------------------------------------------------------------------------
// Extraction: a depth walk that also counts the nodes the query should capture, the query, then one sweep over the
// captures in document order with a stack of the definitions, wrappers, scopes and imports around each one. Nothing
// here asks a node for its parent or siblings: tree-sitter finds a parent by walking down from the root, which is
// quadratic over a wide file.

interface Extraction {
  input: ParseInput
  language: ParseLanguage
  loaded: Loaded
  tree: Tree
  cursor: TreeCursor
  limits: ParseLimits
  parseMs: number
  deadline: number
  refuse: (because: ParseRefusal, extra?: Partial<UnparsedFile>) => UnparsedFile
}

function extract(x: Extraction): ParseResult {
  const begun = performance.now()
  const late = () => performance.now() > x.deadline
  const spans: Span[] = []
  const walked = walk(
    x.cursor,
    x.loaded.anchors,
    x.limits.depth,
    late,
    x.input.statements ? { table: x.loaded.statements, spans } : undefined,
  )
  if (walked === "timeout") return x.refuse("timeout", { language: x.language, detail: "walk" })
  if (walked === "nesting") return x.refuse("nesting", { language: x.language })
  const walkMs = performance.now() - begun
  // 0.25.10's captures() never calls its progress callback (measured: no call during G1-15's 38 s chain query), so the
  // box goes in as timeoutMicros, which it honours (0 would mean no limit). The callback stays for versions that call it.
  const captures = x.loaded.query.captures(x.tree.rootNode, {
    progressCallback: late,
    timeoutMicros: Math.max(1, Math.min(2_000_000_000, Math.floor((x.deadline - performance.now()) * 1_000))),
  })
  if (late()) return x.refuse("timeout", { language: x.language, detail: "query" })
  if (captures.length !== walked.anchors)
    return x.refuse("capture-count", { language: x.language, detail: `${captures.length} of ${walked.anchors}` })
  // Every capture is named by its role (querySource), so none is dropped here.
  const items = captures
    .flatMap((capture) => {
      const role = capture.name
      if (!isRole(role)) return []
      const node = capture.node
      return [{ node, role, type: node.type, start: node.startIndex, end: node.endIndex }]
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const swept = sweep(x.input, x.language, items, late, spans)
  // The sweep checks the clock between items; a single item that ran past the box still makes the file a timeout.
  if (!swept || late()) return x.refuse("timeout", { language: x.language, detail: "sweep" })
  return {
    parsed: true,
    path: x.input.path,
    language: x.language,
    grammar: `${GRAMMARS[x.language].package}@${GRAMMARS[x.language].version}`,
    queries: QUERY_VERSION,
    hasError: x.tree.rootNode.hasError,
    ...swept,
    depth: walked.depth,
    parseMs: x.parseMs,
    walkMs,
    extractMs: performance.now() - begun,
  }
}

// A statement node the walk saw (VS-37a): its character range, its 1-based lines, and whether it is compound.
interface Span {
  start: number
  end: number
  first: number
  last: number
  compound: boolean
}

// Every node once, without recursion, stopping at the first level past the limit. Asked for statements, it also
// records each statement node it passes, in document order with a parent before its children, read from the cursor
// alone, so no node is ever asked for its parent.
function walk(
  cursor: TreeCursor,
  anchors: Uint8Array,
  limit: number,
  late: () => boolean,
  statements?: { table: Uint8Array; spans: Span[] },
) {
  const at = { depth: 0, deepest: 0, anchors: 0, seen: 0 }
  for (;;) {
    at.anchors += anchors[cursor.nodeTypeId]
    at.seen++
    const role = statements?.table[cursor.nodeTypeId]
    if (role) {
      const first = cursor.startPosition
      const end = cursor.endPosition
      statements?.spans.push({
        start: cursor.startIndex,
        end: cursor.endIndex,
        first: first.row + 1,
        last: end.column === 0 && end.row > first.row ? end.row : end.row + 1,
        compound: role === 2,
      })
    }
    if (at.seen % 8_192 === 0 && late()) return "timeout" as const
    if (cursor.gotoFirstChild()) {
      at.depth++
      if (at.depth > limit) return "nesting" as const
      at.deepest = Math.max(at.deepest, at.depth)
      continue
    }
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return { depth: at.deepest, anchors: at.anchors }
      at.depth--
    }
  }
}

interface Item {
  node: Node
  role: Role
  type: string
  start: number
  end: number
}

interface Def extends Draft {
  start: number
  end: number
}

interface Container {
  name: string
  exported: boolean
  kind: string
  trait?: string // a Rust `impl Trait for T`
  ambient?: boolean // a TS `declare module "name"`, whose declarations are all exported
}

interface Frame {
  item: Item
  def?: Def
  enclosing?: Def // the innermost definition at or above this frame
  container?: Container // the innermost container at or above this frame
  moduleScope: boolean // whether a declaration directly inside this frame is at module (or member) scope
  members: boolean // whether this is the member body of the definition right below it (`container` then names it)
  inImport: boolean
}

interface Context {
  input: ParseInput
  language: ParseLanguage
  text: string
  top?: Frame
  stack: readonly Frame[]
  decorators: readonly Item[]
  trivia: readonly Item[]
  facts: Facts
}

// What only the whole file says: TS/JS export clauses and `module.exports`, Python's `__all__`, Rust trait
// visibility. Gathered before the sweep, because an export clause can follow what it exports.
interface Facts {
  exported: Map<string, string[]> // name -> aliases
  all?: Set<string>
  traits: Map<string, boolean>
}

function sweep(
  input: ParseInput,
  language: ParseLanguage,
  items: readonly Item[],
  late: () => boolean,
  spans: readonly Span[],
) {
  const text = input.text
  const facts = gather(language, text, items)
  const stack: Frame[] = []
  const statementAt = statementFinder(spans)
  const out = {
    errors: [] as { start: number; end: number }[],
    references: [] as ParsedReference[],
    comments: [] as CommentRange[],
    strings: [] as SourceRange[],
  }
  const defs: Def[] = []
  const names = new Set<number>() // start indices of definition names, which are not references
  const callees = new Set<number>() // end indices of callees
  const cuts: Range[] = [] // parameter default values, which signatures read as `…`
  // The decorators or attributes since the last definition, and the comments among them.
  const run = { decorators: [] as Item[], trivia: [] as Item[] }
  const clear = () => {
    run.decorators.length = 0
    run.trivia.length = 0
  }
  const ok = items.every((item, index) => {
    if (index % 1_024 === 0 && late()) return false
    while (stack.length && stack[stack.length - 1].item.end <= item.start) stack.pop()
    const top = stack.at(-1)
    const last = run.decorators.at(-1)
    if (last && item.role !== "comment" && item.role !== "decorator" && item.role !== "definition") {
      if (item.start >= last.end) clear()
    }
    if (item.role === "comment") {
      out.comments.push(commentRange(item.node, text, item))
      if (run.decorators.length) run.trivia.push(item)
      return true
    }
    if (item.role === "string") {
      out.strings.push({ start: item.node.startPosition.row + 1, end: item.node.endPosition.row + 1 })
      return true
    }
    if (item.role === "error") {
      out.errors.push({ start: item.node.startPosition.row + 1, end: lastLine(item.node) })
      return true
    }
    if (item.role === "decorator") {
      run.decorators.push(item)
      return true
    }
    if (item.role === "default") {
      const value = item.node.childForFieldName(RULES[language].defaults[item.type] ?? "")
      if (value) cuts.push({ start: value.startIndex, end: value.endIndex })
      return true
    }
    if (item.role === "call") {
      const field = item.node.childForFieldName(RULES[language].callee[item.type] ?? "")
      // A Rust turbofish (`parse::<u8>()`) ends after its type arguments; the callee is the function inside it.
      const callee = field?.type === "generic_function" ? field.childForFieldName("function") : field
      if (callee) callees.add(callee.endIndex)
      return true
    }
    if (item.role === "reference") {
      if (names.has(item.start)) return true
      const name = text.slice(item.start, item.end)
      if (input.names && !input.names.has(name)) return true
      const line = item.node.startPosition.row + 1
      const statement = input.statements ? statementAt(item.start, line) : undefined
      out.references.push({
        name,
        line,
        column: item.node.startPosition.column,
        kind: referenceKind(language, item, name, top, callees),
        ...(top?.enclosing ? { enclosing: top.enclosing.name } : {}),
        ...(statement ? { statement } : {}),
      })
      return true
    }
    const context: Context = {
      input,
      language,
      text,
      top,
      stack,
      decorators: run.decorators,
      trivia: run.trivia,
      facts,
    }
    const found =
      item.role === "definition" || item.role === "assignment" || item.role === "wrapper" ? define(item, context) : []
    if (item.role === "assignment" && !found.length) return true
    found.forEach((def) => {
      def.nameStart.forEach((start) => names.add(start))
      defs.push(def)
    })
    if (found.length) clear()
    stack.push(frame(item, found[0], context))
    return true
  })
  if (!ok) return undefined
  // A default value sits after the head that holds it, so heads are read once every default is known.
  const sorted = cuts.toSorted((a, b) => a.start - b.start || b.end - a.end)
  return { ...out, definitions: defs.map((def) => publicDefinition(def, text, sorted)) }
}

// The statement around each reference, asked in document order: a stack of the statements open at that point, so the
// cost is one pass over the statements however many references there are. The innermost simple statement gives its
// lines; an innermost compound one gives its first line through the reference's.
function statementFinder(spans: readonly Span[]) {
  const open: Span[] = []
  const next = { index: 0 }
  return (index: number, line: number) => {
    while (next.index < spans.length && spans[next.index].start <= index) {
      const span = spans[next.index]
      while (open.length && open[open.length - 1].end <= span.start) open.pop()
      open.push(span)
      next.index++
    }
    while (open.length && open[open.length - 1].end <= index) open.pop()
    const top = open.at(-1)
    if (!top) return undefined
    return top.compound ? { start: top.first, end: Math.max(top.first, line) } : { start: top.first, end: top.last }
  }
}

function publicDefinition(def: Def, text: string, cuts: readonly Range[]): ParsedDefinition {
  const signature = def.signature
  return {
    name: def.name,
    kind: def.kind,
    start: def.start,
    end: def.end,
    exported: def.exported,
    signature:
      typeof signature === "string"
        ? signature
        : signatureOf(signature.prefix + withoutDefaults(text, signature.from, signature.to, cuts)),
    ...(def.container ? { container: def.container } : {}),
    ...(def.aliases?.length ? { aliases: def.aliases } : {}),
  }
}

// The source in [from, to) with every outermost default value in it replaced by `…`. One binary search per default,
// so a head never walks the defaults nested inside the ones it cuts.
function withoutDefaults(text: string, from: number, to: number, cuts: readonly Range[]) {
  const pieces: string[] = []
  const at = { from, index: firstCut(cuts, from, 0) }
  while (at.index < cuts.length && cuts[at.index].start < to) {
    const cut = cuts[at.index]
    pieces.push(text.slice(at.from, cut.start), "…")
    at.from = Math.min(to, cut.end)
    at.index = firstCut(cuts, at.from, at.index + 1)
  }
  pieces.push(text.slice(at.from, to))
  return pieces.join("")
}

// The index of the first cut, from `low` on, that starts at or after `start`.
function firstCut(cuts: readonly Range[], start: number, low: number) {
  const range = { low, high: cuts.length }
  while (range.low < range.high) {
    const middle = (range.low + range.high) >>> 1
    const before = cuts[middle].start < start
    if (before) range.low = middle + 1
    if (!before) range.high = middle
  }
  return range.low
}

function frame(item: Item, def: Def | undefined, context: Context): Frame {
  const top = context.top
  const inherited = top?.moduleScope ?? true
  return {
    item,
    def,
    enclosing: def ?? top?.enclosing,
    container: containerOf(item, def, context) ?? top?.container,
    moduleScope: scopeOf(item, def, context, inherited),
    members: MEMBER_BODIES.has(item.type) && top?.def?.body === item.start,
    inImport:
      item.role === "import" || (item.type === "export_statement" && hasField(item.node, "source")) || !!top?.inImport,
  }
}

// Whether a declaration directly inside this frame is at module scope (for Java and Rust members: not local).
function scopeOf(item: Item, def: Def | undefined, context: Context, inherited: boolean) {
  if (item.role === "wrapper" && !def) return inherited
  if (item.role === "container") return false
  if (item.role === "scope") {
    // A TS namespace's body keeps module scope.
    const top = context.top
    return !!top?.def && top.def.kind === "module" && top.item.end === item.end && inherited
  }
  if (!def) return inherited
  if (context.language === "java") return def.kind === "class" || def.kind === "interface" || def.kind === "enum"
  if (context.language === "rust") return def.kind === "module"
  return def.kind === "module"
}

function containerOf(item: Item, def: Def | undefined, context: Context): Container | undefined {
  if (item.role === "container") {
    const type = typeName(item.node.childForFieldName("type"), context.text)
    const trait = item.node.childForFieldName("trait")
    return {
      name: type ?? "",
      kind: "impl",
      exported: true,
      ...(trait ? { trait: typeName(trait, context.text) ?? "" } : {}),
    }
  }
  if (!def) return undefined
  if (!["class", "interface", "module", "enum", "struct", "trait"].includes(def.kind)) return undefined
  const ambient = item.type === "module" && item.node.childForFieldName("name")?.type === "string"
  return { name: def.name, kind: def.kind, exported: def.exported, ...(ambient ? { ambient } : {}) }
}

function referenceKind(
  language: ParseLanguage,
  item: Item,
  name: string,
  top: Frame | undefined,
  callees: Set<number>,
) {
  if (top?.inImport) return "import" as const
  if (callees.has(item.end)) return name === "require" && script(language) ? ("import" as const) : ("call" as const)
  if (item.type === "type_identifier") return "type" as const
  return "value" as const
}

// ---------------------------------------------------------------------------------------------------------------------
// Definitions per language.

function define(item: Item, context: Context): Def[] {
  if (script(context.language)) return defineScript(item, context)
  if (context.language === "python") return definePython(item, context)
  if (context.language === "go") return defineGo(item, context)
  if (context.language === "rust") return defineRust(item, context)
  return defineJava(item, context)
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"])
// The bodies whose members are recorded: not an object literal's methods, nor a type literal's (TS `object_type`).
const MEMBER_BODIES = new Set(["class_body", "interface_body"])
const MEMBERS = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "public_field_definition",
  "field_definition",
])

function defineScript(item: Item, context: Context): Def[] {
  const node = item.node
  const text = context.text
  if (item.type === "export_statement") return defaultExport(item, context)
  if (item.role === "wrapper") return []
  if (item.role === "assignment") return commonJsExport(item, context)
  if (item.type === "variable_declarator") return declarator(item, context)
  if (MEMBERS.has(item.type)) {
    const top = context.top
    if (!top || !MEMBER_BODIES.has(top.item.type)) return []
    const name = node.childForFieldName("name") ?? node.childForFieldName("property")
    if (!name) return []
    // An anonymous class that is no definition (`return class { m() {} }`) gives its members no container.
    const owner = top.members ? top.container : undefined
    const priv =
      name.type === "private_property_identifier" ||
      node.namedChildren.some((child) => child?.type === "accessibility_modifier" && slice(text, child) === "private")
    const field = item.type.endsWith("field_definition")
    const kind = RULES[context.language].kinds[item.type] ?? "method"
    const from = firstChildStart(node, ["decorator"])
    return [
      definition(item, context, {
        name: slice(text, name),
        nameStart: [name.startIndex],
        kind,
        exported: !!owner?.exported && !priv,
        signature: field
          ? signatureOf(text.slice(from, (node.childForFieldName("type") ?? name).endIndex))
          : { prefix: "", from, to: bodyStart(node) },
        ...(owner ? { container: owner.name } : {}),
      }),
    ]
  }
  const name = node.childForFieldName("name")
  if (!name) return []
  const own = item.type === "module" && name.type === "string" ? slice(text, name).slice(1, -1) : slice(text, name)
  const exports = exportOf(own, context)
  // Only a declaration at module or namespace scope is directly in a container; one in a function body is not.
  const container = (context.top?.moduleScope ?? true) ? context.top?.container : undefined
  const ambient = item.type === "module" && name.type === "string"
  return [
    definition(item, context, {
      name: own,
      nameStart: [name.startIndex],
      kind: RULES[context.language].kinds[item.type] ?? "function",
      exported:
        ambient ||
        !!container?.ambient ||
        (exports.exported &&
          (container?.kind === "module" ? container.exported : true) &&
          context.top?.enclosing?.kind !== "function" &&
          context.top?.enclosing?.kind !== "method"),
      aliases: exports.aliases,
      signature: { prefix: "", from: firstChildStart(node, ["decorator"]), to: bodyStart(node) },
      body: node.childForFieldName("body")?.startIndex,
      ...(container ? { container: container.name } : {}),
    }),
  ]
}

// `export default function () {}`, `export default class {}`, `export default () => ...`: a definition named
// "default". Named defaults (`export default function f`) are their own definitions with the alias "default".
function defaultExport(item: Item, context: Context): Def[] {
  const value = item.node.childForFieldName("value")
  if (!value) return []
  const kind = value.type === "class" ? "class" : FUNCTION_VALUES.has(value.type) ? "function" : undefined
  if (!kind) return []
  return [
    definition(item, context, {
      name: "default",
      nameStart: [],
      kind,
      exported: true,
      signature: { prefix: "", from: value.startIndex, to: bodyStart(value) },
      body: value.childForFieldName("body")?.startIndex,
    }),
  ]
}

// `exports.x = ...` and `module.exports.x = ...` at module scope, in JavaScript; and `module.exports = class Foo {}`
// or `= function named() {}`, the module's default export, named after its value ("default" when it has no name). A
// `module.exports` of a name or an object literal is an export list, which `gather` reads.
function commonJsExport(item: Item, context: Context): Def[] {
  if (context.stack.length) return []
  const text = context.text
  const left = item.node.childForFieldName("left")
  const right = item.node.childForFieldName("right")
  if (!left || !right) return []
  const kind = FUNCTION_VALUES.has(right.type) ? "function" : right.type === "class" ? "class" : "variable"
  const head = { prefix: "", from: left.startIndex, to: bodyStart(right) }
  if (slice(text, left) === "module.exports") {
    if (kind === "variable") return []
    const name = right.childForFieldName("name")
    return [
      definition(item, context, {
        name: name ? slice(text, name) : "default",
        nameStart: name ? [name.startIndex] : [],
        kind,
        exported: true,
        aliases: name ? ["default"] : [],
        signature: head,
        body: right.childForFieldName("body")?.startIndex,
      }),
    ]
  }
  const target = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(slice(text, left))
  if (!target) return []
  return [
    definition(item, context, {
      name: target[1],
      nameStart: [left.endIndex - target[1].length],
      kind,
      exported: true,
      signature: kind === "variable" ? slice(text, left) : head,
      body: right.childForFieldName("body")?.startIndex,
    }),
  ]
}

function declarator(item: Item, context: Context): Def[] {
  const top = context.top
  if (!top?.moduleScope) return []
  const node = item.node
  const text = context.text
  const name = node.childForFieldName("name")
  if (name?.type !== "identifier") return [] // destructuring binds no single name
  const value = node.childForFieldName("value")
  const kind = value && FUNCTION_VALUES.has(value.type) ? "function" : value?.type === "class" ? "class" : "variable"
  const keyword =
    top.item.type === "variable_declaration" ? "var" : (top.item.node.childForFieldName("kind")?.type ?? "const")
  const own = slice(text, name)
  const typed = node.childForFieldName("type")
  const exports = exportOf(own, context)
  const container = top.container
  // A variable's value never enters its signature, since it can hold a credential; a function's parameters do, each
  // default read as `…`.
  const head = `${keyword} ${own}${typed ? slice(text, typed) : ""}`
  return [
    definition(item, context, {
      name: own,
      nameStart: [name.startIndex],
      kind,
      exported:
        !!container?.ambient || (exports.exported && (container?.kind === "module" ? container.exported : true)),
      aliases: exports.aliases,
      signature:
        kind === "variable" || !value
          ? signatureOf(head)
          : { prefix: `${head} = `, from: value.startIndex, to: bodyStart(value) },
      body: value?.childForFieldName("body")?.startIndex,
      ...(container ? { container: container.name } : {}),
    }),
  ]
}

// Exported through a direct `export` wrapper, or by name through an export clause, `export default name`,
// `export = name` or `module.exports`.
function exportOf(name: string, context: Context) {
  const wrappers = directWrappers(context)
  const statement = wrappers.find((frame) => frame.item.type === "export_statement")
  const byName = (context.top?.moduleScope ?? true) && context.facts.exported.has(name)
  const aliases = [
    ...(statement && statement.item.node.children.some((child) => child?.type === "default") ? ["default"] : []),
    ...(byName ? (context.facts.exported.get(name) ?? []) : []),
  ]
  return { exported: !!statement || byName, aliases: [...new Set(aliases)].filter((alias) => alias !== name) }
}

function directWrappers(context: Context) {
  const stack = context.stack
  const end = stack.length
  const start = stack.findLastIndex((frame) => frame.item.role !== "wrapper" || !!frame.def) + 1
  return stack.slice(start, end)
}

function definePython(item: Item, context: Context): Def[] {
  const node = item.node
  const text = context.text
  const top = context.top
  const enclosing = top?.enclosing
  if (item.role === "wrapper") return []
  if (item.type === "assignment") {
    if (!(top?.moduleScope ?? true)) return []
    const left = node.childForFieldName("left")
    if (left?.type !== "identifier") return []
    const own = slice(text, left)
    const typed = node.childForFieldName("type")
    const head = `${own}${typed ? `: ${slice(text, typed)}` : ""}`
    return [
      definition(item, context, {
        name: own,
        nameStart: [left.startIndex],
        kind: "variable",
        exported: context.facts.all ? context.facts.all.has(own) : pythonPublic(own),
        signature: signatureOf(head),
      }),
    ]
  }
  const name = node.childForFieldName("name")
  if (!name) return []
  const own = slice(text, name)
  const member = enclosing?.kind === "class"
  const local = enclosing?.kind === "function" || enclosing?.kind === "method"
  // A definition in a function body is in no container, even when the function is a method.
  const container = local ? undefined : top?.container
  // The head stops at its own colon, so neither the colon nor a comment after it enters the signature.
  const colon = node.children.find((child) => child?.type === ":")
  return [
    definition(item, context, {
      name: own,
      nameStart: [name.startIndex],
      kind: item.type === "class_definition" ? "class" : member ? "method" : "function",
      exported: local
        ? false
        : member
          ? pythonPublic(own) && enclosing.exported
          : context.facts.all
            ? context.facts.all.has(own)
            : pythonPublic(own),
      signature: { prefix: "", from: node.startIndex, to: colon?.startIndex ?? bodyStart(node) },
      ...(container ? { container: container.name } : {}),
    }),
  ]
}

// No leading underscore, except dunders (`__init__`), which are part of every class's interface.
function pythonPublic(name: string) {
  return !name.startsWith("_") || (name.length > 4 && name.startsWith("__") && name.endsWith("__"))
}

function defineGo(item: Item, context: Context): Def[] {
  const node = item.node
  const text = context.text
  const top = context.top
  const local = !(top?.moduleScope ?? true)
  if (item.type === "const_spec" || item.type === "var_spec") {
    if (local) return []
    const typed = node.childForFieldName("type")
    const keyword = item.type === "const_spec" ? "const" : "var"
    return node
      .childrenForFieldName("name")
      .filter((name): name is Node => name?.type === "identifier")
      .map((name) => {
        const own = slice(text, name)
        const head = `${keyword} ${own}${typed ? ` ${slice(text, typed)}` : ""}`
        return definition(item, context, {
          name: own,
          nameStart: [name.startIndex],
          kind: "variable",
          exported: goExported(own),
          signature: signatureOf(head),
        })
      })
  }
  const name = node.childForFieldName("name")
  if (!name) return []
  const own = slice(text, name)
  const shape = node.childForFieldName("type")?.type
  const kind =
    item.type === "type_spec"
      ? shape === "struct_type"
        ? "struct"
        : shape === "interface_type"
          ? "interface"
          : "type"
      : (RULES.go.kinds[item.type] ?? "function")
  const receiver = item.type === "method_declaration" ? goReceiver(node, text) : undefined
  // A type spec does not hold its `type` keyword, which belongs to the declaration around it.
  const head = `${item.type.startsWith("type_") ? "type " : ""}${text.slice(node.startIndex, bodyStart(node))}`
  return [
    definition(item, context, {
      name: own,
      nameStart: [name.startIndex],
      kind,
      exported: !local && goExported(own),
      signature: signatureOf(head),
      ...(receiver ? { container: receiver } : {}),
    }),
  ]
}

function goExported(name: string) {
  return /^\p{Lu}/u.test(name)
}

// The receiver's type name: `(s *Server)`, `(g Gen[T])`.
function goReceiver(node: Node, text: string) {
  const declared = node
    .childForFieldName("receiver")
    ?.namedChildren.find((child) => child?.type === "parameter_declaration")
  const type = declared?.childForFieldName("type")
  const pointed = type?.type === "pointer_type" ? type.namedChildren[0] : type
  const base = pointed?.type === "generic_type" ? pointed.childForFieldName("type") : pointed
  return base?.type === "type_identifier" ? slice(text, base) : undefined
}

function defineRust(item: Item, context: Context): Def[] {
  const node = item.node
  const text = context.text
  const top = context.top
  const name = node.childForFieldName("name")
  if (!name) return []
  const own = slice(text, name)
  const visible = rustVisible(node, text)
  const owner = top?.container
  const direct = !!top && (top.item.role === "container" || top.def?.kind === "trait")
  const fn = item.type === "function_item" || item.type === "function_signature_item"
  const method = fn && direct
  const local = !method && !(top?.moduleScope ?? true) && !direct
  const exported = method
    ? owner?.kind === "trait"
      ? owner.exported
      : owner?.trait !== undefined
        ? (context.facts.traits.get(owner.trait) ?? true)
        : visible
    : !local && visible
  const end =
    item.type === "const_item" || item.type === "static_item"
      ? (node.childForFieldName("type") ?? name).endIndex
      : bodyStart(node)
  const signature =
    item.type === "macro_definition" ? `macro_rules! ${own}` : signatureOf(text.slice(node.startIndex, end))
  // An item in a function body is in no container, even inside a module.
  const container = direct || (owner?.kind === "module" && !local) ? owner?.name : undefined
  return [
    definition(item, context, {
      name: own,
      nameStart: [name.startIndex],
      kind: method ? "method" : (RULES.rust.kinds[item.type] ?? "function"),
      exported,
      signature,
      ...(container ? { container } : {}),
    }),
  ]
}

// Any `pub` but `pub(self)` and `pub(in self)`, which are private.
function rustVisible(node: Node, text: string) {
  const modifier = node.namedChildren.find((child) => child?.type === "visibility_modifier")
  if (!modifier) return false
  const written = slice(text, modifier).replace(/\s+/g, "")
  return written !== "pub(self)" && written !== "pub(inself)"
}

function defineJava(item: Item, context: Context): Def[] {
  const node = item.node
  const text = context.text
  const top = context.top
  const local = !(top?.moduleScope ?? true)
  // Only a member of a class, interface or enum declaration is in it: an anonymous class's members, and a local class,
  // are in no container.
  const direct = top?.def?.kind === "class" || top?.def?.kind === "interface" || top?.def?.kind === "enum"
  const container = direct ? top?.container : undefined
  const modifiers = node.namedChildren.find((child) => child?.type === "modifiers")
  const priv = !!modifiers?.children.some((child) => child?.type === "private")
  const exported = !local && !priv && (container ? container.exported : true)
  const keywords = (modifiers?.children ?? [])
    .filter((child): child is Node => !!child && !child.isNamed)
    .map((child) => slice(text, child))
    .join(" ")
  if (item.type === "field_declaration" || item.type === "constant_declaration") {
    const typed = node.childForFieldName("type")
    return node
      .childrenForFieldName("declarator")
      .map((declared) => declared?.childForFieldName("name"))
      .filter((name): name is Node => !!name)
      .map((name) => {
        const own = slice(text, name)
        const head = `${keywords} ${typed ? slice(text, typed) : ""} ${own}`
        return definition(item, context, {
          name: own,
          nameStart: [name.startIndex],
          kind: "variable",
          exported,
          signature: signatureOf(head),
          ...(container ? { container: container.name } : {}),
        })
      })
  }
  const name = node.childForFieldName("name")
  if (!name) return []
  const rest = modifiers ? modifiers.endIndex : node.startIndex
  const head = `${keywords} ${text.slice(rest, bodyStart(node))}`
  return [
    definition(item, context, {
      name: slice(text, name),
      nameStart: [name.startIndex],
      kind: RULES.java.kinds[item.type] ?? "class",
      exported,
      signature: signatureOf(head),
      ...(container ? { container: container.name } : {}),
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers.

interface Draft {
  name: string
  nameStart: number[]
  kind: DefinitionKind
  exported: boolean
  signature: string | Head // a Head is read after the sweep, without its parameter defaults
  container?: string
  aliases?: string[]
  body?: number // where its member body starts, for a class or interface (see Frame.members)
}

// A signature still to be read: `prefix`, then the source in [from, to) without its parameter defaults.
interface Head {
  prefix: string
  from: number
  to: number
}

interface Range {
  start: number
  end: number
}

// A definition's lines: from the earliest of its node, its direct wrappers (export, declare, the declaration list, a
// Python decorator wrapper ending where it ends) and the decorators or attributes right before it, to its last line.
function definition(item: Item, context: Context, draft: Draft): Def {
  const wrappers = directWrappers(context).filter(
    (frame) => frame.item.type !== "decorated_definition" || frame.item.end === item.end,
  )
  const decorator = adjacent(item, context)
  const first = [...wrappers.map((frame) => frame.item.node), ...(decorator ? [decorator.node] : []), item.node].reduce(
    (earliest, node) => (node.startIndex < earliest.startIndex ? node : earliest),
  )
  return { ...draft, start: first.startPosition.row + 1, end: lastLine(item.node) }
}

// The first decorator (TS members) or attribute (Rust) of the run that ends right before this item, with only
// whitespace and comments between them. Both lists are in document order, so one pass walks them backwards together
// and reads each gap's text once: a run costs its length, not its length squared.
function adjacent(item: Item, context: Context) {
  const text = context.text
  const trivia = context.trivia
  const decorators = context.decorators
  const blank = (from: number, to: number) => text.slice(from, to).trim() === ""
  const at = { next: item.start, comment: trivia.length - 1, gap: 0 }
  const stop = decorators.findLastIndex((dec) => {
    if (dec.end > at.next) return true
    // A comment at or past the gap's end is inside a decorator already passed.
    while (at.comment >= 0 && trivia[at.comment].start >= at.next) at.comment--
    at.gap = at.next
    while (at.comment >= 0 && trivia[at.comment].start >= dec.end) {
      if (!blank(trivia[at.comment].end, at.gap)) return true
      at.gap = trivia[at.comment].start
      at.comment--
    }
    if (!blank(dec.end, at.gap)) return true
    at.next = dec.start
    return false
  })
  return decorators.at(stop + 1)
}

function commentRange(node: Node, text: string, item: Item): CommentRange {
  // Rust doc comments and some line comments end with their newline; the range stops at the line's end.
  const raw = text.slice(item.start, item.end)
  const own = raw.endsWith("\n") ? raw.slice(0, -1) : raw
  const start = node.startPosition.row + 1
  return { start, end: start + (own.match(/\n/g)?.length ?? 0), text: own }
}

function lastLine(node: Node) {
  const end = node.endPosition
  const start = node.startPosition
  return end.column === 0 && end.row > start.row ? end.row : end.row + 1
}

function bodyStart(node: Node) {
  return node.childForFieldName("body")?.startIndex ?? node.endIndex
}

function firstChildStart(node: Node, skip: readonly string[]) {
  return node.children.find((child) => !!child && !skip.includes(child.type))?.startIndex ?? node.startIndex
}

function hasField(node: Node, field: string) {
  return !!node.childForFieldName(field)
}

function typeName(node: Node | null, text: string): string | undefined {
  if (!node) return undefined
  if (node.type === "generic_type") return typeName(node.childForFieldName("type"), text)
  if (node.type === "scoped_type_identifier") return typeName(node.childForFieldName("name"), text)
  return slice(text, node)
}

function slice(text: string, node: Node) {
  return text.slice(node.startIndex, node.endIndex)
}

// Whitespace collapsed, at most 240 UTF-16 units, never cut inside a surrogate pair.
function signatureOf(raw: string) {
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat.length <= 240) return flat
  const cut = /[\uD800-\uDBFF]/.test(flat[239] ?? "") ? 239 : 240
  return flat.slice(0, cut)
}

function script(language: ParseLanguage) {
  return language === "typescript" || language === "tsx" || language === "javascript"
}

// The text after a file name's last dot, lower-cased; none for a name with no dot after its first character.
function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}

// The whole-file facts, read before the sweep (see Facts).
function gather(language: ParseLanguage, text: string, items: readonly Item[]): Facts {
  const exported = new Map<string, string[]>()
  const add = (name: string, alias?: string) =>
    exported.set(name, [...(exported.get(name) ?? []), ...(alias && alias !== name ? [alias] : [])])
  const traits = new Map<string, boolean>()
  const scopes: Item[] = []
  const found = { all: undefined as Set<string> | undefined }
  items.forEach((item) => {
    while (scopes.length && scopes[scopes.length - 1].end <= item.start) scopes.pop()
    const top = !scopes.length
    if (item.role === "scope") scopes.push(item)
    if (item.type === "export_statement" && !hasField(item.node, "source")) {
      const node = item.node
      const clause = node.namedChildren.find((child) => child?.type === "export_clause")
      clause?.namedChildren
        .filter((child): child is Node => child?.type === "export_specifier")
        .forEach((specifier) => {
          const name = specifier.childForFieldName("name")
          const alias = specifier.childForFieldName("alias")
          if (name) add(slice(text, name), alias ? slice(text, alias) : undefined)
        })
      const value = node.childForFieldName("value")
      if (value?.type === "identifier") add(slice(text, value), "default")
      const assigned = node.children.some((child) => child?.type === "=")
      const target = node.namedChildren.find((child) => child?.type === "identifier")
      if (assigned && target) add(slice(text, target))
    }
    if (language === "javascript" && item.role === "assignment" && top) {
      const left = item.node.childForFieldName("left")
      const right = item.node.childForFieldName("right")
      if (left && right && slice(text, left) === "module.exports") {
        if (right.type === "identifier") add(slice(text, right), "default")
        right.namedChildren.forEach((child) => {
          if (child?.type === "shorthand_property_identifier") add(slice(text, child))
          const key = child?.type === "pair" ? child.childForFieldName("key") : null
          const value = child?.type === "pair" ? child.childForFieldName("value") : null
          if (key && value?.type === "identifier") add(slice(text, value), slice(text, key))
        })
      }
    }
    if (language === "python" && item.type === "assignment" && top) {
      const left = item.node.childForFieldName("left")
      const right = item.node.childForFieldName("right")
      if (left && right && slice(text, left) === "__all__" && (right.type === "list" || right.type === "tuple")) {
        const entries = right.namedChildren.filter((child): child is Node => !!child)
        const strings = entries.flatMap((entry) =>
          entry.type === "string"
            ? entry.namedChildren
                .filter((part): part is Node => part?.type === "string_content")
                .map((part) => slice(text, part))
            : [],
        )
        found.all = entries.every((entry) => entry.type === "string") ? new Set(strings) : undefined
      }
    }
    if (language === "rust" && item.type === "trait_item") {
      const name = item.node.childForFieldName("name")
      if (name) traits.set(slice(text, name), rustVisible(item.node, text))
    }
  })
  return { exported, traits, ...(found.all ? { all: found.all } : {}) }
}

// A table frozen all the way down (see the opening comment).
function frozen<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null) Object.values(value).forEach((entry) => frozen(entry))
  return Object.freeze(value)
}

export * as ReviewParse from "./parse"
