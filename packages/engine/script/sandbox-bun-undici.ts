import { realpathSync } from "node:fs"
import type { BunPlugin } from "bun"

// Bun 1.3.14 misbundles this installed package's export-star from its built-in undici module.
// Preserve the original wrapper as an immutable ESM asset so Bun itself evaluates its unchanged imports/exports.
export async function sandboxBunUndici(engine: string) {
  const source = realpathSync(Bun.resolveSync("@effect/platform-node/Undici", engine))
  const asset = "assets/platform-node-undici.mjs"
  const plugin: BunPlugin = {
    name: "installed-bun-undici-esm",
    setup(build) {
      build.onResolve({ filter: /^(?:@effect\/platform-node\/Undici|\.\/Undici\.js)$/ }, (args) => {
        if (realpathSync(Bun.resolveSync(args.path, args.resolveDir || engine)) !== source) return
        return { path: `./${asset}`, external: true }
      })
    },
  }
  return { source, asset, plugin, contents: await Bun.file(source).arrayBuffer() }
}
