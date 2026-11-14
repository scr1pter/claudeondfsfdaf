import { fileURLToPath } from "url"
import { lazy } from "@/util/lazy"

// A path for a `.wasm` asset that a `with { type: "wasm" }` import resolved. Bun hands back an absolute path or a
// file URL; the Node bundle (script/build-node.ts, one file with no splitting) hands back a path relative to the
// bundle, which `import.meta.url` resolves because this module is inlined into that same file.
export function resolveWasm(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

// The web-tree-sitter runtime, initialised once per process. `Parser.init` replaces the library's one global wasm
// binding (web-tree-sitter 0.25.10, tree-sitter.js:3776-3781), so a second init would strand every parser and
// language loaded before it: the shell tool's command parsers and the review parser (review/parse.ts) share this one.
export const runtime = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  return Parser
})

// Set once a WebAssembly trap or abort escapes a parse (review/parse.ts sets it): the runtime's memory may then be
// corrupt, and a parser on it may misread its input without failing. Nothing parses with a poisoned runtime again in
// this process: the review parser refuses every later file, and the shell tool fails every later command's permission
// scan closed, as it does a command its grammar cannot parse.
const state = { poisoned: false }

export function poison() {
  state.poisoned = true
}

export function poisoned() {
  return state.poisoned
}

export * as TreeSitter from "./tree-sitter"
