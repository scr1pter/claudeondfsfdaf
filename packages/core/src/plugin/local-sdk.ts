export * as LocalPluginSdk from "./local-sdk"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Global } from "../global"
import { ProcessIsolation } from "../process-isolation"

const registered = new Set<string>()
type Import = { s: number; e: number; d: number; n?: string; call?: number }
type Module = { source: string; imports: Import[]; targets: Map<number, string> }

// Resolve compatibility imports in an isolated module graph, never in the user's package tree.
// Existing packages and their export maps remain authoritative for every import that resolves.
export async function prepare(entry: string) {
  ProcessIsolation.assertExternalCodeAllowed()
  // The rewrite needs Bun's loader: its resolver, Bun.plugin virtual modules and import.meta.require. The desktop
  // engine runs on Node.js, so it imports the plugin in place, and an SDK import the plugin cannot resolve fails with
  // Node's module-not-found error instead of reaching the bundled SDK.
  if (typeof Bun === "undefined") return entry
  const { parse } = await import("@babel/parser")
  const first = await fs.realpath(entry.startsWith("file:") ? fileURLToPath(entry) : entry)
  const modules = new Map<string, Module>()
  const pending = [first]
  const missing = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (modules.has(file)) continue
    const source = await fs.readFile(file, "utf8")
    const imports = moduleImports(source, file, parse)
    const targets = new Map<number, string>()
    modules.set(file, { source, imports, targets })
    for (const item of imports) {
      if (!item.n) continue
      const resolved = resolve(item.n, file)
      if (!resolved && /^@[^/]+\/plugin(?:\/tui)?$/.test(item.n)) {
        missing.add(file)
        targets.set(item.s, item.n.endsWith("/tui") ? "vector:local-plugin-sdk/tui" : "vector:local-plugin-sdk")
        continue
      }
      if (!resolved) continue
      targets.set(item.s, resolved)
      if (!item.n.startsWith(".") && !path.isAbsolute(item.n) && !item.n.startsWith("file:")) continue
      if (!resolved.startsWith("file:")) continue
      const local = fileURLToPath(resolved)
      if (!/\.[cm]?[jt]sx?$/.test(local) || local.split(path.sep).includes("node_modules")) continue
      pending.push(local)
    }
  }
  if (!missing.size && ![...modules.values()].some((module) => module.imports.some((item) => item.d >= 0 && !item.n)))
    return entry
  await installRuntime()
  const digest = createHash("sha256")
  for (const [file, module] of modules)
    digest
      .update(file)
      .update(module.source)
      .update(JSON.stringify([...module.targets]))
  const cache = path.join(Global.Path.cache, "plugin-compat", digest.digest("hex"))
  const files = new Map(
    [...modules.keys()].map((file, index) => [file, path.join(cache, `${index}${path.extname(file)}`)]),
  )
  await fs.mkdir(cache, { recursive: true })
  for (const [file, module] of modules) {
    const metadata = `__vector_plugin_meta_${createHash("sha256").update(file).digest("hex").slice(0, 16)}`
    const runtime = `${metadata}_runtime`
    const origin = JSON.stringify(pathToFileURL(file).href)
    const edits = module.imports
      .flatMap((item) => {
        if (item.d === -2) return [{ start: item.s, end: item.e, value: metadata }]
        if (!item.n) {
          if (item.d < 0 || item.call === undefined) return []
          return [{ start: item.call, end: item.call + 6, value: `${runtime}.load.bind(undefined, ${origin})` }]
        }
        const target = module.targets.get(item.s)
        if (!target) return []
        const cached = target.startsWith("file:") ? files.get(fileURLToPath(target)) : undefined
        const value = cached ? pathToFileURL(cached).href : target
        return [{ start: item.s, end: item.e, value: JSON.stringify(value) }]
      })
      .sort((a, b) => b.start - a.start || b.end - a.end)
    const rewritten = edits.reduce(
      (source, edit) => source.slice(0, edit.start) + edit.value + source.slice(edit.end),
      module.source,
    )
    const filename = JSON.stringify(file)
    const dirname = JSON.stringify(path.dirname(file))
    const prefix = `import ${runtime} from "vector:local-plugin-compat";
const ${metadata} = { ...import.meta, url: ${origin}, filename: ${filename}, path: ${filename}, dirname: ${dirname}, dir: ${dirname}, resolve: (specifier, parent = ${origin}) => ${runtime}.resolve(specifier, parent), require: (specifier) => import.meta.require(${runtime}.resolve(specifier, ${origin})) };\n`
    const output = files.get(file)!
    const temporary = `${output}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, prefix + rewritten.replace(/^#![^\n]*\n/, ""))
    await fs.rename(temporary, output)
  }
  return pathToFileURL(files.get(first)!).href
}

function resolve(specifier: string, parent: string) {
  try {
    return resolveImport(specifier, parent)
  } catch {
    return undefined
  }
}

function resolveImport(specifier: string, parent: string | URL) {
  ProcessIsolation.assertExternalCodeAllowed()
  // Bun's package resolver needs a native parent path for Windows drives and percent-escaped URLs.
  const source = typeof parent === "string" ? parent : parent.href
  const file = source.startsWith("file:") ? fileURLToPath(source) : source
  // import.meta.resolve can return a nonexistent .js path for a real .ts module. The graph scanner
  // must use the loader's filesystem resolution before reading local source, including computed imports.
  if (specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.startsWith("file:"))
    return pathToFileURL(
      Bun.resolveSync(specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier, path.dirname(file)),
    ).href
  return import.meta.resolve(specifier, file)
}

async function installRuntime() {
  if (registered.has("sdk")) return
  Bun.plugin({
    name: "vector-local-plugin-sdk",
    setup(build) {
      build.module("vector:local-plugin-compat", () => ({
        exports: { default: { load, resolve: resolveImport } },
        loader: "object",
      }))
      build.module("vector:local-plugin-sdk", async () => ({
        exports: await import("@vectordevai/plugin"),
        loader: "object",
      }))
      build.module("vector:local-plugin-sdk/tui", async () => ({
        exports: await import("@vectordevai/plugin/tui"),
        loader: "object",
      }))
    },
  })
  registered.add("sdk")
}

function moduleImports(source: string, file: string, parse: typeof import("@babel/parser").parse) {
  const imports: Import[] = []
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    const value = node as Record<string, unknown>
    const input = value.source as Record<string, unknown> | undefined
    if (
      typeof value.type === "string" &&
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(
        value.type,
      ) &&
      input &&
      typeof input.start === "number" &&
      typeof input.end === "number"
    ) {
      imports.push({
        s: input.start,
        e: input.end,
        d: value.type === "ImportExpression" ? 0 : -1,
        n: typeof input.value === "string" ? input.value : undefined,
        call: value.type === "ImportExpression" && typeof value.start === "number" ? value.start : undefined,
      })
    }
    if (
      value.type === "MetaProperty" &&
      (value.meta as { name?: string })?.name === "import" &&
      typeof value.start === "number" &&
      typeof value.end === "number"
    ) {
      imports.push({ s: value.start, e: value.end, d: -2 })
      return
    }
    Object.values(value).forEach(visit)
  }
  visit(
    parse(source, {
      sourceType: "unambiguous",
      plugins: [
        "typescript",
        ...(file.endsWith("x") ? ["jsx" as const] : []),
        "deprecatedImportAssert",
        "decorators-legacy",
      ],
      createImportExpressions: true,
    }),
  )
  return imports
}

async function load(parent: string, specifier: string, options?: ImportCallOptions) {
  ProcessIsolation.assertExternalCodeAllowed()
  const target = (() => {
    try {
      return resolveImport(`${specifier}`, parent)
    } catch (error) {
      if (/^@[^/]+\/plugin(?:\/tui)?$/.test(specifier))
        return specifier.endsWith("/tui") ? "vector:local-plugin-sdk/tui" : "vector:local-plugin-sdk"
      throw error
    }
  })()
  const local =
    target.startsWith("file:") &&
    /\.[cm]?[jt]sx?$/.test(fileURLToPath(target)) &&
    !fileURLToPath(target).split(path.sep).includes("node_modules")
  const entry = local ? await prepare(target) : target
  ProcessIsolation.assertExternalCodeAllowed()
  const mod = await import(entry, options)
  ProcessIsolation.assertExternalCodeAllowed()
  return mod
}
