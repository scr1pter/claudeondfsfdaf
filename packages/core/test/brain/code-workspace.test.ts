import { describe, expect, test } from "bun:test"
import { BrainCode } from "@vectordevai/core/brain/code"

// VS-25b: workspace-package and tsconfig path-alias resolution in BrainCode.resolve. Without a workspace every result is
// the one printed before the change (the golden table below); with one, only TypeScript, JavaScript and markup
// specifiers that neither the relative attempt nor a sibling resolved can change, and whatever the workspace leaves
// unresolved falls through to the suffix match unchanged.

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

const FILES: Record<string, string> = {
  "package.json": json({ name: "acme", private: true, workspaces: ["packages/*", "!packages/ignored"] }),
  "packages/core/package.json": json({
    name: "@acme/core",
    exports: { ".": "./src/index.ts", "./*": "./src/*.ts", "./internal/*": null },
    dependencies: { zod: "1.0.0" },
  }),
  "packages/core/src/index.ts": 'export * from "./review/types"\n',
  "packages/core/src/review/types.ts": 'export type Side = "LEFT" | "RIGHT"\n',
  "packages/core/src/review/eval.ts": "export const score = 1\n",
  "packages/core/src/internal/secret.ts": "export const hidden = 1\n",
  "packages/app/package.json": json({ name: "@acme/app", dependencies: { "@acme/core": "workspace:*" } }),
  "packages/app/tsconfig.json":
    '{\n  // aliases\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./src/*"], "~config": ["./src/config.ts"], "@/review/*": ["./missing/*", "./src/review/*"] },\n  },\n}\n',
  "packages/app/src/feature.ts":
    'import { score } from "@/review/eval"\nimport type { Side } from "@acme/core/review/types"\n',
  "packages/app/src/config.ts": "export const config = {}\n",
  "packages/app/src/review/eval.ts": "export const local = 1\n",
  "packages/app/src/review/types.ts": "export type Local = 1\n",
  "packages/app/src/view.vue": '<script setup lang="ts">\nimport { score } from "@/review/eval"\n</script>\n',
  "packages/app/src/main.go": "package main\n",
  "packages/app/src/tool.py": "import review.eval\n",
  "packages/legacy/package.json": json({ name: "@acme/legacy", main: "lib/main.js" }),
  "packages/legacy/lib/main.js": "module.exports = {}\n",
  "packages/legacy/lib/extra.js": "module.exports = {}\n",
  "packages/built/package.json": json({ name: "@acme/built", exports: { ".": { import: "./dist/index.js" } } }),
  "packages/built/src/index.ts": "export const built = 1\n",
  "packages/conditions/package.json": json({
    name: "@acme/conditions",
    exports: { ".": { types: "./types/index.d.ts", import: { source: "./src/main.ts", default: "./dist/main.js" } } },
  }),
  "packages/conditions/src/main.ts": "export const main = 1\n",
  "packages/dup-a/package.json": json({ name: "@acme/dup" }),
  "packages/dup-a/thing.ts": "export const a = 1\n",
  "packages/dup-b/package.json": json({ name: "@acme/dup" }),
  "packages/dup-b/thing.ts": "export const b = 1\n",
  "packages/ignored/package.json": json({ name: "@acme/ignored" }),
  "packages/ignored/index.ts": "export const ignored = 1\n",
  "fixtures/copy/package.json": json({ name: "@acme/core" }),
  "fixtures/copy/src/review/types.ts": "export type Copy = 1\n",
  "node_modules/react/package.json": json({ name: "react", main: "index.js" }),
  "node_modules/react/index.js": "module.exports = {}\n",
  "broken/package.json": "{ not json",
  // The existing code-index fixture's other languages.
  "pkg/__init__.py": "",
  "pkg/models.py": "class Invoice:\n    pass\n",
  "pkg/service.py": "from .models import Invoice\nfrom pkg.models import compute_total\n",
  "cmd/main.go": 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/store"\n)\n',
  "internal/store/store.go": "package store\n",
  "src/lib.rs": "mod parser;\n\nuse crate::parser::Ast;\n",
  "src/parser.rs": "pub struct Ast {}\n",
  "app/com/shop/Order.java": "package com.shop;\n",
  "app/com/shop/Service.java": "package com.shop;\n\nimport com.shop.Order;\n",
  "lib/util.h": "typedef struct Buffer {} Buffer;\n",
  "lib/util.c": '#include "util.h"\n',
  "lib/parser.rb": "class DocumentParser\nend\n",
  "lib/runner.rb": 'require_relative "parser"\n',
  "src/Domain/Invoice.php": "<?php\n",
  "src/Domain/Billing.php": "<?php\n\nuse App\\Domain\\Invoice;\n",
}

const FEATURE = "packages/app/src/feature.ts"

// [file, specifier]; the language is BrainCode.language(file).
const ROWS: (readonly [string, string])[] = [
  [FEATURE, "./config"],
  [FEATURE, "../src/review/eval"],
  [FEATURE, "./missing"],
  [FEATURE, "@/review/eval"],
  [FEATURE, "@/config"],
  [FEATURE, "~config"],
  [FEATURE, "src/config"],
  [FEATURE, "@acme/core"],
  [FEATURE, "@acme/core/review/types"],
  [FEATURE, "@acme/core/internal/secret"],
  [FEATURE, "@acme/legacy"],
  [FEATURE, "@acme/legacy/lib/extra"],
  [FEATURE, "@acme/built"],
  [FEATURE, "@acme/conditions"],
  [FEATURE, "@acme/dup/thing"],
  [FEATURE, "@acme/ignored"],
  [FEATURE, "react"],
  [FEATURE, "zod"],
  ["packages/app/src/view.vue", "@/review/eval"],
  ["packages/app/src/main.go", "@acme/core/review/types"],
  ["packages/app/src/tool.py", "review.eval"],
  ["fixtures/copy/src/review/types.ts", "@acme/core/review/types"],
  ["pkg/service.py", ".models"],
  ["pkg/service.py", "pkg.models"],
  ["cmd/main.go", "fmt"],
  ["cmd/main.go", "example.com/app/internal/store"],
  ["src/lib.rs", "parser"],
  ["src/lib.rs", "crate::parser::Ast"],
  ["app/com/shop/Service.java", "com.shop.Order"],
  ["lib/util.c", "util.h"],
  ["lib/runner.rb", "parser"],
  ["src/Domain/Billing.php", "App\\Domain\\Invoice"],
]

// Printed at 6e2f1d04, before workspace resolution, by BrainCode.resolve over ROWS: [file, specifier, files].
const GOLDEN: (readonly [string, string, string[]])[] = [
  ["packages/app/src/feature.ts", "./config", ["packages/app/src/config.ts"]],
  ["packages/app/src/feature.ts", "../src/review/eval", ["packages/app/src/review/eval.ts"]],
  ["packages/app/src/feature.ts", "./missing", []],
  [
    "packages/app/src/feature.ts",
    "@/review/eval",
    ["packages/core/src/review/eval.ts", "packages/app/src/review/eval.ts"],
  ],
  ["packages/app/src/feature.ts", "@/config", ["packages/app/src/config.ts"]],
  ["packages/app/src/feature.ts", "~config", []],
  ["packages/app/src/feature.ts", "src/config", ["packages/app/src/config.ts"]],
  ["packages/app/src/feature.ts", "@acme/core", ["packages/core/package.json"]],
  [
    "packages/app/src/feature.ts",
    "@acme/core/review/types",
    ["packages/core/src/review/types.ts", "packages/app/src/review/types.ts", "fixtures/copy/src/review/types.ts"],
  ],
  ["packages/app/src/feature.ts", "@acme/core/internal/secret", ["packages/core/src/internal/secret.ts"]],
  ["packages/app/src/feature.ts", "@acme/legacy", ["packages/legacy/package.json"]],
  ["packages/app/src/feature.ts", "@acme/legacy/lib/extra", ["packages/legacy/lib/extra.js"]],
  ["packages/app/src/feature.ts", "@acme/built", ["packages/built/package.json"]],
  ["packages/app/src/feature.ts", "@acme/conditions", ["packages/conditions/package.json"]],
  ["packages/app/src/feature.ts", "@acme/dup/thing", ["packages/dup-a/thing.ts", "packages/dup-b/thing.ts"]],
  ["packages/app/src/feature.ts", "@acme/ignored", ["packages/ignored/package.json", "packages/ignored/index.ts"]],
  ["packages/app/src/feature.ts", "react", ["node_modules/react/package.json", "node_modules/react/index.js"]],
  ["packages/app/src/feature.ts", "zod", []],
  [
    "packages/app/src/view.vue",
    "@/review/eval",
    ["packages/core/src/review/eval.ts", "packages/app/src/review/eval.ts"],
  ],
  [
    "packages/app/src/main.go",
    "@acme/core/review/types",
    ["packages/core/src/review/types.ts", "packages/app/src/review/types.ts", "fixtures/copy/src/review/types.ts"],
  ],
  ["packages/app/src/tool.py", "review.eval", ["packages/core/src/review/eval.ts", "packages/app/src/review/eval.ts"]],
  [
    "fixtures/copy/src/review/types.ts",
    "@acme/core/review/types",
    ["packages/core/src/review/types.ts", "packages/app/src/review/types.ts", "fixtures/copy/src/review/types.ts"],
  ],
  ["pkg/service.py", ".models", ["pkg/models.py"]],
  ["pkg/service.py", "pkg.models", ["pkg/models.py"]],
  ["cmd/main.go", "fmt", []],
  ["cmd/main.go", "example.com/app/internal/store", ["internal/store/store.go"]],
  ["src/lib.rs", "parser", ["src/parser.rs"]],
  ["src/lib.rs", "crate::parser::Ast", ["src/parser.rs", "lib/parser.rb"]],
  ["app/com/shop/Service.java", "com.shop.Order", ["app/com/shop/Order.java"]],
  ["lib/util.c", "util.h", ["lib/util.h"]],
  ["lib/runner.rb", "parser", ["lib/parser.rb"]],
  ["src/Domain/Billing.php", "App\\Domain\\Invoice", ["src/Domain/Invoice.php"]],
]

// Printed at 6e2f1d04, before workspace resolution: BrainCode.dependencies of every file of FILES with any.
const GOLDEN_DEPENDENCIES: (readonly [string, string[]])[] = [
  ["packages/core/src/index.ts", ["packages/core/src/review/types.ts"]],
  [
    "packages/app/src/feature.ts",
    [
      "packages/core/src/review/eval.ts",
      "packages/app/src/review/eval.ts",
      "packages/core/src/review/types.ts",
      "packages/app/src/review/types.ts",
      "fixtures/copy/src/review/types.ts",
    ],
  ],
  ["packages/app/src/view.vue", ["packages/core/src/review/eval.ts", "packages/app/src/review/eval.ts"]],
  ["packages/app/src/tool.py", ["packages/core/src/review/eval.ts", "packages/app/src/review/eval.ts"]],
  ["pkg/service.py", ["pkg/models.py"]],
  ["cmd/main.go", ["internal/store/store.go"]],
  ["src/lib.rs", ["src/parser.rs", "lib/parser.rb"]],
  ["app/com/shop/Service.java", ["app/com/shop/Order.java"]],
  ["lib/util.c", ["lib/util.h"]],
  ["lib/runner.rb", ["lib/parser.rb"]],
  ["src/Domain/Billing.php", ["src/Domain/Invoice.php"]],
]

const LOOKUP = BrainCode.lookup(Object.keys(FILES))
const WORKSPACE = BrainCode.workspace(Object.entries(FILES).map(([path, text]) => ({ path, text })))
const resolved = (workspace?: BrainCode.Workspace) =>
  ROWS.map(
    ([file, specifier]) =>
      [file, specifier, BrainCode.resolve(file, specifier, BrainCode.language(file)!, LOOKUP, workspace)] as const,
  )
const dependencies = (workspace?: BrainCode.Workspace) =>
  Object.keys(FILES).flatMap((file) => {
    const language = BrainCode.language(file)
    if (!language) return []
    const found = BrainCode.dependencies(file, BrainCode.imports(FILES[file], language), language, LOOKUP, workspace)
    return found.length ? [[file, found] as const] : []
  })

describe("BrainCode.resolve without a workspace", () => {
  test("gives every result it gave before workspace resolution, for every language", () => {
    expect(resolved()).toEqual(GOLDEN)
    expect(dependencies()).toEqual(GOLDEN_DEPENDENCIES)
  })

  test("INDEX_FILES is exported with the value it had", () => {
    expect(BrainCode.INDEX_FILES).toEqual([
      "index.ts",
      "index.tsx",
      "index.js",
      "index.jsx",
      "__init__.py",
      "mod.rs",
      "lib.rs",
      "index.php",
    ])
  })
})

describe("BrainCode.resolve with a workspace", () => {
  test("resolves aliases and workspace packages, and leaves every other row as it was", () => {
    const changed = new Map<string, string[]>([
      [`${FEATURE}\0@/review/eval`, ["packages/app/src/review/eval.ts"]],
      [`${FEATURE}\0~config`, ["packages/app/src/config.ts"]],
      [`${FEATURE}\0@acme/core`, ["packages/core/src/index.ts"]],
      [`${FEATURE}\0@acme/core/review/types`, ["packages/core/src/review/types.ts"]],
      [`${FEATURE}\0@acme/legacy`, ["packages/legacy/lib/main.js"]],
      [`${FEATURE}\0@acme/conditions`, ["packages/conditions/src/main.ts"]],
      ["packages/app/src/view.vue\0@/review/eval", ["packages/app/src/review/eval.ts"]],
      ["fixtures/copy/src/review/types.ts\0@acme/core/review/types", ["packages/core/src/review/types.ts"]],
    ])
    expect(resolved(WORKSPACE)).toEqual(
      GOLDEN.map(
        ([file, specifier, files]) => [file, specifier, changed.get(`${file}\0${specifier}`) ?? files] as const,
      ),
    )
    // Unchanged on purpose: a relative import; "@/config", which the suffix match already read right; a subpath the
    // package does not export ("./internal/*": null); a target outside the tree (dist); a name two members claim; a
    // folder the workspace globs leave out; npm packages; and every language that is not TypeScript, JavaScript or
    // markup (the Go and Python files under packages/app among them).
    expect(dependencies(WORKSPACE)).toEqual(
      GOLDEN_DEPENDENCIES.map(([file, found]) => {
        if (file === FEATURE)
          return [file, ["packages/app/src/review/eval.ts", "packages/core/src/review/types.ts"]] as const
        if (file === "packages/app/src/view.vue") return [file, ["packages/app/src/review/eval.ts"]] as const
        return [file, found] as const
      }),
    )
  })

  test("reads members from the root's workspaces globs, keeps names one member claims, and skips what it cannot read", () => {
    expect(WORKSPACE.packages.map((item) => [item.name, item.directory])).toEqual([
      ["@acme/app", "packages/app"],
      ["@acme/built", "packages/built"],
      ["@acme/conditions", "packages/conditions"],
      ["@acme/core", "packages/core"],
      ["@acme/legacy", "packages/legacy"],
      ["acme", ""],
    ])
    expect(WORKSPACE.ambiguous).toEqual(["@acme/dup"])
    const core = WORKSPACE.packages.find((item) => item.name === "@acme/core")!
    expect(core).toEqual({
      name: "@acme/core",
      directory: "packages/core",
      encapsulated: true,
      exports: [
        [".", ["./src/index.ts"]],
        ["./*", ["./src/*.ts"]],
        ["./internal/*", []],
      ],
      dependencies: ["zod"],
    })
    expect(WORKSPACE.packages.find((item) => item.name === "@acme/app")?.dependencies).toEqual(["@acme/core"])
    // Conditions in order (import, default, require, node, browser, types), then the others as written, nested too.
    expect(WORKSPACE.packages.find((item) => item.name === "@acme/conditions")?.exports).toEqual([
      [".", ["./dist/main.js", "./src/main.ts", "./types/index.d.ts"]],
    ])
    expect(WORKSPACE.packages.find((item) => item.name === "@acme/legacy")).toMatchObject({
      encapsulated: false,
      exports: [[".", ["./lib/main.js"]]],
    })
    // The tsconfig is JSONC: a comment and trailing commas.
    expect(WORKSPACE.aliases).toEqual([
      {
        directory: "packages/app",
        base: "packages/app",
        baseUrl: true,
        paths: [
          ["@/*", ["./src/*"]],
          ["~config", ["./src/config.ts"]],
          ["@/review/*", ["./missing/*", "./src/review/*"]],
        ],
      },
    ])
  })

  test("without a workspace declaration every manifest is a member, and pnpm-workspace.yaml declares one", () => {
    const manifests = (extra: Record<string, string>) =>
      Object.entries({
        "package.json": json({ name: "root" }),
        "a/package.json": json({ name: "a" }),
        "b/package.json": json({ name: "b" }),
        "c/d/package.json": json({ name: "d" }),
        ...extra,
      }).map(([path, text]) => ({ path, text }))
    const names = (workspace: BrainCode.Workspace) => workspace.packages.map((item) => item.name)
    expect(names(BrainCode.workspace(manifests({})))).toEqual(["a", "b", "d", "root"])
    expect(
      names(
        BrainCode.workspace(
          manifests({ "pnpm-workspace.yaml": "packages:\n  - 'a'\n  - \"c/*\" # nested\n  - '!b'\nother: 1\n" }),
        ),
      ),
    ).toEqual(["a", "d", "root"])
    expect(names(BrainCode.workspace(manifests({ "pnpm-workspace.yaml": "packages: [a, 'b']\n" })))).toEqual([
      "a",
      "b",
      "root",
    ])
    expect(
      names(
        BrainCode.workspace(manifests({ "package.json": json({ name: "root", workspaces: { packages: ["c/**"] } }) })),
      ),
    ).toEqual(["d", "root"])
    // A pnpm file with no packages list declares nothing.
    expect(names(BrainCode.workspace(manifests({ "pnpm-workspace.yaml": "catalog:\n  x: 1\n" })))).toEqual([
      "a",
      "b",
      "d",
      "root",
    ])
  })

  test("skips manifests in excluded folders, over the size limit, unparsable or without a name, in any input order", () => {
    const entries = [
      { path: "node_modules/x/package.json", text: json({ name: "x" }) },
      { path: "dist/package.json", text: json({ name: "built" }) },
      { path: "big/package.json", text: json({ name: "big", pad: "x".repeat(BrainCode.LIMIT.bytes) }) },
      { path: "broken/package.json", text: "{ nope" },
      { path: "list/package.json", text: "[1]" },
      { path: "anon/package.json", text: json({ version: "1.0.0" }) },
      { path: "z/package.json", text: json({ name: "z" }) },
      { path: "y/package.json", text: json({ name: "y" }) },
    ]
    const workspace = BrainCode.workspace(entries)
    expect(workspace.packages.map((item) => item.name)).toEqual(["y", "z"])
    expect(BrainCode.workspace(entries.toReversed())).toEqual(workspace)
  })

  test('path aliases follow TypeScript: the nearest tsconfig, exact before "*", the longest prefix, targets in order', () => {
    const files = [
      "web/src/a.ts",
      "web/src/lib/b.ts",
      "web/lib/b.ts",
      "web/inner/src/c.ts",
      "web/inner/x.ts",
      "web/types/only.ts",
      "shared/util.ts",
    ]
    const lookup = BrainCode.lookup(files)
    const workspace = BrainCode.workspace([
      {
        path: "web/tsconfig.json",
        text: json({
          compilerOptions: {
            paths: {
              "@/*": ["./src/*"],
              "@/lib/*": ["./lib/*"],
              "@shared": ["../shared/util.ts"],
              "@x/*/y": ["./src/*.ts"],
              "a*b*": ["x"],
            },
          },
        }),
      },
      { path: "web/inner/tsconfig.json", text: json({ compilerOptions: { baseUrl: "src" } }) },
      { path: "web/jsconfig.json", text: json({ compilerOptions: { paths: { "@/*": ["./types/*"] } } }) },
      { path: "web/types/jsconfig.json", text: json({ compilerOptions: { paths: { "@/*": ["./*"] } } }) },
    ])
    const resolve = (file: string, specifier: string) =>
      BrainCode.resolve(file, specifier, "typescript", lookup, workspace)
    // The longest prefix wins over the first pattern.
    expect(resolve("web/src/a.ts", "@/lib/b")).toEqual(["web/lib/b.ts"])
    expect(resolve("web/src/a.ts", "@/a")).toEqual(["web/src/a.ts"])
    // An exact pattern; a target outside the folder; a "*" in the middle; a pattern with two "*" is not TypeScript's.
    expect(resolve("web/src/a.ts", "@shared")).toEqual(["shared/util.ts"])
    expect(resolve("web/src/a.ts", "@x/lib/b/y")).toEqual(["web/src/lib/b.ts"])
    expect(workspace.aliases.find((entry) => entry.directory === "web")?.paths.map(([pattern]) => pattern)).toEqual([
      "@/*",
      "@/lib/*",
      "@shared",
      "@x/*/y",
    ])
    // The nearest tsconfig's aliases apply, and its baseUrl reads bare specifiers under the base.
    expect(resolve("web/inner/x.ts", "c")).toEqual(["web/inner/src/c.ts"])
    // A folder's jsconfig.json is read only when it has no tsconfig.json.
    expect(workspace.aliases.map((entry) => entry.directory)).toEqual(["web", "web/inner", "web/types"])
    expect(resolve("web/types/only.ts", "@/only")).toEqual(["web/types/only.ts"])
  })

  test('exports follow Node: an exact key, else the "*" key with the longest prefix; a fallback list in order', () => {
    const lookup = BrainCode.lookup([
      "p/src/a.ts",
      "p/src/deep/b.ts",
      "p/lib/c.js",
      "p/index.ts",
      "q/main.ts",
      "app.ts",
    ])
    const workspace = BrainCode.workspace([
      {
        path: "p/package.json",
        text: json({
          name: "p",
          exports: {
            "./*": "./src/*.ts",
            "./deep/*": ["./missing/*.ts", "./src/deep/*.ts"],
            "./c": "./lib/c.js",
            "./x": "../out.js",
          },
        }),
      },
      { path: "q/package.json", text: json({ name: "q", exports: "./main.ts" }) },
    ])
    const resolve = (specifier: string) => BrainCode.resolve("app.ts", specifier, "typescript", lookup, workspace)
    expect(resolve("p/a")).toEqual(["p/src/a.ts"])
    expect(resolve("p/deep/b")).toEqual(["p/src/deep/b.ts"])
    expect(resolve("p/c")).toEqual(["p/lib/c.js"])
    expect(resolve("q")).toEqual(["q/main.ts"])
    // A target outside the package and "." (not exported) fall through to the suffix match.
    expect(resolve("p/x")).toEqual(BrainCode.resolve("app.ts", "p/x", "typescript", lookup))
    expect(resolve("p")).toEqual(BrainCode.resolve("app.ts", "p", "typescript", lookup))
  })

  // The manifests are the reviewed head's: on a fork pull request their author writes them.
  describe("bounds on what a manifest can make it do", () => {
    const root = (globs: string[], extra: { path: string; text: string }[] = []) => [
      { path: "package.json", text: json({ name: "root", workspaces: globs }) },
      ...extra,
    ]

    test("a glob over minimatch's 64 KiB limit is dropped rather than thrown", () => {
      const workspace = BrainCode.workspace(
        root(["x".repeat(70_000), "pkgs/*"], [{ path: "pkgs/a/package.json", text: json({ name: "a" }) }]),
      )
      expect(workspace.packages.map((item) => item.name)).toEqual(["a", "root"])
      expect(workspace.truncated).toBe(true)
    })

    test("globs that backtrack are dropped, and extglobs are read as text", () => {
      const name = "a".repeat(250)
      const started = performance.now()
      const workspace = BrainCode.workspace(
        root(
          [`*a*a*a*a*c`, `+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)+(a|aa)b`, "ok/*"],
          [
            { path: `${name}/package.json`, text: json({ name: "long" }) },
            { path: "ok/x/package.json", text: json({ name: "x" }) },
          ],
        ),
      )
      // `*a*a*c` alone took 28 s against a 1,000-character folder name, and an extglob of 20 groups 2 s against 40.
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(workspace.packages.map((item) => item.name)).toEqual(["root", "x"])
      expect(workspace.truncated).toBe(true)
    })

    test("thousands of globs and manifests finish within a fixed bound, keeping the first in path order", () => {
      const count = 3_000
      const globs = Array.from({ length: count }, (_, at) => `packages/g${String(at).padStart(4, "0")}/*`)
      const manifests = Array.from({ length: count }, (_, at) => ({
        path: `packages/g${String(at).padStart(4, "0")}/p/package.json`,
        text: json({ name: `p${at}` }),
      }))
      const started = performance.now()
      const workspace = BrainCode.workspace(root(globs, manifests))
      // Every glob against every manifest took 33.6 s at this size.
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(workspace.truncated).toBe(true)
      expect(workspace.packages).toHaveLength(BrainCode.WORKSPACE_LIMIT.globs + 1)
      expect(workspace.packages.map((item) => item.directory)).toContain("packages/g0000/p")
    })

    test("past the deadline nothing more is read, and the result says so", () => {
      const workspace = BrainCode.workspace(
        root(["pkgs/*"], [{ path: "pkgs/a/package.json", text: json({ name: "a" }) }]),
        { deadline: performance.now() - 1 },
      )
      expect(workspace).toMatchObject({ packages: [], aliases: [], truncated: true })
      expect(BrainCode.workspace(root(["pkgs/*"])).truncated).toBe(false)
    })

    test("pnpm-workspace.yaml is read in linear time, however long its lines", () => {
      const started = performance.now()
      const workspace = BrainCode.workspace([
        { path: "package.json", text: json({ name: "root" }) },
        { path: "pnpm-workspace.yaml", text: `packages:\n  - a${" ".repeat(300_000)}b\n  - c # x\n` },
        { path: "c/package.json", text: json({ name: "c" }) },
      ])
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(workspace.packages.map((item) => item.name)).toEqual(["c", "root"])
    })
  })

  test("importLines: the lines of the import statements BrainCode.imports reads", () => {
    const lines = (text: string, language: BrainCode.Language) =>
      [...BrainCode.importLines(text, language)].toSorted((a, b) => a - b)
    // An export with no quote before a later `export * from` is not part of that statement.
    expect(
      lines(
        'export function a() {\n  return load()\n}\nexport * from "./util"\nimport {\n  x,\n} from "./xy"\nconst m = await import(\n  "./m"\n)\nm.load()\n',
        "typescript",
      ),
    ).toEqual([4, 5, 6, 7, 8, 9, 10])
    expect(lines("from pkg import (\n    one,\n    two,\n)\nimport os\nvalue = one()\n", "python")).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(lines('package b\n\nimport (\n\t"fmt"\n)\n\nfunc f() { fmt.Println() }\n', "go")).toEqual([3, 4, 5])
    expect(lines('#include "compute.h"\nint main() { return compute(1); }\n', "c")).toEqual([1])
    expect(lines("<?php\nuse App\\Store\\Order;\n$order = new Order();\n", "php")).toEqual([2])
  })
})
