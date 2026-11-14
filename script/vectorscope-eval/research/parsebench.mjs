// Session origin: round-two scratchpad g1/scripts/parsebench.mjs, 2026-11-06. Changes: argument guard before any require; NODE_MODULES resolved to an absolute path.
// See README.md for its inputs, the findings it backs and how to run it.
// usage: node parsebench.mjs <nodeModulesDir> <repoDir> <ext> <wasmRelPath> [maxFiles]
import { createRequire } from "node:module"
import { readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
const usage = "usage: node parsebench.mjs NODE_MODULES REPO EXTS WASM_REL [MAX_FILES] (EXTS comma-separated, for example .go; WASM_REL relative to NODE_MODULES)"
const argv = process.argv.slice(2)
if (argv[0] === "--help" || argv[0] === "-h") { console.log(usage); process.exit(0) }
if (argv.length < 4 || argv.length > 5 || (argv[4] !== undefined && !/^[1-9]\d*$/.test(argv[4]))) { console.error(usage); process.exit(2) }
const [, repo, ext, wasmRel, maxArg] = argv
const nm = path.resolve(argv[0])
const require = createRequire(path.join(nm, "x.js"))
const { Parser, Language } = require(path.join(nm, "web-tree-sitter/tree-sitter.cjs"))
const t0 = performance.now()
await Parser.init()
const lang = await Language.load(path.join(nm, wasmRel))
const tInit = performance.now() - t0
const parser = new Parser(); parser.setLanguage(lang)
const exts = ext.split(",")
let files = execFileSync("git", ["-C", repo, "ls-files"], { maxBuffer: 1 << 28 }).toString().split("\n").filter((f) => exts.some((e) => f.endsWith(e)))
const total = files.length
const max = Number(maxArg || 1e9)
// deterministic shuffle subset
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
files = files.map((f) => [rnd(), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, max)
let bytes = 0, skipped = 0, errors = 0; const per = []
let peak = 0
const tp = performance.now()
for (const f of files) {
  const p = path.join(repo, f)
  let st; try { st = statSync(p) } catch { skipped++; continue }
  if (!st.isFile() || st.size > 1 << 20) { skipped++; continue }
  const src = readFileSync(p, "utf8")
  const s = performance.now()
  const tree = parser.parse(src)
  per.push(performance.now() - s)
  if (tree.rootNode.hasError) errors++
  tree.delete()
  bytes += st.size
  if (per.length % 2000 === 0) peak = Math.max(peak, process.memoryUsage().rss)
}
const tParse = performance.now() - tp
peak = Math.max(peak, process.memoryUsage().rss)
per.sort((a, b) => a - b)
const q = (x) => per[Math.min(per.length - 1, Math.floor(x * per.length))]
console.log(JSON.stringify({ repo: path.basename(repo), ext, wasm: wasmRel, filesInRepo: total, parsed: per.length, skipped, withErrors: errors, MB: +(bytes / 1048576).toFixed(1), initMs: Math.round(tInit), totalMs: Math.round(tParse), filesPerSec: Math.round(per.length / (tParse / 1000)), MBperSec: +((bytes / 1048576) / (tParse / 1000)).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), maxMs: +per[per.length - 1].toFixed(1), peakRssMB: Math.round(peak / 1048576) }))
