#!/usr/bin/env bun
// VS-25a throughput bench for the review parser (src/review/parse.ts). Nothing calls it: it is eval tooling, run by hand
// from packages/engine, under Bun or, bundled with `bun build --target=node`, under Node. It reads one checkout, writes
// no file and prints one JSON line. Name every repository it measures by URL and commit wherever its figures are
// recorded; results stay uncommitted (I-13).
//
//   bun run script/vectorscope-parse-bench.ts <repoDir> <ext,...> [maxFiles=4000] [--limits default|generous]
//     [--min-bytes N] [--names]
//
// Files come from `git ls-files`, filtered by extension, in a deterministic seeded shuffle (the round-two
// parsebench.mjs order, seed 7), so two runs measure the same sample. `--limits generous` lifts the time boxes, to see
// what the default limits refuse; `--min-bytes` keeps only files at least that large (the near-1 MiB sample); `--names`
// passes a five-name filter, to see whether filtering references saves extraction time.

import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { Effect } from "effect"
import { ReviewParse } from "../src/review/parse"

const usage =
  "usage: vectorscope-parse-bench.ts REPO EXTS [MAX_FILES] [--limits default|generous] [--min-bytes N] [--names]"
const args = parseArgs({
  allowPositionals: true,
  options: {
    limits: { type: "string", default: "default" },
    "min-bytes": { type: "string", default: "0" },
    names: { type: "boolean", default: false },
  },
})
const [repo, exts, max = "4000"] = args.positionals
if (!repo || !exts || !/^[1-9]\d*$/.test(max) || !["default", "generous"].includes(args.values.limits)) {
  console.error(usage)
  process.exit(2)
}

const limits =
  args.values.limits === "generous"
    ? { ...ReviewParse.PARSE_LIMITS, parseMs: 600_000, extractMs: 600_000 }
    : ReviewParse.PARSE_LIMITS
const minBytes = Number(args.values["min-bytes"])
const wanted = exts.split(",").map((ext) => ext.replace(/^\./, "").toLowerCase())
const listed = execFileSync("git", ["-C", repo, "ls-files", "-z"], { maxBuffer: 1 << 30 })
  .toString()
  .split("\0")
  .filter((file) => wanted.some((ext) => file.toLowerCase().endsWith(`.${ext}`)))
const seed = { value: 7 }
const random = () => (seed.value = (seed.value * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
const sample = listed
  .map((file) => ({ file, key: random() }))
  .sort((a, b) => a.key - b.key)
  .map((entry) => entry.file)
  .filter((file) => sizeOf(path.join(repo, file)) >= Math.max(0, minBytes))
  .slice(0, Number(max))

const loads = await Promise.all(
  [...new Set(sample.map((file) => ReviewParse.languageOf(file)).filter((language) => language !== undefined))].map(
    async (language) => {
      const started = performance.now()
      const grammar = await Effect.runPromise(ReviewParse.grammar(language))
      return { language, ms: round(performance.now() - started), bytes: grammar.bytes, abi: grammar.abi }
    },
  ),
)

const names = args.values.names ? new Set(["Effect", "path", "test", "name", "value"]) : undefined
const totals = { files: 0, bytes: 0, parsedBytes: 0, errors: 0, definitions: 0, references: 0, comments: 0, strings: 0 }
const times = { total: [] as number[], parse: [] as number[], extract: [] as number[], walk: [] as number[] }
const refusals: Record<string, number> = {}
const peak = { rss: process.memoryUsage().rss }
const started = performance.now()
for (const [index, file] of sample.entries()) {
  const full = path.join(repo, file)
  // Files far over the input cap are counted as refused without being read.
  const size = sizeOf(full)
  const skipped = size > limits.inputBytes * 4
  const text = skipped ? "" : readFileSync(full, "utf8")
  const t0 = performance.now()
  const result = skipped
    ? ({ parsed: false, because: "too-large" } as const)
    : await Effect.runPromise(ReviewParse.parse({ path: file, text, ...(names ? { names } : {}) }, limits))
  const ms = performance.now() - t0
  totals.files++
  totals.bytes += size
  if (!result.parsed) {
    refusals[result.because] = (refusals[result.because] ?? 0) + 1
    continue
  }
  totals.parsedBytes += size
  totals.errors += result.hasError ? 1 : 0
  totals.definitions += result.definitions.length
  totals.references += result.references.length
  totals.comments += result.comments.length
  totals.strings += result.strings.length
  times.total.push(ms)
  times.parse.push(result.parseMs)
  times.extract.push(result.extractMs)
  times.walk.push(result.walkMs)
  if (index % 200 === 0) peak.rss = Math.max(peak.rss, process.memoryUsage().rss)
}
const elapsed = (performance.now() - started) / 1000
peak.rss = Math.max(peak.rss, process.memoryUsage().rss)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const megabytes = totals.parsedBytes / 1_048_576
console.log(
  JSON.stringify({
    repo: path.basename(path.resolve(repo)),
    commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim(),
    runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
    exts: wanted,
    limits: args.values.limits,
    minBytes,
    names: !!names,
    filesInRepo: listed.length,
    sampled: sample.length,
    loads,
    parsed: times.total.length,
    refusals,
    MB: round(megabytes),
    seconds: round(elapsed),
    filesPerSec: round(times.total.length / (sum(times.total) / 1000)),
    MBperSecParse: round(megabytes / (sum(times.parse) / 1000)),
    MBperSecTotal: round(megabytes / (sum(times.total) / 1000)),
    walkShare: round(sum(times.walk) / sum(times.total)),
    totalMs: quantiles(times.total),
    parseMs: quantiles(times.parse),
    extractMs: quantiles(times.extract),
    errorTreeShare: round(totals.errors / Math.max(1, times.total.length)),
    definitions: totals.definitions,
    references: totals.references,
    comments: totals.comments,
    strings: totals.strings,
    peakRssMB: Math.round(peak.rss / 1_048_576),
  }),
)

// A tracked path that is not a regular file here (deleted, a submodule, or a symbolic link, which may point outside the
// checkout) reads as -1 and is left out, so the bench reads only regular files inside the checkout.
function sizeOf(file: string) {
  const found = lstatSync(file, { throwIfNoEntry: false })
  return found?.isFile() ? found.size : -1
}

function quantiles(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0)
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1) ?? 0) }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
