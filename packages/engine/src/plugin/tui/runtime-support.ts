import { plugin } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"
import {
  createRuntimePlugin,
  isCoreRuntimeModuleSpecifier,
  runtimeModuleIdForSpecifier,
} from "@opentui/core/runtime-plugin"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// The same key @opentui/solid/runtime-plugin-support/configure checks, so neither registers the
// runtime plugin a second time in one process.
const installedKey = Symbol.for("opentui.solid.runtime-plugin-support")

const modules = {
  "@opentui/solid": () => import("@opentui/solid"),
  "solid-js": () => import("solid-js"),
  "solid-js/store": () => import("solid-js/store"),
  ...keymapRuntimeModules,
}

// The packages/ directory of a source checkout. A compiled binary has no such path, so nothing is
// excluded there.
const sourceRoot = import.meta.path.endsWith(
  path.join("packages", "engine", "src", "plugin", "tui", "runtime-support.ts"),
)
  ? path.resolve(import.meta.dir, "../../../..")
  : undefined

/**
 * Registers OpenTUI's runtime module plugin so external TUI plugins share Vector's Solid, core and
 * keymap instances, the way `ensureRuntimePluginSupport` from `@opentui/solid` does, with one change.
 *
 * The upstream plugin is process-global: its catch-all resolver installs a loader for every file
 * resolved afterwards, and that loader rewrites `from "..."` specifiers in the file's raw text, even
 * inside strings and regex literals. A Vector source file that mentions a runtime specifier becomes
 * a "resolve parent", and every later file then has bare specifiers such as `from "ai"` replaced by
 * `file:///...` URLs, which ends a regex literal at the first `/`. That broke hub.test.ts on Linux
 * engine shard 2/4. Vector's own sources resolve these packages normally and the exact-specifier
 * resolvers still map runtime specifiers to the shared modules, so the text rewrite is skipped for
 * them and kept for plugin files outside the source tree.
 */
export function ensureTuiRuntimePluginSupport() {
  const state = globalThis as typeof globalThis & { [installedKey]?: unknown }
  if (state[installedKey]) return false

  ensureSolidTransformPlugin({
    moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
    resolvePath: (specifier) =>
      isCoreRuntimeModuleSpecifier(specifier) || Object.hasOwn(modules, specifier)
        ? runtimeModuleIdForSpecifier(specifier)
        : null,
  })

  const runtime = createRuntimePlugin({ core: () => import("@opentui/core"), additional: modules })
  plugin({
    name: runtime.name,
    setup: (build) => {
      // Only the catch-all resolver installs text-rewriting loaders; the exact-specifier resolvers
      // that map runtime specifiers to the shared modules stay as they are. Resolving a specifier
      // inside a resolver runs the resolvers again, so a nested call is left to Bun's own
      // resolution: without that, this check and the upstream resolver each recurse to the stack
      // limit for every import, and an import graph the size of the engine never finishes loading.
      let resolving = false
      const onResolve: typeof build.onResolve = (constraints, callback) =>
        build.onResolve(constraints, (args) => {
          if (constraints.filter.source !== ".*") return callback(args)
          if (resolving) return undefined
          resolving = true
          try {
            return isVectorSource(args.path, args.importer) ? undefined : callback(args)
          } finally {
            resolving = false
          }
        })
      return runtime.setup(
        new Proxy(build, {
          get(target, key) {
            if (key === "onResolve") return onResolve
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }),
      )
    },
  })

  state[installedKey] = {
    specifiers: new Set(Object.keys(modules)),
    rewriteKey: "true:false",
  }
  return true
}

function isVectorSource(specifier: string, importer: string) {
  if (!sourceRoot) return false
  const file = resolveFile(specifier, importer)
  if (!file) return false
  const relative = path.relative(sourceRoot, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
  return !relative.split(/[\\/]/).includes("node_modules")
}

// Resolves the way the upstream catch-all resolver does before it installs a loader. Other schemes
// (node:, bun:, the runtime module ids) are never source files.
function resolveFile(specifier: string, importer: string) {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier)
  if (path.isAbsolute(specifier)) return specifier
  if (/^[a-z][a-z0-9+.-]+:/i.test(specifier)) return undefined
  try {
    const resolved = import.meta.resolve(specifier, importer)
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : undefined
  } catch {
    return undefined
  }
}
