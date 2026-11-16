import { realpathSync } from "node:fs"
import type { BunPlugin } from "bun"

// Bun 1.3.14 misbundles this installed package's export-star from its built-in undici module.
// Preserve the original wrapper as an immutable ESM asset so Bun itself evaluates its unchanged imports/exports.
export async function sandboxBunUndici(engine: string) {
  const source = realpathSync(Bun.resolveSync("@effect/platform-node/Undici", engine))
  const asset = "assets/platform-node-undici.mjs"
  // Bun 1.3.14 also leaves an inlined `export * from` an external module unbound, so re-export the wrapper's names
  // explicitly. This Bun resolves `undici` to its built-in module wherever the wrapper lives, as the probe's Bun does.
  const names = Object.keys(await import(source))
  const plugin: BunPlugin = {
    name: "installed-bun-undici-esm",
    setup(build) {
      // Bun 1.3.14 emits the original specifier for an external module and ignores a returned path,
      // so the wrapper is replaced by a module whose own external specifier is already the asset path.
      build.onResolve({ filter: /^(?:@effect\/platform-node\/Undici|\.\/Undici\.js)$/ }, (args) => {
        if (realpathSync(Bun.resolveSync(args.path, args.resolveDir || engine)) !== source) return
        return { path: source, namespace: "vector-undici" }
      })
      build.onLoad({ filter: /.*/, namespace: "vector-undici" }, () => ({
        contents: `export { ${names.join(", ")} } from "./${asset}"\n`,
        loader: "js",
      }))
      build.onResolve({ filter: /^\.\/assets\/platform-node-undici\.mjs$/ }, (args) => ({
        path: args.path,
        external: true,
      }))
    },
  }
  return { source, asset, plugin, contents: await Bun.file(source).arrayBuffer() }
}
