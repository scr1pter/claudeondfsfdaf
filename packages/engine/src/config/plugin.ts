import { Glob } from "@vectordevai/core/util/glob"
import { ConfigPluginV1 } from "@vectordevai/core/v1/config/plugin"
import { pathToFileURL } from "url"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/plugin/shared"
import path from "path"

export type Scope = "global" | "local"

// Origin keeps the original config provenance attached to a spec.
// After multiple config files are merged, callers still need to know which file declared the plugin
// and whether it should behave like a global or project-local plugin.
export type Origin = {
  spec: ConfigPluginV1.Spec
  source: string
  scope: Scope
}

/** The plugins a config folder loads on its own: each script directly in its plugin folder. */
export const ENTRIES = "{plugin,plugins}/*.{ts,js}"
/** What those plugins may import from folders beside them, which the prompt guard's hold fingerprints too. */
export const HELPERS = "{plugin,plugins}/!(node_modules)/**/*.{ts,js,mjs,cjs,mts,cts,json}"

/**
 * The plugins under a config folder. With `allowed` (PromptTrust.allowed), a held plugin is left out, and so is every
 * plugin of a folder whose helper modules are held, since any of them may import one.
 */
export async function load(dir: string, allowed?: (file: string) => boolean) {
  const options = { cwd: dir, absolute: true, dot: true, symlink: true }
  const entries = await Glob.scan(ENTRIES, options)
  const folder = (file: string) => path.relative(dir, file).split(path.sep)[0]
  const held = allowed
    ? new Set((await Glob.scan(HELPERS, options)).filter((file) => !allowed(file)).map(folder))
    : new Set<string>()
  return entries
    .filter((item) => (!allowed || allowed(item)) && !held.has(folder(item)))
    .map((item): ConfigPluginV1.Spec => pathToFileURL(item).href)
}

export function pluginSpecifier(plugin: ConfigPluginV1.Spec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

export function pluginOptions(plugin: ConfigPluginV1.Spec): ConfigPluginV1.Options | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

// Path-like specs are resolved relative to the config file that declared them so merges later on do not
// accidentally reinterpret `./plugin.ts` relative to some other directory.
export async function resolvePluginSpec(
  plugin: ConfigPluginV1.Spec,
  configFilepath: string,
): Promise<ConfigPluginV1.Spec> {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  const resolved = await resolvePathPluginTarget(file).catch(() => file)

  if (Array.isArray(plugin)) return [resolved, plugin[1]]
  return resolved
}

// Dedupe on the load identity (package name for npm specs, exact file URL for local specs), but keep the
// full Origin so downstream code still knows which config file won and where follow-up writes should go.
export function deduplicatePluginOrigins(plugins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const plugin of plugins.toReversed()) {
    const spec = pluginSpecifier(plugin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(plugin)
  }

  return list.toReversed()
}

export * as ConfigPlugin from "./plugin"
