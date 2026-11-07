import { describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Exit } from "effect"
import { BrainCode } from "@vectordevai/core/brain/code"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { classifyTrivial } from "@vectordevai/core/review/trivial"
import {
  ReviewParse,
  type ParsedDefinition,
  type ParsedFile,
  type ParseInput,
  type ParseLanguage,
  type ParseLimits,
  type ParseResult,
} from "../../src/review/parse"
import { tmpdir } from "../fixture/fixture"

// VS-25a: the review parser over small fixtures per language, its refusals, its limits and its isolation from the
// reviewed repository. Tests that are not about time pass generous time boxes, so a slow runner never turns them into
// timeouts; the default boxes are tested where they are the subject.

const GENEROUS: ParseLimits = { ...ReviewParse.PARSE_LIMITS, parseMs: 60_000, extractMs: 60_000 }
// Built from parts, so no token-shaped literal sits in this file.
const TOKEN = ["ghp_", "0123456789abcdefghijABCDEFGHIJ012345"].join("")
const ENGINE = path.resolve(import.meta.dir, "../..")

const run = (input: ParseInput, limits: ParseLimits = GENEROUS) => Effect.runPromise(ReviewParse.parse(input, limits))

async function parsed(file: string, text: string, extra: Partial<ParseInput> = {}): Promise<ParsedFile> {
  const result = await run({ path: file, text, ...extra })
  if (!result.parsed) throw new Error(`not parsed: ${JSON.stringify(result)}`)
  return result
}

async function refused(input: ParseInput, limits: ParseLimits = GENEROUS) {
  const result = await run(input, limits)
  if (result.parsed) throw new Error(`parsed ${input.path}`)
  return result
}

// One line per definition: kind, name, lines, and what is set of exported, container and aliases.
const brief = (def: ParsedDefinition) =>
  [
    `${def.kind} ${def.name} ${def.start}-${def.end}`,
    def.exported ? "exported" : "",
    def.container ? `in ${def.container}` : "",
    def.aliases ? `as ${def.aliases.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" ")

const signatures = (file: ParsedFile) => Object.fromEntries(file.definitions.map((def) => [def.name, def.signature]))
const refs = (file: ParsedFile, name: string) =>
  file.references.filter((ref) => ref.name === name).map((ref) => `${ref.line}:${ref.kind}:${ref.enclosing ?? ""}`)

const lines = (...rows: string[]) => rows.join("\n") + "\n"

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures, one per language. Each but TSX holds token-shaped literals, in values and (TS, JS, Python) parameter
// defaults, that no signature may repeat.

const TS = lines(
  `import { helper as aid } from "./helper"`, // 1
  `/** A class. */`,
  `@Component({ selector: "x-y" })`,
  `export class Widget extends Base {`,
  `  @Input() label: string = "${TOKEN}"`, // 5
  `  private secret = 1`,
  `  #hidden = 2`,
  `  protected shown(): void {}`,
  `  @HostListener("click")`,
  `  onClick(event: Event): void {`, // 10
  `    aid(event)`,
  `    this.shown()`,
  `  }`,
  `}`,
  `class Internal { run() {} }`, // 15
  `export { Internal as Public }`,
  `export default function main(): number { return 1 }`,
  `export const TOKEN: string = "${TOKEN}"`,
  `const handler = (input: string) => input.trim()`,
  `export function outer() {`, // 20
  `  const local = 1`,
  `  function inner() {}`,
  `}`,
  `namespace Space { export function member() {} }`,
  `export namespace Open { export const value = 1 }`, // 25
  `declare module "ambient" { function declared(): void }`,
  `export const { a, b } = pair`,
  `export function connect(key = "${TOKEN}", { token = "${TOKEN}" } = {}) {}`,
  `class Client { constructor(private k: string = "${TOKEN}") {} }`,
  `const open = (t = "${TOKEN}") => t`, // 30
  `function wrap() { return { inner() {} } }`,
  `export const api = { get() {} }`,
  `class Maker { make() { return class { built() {} } } }`,
  `export interface Shape { area(): number; nested: { hidden(): void } }`,
)

const TSX = lines(
  "type Route = `/users/${string}`",
  "export const View = () => (",
  '  <div className="a',
  '  b" title={`t ${/* note */ x}`}>{label}</div>',
  ")",
)

const JS = lines(
  "#!/usr/bin/env node",
  `const path = require("path")`,
  "exports.read = function (file) { return path.join(file) }",
  "module.exports.write = (file) => file",
  `module.exports.VERSION = "${TOKEN}"`, // 5
  "function hidden() {}",
  "function shown() {}",
  "module.exports = { shown, alias: hidden }",
  "class Store { #items = []; size = 0; get() {} }",
  "// done", // 10
  "module.exports = class Cache { put() {} }",
  `function connect({ token = "${TOKEN}" }, key = "${TOKEN}") {}`,
)

const PY = lines(
  `"""Module docstring."""`,
  "import os",
  "from .util import helper as aid",
  `__all__ = ["Service", "run", "_forced"]`,
  `API_KEY: str = "${TOKEN}"`, // 5
  "_forced = 1",
  "",
  "@decorator",
  "@other(1)",
  "class Service(Base):", // 10
  `    """Doc."""`,
  "    def __init__(self, name: str) -> None:",
  "        self.name = name",
  "    def _private(self): pass",
  "    @property", // 15
  "    def label(self) -> str:",
  `        return f"{self.name!r} {'x'}"`,
  "",
  "def run(): aid(os.getcwd())",
  "def unlisted(): pass", // 20
  "# trailing",
  `def connect(token="${TOKEN}", *, key: str = "${TOKEN}"):  # inline`,
  "    def helper(): pass",
  "class Holder:",
  "    def method(self):", // 25
  "        def nested(): pass",
)

const GO = lines(
  "package server",
  "",
  "import (",
  `\t"fmt"`,
  `\tstr "strings"`, // 5
  ")",
  "",
  "// Server serves.",
  "type Server struct{ Addr string }",
  "type handler interface{ Serve() }", // 10
  "type ID = string",
  "const Max, min = 5, 6",
  `var Token string = "${TOKEN}"`,
  "func (s *Server) Run() error { fmt.Println(`raw",
  "text`); return nil }", // 15
  "func (s Server) stop() {}",
  "func New() *Server { type local struct{}; r := 'c'; _ = r; return &Server{} }",
)

const RS = lines(
  "/// A widget.",
  "#[derive(Debug)]",
  "#[cfg_attr(test, derive(Clone))]",
  "pub struct Widget { id: u32 }",
  "impl Widget {", // 5
  "    pub fn new() -> Self { make() }",
  "    fn secret(&self) {}",
  "}",
  `impl std::fmt::Display for Widget { fn fmt(&self, f: &mut Formatter) -> Result { write!(f, "w") } }`,
  "trait Hidden { fn hook(&self); }", // 10
  "pub trait Open { fn call(&self) {} }",
  "impl Hidden for Widget { fn hook(&self) {} }",
  "pub(self) fn private_fn() {}",
  "pub(crate) const MAX: u32 = 5;",
  `static KEY: &str = "${TOKEN}";`, // 15
  `const BYTES: &[u8] = b"bytes";`,
  `const RAW: &str = r#"raw"#;`,
  "mod inner { pub fn deep() {} }",
  "macro_rules! shout { () => {} }",
  "// line", // 20
  "fn turbo() { parse::<u8>(); items.collect::<Vec<u8>>(); }",
  "mod scope { fn outer() { fn local() {} } }",
)

const JAVA = lines(
  "package app;",
  "import java.util.List;",
  "@Deprecated",
  "public class Main {",
  `  @Value("x") private static final String KEY = "${TOKEN}", OTHER = "o";`, // 5
  "  int count;",
  "  public Main() { super(); }",
  '  String block = """',
  "    text",
  '    """;', // 10
  "  private void hide() { List.of(new Item()); run(); class Local { void x() {} } }",
  "  protected void run() {}",
  "  private static class Secret { void inside() {} }",
  "  static class Nested { void shown() {} }",
  "  enum Mode { A; void m() {} }", // 15
  "}",
  "interface Api { int LIMIT = 1; void call(); private void helper() {} }",
  "class PackagePrivate {}",
  "class Spawner { void spawn() { new Thread(new Runnable() { public void go() {} }); } }",
)

const FIXTURES: Record<ParseLanguage, { path: string; text: string }> = {
  typescript: { path: "src/widget.ts", text: TS },
  tsx: { path: "src/view.tsx", text: TSX },
  javascript: { path: "lib/index.js", text: JS },
  python: { path: "pkg/mod.py", text: PY },
  go: { path: "pkg/server.go", text: GO },
  rust: { path: "src/lib.rs", text: RS },
  java: { path: "src/Main.java", text: JAVA },
}

// ---------------------------------------------------------------------------------------------------------------------

describe("grammars", () => {
  test("each pinned grammar loads from the engine's own dependencies, at its pinned ABI", async () => {
    const manifest = JSON.parse(await readFile(path.join(ENGINE, "package.json"), "utf8"))
    for (const language of ReviewParse.PARSE_LANGUAGES) {
      const pin = ReviewParse.GRAMMARS[language]
      const loaded = await Effect.runPromise(ReviewParse.grammar(language))
      expect(loaded.abi).toBe(pin.abi)
      expect(loaded.bytes).toBeLessThanOrEqual(ReviewParse.PARSE_LIMITS.grammarBytes)
      expect(manifest.dependencies[pin.package]).toBe(pin.version)
      const installed = JSON.parse(
        await readFile(fileURLToPath(import.meta.resolve(`${pin.package}/package.json`)), "utf8"),
      )
      expect(installed.version).toBe(pin.version)
      expect(await realpath(loaded.path)).toBe(
        await realpath(fileURLToPath(import.meta.resolve(`${pin.package}/${pin.wasm}`))),
      )
    }
  })

  test("never tree-sitter-wasms, and web-tree-sitter stays at 0.25.10", async () => {
    const manifest = JSON.parse(await readFile(path.join(ENGINE, "package.json"), "utf8"))
    expect(manifest.dependencies["web-tree-sitter"]).toBe("0.25.10")
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain("tree-sitter-wasms")
  })

  test("every query is bare one-node patterns, one per node type", () => {
    for (const language of ReviewParse.PARSE_LANGUAGES) {
      const rules = ReviewParse.RULES[language]
      const patterns = ReviewParse.querySource(rules.roles).split("\n")
      for (const pattern of patterns) {
        const match = /^\(([A-Za-z_]+)\) @([a-z]+)$/.exec(pattern)
        expect(match).not.toBeNull()
        expect(ReviewParse.ROLES as readonly string[]).toContain(match![2])
      }
      expect(new Set(patterns.map((pattern) => pattern.split(" ")[0])).size).toBe(patterns.length)
      for (const type of Object.keys(rules.kinds)) expect(rules.roles[type]).toBe("definition")
      for (const type of Object.keys(rules.callee)) expect(rules.roles[type]).toBe("call")
      for (const type of Object.keys(rules.defaults)) expect(rules.roles[type]).toBe("default")
    }
  })

  test("every exported table is frozen all the way down", () => {
    const tables: unknown[] = [
      ReviewParse.PARSE_LANGUAGES,
      ReviewParse.REPORTED_LANGUAGES,
      ReviewParse.PARSE_EXTENSIONS,
      ReviewParse.REPORTED_EXTENSIONS,
      ReviewParse.GRAMMARS,
      ReviewParse.PARSE_LIMITS,
      ReviewParse.DEFINITION_KINDS,
      ReviewParse.REFERENCE_KINDS,
      ReviewParse.PARSE_REFUSALS,
      ReviewParse.ROLES,
      ReviewParse.RULES,
      ReviewParse.STATEMENTS,
    ]
    const thawed = (value: unknown): boolean =>
      typeof value === "object" && value !== null && (!Object.isFrozen(value) || Object.values(value).some(thawed))
    expect(tables.filter(thawed)).toEqual([])
    expect(() => {
      ;(ReviewParse.PARSE_LIMITS as { inputBytes: number }).inputBytes = 1
    }).toThrow(TypeError)
    expect(() => {
      ;(ReviewParse.RULES.go.roles as Record<string, string>).comment = "string"
    }).toThrow(TypeError)
    expect(ReviewParse.PARSE_LIMITS.inputBytes).toBe(1_048_576)
  })

  test("every module the parser loads is named by a literal specifier", async () => {
    const source = await readFile(path.join(ENGINE, "src/review/parse.ts"), "utf8")
    const loads = [...source.matchAll(/import\(([^)]*)\)/g)].map((match) => match[1])
    expect(loads).toHaveLength(ReviewParse.PARSE_LANGUAGES.length)
    for (const load of loads) expect(load).toMatch(/^"tree-sitter-[a-z]+\/tree-sitter-[a-z]+\.wasm" as string, \{/)
  })

  test("a grammar over its cap is refused before it loads", async () => {
    const result = await refused({ path: "a.ts", text: "const a = 1" }, { ...GENEROUS, grammarBytes: 1_000 })
    expect(result).toMatchObject({ because: "grammar", detail: "too-large", language: "typescript" })
  })
})

describe("languages", () => {
  test("extensions follow trivial.ts's rule and VS-24c's language sets", () => {
    expect(Object.keys(ReviewParse.PARSE_EXTENSIONS).toSorted()).toEqual(
      "ts tsx mts cts js jsx mjs cjs go rs java py pyi".split(" ").toSorted(),
    )
    expect(ReviewParse.languageOf("types/index.d.ts")).toBe("typescript")
    expect(ReviewParse.languageOf("SRC/App.TSX")).toBe("tsx")
    expect(ReviewParse.languageOf("a/b.MJS")).toBe("javascript")
    expect(ReviewParse.languageOf(".ts")).toBeUndefined()
    expect(ReviewParse.languageOf("Makefile")).toBeUndefined()
    for (const name of ["x.constructor", "x.__proto__", "x.toString", "x.hasOwnProperty"])
      expect(ReviewParse.languageOf(name)).toBeUndefined()
  })

  test("every parsed extension is the same family in BrainCode", () => {
    const family: Record<ParseLanguage, BrainCode.Language> = {
      typescript: "typescript",
      tsx: "typescript",
      javascript: "typescript",
      python: "python",
      go: "go",
      rust: "rust",
      java: "java",
    }
    for (const [ext, language] of Object.entries(ReviewParse.PARSE_EXTENSIONS))
      expect(BrainCode.language(`src/file.${ext}`)).toBe(family[language])
  })

  test("C, C++, C# and PHP are refused and named for separate reporting; other languages are refused unnamed", async () => {
    const cases = { "a.c": "c", "a.h": "c", "a.cpp": "cpp", "a.hpp": "cpp", "a.cs": "csharp", "a.php": "php" }
    for (const [file, reported] of Object.entries(cases))
      expect(await refused({ path: file, text: "int x;" })).toMatchObject({ because: "language", reported })
    const other = await refused({ path: "a.rb", text: "x = 1" })
    expect(other.because).toBe("language")
    expect(other.reported).toBeUndefined()
  })
})

describe("TypeScript", () => {
  test("definitions: spans from decorators and export wrappers, member export rules, aliases, containers", async () => {
    const file = await parsed(FIXTURES.typescript.path, TS)
    expect(file.definitions.map(brief)).toEqual([
      "class Widget 3-14 exported",
      "variable label 5-5 exported in Widget",
      "variable secret 6-6 in Widget",
      "variable #hidden 7-7 in Widget",
      "method shown 8-8 exported in Widget",
      "method onClick 9-13 exported in Widget",
      "class Internal 15-15 exported as Public",
      "method run 15-15 exported in Internal",
      "function main 17-17 exported as default",
      "variable TOKEN 18-18 exported",
      "function handler 19-19",
      "function outer 20-23 exported",
      "function inner 22-22",
      "module Space 24-24",
      "function member 24-24 in Space",
      "module Open 25-25 exported",
      "variable value 25-25 exported in Open",
      "module ambient 26-26 exported",
      "function declared 26-26 exported in ambient",
      "function connect 28-28 exported",
      "class Client 29-29",
      "method constructor 29-29 in Client",
      "function open 30-30",
      // An object literal's methods (lines 31 and 32) and a type literal's (line 34) are no definitions; an anonymous
      // class's members are in no container, and a function body is not its method's class.
      "function wrap 31-31",
      "variable api 32-32 exported",
      "class Maker 33-33",
      "method make 33-33 in Maker",
      "method built 33-33",
      "interface Shape 34-34 exported",
      "method area 34-34 exported in Shape",
    ])
    expect(signatures(file)).toMatchObject({
      Widget: "class Widget extends Base",
      label: "label: string",
      secret: "private secret",
      shown: "protected shown(): void",
      onClick: "onClick(event: Event): void",
      main: "function main(): number",
      TOKEN: "const TOKEN: string",
      handler: "const handler = (input: string) =>",
      member: "function member()",
      // Parameter defaults, destructured ones and a constructor parameter property's initialiser read as `…`.
      connect: "function connect(key = …, { token = … } = …)",
      constructor: "constructor(private k: string = …)",
      open: "const open = (t = …) =>",
    })
  })

  test("references: calls, imports, types and their enclosing definitions", async () => {
    const file = await parsed(FIXTURES.typescript.path, TS)
    expect(refs(file, "aid")).toEqual(["1:import:", "11:call:onClick"])
    expect(refs(file, "helper")).toEqual(["1:import:"])
    expect(refs(file, "shown")).toEqual(["12:call:onClick"])
    expect(refs(file, "Component")).toEqual(["3:call:"])
    expect(refs(file, "Event")).toEqual(["10:type:onClick"])
    expect(refs(file, "Base")).toEqual(["4:value:Widget"])
    // Definition names are not references; the export clause names are.
    expect(refs(file, "Widget")).toEqual([])
    expect(refs(file, "Internal")).toEqual(["16:value:"])
    // A block-scoped variable is not a module definition, so its name is a reference like any other.
    expect(refs(file, "local")).toEqual(["21:value:outer"])
  })

  test("comments and strings", async () => {
    const file = await parsed(FIXTURES.typescript.path, TS)
    expect(file.comments).toEqual([{ start: 2, end: 2, text: "/** A class. */" }])
    expect(file.strings.map((range) => range.start)).toEqual([1, 3, 5, 9, 18, 26, 28, 28, 29, 30])
    expect(file.hasError).toBe(false)
  })

  test("`export =` and `export { x as default }` mark the target exported", async () => {
    const assigned = await parsed("a.ts", lines("class Api {}", "export = Api"))
    expect(assigned.definitions.map(brief)).toEqual(["class Api 1-1 exported"])
    const aliased = await parsed("b.ts", lines("function make() {}", "export { make as default }"))
    expect(aliased.definitions.map(brief)).toEqual(["function make 1-1 exported as default"])
    const anonymous = await parsed("c.ts", lines("export default class {", "  open() {}", "}"))
    expect(anonymous.definitions.map(brief)).toEqual([
      "class default 1-3 exported",
      "method open 2-2 exported in default",
    ])
  })

  test("TSX: JSX attribute strings, template literal types and a comment inside a template substitution", async () => {
    const file = await parsed(FIXTURES.tsx.path, TSX)
    expect(file.language).toBe("tsx")
    expect(file.strings).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 4 },
      { start: 4, end: 4 },
    ])
    expect(file.comments).toEqual([{ start: 4, end: 4, text: "/* note */" }])
    expect(file.definitions.map(brief)).toEqual(["type Route 1-1", "function View 2-5 exported"])
  })
})

describe("JavaScript", () => {
  test("CommonJS exports, require as an import, and no hash-bang comment", async () => {
    const file = await parsed(FIXTURES.javascript.path, JS)
    expect(file.definitions.map(brief)).toEqual([
      "variable path 2-2",
      "function read 3-3 exported",
      "function write 4-4 exported",
      "variable VERSION 5-5 exported",
      "function hidden 6-6 exported as alias",
      "function shown 7-7 exported",
      "class Store 9-9",
      "variable #items 9-9 in Store",
      "variable size 9-9 in Store",
      "method get 9-9 in Store",
      "class Cache 11-11 exported as default",
      "method put 11-11 exported in Cache",
      "function connect 12-12",
    ])
    expect(signatures(file)).toMatchObject({
      read: "exports.read = function (file)",
      write: "module.exports.write = (file) =>",
      VERSION: "module.exports.VERSION",
      Cache: "module.exports = class Cache",
      connect: "function connect({ token = … }, key = …)",
    })
    expect(refs(file, "require")).toEqual(["2:import:path"])
    expect(refs(file, "join")).toEqual(["3:call:read"])
    expect(file.comments).toEqual([{ start: 10, end: 10, text: "// done" }])
  })

  test("`module.exports =` a class or function is the module's default export, named after it when it has a name", async () => {
    const named = await parsed("a.js", lines("module.exports = function named(key = 1) {}"))
    expect(named.definitions.map(brief)).toEqual(["function named 1-1 exported as default"])
    expect(named.definitions[0].signature).toBe("module.exports = function named(key = …)")
    const anonymous = await parsed("b.js", lines("module.exports = class {", "  run() {}", "}"))
    expect(anonymous.definitions.map(brief)).toEqual([
      "class default 1-3 exported",
      "method run 2-2 exported in default",
    ])
    const arrow = await parsed("c.js", lines("module.exports = () => 1"))
    expect(arrow.definitions.map(brief)).toEqual(["function default 1-1 exported"])
    // A value that is neither stays an export list or nothing, as before.
    expect((await parsed("d.js", lines("module.exports = 1"))).definitions).toEqual([])
  })
})

describe("Python", () => {
  test("__all__ decides module exports; class members follow their class; decorators open the span", async () => {
    const file = await parsed(FIXTURES.python.path, PY)
    expect(file.definitions.map(brief)).toEqual([
      "variable __all__ 4-4",
      "variable API_KEY 5-5",
      "variable _forced 6-6 exported",
      "class Service 8-17 exported",
      "method __init__ 12-13 exported in Service",
      "method _private 14-14 in Service",
      "method label 15-17 exported in Service",
      "function run 19-19 exported",
      "function unlisted 20-20",
      "function connect 22-23",
      "function helper 23-23",
      "class Holder 24-26",
      "method method 25-26 in Holder",
      // A function in a method's body is in no container.
      "function nested 26-26",
    ])
    expect(signatures(file)).toMatchObject({
      API_KEY: "API_KEY: str",
      Service: "class Service(Base)",
      __init__: "def __init__(self, name: str) -> None",
      // Defaults read as `…`, and the head stops at its colon, before the comment after it.
      connect: "def connect(token=…, *, key: str = …)",
    })
    expect(refs(file, "aid")).toEqual(["3:import:", "19:call:run"])
    expect(refs(file, "getcwd")).toEqual(["19:call:run"])
  })

  test("docstrings and f-strings are strings, never comments", async () => {
    const file = await parsed(FIXTURES.python.path, PY)
    expect(file.comments).toEqual([
      { start: 21, end: 21, text: "# trailing" },
      { start: 22, end: 22, text: "# inline" },
    ])
    expect(file.strings.map((range) => range.start)).toEqual([1, 4, 4, 4, 5, 11, 17, 17, 22, 22])
  })

  test("without __all__: a leading underscore is private, dunders are public", async () => {
    const file = await parsed(
      "pkg/plain.py",
      lines(
        "VISIBLE = 1",
        "_hidden = 2",
        "def __dunder__(): pass",
        "def _private(): pass",
        "class _Hidden:",
        "    def shown(self): pass",
        "def outer():",
        "    def inner(): pass",
        "    LOCAL = 1",
        `s = "a" "b"`,
      ),
    )
    expect(file.definitions.map(brief)).toEqual([
      "variable VISIBLE 1-1 exported",
      "variable _hidden 2-2",
      "function __dunder__ 3-3 exported",
      "function _private 4-4",
      "class _Hidden 5-6",
      "method shown 6-6 in _Hidden",
      "function outer 7-9 exported",
      "function inner 8-8",
      "variable s 10-10 exported",
    ])
    expect(file.strings).toEqual([
      { start: 10, end: 10 },
      { start: 10, end: 10 },
    ])
  })
})

describe("Go", () => {
  test("exported by case; receivers name the container; local types are not exported", async () => {
    const file = await parsed(FIXTURES.go.path, GO)
    expect(file.definitions.map(brief)).toEqual([
      "struct Server 9-9 exported",
      "interface handler 10-10",
      "type ID 11-11 exported",
      "variable Max 12-12 exported",
      "variable min 12-12",
      "variable Token 13-13 exported",
      "method Run 14-15 exported in Server",
      "method stop 16-16 in Server",
      "function New 17-17 exported",
      "struct local 17-17",
    ])
    expect(signatures(file)).toMatchObject({
      Server: "type Server struct{ Addr string }",
      ID: "type ID = string",
      Max: "const Max",
      Token: "var Token string",
      Run: "func (s *Server) Run() error",
    })
    expect(refs(file, "Println")).toEqual(["14:call:Run"])
    expect(refs(file, "str")).toEqual(["5:import:"])
  })

  test("raw strings span their lines; runes are not strings", async () => {
    const file = await parsed(FIXTURES.go.path, GO)
    expect(file.strings).toEqual([
      { start: 4, end: 4 },
      { start: 5, end: 5 },
      { start: 13, end: 13 },
      { start: 14, end: 15 },
    ])
    expect(file.comments).toEqual([{ start: 8, end: 8, text: "// Server serves." }])
  })
})

describe("Rust", () => {
  test("attributes open the span; trait methods follow the trait; pub(self) is private", async () => {
    const file = await parsed(FIXTURES.rust.path, RS)
    expect(file.definitions.map(brief)).toEqual([
      "struct Widget 2-4 exported",
      "method new 6-6 exported in Widget",
      "method secret 7-7 in Widget",
      "method fmt 9-9 exported in Widget",
      "trait Hidden 10-10",
      "method hook 10-10 in Hidden",
      "trait Open 11-11 exported",
      "method call 11-11 exported in Open",
      "method hook 12-12 in Widget",
      "function private_fn 13-13",
      "variable MAX 14-14 exported",
      "variable KEY 15-15",
      "variable BYTES 16-16",
      "variable RAW 17-17",
      "module inner 18-18",
      "function deep 18-18 exported in inner",
      "macro shout 19-19",
      "function turbo 21-21",
      "module scope 22-22",
      // An item in a function body is in no container, even inside a module.
      "function outer 22-22 in scope",
      "function local 22-22",
    ])
    expect(signatures(file)).toMatchObject({
      Widget: "pub struct Widget",
      new: "pub fn new() -> Self",
      private_fn: "pub(self) fn private_fn()",
      MAX: "pub(crate) const MAX: u32",
      KEY: "static KEY: &str",
      shout: "macro_rules! shout",
    })
    expect(refs(file, "make")).toEqual(["6:call:new"])
    expect(refs(file, "write")).toEqual(["9:call:fmt"])
    expect(refs(file, "Formatter")).toEqual(["9:type:fmt"])
    // A turbofish callee is a call, whether a path or a method.
    expect(refs(file, "parse")).toEqual(["21:call:turbo"])
    expect(refs(file, "collect")).toEqual(["21:call:turbo"])
  })

  test("doc comments stop at their line's end; byte, raw and C strings are strings", async () => {
    const file = await parsed(FIXTURES.rust.path, RS)
    expect(file.comments).toEqual([
      { start: 1, end: 1, text: "/// A widget." },
      { start: 20, end: 20, text: "// line" },
    ])
    expect(file.strings.map((range) => range.start)).toEqual([9, 15, 16, 17])
    const c = await parsed(
      "src/c.rs",
      lines(`const C: &CStr = c"cstr";`, `const R: &[u8] = br"x";`, "const Q: char = 'q';"),
    )
    expect(c.strings.map((range) => range.start)).toEqual([1, 2])
  })
})

describe("Java", () => {
  test("package-private is exported, private is not, local classes are not; local and anonymous classes are in no container", async () => {
    const file = await parsed(FIXTURES.java.path, JAVA)
    expect(file.definitions.map(brief)).toEqual([
      "class Main 3-16 exported",
      "variable KEY 5-5 in Main",
      "variable OTHER 5-5 in Main",
      "variable count 6-6 exported in Main",
      "method Main 7-7 exported in Main",
      "variable block 8-10 exported in Main",
      "method hide 11-11 in Main",
      "class Local 11-11",
      "method x 11-11 in Local",
      "method run 12-12 exported in Main",
      "class Secret 13-13 in Main",
      "method inside 13-13 in Secret",
      "class Nested 14-14 exported in Main",
      "method shown 14-14 exported in Nested",
      "enum Mode 15-15 exported in Main",
      "method m 15-15 exported in Mode",
      "interface Api 17-17 exported",
      "variable LIMIT 17-17 exported in Api",
      "method call 17-17 exported in Api",
      "method helper 17-17 in Api",
      "class PackagePrivate 18-18 exported",
      "class Spawner 19-19 exported",
      "method spawn 19-19 exported in Spawner",
      "method go 19-19",
    ])
    expect(signatures(file)).toMatchObject({
      Main: "public Main()",
      KEY: "private static final String KEY",
      count: "int count",
      hide: "private void hide()",
      LIMIT: "int LIMIT",
    })
    expect(refs(file, "run")).toEqual(["11:call:hide"])
    expect(refs(file, "Item")).toEqual(["11:call:hide"])
    expect(refs(file, "List")).toEqual(["2:import:", "11:value:hide"])
  })

  test("text blocks are strings", async () => {
    const file = await parsed(FIXTURES.java.path, JAVA)
    expect(file.strings).toEqual([
      { start: 5, end: 5 },
      { start: 5, end: 5 },
      { start: 5, end: 5 },
      { start: 8, end: 10 },
    ])
  })
})

describe("records", () => {
  test("no signature ever holds a variable's value or a parameter default", async () => {
    for (const fixture of Object.values(FIXTURES)) {
      const file = await parsed(fixture.path, fixture.text)
      for (const def of file.definitions) expect(def.signature).not.toContain("ghp_")
    }
  })

  test("a default inside a default is cut with it, and a cut never reaches past its head", async () => {
    const file = await parsed(
      "a.ts",
      lines(
        `function f(a = (b = "${TOKEN}") => b, c = 1) {`,
        `  return { g(d = 2) {} }`,
        `}`,
        `class K { m(e = class { n(h = 3) {} }) {} }`,
      ),
    )
    expect(signatures(file)).toMatchObject({ f: "function f(a = …, c = …)", m: "m(e = …)", n: "n(h = …)" })
  })

  test("signatures collapse whitespace and stop at 240 UTF-16 units, never inside a surrogate pair", async () => {
    // A literal type, not a default, so the long text stays in the signature.
    const pad = 'function f(a: "'
    const text = `${pad}${"x".repeat(239 - pad.length)}😀") {}\n`
    const file = await parsed("a.ts", text)
    expect(file.definitions[0].signature).toHaveLength(239)
    const wide = await parsed("b.ts", `function g(\n  a: number,\n\n  b: string,\n) {}\n`)
    expect(wide.definitions[0].signature).toBe("function g( a: number, b: string, )")
  })

  test("lines are 1-based and columns count UTF-16 units", async () => {
    const file = await parsed("u.ts", lines(`const s = "😀é"; foo(s)`, "const ü = 1"))
    expect(file.references.find((ref) => ref.name === "foo")).toMatchObject({ line: 1, column: 17, kind: "call" })
    expect(file.definitions.map((def) => def.name)).toEqual(["s", "ü"])
  })

  test("a names filter keeps only those references", async () => {
    const file = await parsed(FIXTURES.typescript.path, TS, { names: new Set(["aid"]) })
    expect(file.references.map((ref) => `${ref.name}:${ref.line}:${ref.kind}`)).toEqual(["aid:1:import", "aid:11:call"])
    expect(file.definitions).toHaveLength(30)
  })

  test("CRLF sources keep their carriage returns in comment text, on the right lines", async () => {
    const file = await parsed("a.ts", "// one\r\n/* two\r\n three */\r\nconst x = 1\r\n")
    expect(file.comments).toEqual([
      { start: 1, end: 1, text: "// one" },
      { start: 2, end: 3, text: "/* two\r\n three */" },
    ])
    expect(file.definitions.map(brief)).toEqual(["variable x 4-4"])
  })

  test("syntax errors still yield what parsed, with the error lines", async () => {
    const file = await parsed("a.ts", lines("function ok() {}", "function broken( {", "const after = 1"))
    expect(file.hasError).toBe(true)
    expect(file.errors.length).toBeGreaterThan(0)
    expect(file.definitions.map((def) => def.name)).toContain("ok")
  })

  test("fibers interleaving parses of several languages get the same records as one at a time", async () => {
    const inputs = [...Object.values(FIXTURES), ...Object.values(FIXTURES)].map((fixture) => ({
      path: fixture.path,
      text: fixture.text,
    }))
    const strip = (result: ParseResult) =>
      result.parsed ? { ...result, parseMs: 0, walkMs: 0, extractMs: 0 } : { ...result, ms: 0 }
    const one = await Promise.all(inputs.map((input) => run(input).then(strip)))
    const together = await Effect.runPromise(
      Effect.all(
        inputs.map((input) => ReviewParse.parse(input, GENEROUS)),
        { concurrency: "unbounded" },
      ),
    )
    expect(together.map(strip)).toEqual(one)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe("refusals and limits", () => {
  test("binary: a NUL in the first 8,000 characters", async () => {
    expect(await refused({ path: "a.ts", text: "const a = 1\0" })).toMatchObject({ because: "binary" })
    await parsed("b.ts", `const a = "${"x".repeat(8_000)}"\n// \0\n`)
  })

  test("input cap: exactly 1 MiB of UTF-8 parses, one byte more is refused", async () => {
    const head = "// "
    const exact = head + "x".repeat(ReviewParse.PARSE_LIMITS.inputBytes - head.length)
    expect((await parsed("a.ts", exact)).comments).toHaveLength(1)
    expect(await refused({ path: "a.ts", text: exact + "x" })).toMatchObject({ because: "too-large" })
    // Counted in UTF-8 bytes, not characters.
    const wide = head + "é".repeat(ReviewParse.PARSE_LIMITS.inputBytes / 2)
    expect(await refused({ path: "a.ts", text: wide })).toMatchObject({ because: "too-large" })
  })

  test("parse timeout: refused promptly, and the parser works again after it", async () => {
    const text = "const a = 1;\n".repeat(70_000)
    const started = performance.now()
    expect(await refused({ path: "a.ts", text }, { ...GENEROUS, parseMs: 1 })).toMatchObject({ because: "timeout" })
    expect(performance.now() - started).toBeLessThan(2_000)
    // A cancelled parse resumes on the next call unless the parser is reset, so the next file must come out whole.
    expect((await parsed("b.ts", "const b = 2;\n")).definitions.map((def) => def.name)).toEqual(["b"])
    expect((await parsed("a.ts", text)).definitions).toHaveLength(70_000)
  })

  test("extraction timeout and a caller's deadline", async () => {
    const text = "const a = 1;\n".repeat(70_000)
    expect(await refused({ path: "a.ts", text }, { ...GENEROUS, extractMs: 0 })).toMatchObject({ because: "timeout" })
    const late = await refused({ path: "a.ts", text, deadline: performance.now() - 1 })
    expect(late).toMatchObject({ because: "timeout" })
    expect(late.ms).toBeLessThan(500)
  })

  test("one item that runs past the extraction box makes the file a timeout, not a late success", async () => {
    // A file of fewer than 1,024 captures is checked once inside the sweep, before its first item; this item then
    // stalls past the box, as one quadratic definition once did.
    class Stalling extends Set<string> {
      override has() {
        Bun.sleepSync(400)
        return true
      }
    }
    const result = await refused(
      { path: "a.ts", text: "foo()\n", names: new Stalling() },
      { ...GENEROUS, extractMs: 200 },
    )
    expect(result).toMatchObject({ because: "timeout", detail: "sweep", language: "typescript" })
  })

  test("nesting past the depth limit is refused before any query runs", async () => {
    const deep = (depth: number) => `let x = ${"[".repeat(depth)}a${"]".repeat(depth)};\n`
    const started = performance.now()
    expect(await refused({ path: "a.ts", text: deep(20_000) }, ReviewParse.PARSE_LIMITS)).toMatchObject({
      because: "nesting",
    })
    // G1-15's chain, whose capture query took 38.5 s and lost a third of its identifiers on 0.25.10.
    const chain = `let x = a${"+a".repeat(100_000)};\n`
    expect(await refused({ path: "a.ts", text: chain }, ReviewParse.PARSE_LIMITS)).toMatchObject({ because: "nesting" })
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  test("a slow query is stopped by its own time box", async () => {
    // With the depth limit lifted, G1-15's chain passes the walk; its capture query alone would run for about 40 s.
    const chain = `let x = a${"+a".repeat(100_000)};\n`
    const started = performance.now()
    const result = await refused({ path: "a.ts", text: chain }, { ...GENEROUS, depth: 1_000_000, extractMs: 1_000 })
    expect(result).toMatchObject({ because: "timeout", detail: "query" })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test("just under the depth limit: a complete record within the default boxes, or a prompt timeout", async () => {
    const text = `let x = ${"[".repeat(16_000)}a${"]".repeat(16_000)};\nfunction tail() { return b }\n`
    const started = performance.now()
    const result = await run({ path: "a.ts", text }, ReviewParse.PARSE_LIMITS)
    expect(performance.now() - started).toBeLessThan(5_000)
    if (!result.parsed) return expect(result.because).toBe("timeout")
    expect(result.depth).toBeGreaterThan(16_000)
    expect(result.references.map((ref) => ref.name).toSorted()).toEqual(["a", "b"])
  })

  test("just under the depth limit, with time to spare: a complete record with every capture", async () => {
    const text = `let x = ${"[".repeat(16_000)}a${"]".repeat(16_000)};\nfunction tail() { return b }\n`
    const file = await parsed("a.ts", text)
    expect(file.depth).toBeGreaterThan(16_000)
    expect(file.references.map((ref) => ref.name).toSorted()).toEqual(["a", "b"])
    expect(file.definitions.map(brief)).toEqual(["variable x 1-1", "function tail 2-2"])
  })

  test("a long run of decorators or attributes costs its length: done or refused within the default boxes", async () => {
    // 48,000 decorators or attributes, each with a comment after it (480 KB): the adjacency check once read every
    // comment for every decorator, and the run's last definition then took about 28 s.
    const cases = [
      { path: "a.ts", text: `class A {\n${"  @a /**/\n".repeat(48_000)}  m() {}\n}\n`, def: "method m 2-48002 in A" },
      { path: "a.rs", text: `${"#[a] /**/\n".repeat(48_000)}fn f() {}\n`, def: "function f 1-48001" },
    ]
    for (const flood of cases) {
      const started = performance.now()
      const result = await run({ path: flood.path, text: flood.text }, ReviewParse.PARSE_LIMITS)
      expect(performance.now() - started).toBeLessThan(3_000)
      if (!result.parsed) expect(result.because).toBe("timeout")
      if (result.parsed) expect(result.definitions.map(brief)).toContain(flood.def)
    }
  })

  test("G1-15: a capture the query cursor drops past 65,535 levels is caught by the capture count", async () => {
    const text = `let x = ${"[".repeat(70_000)}a${"]".repeat(70_000)};\nfunction tail() { return b }\n`
    const result = await refused({ path: "a.ts", text }, { ...GENEROUS, depth: 1_000_000 })
    expect(result.because).toBe("capture-count")
    expect(result.detail).toMatch(/^\d+ of \d+$/)
  })

  test("a wide, shallow file keeps every one of 70,000 references", async () => {
    const text = `const x = [${Array.from({ length: 70_000 }, () => "a").join(",")}]\n`
    const file = await parsed("a.ts", text)
    expect(file.depth).toBeLessThan(10)
    expect(file.references.filter((ref) => ref.name === "a")).toHaveLength(70_000)
    expect(file.references).toHaveLength(70_000)
  })

  test("trees are deleted after extraction: twenty large trees leave memory bounded", async () => {
    const text = `export const data = [${"0,".repeat(250_000)}0]\n`
    const rss = () => {
      Bun.gc(true)
      return process.memoryUsage().rss
    }
    await parsed("warm.ts", text)
    const before = rss()
    for (const index of Array.from({ length: 20 }, (_, i) => i)) await parsed(`f${index}.ts`, text)
    expect(rss() - before).toBeLessThan(150 * 1_048_576)
  }, 60_000)
})

describe("failures are records, never thrown review errors", () => {
  test("input that is not text", async () => {
    const exit = await Effect.runPromiseExit(
      ReviewParse.parse({ path: "a.ts", text: 42 as unknown as string }, GENEROUS),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit))
      expect(exit.value).toMatchObject({ parsed: false, because: "parser-error", detail: "TypeError" })
    const pathless = await Effect.runPromiseExit(
      ReviewParse.parse({ path: undefined as unknown as string, text: "x" }, GENEROUS),
    )
    expect(Exit.isSuccess(pathless)).toBe(true)
  })

  test("a throw during extraction, after a real parse, is a parser-error record and the parser goes on", async () => {
    const names = {
      has() {
        throw new Error(`boom ${TOKEN}`)
      },
    } as unknown as ReadonlySet<string>
    const exit = await Effect.runPromiseExit(ReviewParse.parse({ path: "a.go", text: GO, names }, GENEROUS))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({ parsed: false, because: "parser-error", detail: "Error", language: "go" })
      expect(JSON.stringify(exit.value)).not.toContain("ghp_")
    }
    expect((await parsed(FIXTURES.go.path, GO)).definitions.length).toBeGreaterThan(0)
  })

  test("a wasm trap poisons the shared runtime for the rest of the process", async () => {
    // A real trap: a one-function module whose body is `unreachable`, called from inside extraction.
    const output = await child(`
      const trap = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 5, 1, 3, 0, 0, 11,
      ]))).exports.f
      const names = { has() { trap() } }
      const before = TreeSitter.poisoned()
      const first = await Effect.runPromiseExit(ReviewParse.parse({ path: "a.go", text: "package a\\nfunc A() {}\\n", names }))
      const second = await Effect.runPromise(ReviewParse.parse({ path: "b.ts", text: "const b = 1\\n" }))
      console.log(JSON.stringify({ before, first: first._tag === "Success" ? first.value : first._tag, second, after: TreeSitter.poisoned() }))
    `)
    expect(output.first).toMatchObject({ parsed: false, because: "parser-error", detail: "runtime-disabled" })
    expect(output.second).toMatchObject({ parsed: false, because: "parser-error", detail: "runtime-disabled" })
    // The flag the shell tool reads before every command parse (tool/shell.ts `parse`).
    expect(output.before).toBe(false)
    expect(output.after).toBe(true)
  })

  test("parseMs times the parse alone, not the first file's grammar load", async () => {
    const output = await child(`
      const started = performance.now()
      const result = await Effect.runPromise(ReviewParse.parse({ path: "a.rs", text: "fn a() {}\\n" }))
      console.log(JSON.stringify({ wall: performance.now() - started, parseMs: result.parseMs, extractMs: result.extractMs }))
    `)
    // The grammar load (tens of milliseconds) is in the wall time; a one-line parse takes well under a millisecond.
    expect(output.parseMs).toBeLessThan(output.wall / 4)
    expect(output.parseMs + output.extractMs).toBeLessThan(output.wall)
  })
})

describe("isolation from the reviewed repository (I-8)", () => {
  test("grammar files planted in the working directory or NODE_PATH are never loaded", async () => {
    const output = await child(
      `
      const go = await Effect.runPromise(ReviewParse.parse({ path: process.cwd() + "/node_modules/tree-sitter-go/main.go", text: "package a\\nfunc A() {}\\n" }))
      const ts = await Effect.runPromise(ReviewParse.parse({ path: process.cwd() + "/tree-sitter-typescript.ts", text: "export const a = 1\\n" }))
      const grammars = await Promise.all(["go", "typescript"].map((language) => Effect.runPromise(ReviewParse.grammar(language))))
      console.log(JSON.stringify({ go: go.parsed, ts: ts.parsed, paths: grammars.map((grammar) => grammar.path) }))
    `,
      async (repo) => {
        const planted = [
          "node_modules/tree-sitter-go/tree-sitter-go.wasm",
          "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
          "node_modules/web-tree-sitter/tree-sitter.wasm",
          "tree-sitter-go.wasm",
          "tree-sitter-typescript.wasm",
        ]
        for (const file of planted) {
          await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
          await writeFile(path.join(repo, file), "not a grammar")
        }
        await writeFile(path.join(repo, "node_modules/tree-sitter-go/package.json"), `{"name":"tree-sitter-go"}`)
      },
    )
    expect(output.go).toBe(true)
    expect(output.ts).toBe(true)
    const engine = await realpath(path.join(ENGINE, "../.."))
    for (const loaded of output.paths) {
      expect(await realpath(loaded)).toStartWith(engine)
      expect(loaded).not.toContain(output.repo)
    }
  })
})

describe("VS-24c's comment and string contract", () => {
  test("parsed ranges drive classifyTrivial, CRLF included", async () => {
    const base = "export function f() {\r\n  // old note\r\n  const s = `a\r\n  b`\r\n  return s\r\n}\r\n"
    const comment = base.replace("old note", "new note")
    // trivial.ts reads only trailing whitespace as whitespace: inside the template's first line, and after `return s`.
    const inString = base.replace("`a\r", "`a  \r")
    const outside = base.replace("return s\r", "return s  \r")
    const decide = async (head: string) => {
      const sides = { LEFT: await parsed("src/f.ts", base), RIGHT: await parsed("src/f.ts", head) }
      return classifyTrivial(parseUnifiedDiff(diff("src/f.ts", base, head)), {
        sensitive: () => false,
        comments: (_path, side) => sides[side].comments,
        strings: (_path, side) => sides[side].strings,
      })
    }
    expect(await decide(comment)).toEqual({ trivial: true, kinds: ["comment"] })
    expect(await decide(inString)).toMatchObject({ trivial: false, because: "string-literal" })
    expect(await decide(outside)).toEqual({ trivial: true, kinds: ["whitespace"] })
  })
})

describe("BrainCode cross-check", () => {
  // The extractor decision keeps BrainCode for the import graph; where the two readers disagree on what a file
  // exports, the disagreement is listed here (and in the deviation log) so it cannot drift unseen.
  const DISAGREEMENTS: Record<string, { parser: string[]; brain: string[] }> = {
    typescript: {
      parser: ["Internal", "Open", "ambient", "area", "declared", "label", "onClick", "run", "shown", "value"],
      brain: [],
    },
    javascript: { parser: ["Cache", "VERSION", "hidden", "put", "read", "shown", "write"], brain: [] },
    python: { parser: ["__init__", "_forced", "label"], brain: ["API_KEY", "Holder", "connect", "unlisted"] },
    go: { parser: [], brain: [] },
    rust: { parser: ["call", "deep", "fmt"], brain: ["private_fn"] },
    java: {
      parser: [
        "Api",
        "LIMIT",
        "Mode",
        "Nested",
        "PackagePrivate",
        "Spawner",
        "block",
        "call",
        "count",
        "m",
        "shown",
        "spawn",
      ],
      brain: [],
    },
  }

  test("exported names agree but for the listed differences", async () => {
    const fixtures: [string, ParseLanguage, BrainCode.Language][] = [
      ["typescript", "typescript", "typescript"],
      ["javascript", "javascript", "typescript"],
      ["python", "python", "python"],
      ["go", "go", "go"],
      ["rust", "rust", "rust"],
      ["java", "java", "java"],
    ]
    const found = await Promise.all(
      fixtures.map(async ([label, language, brain]) => {
        const fixture = FIXTURES[language]
        const file = await parsed(fixture.path, fixture.text)
        const ours = new Set(file.definitions.filter((def) => def.exported).map((def) => def.name))
        const theirs = new Set(
          BrainCode.symbols(fixture.text, brain)
            .filter((symbol) => symbol.exported)
            .map((symbol) => symbol.name),
        )
        const differences = {
          parser: [...ours].filter((name) => !theirs.has(name)).toSorted(),
          brain: [...theirs].filter((name) => !ours.has(name)).toSorted(),
        }
        return [label, differences] as const
      }),
    )
    expect(Object.fromEntries(found)).toEqual(DISAGREEMENTS)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

// Runs a script in a fresh process (its own module state), from a scratch directory (the engine's test tmpdir) that
// `prepare` may fill, with NODE_PATH pointing into it. The script sees `Effect`, `ReviewParse` and `TreeSitter`; it
// prints one JSON line.
async function child(body: string, prepare?: (repo: string) => Promise<void>) {
  await using tmp = await tmpdir()
  const repo = tmp.path
  await prepare?.(repo)
  const script = path.join(repo, "child.ts")
  await writeFile(
    script,
    [
      `import { Effect } from ${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))}`,
      `import { ReviewParse } from ${JSON.stringify(path.join(ENGINE, "src/review/parse.ts"))}`,
      `import { TreeSitter } from ${JSON.stringify(path.join(ENGINE, "src/util/tree-sitter.ts"))}`,
      body,
    ].join("\n"),
  )
  const proc = Bun.spawn([process.execPath, script], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", HOME: repo, NODE_PATH: path.join(repo, "node_modules") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`)
  return { ...JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"), repo }
}

// A one-hunk unified diff between two texts of the same line count.
function diff(file: string, base: string, head: string) {
  const split = (text: string) => text.split("\n").slice(0, -1)
  const left = split(base)
  const right = split(head)
  const body = left.flatMap((line, index) => (line === right[index] ? [` ${line}`] : [`-${line}`, `+${right[index]}`]))
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${left.length} +1,${right.length} @@`,
    ...body,
    "",
  ].join("\n")
}

// VS-37a: each reference's statement, only when asked. A simple statement gives its lines; a compound one (an `if`, a
// loop) its first line through the reference's; a type in a signature, and a Rust tail expression, give none.
describe("statements", () => {
  const at = (file: ParsedFile, name: string) =>
    file.references
      .filter((ref) => ref.name === name)
      .map((ref) => `${ref.line}:${ref.statement ? `${ref.statement.start}-${ref.statement.end}` : "none"}`)

  test("are left out unless asked for, and asking changes nothing else", async () => {
    for (const [language, fixture] of Object.entries(FIXTURES)) {
      const plain = await parsed(fixture.path, fixture.text)
      expect(plain.references.some((ref) => "statement" in ref)).toBe(false)
      const asked = await parsed(fixture.path, fixture.text, { statements: true })
      expect(
        asked.references.some((ref) => ref.statement !== undefined),
        language,
      ).toBe(true)
      const { references, parseMs, walkMs, extractMs, ...rest } = asked
      const { references: before, parseMs: a, walkMs: b, extractMs: c, ...same } = plain
      expect([parseMs, walkMs, extractMs, a, b, c].every((ms) => ms >= 0)).toBe(true)
      expect(rest).toEqual(same)
      // The same references, each with its statement added.
      expect(references).toHaveLength(before.length)
      expect(references).toMatchObject(before)
    }
  })

  test("TypeScript and JavaScript", async () => {
    const file = await parsed(
      "run.ts",
      lines(
        "export function run(items: Item[]) {",
        "  const total = compute(",
        "    items,",
        "  )",
        "  if (check(total)) {",
        "    notify(total)",
        "  }",
        "  return finish(total)",
        "}",
        "class Box { field = make() }",
      ),
      { statements: true },
    )
    expect(at(file, "compute")).toEqual(["2:2-4"])
    expect(at(file, "check")).toEqual(["5:5-5"])
    expect(at(file, "notify")).toEqual(["6:6-6"])
    expect(at(file, "finish")).toEqual(["8:8-8"])
    expect(at(file, "Item")).toEqual(["1:none"])
    expect(at(file, "make")).toEqual(["10:10-10"])
    const loop = await parsed("loop.js", lines("do {", "  step()", "} while (more())"), { statements: true })
    expect(at(loop, "more")).toEqual(["3:1-3"])
    expect(at(loop, "step")).toEqual(["2:2-2"])
  })

  test("Python", async () => {
    const file = await parsed(
      "run.py",
      lines(
        "def run(x):",
        "    value = compute(",
        "        x,",
        "    )",
        "    if check(value):",
        "        notify(value)",
        "    for item in items():",
        "        pass",
        "    return finish(value)",
      ),
      { statements: true },
    )
    expect(at(file, "compute")).toEqual(["2:2-4"])
    expect(at(file, "check")).toEqual(["5:5-5"])
    expect(at(file, "notify")).toEqual(["6:6-6"])
    expect(at(file, "items")).toEqual(["7:7-7"])
    expect(at(file, "finish")).toEqual(["9:9-9"])
  })

  test("Go", async () => {
    const file = await parsed(
      "run.go",
      lines(
        "package main",
        "",
        "func run() {",
        "\tif err := check(); err != nil {",
        "\t\tnotify(err)",
        "\t}",
        "\tvalue := compute(",
        "\t\t1,",
        "\t)",
        "\tdefer finish(value)",
        "}",
      ),
      { statements: true },
    )
    expect(at(file, "check")).toEqual(["4:4-4"])
    expect(at(file, "notify")).toEqual(["5:5-5"])
    expect(at(file, "compute")).toEqual(["7:7-9"])
    expect(at(file, "finish")).toEqual(["10:10-10"])
  })

  test("Rust: a tail expression is in no statement", async () => {
    const file = await parsed(
      "run.rs",
      lines(
        "fn run() -> u8 {",
        "    let value = compute(",
        "        1,",
        "    );",
        "    notify(value);",
        "    finish(value)",
        "}",
      ),
      { statements: true },
    )
    expect(at(file, "compute")).toEqual(["2:2-4"])
    expect(at(file, "notify")).toEqual(["5:5-5"])
    expect(at(file, "finish")).toEqual(["6:none"])
  })

  test("Java", async () => {
    const file = await parsed(
      "Run.java",
      lines(
        "class Run {",
        "  private final Box box = make();",
        "  int run() {",
        "    int value = compute(",
        "      1);",
        "    if (check(value)) {",
        "      notify(value);",
        "    }",
        "    return finish(value);",
        "  }",
        "}",
      ),
      { statements: true },
    )
    expect(at(file, "make")).toEqual(["2:2-2"])
    expect(at(file, "compute")).toEqual(["4:4-5"])
    expect(at(file, "check")).toEqual(["6:6-6"])
    expect(at(file, "notify")).toEqual(["7:7-7"])
    expect(at(file, "finish")).toEqual(["9:9-9"])
  })
})
