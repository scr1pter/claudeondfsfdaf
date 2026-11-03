// Resolve the participant's real Vite declaration without building or rewriting it.
const fs = require("node:fs")
const path = require("node:path")
const { createRequire } = require("node:module")
const { pathToFileURL } = require("node:url")
;(async () => {
  const app = path.resolve(process.argv[2])
  const packagePath = path.join(app, "package.json")
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  const command = pkg.scripts?.build
  if (typeof command !== "string" || !/^vite[ \t]+build(?:[ \t]+--(?:emptyOutDir|outDir[ \t]+dist))*[ \t]*$/.test(command)) throw new Error("unrecognized build command; manual instrument review required")
  const vite = await import(pathToFileURL(createRequire(packagePath).resolve("vite")).href)
  if (path.resolve(process.cwd()) !== app) throw new Error("probe must run from the actual application directory")
  const config = await vite.resolveConfig(command.includes("--outDir") ? { build: { outDir: "dist" } } : {}, "build", "production")
  const root = path.resolve(config.root)
  const input = config.build.rollupOptions.input || path.join(root, "index.html")
  const inputs = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input)
  if (!inputs.length || inputs.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("unknown Vite input declaration")
  process.stdout.write(JSON.stringify({ root, output: path.resolve(root, config.build.outDir),
    public: config.publicDir ? path.resolve(config.publicDir) : null,
    inputs: inputs.map(value => path.resolve(root, value)) }) + "\n")
})().catch(error => { process.stderr.write(String(error.message || error) + "\n"); process.exitCode = 2 })
