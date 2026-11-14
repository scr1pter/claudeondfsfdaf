// The app runs in a browser (the web app and the desktop's renderer), so nothing it bundles may import a Node or Bun
// module: Vite swaps each for an empty stub, so a named import from one fails the production build ("AsyncLocalStorage"
// is not exported by "__vite-browser-external", from core's egress layer in 1.99.111) and any other use fails when it
// runs. The dev server shows neither. This walks the import graph Vite bundles, dynamic imports and Vector's own workers
// included, through @vectordevai/core and every other package, and prints each such import with the file making it.
//
//   bun packages/app/script/browser-imports.ts [entry files]
//
// With no entry it walks the pages' module scripts. It prints { modules, runtime } as JSON and exits 1 when runtime
// lists anything, 2 when the walk cannot resolve an import. src/browser-bundle.test.ts runs it in a process of its own:
// inside a `bun test` run of several files, Bun.build fails to resolve files the test runner's own scan listed.

import { builtinModules } from "node:module"
import path from "node:path"
import { browserInputPath } from "../src/browser-bundle-path"

const ROOT = path.resolve(import.meta.dir, "../../..")
const RUNTIME = new Set([...builtinModules, "bun"].flatMap((name) => [name, `node:${name}`]))
// What Vite turns into a URL or a stylesheet rather than code it bundles.
const ASSET = /\.(css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wasm|aac|mp3|wav|onnx)$/
// Bun 1.3.14's async plugin resolver crashes on Windows workspace symlinks before it normalizes their paths.
// Leave ordinary imports to its browser resolver; intercept only imports this guard actually handles.
const HANDLED = new RegExp(
  `^(?:${[...RUNTIME].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$|^bun:|\\?|${ASSET.source}|/jsx(?:-dev)?-runtime$`,
)
// A worker started from a file next to the code, which Vite also bundles as an entry of its own.
const WORKER = /new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url/g
// The pages the web app, the desktop renderer and the phone app (WP A38) load. The phone's service worker is built on
// its own (src/phone/build.ts); src/phone/phone.test.ts walks it by name.
const PAGES = [
  "packages/app/index.html",
  "packages/desktop/src/renderer/index.html",
  "packages/app/src/phone/index.html",
]

const entries =
  process.argv.length > 2
    ? process.argv.slice(2).map((entry) => path.resolve(entry))
    : (await Promise.all(PAGES.map(pageEntries))).flat()
const graph = await walk(entries)
console.log(JSON.stringify(graph, null, 2))
if (graph.runtime.length > 0) process.exitCode = 1

async function pageEntries(page: string) {
  const html = await Bun.file(path.join(ROOT, page)).text()
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.tsx?)"[^>]*>/g)].map((match) => match[1])
  if (sources.length === 0) fail(`${page} has no module script`)
  // Vite reads "/src/entry.tsx" from the page's own folder.
  return sources.map((source) => path.join(path.dirname(path.join(ROOT, page)), source))
}

/** Every module the entries bundle, and each Node or Bun import among them, repeated for the workers they start. */
async function walk(start: string[]) {
  const seen = new Set<string>()
  const runtime = new Set<string>()
  const modules = new Set<string>()
  const pending = [...start]
  while (pending.length > 0) {
    const batch = [...new Set(pending.splice(0))].filter((entry) => !seen.has(entry))
    batch.forEach((entry) => seen.add(entry))
    if (batch.length === 0) break
    const workers = new Set<string>()
    const result = await Bun.build({
      entrypoints: batch,
      target: "browser",
      conditions: ["browser"],
      metafile: true,
      throw: false,
      plugins: [
        {
          name: "node-imports",
          setup(build) {
            build.onResolve({ filter: HANDLED }, (args) => {
              const [specifier, query] = args.path.split("?")
              if (RUNTIME.has(specifier) || specifier.startsWith("bun:")) {
                runtime.add(`${relative(args.importer)} imports ${specifier}`)
                return { path: args.path, external: true }
              }
              // A worker of Vector's own, which Vite bundles as an entry of its own. A package's worker (Monaco's,
              // Pierre's) is that package's browser build.
              if (query?.split("&").includes("worker") && specifier.startsWith("."))
                workers.add(path.resolve(path.dirname(args.importer), specifier))
              if (query !== undefined || ASSET.test(specifier)) return { path: args.path, external: true }
              // Vite compiles Solid's JSX itself; this walk only reads it.
              if (/\/jsx(-dev)?-runtime$/.test(specifier)) return { path: args.path, external: true }
              return undefined
            })
          },
        },
      ],
    })
    if (result.logs.length > 0) fail(result.logs.map(String).join("\n"))
    const files = Object.keys(result.metafile?.inputs ?? {}).map((file) => browserInputPath(file))
    files.forEach((file) => modules.add(relative(file)))
    const started = await Promise.all(
      files
        .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`) && /\.[jt]sx?$/.test(file))
        .map(async (file) =>
          [...(await Bun.file(file).text()).matchAll(WORKER)].map((match) =>
            path.resolve(path.dirname(file), match[1]),
          ),
        ),
    )
    pending.push(...workers, ...started.flat())
  }
  return { modules: [...modules].toSorted(), runtime: [...runtime].toSorted() }
}

function relative(file: string) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/")
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}
