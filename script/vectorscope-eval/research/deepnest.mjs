// Session origin: round-two scratchpad g1/scripts/deepnest.mjs, 2026-11-06. Changes: argument guard before any require; NODE_MODULES resolved to an absolute path.
// See README.md for its inputs, the findings it backs and how to run it.
import { createRequire } from "node:module"
import path from "node:path"
const usage = "usage: node deepnest.mjs NODE_MODULES (the folder holding web-tree-sitter and @vscode/tree-sitter-wasm)"
const argv = process.argv.slice(2)
if (argv[0] === "--help" || argv[0] === "-h") { console.log(usage); process.exit(0) }
if (argv.length !== 1) { console.error(usage); process.exit(2) }
const nm = path.resolve(argv[0])
const require = createRequire(path.join(nm, "x.js"))
const { Parser, Language, Query } = require(path.join(nm, "web-tree-sitter/tree-sitter.cjs"))
await Parser.init()
const lang = await Language.load(path.join(nm, "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm"))
const p = new Parser(); p.setLanguage(lang)
const q = new Query(lang, "(identifier) @i")
for (const depth of [1000, 10000, 50000, 200000]) {
  const src = "let x = " + "[".repeat(depth) + "a" + "]".repeat(depth) + ";\n"
  const s = performance.now()
  try {
    const t = p.parse(src)
    const ms1 = performance.now() - s
    let caps = -1, err = ""
    try { caps = q.captures(t.rootNode).length } catch (e) { err = String(e).slice(0, 80) }
    let walk = 0, werr = ""
    try { const c = t.walk(); let d = 0; while (c.gotoFirstChild()) d++; walk = d } catch (e) { werr = String(e).slice(0, 80) }
    let fld = "", ferr = ""
    try { let n = t.rootNode; for (let i = 0; i < depth && n; i++) n = n.firstNamedChild; fld = "ok" } catch (e) { ferr = String(e).slice(0, 80) }
    console.log(JSON.stringify({ depth, bytes: src.length, parseMs: Math.round(ms1), hasError: t.rootNode.hasError, caps, err, walk, werr, ferr }))
    t.delete()
  } catch (e) { console.log(JSON.stringify({ depth, threw: String(e).slice(0, 120), ms: Math.round(performance.now() - s) })) }
  try { const t2 = p.parse("let y = 1;"); console.log("  parser still usable:", t2.rootNode.type); t2.delete() } catch (e) { console.log("  parser broken:", String(e).slice(0, 80)) }
}
