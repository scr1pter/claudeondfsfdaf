// Session origin: round-two scratchpad g1/scripts/slicebench_wt.mjs, 2026-11-06. Changes: argument guard before any require (the language table moved above it); NODE_MODULES resolved to an absolute path; the usage line names this file.
// See README.md for its inputs, the findings it backs and how to run it.
// Simulates a VS-25 Tier 1 slice per case: parse changed files at rev, extract definition names,
// one combined `git grep -l -w -F` of the rev tree-ish (language pathspec), cap 200 candidates,
// read candidates via one `git cat-file --batch`, parse them, find reference sites.
// usage: node slicebench_wt.mjs <nodeModulesDir> <gitDir of a checkout, e.g. repo/.git> <lang: go|ts|py|java|c> <mode: commits|synthetic> <cases> [filesPerCase]
import { createRequire } from "node:module"
import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
const usage = "usage: node slicebench_wt.mjs NODE_MODULES GIT_DIR LANG MODE CASES [FILES_PER_CASE] (GIT_DIR the .git of a checkout; LANG go, ts, py, java or c; MODE commits or synthetic)"
const argv = process.argv.slice(2)
if (argv[0] === "--help" || argv[0] === "-h") { console.log(usage); process.exit(0) }
const [, gitDir, langName, mode, casesArg, fpcArg] = argv
const LANGS = {
  go: { ext: [".go"], wasm: "tree-sitter-go/tree-sitter-go.wasm",
    defs: "(function_declaration name: (identifier) @n) (method_declaration name: (field_identifier) @n) (type_spec name: (type_identifier) @n)",
    refs: "(identifier) @r (field_identifier) @r (type_identifier) @r", exported: (n) => /^[A-Z]/.test(n) },
  ts: { ext: [".ts"], wasm: "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm",
    defs: "(export_statement declaration: [(function_declaration name: (identifier) @n) (class_declaration name: (type_identifier) @n) (interface_declaration name: (type_identifier) @n) (type_alias_declaration name: (type_identifier) @n) (lexical_declaration (variable_declarator name: (identifier) @n))])",
    refs: "(identifier) @r (type_identifier) @r (property_identifier) @r", exported: () => true },
  py: { ext: [".py"], wasm: "tree-sitter-python/tree-sitter-python.wasm",
    defs: "(module (function_definition name: (identifier) @n)) (module (class_definition name: (identifier) @n)) (module (decorated_definition definition: [(function_definition name: (identifier) @n) (class_definition name: (identifier) @n)]))",
    refs: "(identifier) @r", exported: (n) => !n.startsWith("_") },
  java: { ext: [".java"], wasm: "tree-sitter-java/tree-sitter-java.wasm",
    defs: "(class_declaration name: (identifier) @n) (interface_declaration name: (identifier) @n) (method_declaration name: (identifier) @n)",
    refs: "(identifier) @r (type_identifier) @r", exported: () => true },
  c: { ext: [".c", ".h"], wasm: "tree-sitter-c/tree-sitter-c.wasm",
    defs: "(function_definition declarator: (function_declarator declarator: (identifier) @n))",
    refs: "(identifier) @r", exported: () => true },
}
if (argv.length < 5 || argv.length > 6 || !Object.hasOwn(LANGS, langName) || !/^(commits|synthetic)$/.test(mode) || !/^[1-9]\d*$/.test(casesArg) || (fpcArg !== undefined && !/^[1-9]\d*$/.test(fpcArg))) { console.error(usage); process.exit(2) }
const L = LANGS[langName]
const nm = path.resolve(argv[0])
const require = createRequire(path.join(nm, "x.js"))
const { Parser, Language, Query } = require(path.join(nm, "web-tree-sitter/tree-sitter.cjs"))
await Parser.init()
const lang = await Language.load(path.join(nm, L.wasm))
const parser = new Parser(); parser.setLanguage(lang)
const qd = new Query(lang, L.defs), qr = new Query(lang, L.refs)
const git = (...a) => execFileSync("git", ["--git-dir", gitDir, ...a], { maxBuffer: 1 << 30 })
const isLang = (f) => L.ext.some((e) => f.endsWith(e)) && !/(_test\.go|\.d\.ts|vendor\/|test)/.test(f)
function readBatch(rev, files) {
  const r = spawnSync("git", ["--git-dir", gitDir, "cat-file", "--batch"], { input: files.map((f) => `${rev}:${f}\n`).join(""), maxBuffer: 1 << 30 })
  const buf = r.stdout; const out = []; let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(10, i); const hdr = buf.subarray(i, nl).toString(); i = nl + 1
    const m = hdr.match(/ blob (\d+)$/); if (!m) { out.push(null); continue }
    const n = Number(m[1]); out.push(n > 1 << 20 ? null : buf.subarray(i, i + n).toString()); i += n + 1
  }
  return out
}
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const N = Number(casesArg), FPC = Number(fpcArg || 6)
let cases = []
if (mode === "commits") {
  const revs = git("rev-list", "--no-merges", "--since=2025-11-01", "-n", "3000", "HEAD").toString().trim().split("\n")
  for (const rev of revs.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
    const files = git("diff-tree", "--no-commit-id", "--name-only", "--diff-filter=AM", "-r", rev).toString().trim().split("\n").filter(isLang)
    if (files.length) cases.push({ rev, files: files.slice(0, 40) })
    if (cases.length >= N) break
  }
} else {
  const all = git("ls-tree", "-r", "--name-only", "HEAD").toString().split("\n").filter(isLang)
  for (let k = 0; k < N; k++) cases.push({ rev: "HEAD", files: Array.from({ length: FPC }, () => all[Math.floor(rnd() * all.length)]) })
}
const res = []
for (const c of cases) {
  const t0 = performance.now()
  const srcs = readBatch(c.rev, c.files)
  const names = new Set()
  for (const s of srcs) { if (!s) continue; const t = parser.parse(s); for (const cap of qd.captures(t.rootNode)) if (L.exported(cap.node.text) && cap.node.text.length > 2) names.add(cap.node.text); t.delete() }
  const t1 = performance.now()
  const nameList = [...names].slice(0, 40)
  let cands = []
  if (nameList.length) {
    const r = spawnSync("git", ["-C", path.dirname(gitDir), "grep", "-l", "-w", "-F", ...nameList.flatMap((n) => ["-e", n]), "--", ...L.ext.map((e) => `*${e}`)], { maxBuffer: 1 << 30 })
    cands = r.stdout.toString().trim().split("\n").filter(Boolean).filter((f) => !c.files.includes(f))
  }
  const total = cands.length; cands = cands.slice(0, 200)
  const t2 = performance.now()
  const csrc = readBatch(c.rev, cands)
  const t3 = performance.now()
  let refs = 0
  for (const s of csrc) { if (!s) continue; const t = parser.parse(s); for (const cap of qr.captures(t.rootNode)) if (names.has(cap.node.text)) refs++; t.delete() }
  const t4 = performance.now()
  res.push({ files: c.files.length, names: nameList.length, cands: total, total: t4 - t0, parseChanged: t1 - t0, grep: t2 - t1, read: t3 - t2, parseCands: t4 - t3, refs })
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0) }
const col = (k) => res.map((r) => r[k])
console.log(JSON.stringify({ repo: path.basename(gitDir), lang: langName, mode, cases: res.length,
  medianChangedFiles: q(col("files"), 0.5), medianNames: q(col("names"), 0.5), medianCandidates: q(col("cands"), 0.5), shareCapped: +(res.filter((r) => r.cands > 200).length / res.length).toFixed(2),
  totalMs: { p50: q(col("total"), 0.5), p90: q(col("total"), 0.9), p95: q(col("total"), 0.95), max: q(col("total"), 1) },
  p50ms: { parseChanged: q(col("parseChanged"), 0.5), grep: q(col("grep"), 0.5), read: q(col("read"), 0.5), parseCands: q(col("parseCands"), 0.5) },
  p95ms: { parseChanged: q(col("parseChanged"), 0.95), grep: q(col("grep"), 0.95), read: q(col("read"), 0.95), parseCands: q(col("parseCands"), 0.95) } }))
