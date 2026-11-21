// Bundle-time policy for build.ts, shared with its policy test. Bun only, and never part of an emitted program.
import type { BunPlugin } from "bun"

// jsonc-parser's UMD main, which a Node target selects, passes require into its factory, so require("./impl/...") stays a
// runtime call that cannot resolve beside the installed bundle. Resolve the same installed package's ESM entry instead,
// keeping its actual parser implementation.
export const jsoncESM: BunPlugin = {
  name: "installed-jsonc-esm",
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) => ({
      path: Bun.resolveSync("jsonc-parser/lib/esm/main.js", args.resolveDir || import.meta.dir),
    }))
  },
}

// Bun.Transpiler.scan reports import statements and dynamic imports only, not a require through a renamed binding such
// as that factory's argument. This finds such a call whose whole argument is a relative string literal; a computed
// specifier such as "./" + name is not matched.
export function relativeRequires(code: string) {
  return [...code.matchAll(/\b_*require\d*\(\s*(["'`])(\.{1,2}\/[^"'`\\\n$]*)\1\s*\)/g)].map((match) => match[2])
}
