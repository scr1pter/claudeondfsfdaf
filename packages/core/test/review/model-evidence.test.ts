import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { FREE_MODEL_TRAINING_LABEL } from "@vectordevai/core/free-model-choice"
import { DEFAULT_GATE, gateDigest } from "@vectordevai/core/review/eval-report"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import {
  assessReview,
  canonicalPrompts,
  certificateProblems,
  certify,
  EVIDENCE_POLICY_KEYS,
  evidenceScope,
  MAX_CERTIFICATE_DAYS,
  MODEL_EVIDENCE,
  modelEvidenceNotes,
  policyDigest,
  promptsDigest,
  REVIEW_PIPELINE_REVISION,
  REVIEW_PIPELINE_SOURCES,
  routedModel,
  type EvidenceScope,
  type ModelCertificate,
  type ModelSubject,
} from "@vectordevai/core/review/model-evidence"
import { DEFAULT_REVIEW_CONFIG, UNAPPLIED_REVIEW_KEYS, type ReviewConfig } from "@vectordevai/core/review/types"

// The review pipeline's sources, from the repository root: both runners, the core code they share for planning,
// packing, selection, anchoring and the prompts (whose length limits promptsDigest cannot see), the route rules
// (VS-23a), the payload holdback (VS-34a), the trivial gate and the pre-dispatch estimate (VS-24c), the tree-sitter
// parser (VS-25a), the Tier 1 impact slice and its builder (VS-25b), and the review and security agents' own prompts.
// REVIEW_PIPELINE_SOURCES pins a digest of them. The web-tree-sitter runtime init the parser shares with the shell tool
// (engine util/tree-sitter.ts) is left out on purpose: it decides nothing a review finds, and pinning it would tie shell
// changes to the review pin. So, for now, are the slice's shared readers, BrainCode and BrainGraph (core brain/code.ts
// and graph.ts, which also rank the desktop's files) and the changedSymbols fallback (review/symbols.ts): no runner
// reaches them through the slice before VS-25b wiring, which adds them here when it makes them decide the slice. The
// strict guardrail (VS-27b's guardrail.ts) is pinned from the day it lands, though no runner calls it before VS-27c: it
// decides what a strict review posts, and its shared rule pass is the one report.ts's offline re-selection applies, so
// a change to either moves this pin on purpose. So is the rule citation check (VS-43a's citation.ts), pinned from the
// day it lands, as guardrail.ts is: it will decide what a review drops or strips. So is the change-risk band (VS-28c's
// risk.ts), pinned from the day it lands: once wired it decides which passes run under `depth: "auto"`. So is the
// runtime evidence contract (VS-30c's runtime.ts), pinned from the day it lands: once the VS-30 executor runs it,
// runtimeVerdict decides which findings are verified at runtime. So are guarded team memory's rules (VS-35a's team.ts),
// pinned from the day they land: once wired they decide which findings select.ts demotes and which dismissals become
// team memory. Their body reader in state.ts (parseDismissalMarker, guardedTeamPatterns) decides which dismissals
// count as marked, but stays unpinned for now: pinning state.ts would tie this pin to codium's and vector-at-mention's
// edits there. It joins here when the job first calls guardedTeamPatterns, as BrainCode joins with VS-25b wiring.
// verdict.ts and format.ts are left out: completeness decides wording and the verdict, not what a review finds or posts.
const REVIEW_PIPELINE_FILES = [
  "packages/engine/src/review/run.ts",
  "packages/engine/src/review/read-authority.ts",
  "packages/engine/src/review/service.ts",
  "packages/engine/src/cli/cmd/review.ts",
  "packages/engine/src/session/tools.ts",
  "packages/engine/src/session/prompt.ts",
  "packages/engine/src/agent/agent.ts",
  "packages/engine/src/review/model.ts",
  "packages/engine/src/config/agent.ts",
  "packages/engine/src/session/processor.ts",
  "packages/engine/src/session/llm.ts",
  "packages/engine/src/session/llm/request.ts",
  "packages/engine/src/tool/grep.ts",
  "packages/engine/src/tool/glob.ts",
  "packages/engine/src/tool/read.ts",
  "packages/engine/src/tool/external-directory.ts",
  "packages/app/src/features/pull-requests/ai-review.ts",
  "packages/core/src/review/plan.ts",
  "packages/core/src/review/pack.ts",
  "packages/core/src/review/select.ts",
  "packages/core/src/review/diff.ts",
  "packages/core/src/review/fingerprint.ts",
  "packages/core/src/review/prompt.ts",
  "packages/core/src/review/privacy.ts",
  "packages/core/src/review/holdback.ts",
  "packages/core/src/review/trivial.ts",
  "packages/core/src/review/dispatch.ts",
  "packages/core/src/review/risk.ts",
  "packages/core/src/review/guardrail.ts",
  "packages/core/src/review/citation.ts",
  "packages/core/src/review/runtime.ts",
  "packages/core/src/review/team.ts",
  "packages/engine/src/review/parse.ts",
  "packages/core/src/review/impact.ts",
  "packages/engine/src/review/impact.ts",
  "packages/engine/src/agent/prompt/review.txt",
  "packages/engine/src/agent/prompt/security.txt",
  "packages/engine/src/agent/prompt/vectorscope.txt",
]

// Model evidence (VS-07) over synthetic certificates. No real certificate exists: MODEL_EVIDENCE is empty until the
// owner approves one from a held-out run.

const SONNET = "anthropic/claude-sonnet-4-5"
const SCOPE = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
const NOW = Date.parse("2027-01-01T12:00:00Z")

function cert(overrides: Partial<ModelCertificate> = {}): ModelCertificate {
  return {
    version: 1,
    id: "vs-2026-12-sonnet",
    model: SONNET,
    adapters: ["engine"],
    pipeline: SCOPE.pipeline,
    prompts: SCOPE.prompts,
    policy: SCOPE.policy,
    evaluation: {
      report: `sha256:${"a".repeat(64)}`,
      manifest: `sha256:${"b".repeat(64)}`,
      split: "held-out",
      decision: "D2",
      gate: gateDigest(DEFAULT_GATE),
      collected: "2026-12-01",
    },
    approved: { by: "owner", date: "2026-12-02" },
    expires: "2027-02-01",
    ...overrides,
  }
}

const chosen = (model: string, overrides: Partial<ModelSubject> = {}): ModelSubject => ({
  model,
  free: false,
  choice: { explicit: true, setting: "--model" },
  ...overrides,
})

const assess = (
  review: ModelSubject,
  options: {
    certificates?: ModelCertificate[]
    scope?: EvidenceScope
    triage?: ModelSubject
    served?: string[]
    now?: number
  } = {},
) =>
  assessReview({
    review,
    ...(options.triage ? { triage: options.triage } : {}),
    scope: options.scope ?? SCOPE,
    ...(options.served ? { served: options.served } : {}),
    now: options.now ?? NOW,
    certificates: options.certificates ?? [cert()],
  })

describe("the registry", () => {
  test("holds no certificate, so every model is unvetted, and anything in it must be valid", () => {
    expect(MODEL_EVIDENCE).toEqual([])
    for (const item of MODEL_EVIDENCE) expect(certificateProblems(item)).toEqual([])
    const evidence = assessReview({ review: chosen(SONNET), scope: SCOPE, now: NOW })
    expect(evidence.models.map((entry) => entry.status)).toEqual(["unvetted"])
  })
})

describe("scope", () => {
  test("names the runner, pipeline revision, prompts, review settings and triage model", () => {
    expect(SCOPE).toEqual({
      adapter: "engine",
      pipeline: REVIEW_PIPELINE_REVISION,
      prompts: promptsDigest(),
      policy: policyDigest(DEFAULT_REVIEW_CONFIG),
    })
    expect(promptsDigest()).toMatch(/^[0-9a-f]{16}$/)
    expect(promptsDigest()).toBe(promptsDigest())
    // Printed at 6e2f1d04, before VS-25b: a section a key enables enters the digest only under that key (contract §0.3).
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG, triage: "acme/cheap" })).toMatchObject({
      adapter: "desktop",
      triage: "acme/cheap",
    })
  })

  // Phase 1 review: the digest rendered bare inputs only, so a section a prompt shows only when it has something to show
  // could change without changing it.
  test("the prompts digest renders every section a prompt can have, with and without nits, uncommitted too", () => {
    const text = canonicalPrompts().join("\n")
    for (const section of [
      "## Open findings",
      "<open_findings>",
      "## Focus",
      "<focus>",
      "were reviewed before; their diff is shown without context lines",
      "The last review was of",
      "<untrusted_pr_title>",
      "<untrusted_pr_body>",
      "<untrusted_commits>",
      "<untrusted_diff>",
      "<untrusted_changed_files_not_inlined>",
      "open them yourself",
      "their pull request versions are in `<untrusted_pr_file>` blocks when they fit",
      'annotated="true"',
      "<related_code>",
      "<ci_checks>",
      "<untrusted_ci_log",
      "<untrusted_linked_requirements>",
      "<history>",
      "<untrusted_comments>",
      "<team_dismissed>",
      "the repository root",
      "<repository_instructions",
      "<review_rules",
      "Nit means a clarity or style point",
      "Do not report nits.",
      "- Formatting, or anything a linter catches.",
      "- Style, formatting, naming, comments, wording",
      "Reviewing the uncommitted changes in the working tree",
      "the uncommitted changes in the working tree.",
      "<untrusted_fixed_claim",
      "Each `<untrusted_fixed_claim>`",
      "<how_the_owner_reviews>",
      "Stop investigating.",
      "Anything that is not a security defect.",
      "The working tree is the base branch.",
    ])
      expect(text).toContain(section)
  })

  // VS-25b: the <untrusted_impact> block renders only when a slice is set, which only `impact: "graph"` will do, so it
  // enters the digest only under that key and the default digest holds.
  test("the prompts digest covers the impact block under impact: graph only", () => {
    expect(promptsDigest({})).toBe(promptsDigest())
    expect(promptsDigest({ impact: "grep" })).toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph" })).not.toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph" })).toBe(promptsDigest({ impact: "graph" }))
    expect(canonicalPrompts().join("\n")).not.toContain("untrusted_impact")
    expect(canonicalPrompts({ impact: "grep" })).toEqual(canonicalPrompts())
    const graph = canonicalPrompts({ impact: "graph" })
    expect(graph.slice(0, canonicalPrompts().length)).toEqual(canonicalPrompts())
    const text = graph.join("\n")
    for (const section of [
      "`<untrusted_impact>` lists the definitions this change touches",
      "<untrusted_impact>\n",
      "<untrusted_changed_definition ",
      "<untrusted_call_site ",
      'in="caller"',
      "<untrusted_tests>",
      "<untrusted_impact_note>",
      "its time limit; 1 file not searched, missing from a partial clone; git output over its limit; a git error",
      // VS-37a's slice packed in tiers, with every part its block can show.
      "`<untrusted_impact>` holds context Vector computed for this change",
      '<untrusted_enclosing_scope path="src/example.ts" line="4" end_line="6" side="RIGHT" kind="method" container="export class Example">',
      "⋯",
      'side="LEFT" kind="function">',
      "<untrusted_outbound_signature ",
      'used_in="src/example.ts:5"',
      "<untrusted_impact_fallback>",
      "1 changed file in a language Vector does not parse: no enclosing scope; 2 changed files or definitions over the size limit: no enclosing scope; 1 changed file missing from a partial clone: no enclosing scope; 1 dependency file in a language Vector does not parse: no signatures; 2 dependency files over the size, file or time limit: no signatures; 1 dependency file missing from a partial clone: no signatures; 2 files with call sites outside a known statement: three lines either side",
    ])
      expect(text).toContain(section)
    // Both trusts, the review and security prompts, for VS-25b's slice and then VS-37a's.
    expect(graph.length - canonicalPrompts().length).toBe(8)
    expect(graph.slice(canonicalPrompts().length, canonicalPrompts().length + 4).join("\n")).not.toContain(
      "untrusted_enclosing_scope",
    )
    // The default digest holds; the graph digest moved from fd944d83f8d705ad when VS-37a's prompts joined it.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
  })

  // VS-27a: the strict report and result schemas render only under `guardrail: "strict"`, which no runner sets before
  // VS-27c, so they enter the digest only under that key and every other digest holds.
  test("the prompts digest covers the strict schemas under guardrail: strict only", () => {
    expect(promptsDigest({ guardrail: "off" })).toBe(promptsDigest())
    expect(promptsDigest({ guardrail: undefined })).toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph", guardrail: "off" })).toBe(promptsDigest({ impact: "graph" }))
    const strict = promptsDigest({ guardrail: "strict" })
    expect(strict).toBe(promptsDigest({ guardrail: "strict" }))
    const both = promptsDigest({ impact: "graph", guardrail: "strict" })
    expect(both).toBe(promptsDigest({ guardrail: "strict", impact: "graph" }))
    expect(new Set([promptsDigest(), promptsDigest({ impact: "graph" }), strict, both]).size).toBe(4)
    // The default and graph digests are unchanged by VS-27a.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
    // The schema-only strict digests. VS-27a printed f04c185c5b415aaf and 9c87880d813f1e69 (built at f7e1f8df); VS-27b
    // moved them, because the result schema's drop enum follows STRICT_DROPS, which gained severity-unreadable and
    // checks S2's severity half first (built at 12950f7c). VS-27c moves them on purpose when the strict task text joins
    // canonicalPrompts under the key. VS-42, VS-43 and VS-44 must each leave them at whatever value is current when
    // they land, with their own keys off: their fields join the strict schemas only under their keys.
    expect(strict).toBe("b98afb0e878dfe26")
    expect(both).toBe("3ba21b5bc883cd70")
  })

  // VS-42a: `scopeGate: "introduced"` adds the result schema's pre-existing drop, so it moves the digest only under
  // `guardrail: "strict"`; with it off, or without strict, every digest holds (the engine:guardrail-strict digests
  // included).
  test("the prompts digest covers VS-42's scopeGate under guardrail: strict only", () => {
    const strict = promptsDigest({ guardrail: "strict" })
    const both = promptsDigest({ impact: "graph", guardrail: "strict" })
    expect(promptsDigest({ guardrail: "strict", scopeGate: "off" })).toBe(strict)
    expect(promptsDigest({ impact: "graph", guardrail: "strict", scopeGate: "off" })).toBe(both)
    for (const keys of [
      { scopeGate: "introduced" as const },
      { guardrail: "off" as const, scopeGate: "introduced" as const },
    ])
      expect(promptsDigest(keys)).toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph", scopeGate: "introduced" })).toBe(promptsDigest({ impact: "graph" }))
    const gated = promptsDigest({ guardrail: "strict", scopeGate: "introduced" })
    const gatedGraph = promptsDigest({ impact: "graph", guardrail: "strict", scopeGate: "introduced" })
    expect(new Set([promptsDigest(), promptsDigest({ impact: "graph" }), strict, both, gated, gatedGraph]).size).toBe(6)
    // VS-42a held every earlier digest, and printed these (built at d268025c). VS-42 wiring moves them on purpose when
    // the report schema's `scope` field and the prompt clause join under the key.
    expect(strict).toBe("b98afb0e878dfe26")
    expect(both).toBe("3ba21b5bc883cd70")
    expect(gated).toBe("4aa712221043a3a7")
    expect(gatedGraph).toBe("8335adf9de513ee5")
  })

  // VS-44a: `verifyEvidence: "certificate"` adds the certificate verify schema (verifyCertJsonSchema) after the strict
  // schemas, so it moves the digest only under `guardrail: "strict"`; with it off, or without strict, every digest holds
  // (the engine:guardrail-strict and VS-42 digests included).
  test("the prompts digest covers VS-44's verifyEvidence under guardrail: strict only", () => {
    const strict = promptsDigest({ guardrail: "strict" })
    const both = promptsDigest({ impact: "graph", guardrail: "strict" })
    const gated = promptsDigest({ guardrail: "strict", scopeGate: "introduced" })
    expect(promptsDigest({ guardrail: "strict", verifyEvidence: "off" })).toBe(strict)
    expect(promptsDigest({ impact: "graph", guardrail: "strict", verifyEvidence: "off" })).toBe(both)
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced", verifyEvidence: "off" })).toBe(gated)
    for (const keys of [
      { verifyEvidence: "certificate" as const },
      { guardrail: "off" as const, verifyEvidence: "certificate" as const },
      { scopeGate: "introduced" as const, verifyEvidence: "certificate" as const },
    ])
      expect(promptsDigest(keys)).toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph", verifyEvidence: "certificate" })).toBe(promptsDigest({ impact: "graph" }))
    const cert = promptsDigest({ guardrail: "strict", verifyEvidence: "certificate" })
    const certGraph = promptsDigest({ impact: "graph", guardrail: "strict", verifyEvidence: "certificate" })
    const certGated = promptsDigest({ guardrail: "strict", scopeGate: "introduced", verifyEvidence: "certificate" })
    expect(
      new Set([promptsDigest(), promptsDigest({ impact: "graph" }), strict, both, gated, cert, certGraph, certGated])
        .size,
    ).toBe(8)
    // VS-44a held every earlier digest, and printed these (built at cd0903b5). VS-44 wiring moves them on purpose when
    // the blind candidate and the certificate prompt join, and the result schema gains VS-44's drops, under the key.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
    expect(strict).toBe("b98afb0e878dfe26")
    expect(both).toBe("3ba21b5bc883cd70")
    expect(gated).toBe("4aa712221043a3a7")
    expect(cert).toBe("d209592d08bb1e0c")
    expect(certGraph).toBe("468fcac8cde18fe2")
    expect(certGated).toBe("0f3ff2dd0f7c1d7d")
  })

  // VS-28c: the four lens prompts render only under `depth: "auto"` with `lenses: "high"`, so they move the digest only
  // under that pair; either key alone, and every other set of keys, keeps its digest.
  test("the prompts digest covers VS-28's lens prompts under depth: auto with lenses: high only", () => {
    for (const keys of [
      { depth: "auto" as const },
      { lenses: "high" as const },
      { depth: "fixed" as const, lenses: "high" as const },
      { depth: "auto" as const, lenses: "off" as const },
    ]) {
      expect(promptsDigest(keys)).toBe(promptsDigest())
      expect(canonicalPrompts(keys)).toEqual(canonicalPrompts())
      expect(promptsDigest({ ...keys, impact: "graph" })).toBe(promptsDigest({ impact: "graph" }))
      expect(promptsDigest({ ...keys, guardrail: "strict" })).toBe(promptsDigest({ guardrail: "strict" }))
    }
    const lensed = canonicalPrompts({ depth: "auto", lenses: "high" })
    expect(lensed.slice(0, canonicalPrompts().length)).toEqual(canonicalPrompts())
    // Four lenses, each over the review prompts' six inputs for both trusts.
    expect(lensed.length - canonicalPrompts().length).toBe(48)
    const text = lensed.slice(canonicalPrompts().length).join("\n")
    for (const section of [
      "You are Vector's concurrency reviewer.",
      "You are Vector's resource reviewer.",
      "You are Vector's access reviewer.",
      "You are Vector's data-integrity reviewer.",
      "- Anything that is not a concurrency defect.",
      "- Anything that is not a resource defect.",
      "- Anything that is not an access-control defect.",
      "- Anything that is not a data-integrity defect.",
      "Report at most 4 findings",
      "The working tree is the base branch.",
      // The input matrix: nits asked for and not, incremental, and uncommitted.
      "Nit means a clarity or style point; nits come last.",
      "Do not report nits.",
      "The last review was of `",
      "Reviewing the uncommitted changes in the working tree against",
    ])
      expect(text).toContain(section)
    expect(text).not.toContain("<untrusted_impact>")
    // Under impact: "graph" too, each lens also renders with each slice, for both trusts, after its input matrix.
    const graph = canonicalPrompts({ impact: "graph" })
    const lensedGraph = canonicalPrompts({ impact: "graph", depth: "auto", lenses: "high" })
    expect(lensedGraph.slice(0, graph.length)).toEqual(graph)
    expect(lensedGraph.length - graph.length).toBe(48 + 16)
    const graphText = lensedGraph.slice(graph.length).join("\n")
    expect(graphText).toContain("<untrusted_impact>")
    for (const lens of ["concurrency", "resource", "access", "data-integrity"])
      expect(
        lensedGraph
          .slice(graph.length)
          .filter(
            (prompt) => prompt.includes(`You are Vector's ${lens} reviewer.`) && prompt.includes("<untrusted_impact>"),
          ),
      ).toHaveLength(4)
    expect(canonicalPrompts().join("\n")).not.toContain("Report at most 4 findings, the most important first.\n")
    const lenses = promptsDigest({ depth: "auto", lenses: "high" })
    const lensesGraph = promptsDigest({ impact: "graph", depth: "auto", lenses: "high" })
    const lensesStrict = promptsDigest({ guardrail: "strict", depth: "auto", lenses: "high" })
    expect(
      new Set([
        promptsDigest(),
        promptsDigest({ impact: "graph" }),
        promptsDigest({ guardrail: "strict" }),
        lenses,
        lensesGraph,
        lensesStrict,
      ]).size,
    ).toBe(6)
    // VS-28c held every earlier digest, and printed these (built at 0e4c5d1d). VS-28 wiring moves them on purpose when
    // the lens agent prompt joins under the pair.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
    expect(promptsDigest({ guardrail: "strict" })).toBe("b98afb0e878dfe26")
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced" })).toBe("4aa712221043a3a7")
    expect(promptsDigest({ guardrail: "strict", verifyEvidence: "certificate" })).toBe("d209592d08bb1e0c")
    expect(lenses).toBe("dd09332295a99649")
    expect(lensesGraph).toBe("31c1a0612c0f9541")
    expect(lensesStrict).toBe("0ebaacbe7aca1b58")
  })

  // VS-30c: the runtime instruction and its <untrusted_runtime_evidence> block render only under `runtime: "ask"`,
  // standalone and last, so they move the digest only under that key; "off", and every other set of keys, keeps its
  // digest.
  test("the prompts digest covers VS-30's runtime block under runtime: ask only", () => {
    expect(promptsDigest({ runtime: "off" })).toBe(promptsDigest())
    expect(canonicalPrompts({ runtime: "off" })).toEqual(canonicalPrompts())
    expect(promptsDigest({ impact: "graph", runtime: "off" })).toBe(promptsDigest({ impact: "graph" }))
    expect(promptsDigest({ guardrail: "strict", runtime: "off" })).toBe(promptsDigest({ guardrail: "strict" }))
    expect(canonicalPrompts().join("\n")).not.toContain("runtime_evidence")
    const ask = canonicalPrompts({ runtime: "ask" })
    expect(ask.slice(0, -2)).toEqual(canonicalPrompts())
    expect(ask.length - canonicalPrompts().length).toBe(2)
    expect(ask.at(-2)).toStartWith("`<untrusted_runtime_evidence>` holds what this project's own tests printed")
    const block = ask.at(-1) ?? ""
    // Under every cap, so no "not shown" line renders.
    expect(block).not.toContain("not shown")
    for (const section of [
      "<untrusted_runtime_evidence>\n",
      "<untrusted_runtime_run ",
      'side="head"',
      'side="base"',
      'finding="000000000000"',
      'failure="assertion"',
      'stopped="timeout"',
      'command="bun test --coverage --coverage-reporter=lcov" kind="coverage" side="head"',
      "<untrusted_runtime_coverage ",
      "src/example.ts: 1 of 4 changed lines ran; not run: 2, 4-5",
      "src/types.ts: the coverage report lists none of its changed lines",
      "src/other.ts: the coverage report has no record of this file",
      "</untrusted_runtime_evidence>",
    ])
      expect(block).toContain(section)
    // With the other keys, the block still comes last.
    const lensed = canonicalPrompts({ impact: "graph", depth: "auto", lenses: "high", runtime: "ask" })
    expect(lensed.slice(0, -2)).toEqual(canonicalPrompts({ impact: "graph", depth: "auto", lenses: "high" }))
    expect(lensed.slice(-2)).toEqual(ask.slice(-2))
    const runtime = promptsDigest({ runtime: "ask" })
    const runtimeGraph = promptsDigest({ impact: "graph", runtime: "ask" })
    const runtimeStrict = promptsDigest({ guardrail: "strict", runtime: "ask" })
    const runtimeLenses = promptsDigest({ depth: "auto", lenses: "high", runtime: "ask" })
    expect(runtime).toBe(promptsDigest({ runtime: "ask" }))
    expect(
      new Set([
        promptsDigest(),
        promptsDigest({ impact: "graph" }),
        promptsDigest({ guardrail: "strict" }),
        promptsDigest({ depth: "auto", lenses: "high" }),
        runtime,
        runtimeGraph,
        runtimeStrict,
        runtimeLenses,
      ]).size,
    ).toBe(8)
    // VS-30c held every earlier digest, and printed these (built at 213aabe9, with its coverage-run kind and the
    // instruction's coverage sentence). The VS-30 executor moves them on purpose when its repro or verify prompt joins
    // under the key.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
    expect(promptsDigest({ guardrail: "strict" })).toBe("b98afb0e878dfe26")
    expect(promptsDigest({ impact: "graph", guardrail: "strict" })).toBe("3ba21b5bc883cd70")
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced" })).toBe("4aa712221043a3a7")
    expect(promptsDigest({ impact: "graph", guardrail: "strict", scopeGate: "introduced" })).toBe("8335adf9de513ee5")
    expect(promptsDigest({ guardrail: "strict", verifyEvidence: "certificate" })).toBe("d209592d08bb1e0c")
    expect(promptsDigest({ impact: "graph", guardrail: "strict", verifyEvidence: "certificate" })).toBe(
      "468fcac8cde18fe2",
    )
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced", verifyEvidence: "certificate" })).toBe(
      "0f3ff2dd0f7c1d7d",
    )
    expect(promptsDigest({ depth: "auto", lenses: "high" })).toBe("dd09332295a99649")
    expect(promptsDigest({ impact: "graph", depth: "auto", lenses: "high" })).toBe("31c1a0612c0f9541")
    expect(promptsDigest({ guardrail: "strict", depth: "auto", lenses: "high" })).toBe("0ebaacbe7aca1b58")
    expect(runtime).toBe("7d9147298f5cdbaf")
    expect(runtimeGraph).toBe("3bf0c1afc17e08d9")
    expect(runtimeStrict).toBe("8c5154b47a05f952")
    expect(runtimeLenses).toBe("bcb1c5c5258319f1")
  })

  // The runners and the core code they share have no digest a review can compute, so this pins one: a change to any of
  // these files fails here until someone decides whether REVIEW_PIPELINE_REVISION goes up and updates the pin.
  test("the pipeline's sources are pinned next to REVIEW_PIPELINE_REVISION", () => {
    const root = path.join(import.meta.dir, "..", "..", "..", "..")
    const digest = fnv1a64(
      REVIEW_PIPELINE_FILES.map(
        (file) => `${file}\n${readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n")}`,
      ).join("\0"),
    )
    if (digest !== REVIEW_PIPELINE_SOURCES)
      throw new Error(
        `The review pipeline's sources changed (${REVIEW_PIPELINE_FILES.join(", ")}). If the change alters what a review finds or posts, bump REVIEW_PIPELINE_REVISION (REVIEW_PIPELINE_REVISION is ${REVIEW_PIPELINE_REVISION}). Then set REVIEW_PIPELINE_SOURCES in packages/core/src/review/model-evidence.ts to "${digest}".`,
      )
    expect(digest).toBe(REVIEW_PIPELINE_SOURCES)
  })

  test("the policy digest follows the settings that change what is found or posted, and no others", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    for (const change of [
      { verify: "all" as const },
      { verifyPolicy: "shared" as const },
      { security: "always" as const },
      { minConfidence: 0.5 },
      { maxComments: 3 },
      { nits: true },
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).not.toBe(base)
    for (const change of [
      { maxCostUsd: 9 },
      { timeoutMinutes: 30 },
      { ignore: ["docs/**"] },
      { modelEvidence: "warn" as const },
      { model: "acme/other" },
      // The route settings (VS-23a) are scope, not policy: EvidenceScope.route, set only by a runner enforcing them.
      { privacy: "zdr" as const },
      { zdrAttested: ["openrouter"] },
      // VS-33's attestation objects are route settings too.
      { zdrAttested: [{ id: "openrouter", operator: "openrouter", region: "eu" as const, extendedCache: true }] },
      // VS-24's token cap is a budget, and its trivial gate is applied by no runner yet.
      { maxInputTokens: 200_000 },
      { trivial: "review" as const },
      { trivial: "skip" as const },
      // VS-25's impact slice is applied by no runner yet either, nor VS-27's guardrail.
      { impact: "grep" as const },
      { impact: "graph" as const },
      { guardrail: "off" as const },
      { guardrail: "strict" as const },
      // Nor VS-42's scopeGate, with or without strict.
      { scopeGate: "off" as const },
      { scopeGate: "introduced" as const },
      { guardrail: "strict" as const, scopeGate: "introduced" as const },
      // Nor VS-44's verifyEvidence, with or without strict.
      { verifyEvidence: "off" as const },
      { verifyEvidence: "certificate" as const },
      { guardrail: "strict" as const, verifyEvidence: "certificate" as const },
      // Nor VS-28's depth and lenses, alone or together.
      { depth: "fixed" as const },
      { depth: "auto" as const },
      { lenses: "high" as const },
      { depth: "auto" as const, lenses: "high" as const },
      // Nor VS-30's runtime, which no runner applies before the VS-30 executor.
      { runtime: "off" as const },
      { runtime: "ask" as const },
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).toBe(base)
  })

  // VS-24c: `trivial` is a policy key (a skipped change is not reviewed) that no runner applies before VS-24 wiring, so
  // it never enters the digest yet: a review whose config sets `trivial: "skip"` runs, and is scoped as, the full
  // review. Once a runner applies it (it leaves UNAPPLIED_REVIEW_KEYS), it counts only when set to "skip", so the digest
  // of every config made before it, the frozen engine baseline's included, still holds.
  test("the policy digest leaves out VS-24's trivial until a runner applies it", () => {
    // Printed by policyDigest at 8f38f824, before `trivial` was a policy key.
    expect(policyDigest(DEFAULT_REVIEW_CONFIG)).toBe("70512122f41ec160")
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(UNAPPLIED_REVIEW_KEYS).toContain("trivial")
    for (const trivial of ["skip", "review", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, trivial })).toBe(base)
    const skip: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, trivial: "skip" }
    expect(evidenceScope({ adapter: "engine", config: skip })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "desktop", config: skip })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    // Every other key keeps its digest behaviour: a changed value still moves it, with trivial set or not.
    expect(policyDigest({ ...skip, maxComments: 3 })).not.toBe(policyDigest(skip))
    expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, maxSteps: 31 })).not.toBe(base)
  })

  // VS-25b: `impact` is a policy key (the slice is context the model reviews with) that no runner applies before VS-25b
  // wiring, so neither the policy digest nor the prompts digest of a scope moves with it yet. Once a runner applies it,
  // only "graph" counts, in both.
  test("the scope leaves out VS-25b's impact until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(UNAPPLIED_REVIEW_KEYS).toContain("impact")
    for (const impact of ["graph", "grep", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, impact })).toBe(base)
    const graph: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, impact: "graph" }
    expect(evidenceScope({ adapter: "engine", config: graph })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "engine", config: graph }).prompts).toBe(promptsDigest())
    expect(policyDigest({ ...graph, nits: true })).not.toBe(policyDigest(graph))
  })

  // VS-27a: `guardrail` is a policy key (it selects what is posted) that no runner applies before VS-27c, so neither the
  // policy digest nor the prompts digest of a scope moves with it yet. Once a runner applies it, only "strict" counts, in
  // both.
  test("the scope leaves out VS-27's guardrail until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(EVIDENCE_POLICY_KEYS).toContain("guardrail")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("guardrail")
    for (const guardrail of ["strict", "off", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, guardrail })).toBe(base)
    const strict: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" }
    expect(evidenceScope({ adapter: "engine", config: strict })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "desktop", config: { ...strict, impact: "graph" } })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    expect(policyDigest({ ...strict, nits: true })).not.toBe(policyDigest(strict))
  })

  // VS-42a: `scopeGate` is a policy key (S9 drops what would be posted) that no runner applies before VS-42 wiring, so
  // neither the policy digest nor the prompts digest of a scope moves with it yet. Once a runner applies it and the
  // guardrail, the prompts digest counts it only as "introduced" under "strict", and the policy digest only under
  // "strict" (dormant now; VS-42 wiring's test shows `guardrail: "off"` with "introduced" equals the default).
  test("the scope leaves out VS-42's scopeGate until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(EVIDENCE_POLICY_KEYS).toContain("scopeGate")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("scopeGate")
    for (const scopeGate of ["introduced", "off", undefined] as const)
      for (const guardrail of ["strict", "off", undefined] as const)
        expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, guardrail, scopeGate })).toBe(base)
    const gated: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict", scopeGate: "introduced" }
    expect(evidenceScope({ adapter: "engine", config: gated })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "desktop", config: { ...gated, impact: "graph" } })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    expect(policyDigest({ ...gated, nits: true })).not.toBe(policyDigest(gated))
  })

  // VS-44a: `verifyEvidence` is a policy key (S1's certificate check drops what would be posted) that no runner applies
  // before VS-44 wiring, so neither the policy digest nor the prompts digest of a scope moves with it yet. Once a runner
  // applies it and the guardrail, the prompts digest counts it only as "certificate" under "strict", and the policy
  // digest only under "strict" (dormant now; VS-44 wiring's test shows `guardrail: "off"` with "certificate" equals the
  // default).
  test("the scope leaves out VS-44's verifyEvidence until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(EVIDENCE_POLICY_KEYS).toContain("verifyEvidence")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("verifyEvidence")
    for (const verifyEvidence of ["certificate", "off", undefined] as const)
      for (const guardrail of ["strict", "off", undefined] as const)
        expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, guardrail, verifyEvidence })).toBe(base)
    const cert: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict", verifyEvidence: "certificate" }
    expect(evidenceScope({ adapter: "engine", config: cert })).toEqual(SCOPE)
    expect(
      evidenceScope({ adapter: "desktop", config: { ...cert, scopeGate: "introduced", impact: "graph" } }),
    ).toEqual(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }))
    expect(policyDigest({ ...cert, nits: true })).not.toBe(policyDigest(cert))
  })

  // VS-28c: `depth` and `lenses` are policy keys (they choose which passes look for defects) that no runner applies
  // before VS-28 wiring, so neither the policy digest nor the prompts digest of a scope moves with them yet. Once a
  // runner applies both, the prompts digest counts the lens prompts only under the pair, and the policy digest counts
  // `lenses` only under `depth: "auto"` (dormant now; VS-28 wiring's test shows "fixed" with "high" equals the default).
  test("the scope leaves out VS-28's depth and lenses until a runner applies them", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    for (const key of ["depth", "lenses"] as const) {
      expect(EVIDENCE_POLICY_KEYS).toContain(key)
      expect(UNAPPLIED_REVIEW_KEYS).toContain(key)
    }
    for (const depth of ["auto", "fixed", undefined] as const)
      for (const lenses of ["high", "off", undefined] as const)
        expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, depth, lenses })).toBe(base)
    const lensed: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, depth: "auto", lenses: "high" }
    expect(evidenceScope({ adapter: "engine", config: lensed })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "engine", config: lensed }).prompts).toBe(promptsDigest())
    expect(evidenceScope({ adapter: "desktop", config: { ...lensed, impact: "graph", guardrail: "strict" } })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    expect(policyDigest({ ...lensed, nits: true })).not.toBe(policyDigest(lensed))
  })

  // VS-30c: `runtime` is a policy key (a runtime confirmation changes what is verified, and so what is posted) that no
  // runner applies before the VS-30 executor, so neither the policy digest nor the prompts digest of a scope moves with
  // it yet. Once the executor applies it, only "ask" counts, in both; whether the scope then records "ask" or the
  // evidence that actually ran is the executor's decision.
  test("the scope leaves out VS-30's runtime until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(base).toBe("70512122f41ec160")
    expect(EVIDENCE_POLICY_KEYS).toContain("runtime")
    expect(UNAPPLIED_REVIEW_KEYS).toContain("runtime")
    for (const runtime of ["ask", "off", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, runtime })).toBe(base)
    const ask: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, runtime: "ask" }
    expect(evidenceScope({ adapter: "engine", config: ask })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "engine", config: ask }).prompts).toBe(promptsDigest())
    expect(
      evidenceScope({
        adapter: "desktop",
        config: { ...ask, impact: "graph", guardrail: "strict", depth: "auto", lenses: "high" },
      }),
    ).toEqual(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }))
    expect(policyDigest({ ...ask, nits: true })).not.toBe(policyDigest(ask))
  })

  test("a route is in the scope only when the caller enforced it", () => {
    expect(Object.hasOwn(SCOPE, "route")).toBe(false)
    expect(evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG, route: "zdr" })).toEqual({
      ...SCOPE,
      route: "zdr",
    })
    // A config that asks for zdr does not make the scope claim a route nothing enforced.
    const asked: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, privacy: "zdr" }
    expect(evidenceScope({ adapter: "engine", config: asked })).toEqual(SCOPE)
  })
})

describe("certificates", () => {
  test("a complete certificate has no problems", () => {
    expect(certificateProblems(cert())).toEqual([])
    expect(
      certificateProblems(cert({ triage: "acme/cheap", variant: "high", adapters: ["engine", "desktop"] })),
    ).toEqual([])
  })

  test("refuses routers, missing evidence, an approval other than the owner's and a long or missing expiry", () => {
    expect(certificateProblems(cert({ model: "vector/openrouter/free" }))).toContain(
      "model is a router or preset, which may answer with another model, so it cannot be certified",
    )
    expect(certificateProblems(cert({ model: "sonnet" }))).toContain('model must be an exact "provider/model"')
    expect(certificateProblems(cert({ adapters: [] }))).toContain('adapters must list "engine" or "desktop", each once')
    expect(certificateProblems(cert({ prompts: "nope" }))).toContain("prompts must be a promptsDigest()")
    const evaluation = cert().evaluation
    expect(certificateProblems(cert({ evaluation: { ...evaluation, split: "development" } }))).toContain(
      "evaluation.split must be held-out",
    )
    expect(certificateProblems(cert({ evaluation: { ...evaluation, manifest: "draft" } }))).toContain(
      "evaluation.manifest must be the frozen manifest's sha256: digest",
    )
    expect(
      certificateProblems({
        ...cert(),
        approved: { by: "someone", date: "2026-12-02" },
      } as unknown as ModelCertificate),
    ).toContain("approved.by must be owner")
    expect(certificateProblems(cert({ approved: { by: "owner", date: "2026-11-30" } }))).toContain(
      "approved.date is before the results were collected",
    )
    expect(certificateProblems(cert({ expires: "2026-12-02" }))).toContain("expires must be after approved.date")
    expect(certificateProblems(cert({ expires: "2027-06-01" }))).toContain(
      `expires must be at most ${MAX_CERTIFICATE_DAYS} days after approved.date`,
    )
    expect(certificateProblems({ ...cert(), expires: undefined })).toContain("expires must be a YYYY-MM-DD date")
    expect(certificateProblems(cert({ expires: "2027-02-30" }))).toContain("expires must be a YYYY-MM-DD date")
    expect(certificateProblems("cert")).toEqual(["the certificate is not an object"])
    expect(certificateProblems(cert({ route: "zdr" }))).toEqual([])
    expect(certificateProblems({ ...cert(), route: "other" })).toContain('route must be "zdr" when set')
  })

  test("certify builds one only from a passing release decision on frozen labels with one scope", () => {
    const report = {
      split: "held-out",
      frozen: true,
      gate: { config: DEFAULT_GATE, digest: gateDigest(DEFAULT_GATE) },
      decision: {
        decision: "D2",
        candidate: { variant: "engine", model: SONNET },
        outcome: "pass" as const,
        rules: [],
        release: { eligible: true, reasons: [] },
      },
      problems: [],
    }
    const input = {
      id: "vs-2026-12-sonnet",
      report,
      reportDigest: `sha256:${"a".repeat(64)}`,
      manifest: `sha256:${"b".repeat(64)}`,
      collected: "2026-12-01",
      scopes: [SCOPE, SCOPE],
      approved: { by: "owner" as const, date: "2026-12-02" },
      expires: "2027-02-01",
    }
    expect(certify(input)).toEqual({ certificate: cert(), problems: [] })

    const failed = certify({ ...input, report: { ...report, decision: { ...report.decision, outcome: "review" } } })
    expect(failed.certificate).toBeUndefined()
    expect(failed.problems).toContain("the gate's outcome is review, not pass")
    const ineligible = certify({
      ...input,
      report: {
        ...report,
        decision: {
          ...report.decision,
          release: { eligible: false, reasons: ["the results are from the development split"] },
        },
      },
    })
    expect(ineligible.problems).toContain(
      "the report is not a release decision: the results are from the development split",
    )
    expect(certify({ ...input, report: { ...report, frozen: false } }).problems).toContain(
      "the manifest's held-out labels are not frozen",
    )
    expect(certify({ ...input, scopes: [SCOPE, { ...SCOPE, policy: "0".repeat(16) }] }).problems).toContain(
      "the candidate's runs were replayed under different pipelines, prompts, settings or triage models",
    )
    expect(certify({ ...input, scopes: [] }).problems).toContain("no replay scope was given for the candidate's runs")
    // A privacy route is its own reason, and a certificate from runs on one route names it.
    const zdr = { ...SCOPE, route: "zdr" as const }
    expect(certify({ ...input, scopes: [SCOPE, zdr] }).problems).toEqual([
      "the candidate's runs were replayed under different privacy routes",
    ])
    expect(certify({ ...input, scopes: [zdr, zdr] })).toEqual({ certificate: cert({ route: "zdr" }), problems: [] })
    expect(certify({ ...input, expires: "2027-12-01" }).certificate).toBeUndefined()
    const router = certify({
      ...input,
      report: {
        ...report,
        decision: { ...report.decision, candidate: { variant: "engine", model: "vector/openrouter/free" } },
      },
    })
    expect(router.certificate).toBeUndefined()
  })
})

describe("assessing a review's models", () => {
  test("an exact, current certificate in the same scope certifies, and certification says nothing", () => {
    const evidence = assess(chosen(SONNET))
    expect(evidence.models[0]).toMatchObject({ status: "certified", certificate: "vs-2026-12-sonnet" })
    expect(modelEvidenceNotes(evidence)).toEqual([])
  })

  test("unvetted: no certificate for the model; the note keeps the chosen model and says why it ran", () => {
    const evidence = assess(chosen("openai/gpt-5.5"))
    expect(evidence.models[0]!.status).toBe("unvetted")
    expect(modelEvidenceNotes(evidence)).toEqual([
      "`openai/gpt-5.5` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Vector used it because --model names it, and does not switch a chosen model.",
    ])
    // A default the review fell back to says so; a surface that already names the model can leave the reason out.
    const fallback = assess(chosen("openai/gpt-5.5", { choice: { explicit: false, setting: "your default model" } }))
    expect(modelEvidenceNotes(fallback)[0]).toEndWith("No review model is set, so Vector used your default model.")
    expect(modelEvidenceNotes(fallback, { choice: false })).toEqual([
      "`openai/gpt-5.5` has no VectorScope evaluation on record, so how well it reviews is unmeasured.",
    ])
    // A surface that cannot say "no review model is set" says what was left unset instead.
    const agent = assess(
      chosen("openai/gpt-5.5", {
        choice: { explicit: false, setting: "your agent's model", unset: "no model is set in .vector/review.json" },
      }),
    )
    expect(modelEvidenceNotes(agent)[0]).toEndWith(
      "No model is set in .vector/review.json, so Vector used your agent's model.",
    )
  })

  test("expired and stale certificates no longer apply, and say why", () => {
    const expired = assess(chosen(SONNET), { now: Date.parse("2027-02-01T00:00:00Z") })
    expect(expired.models[0]).toMatchObject({ status: "expired", expires: "2027-02-01" })
    expect(modelEvidenceNotes(expired)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) expired on 2027-02-01 and no longer applies.",
    )

    const desktop = assess(chosen(SONNET), { scope: { ...SCOPE, adapter: "desktop" } })
    expect(desktop.models[0]).toMatchObject({ status: "stale", changed: ["adapter"] })
    const settings = assess(chosen(SONNET), {
      scope: evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, verify: "all" } }),
    })
    expect(settings.models[0]!.changed).toEqual(["policy"])
    const pipeline = assess(chosen(SONNET), {
      scope: { ...SCOPE, pipeline: SCOPE.pipeline + 1, prompts: "f".repeat(16) },
    })
    expect(pipeline.models[0]!.changed).toEqual(["pipeline", "prompts"])
    expect(modelEvidenceNotes(pipeline)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) was made with an earlier review pipeline and other review prompts, so it does not apply here.",
    )
    const triaged = assess(chosen(SONNET), {
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage: chosen("acme/cheap"),
    })
    expect(triaged.models.map((entry) => [entry.role, entry.status])).toEqual([
      ["review", "stale"],
      ["triage", "unvetted"],
    ])
    expect(triaged.models[0]!.changed).toEqual(["triage"])
    const variant = assess(chosen(SONNET, { variant: "high" }))
    expect(variant.models[0]!.changed).toEqual(["variant"])
    // A certificate made on zero data retention routes covers only reviews on them, and the other way round.
    const zdr = { ...SCOPE, route: "zdr" as const }
    const route = assess(chosen(SONNET), { certificates: [cert({ route: "zdr" })] })
    expect(route.models[0]).toMatchObject({ status: "stale", changed: ["route"] })
    expect(modelEvidenceNotes(route)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) was made with another privacy setting, so it does not apply here.",
    )
    expect(assess(chosen(SONNET), { scope: zdr }).models[0]).toMatchObject({ status: "stale", changed: ["route"] })
    expect(assess(chosen(SONNET), { scope: zdr, certificates: [cert({ route: "zdr" })] }).models[0]!.status).toBe(
      "certified",
    )

    // The closest certificate is the one reported: here the current one, which certifies.
    const both = assess(chosen(SONNET), {
      certificates: [cert({ id: "old", expires: "2026-12-31", approved: { by: "owner", date: "2026-12-02" } }), cert()],
    })
    expect(both.models[0]).toMatchObject({ status: "certified", certificate: "vs-2026-12-sonnet" })
  })

  test("a malformed certificate never certifies", () => {
    const evidence = assess(chosen(SONNET), { certificates: [cert({ expires: "2027-09-01" })] })
    expect(evidence.models[0]!.status).toBe("unvetted")
  })

  test("retired: the provider retired the model, whatever the certificates say", () => {
    const evidence = assess(chosen(SONNET, { status: "deprecated" }))
    expect(evidence.models[0]!.status).toBe("retired")
    expect(modelEvidenceNotes(evidence)).toEqual([
      "`anthropic/claude-sonnet-4-5` is retired by its provider, so no evaluation applies to it. Choose a current model. Vector used it because --model names it, and does not switch a chosen model.",
    ])
  })

  test("rerouted: routers and presets, another route to a certified model, and replies from models not chosen", () => {
    expect(routedModel("vector/openrouter/free")).toBe(true)
    expect(routedModel("openrouter/openrouter/auto")).toBe(true)
    expect(routedModel("openrouter/@preset/reviews")).toBe(true)
    expect(routedModel("openrouter/anthropic/claude-sonnet-4.5")).toBe(false)
    expect(routedModel(SONNET)).toBe(false)

    const router = assess(chosen("vector/openrouter/free", { free: true }))
    expect(router.models[0]).toMatchObject({ status: "rerouted", rerouted: "router" })
    expect(modelEvidenceNotes(router)[0]).toStartWith(
      "`vector/openrouter/free` is a router: each request may be answered by a different model, so no evaluation applies to it.",
    )

    const route = assess(chosen("openrouter/anthropic/claude-sonnet-4.5"))
    expect(route.models[0]).toMatchObject({ status: "rerouted", rerouted: "route", evaluated: SONNET })
    expect(modelEvidenceNotes(route)[0]).toStartWith(
      "`openrouter/anthropic/claude-sonnet-4.5` has no VectorScope evaluation of its own. The one on record (`vs-2026-12-sonnet`) is of `anthropic/claude-sonnet-4-5`, which may be the same model through another provider or route, and does not cover `openrouter/anthropic/claude-sonnet-4.5`.",
    )

    const served = assess(chosen(SONNET), { served: [SONNET, "acme/other", "acme/other"] })
    expect(served.unexpected).toEqual(["acme/other"])
    expect(served.models[0]).toMatchObject({ status: "rerouted", rerouted: "served" })
    expect(modelEvidenceNotes(served)).toEqual([
      "Replies in this review came from `acme/other`, which it did not choose, so the VectorScope evaluation of `anthropic/claude-sonnet-4-5` does not cover them.",
    ])
    const unvetted = assess(chosen("openai/gpt-5.5"), { served: ["openai/gpt-5.5", "acme/other"] })
    expect(unvetted.models[0]!.status).toBe("unvetted")
    expect(modelEvidenceNotes(unvetted).at(-1)).toBe(
      "Replies in this review came from `acme/other`, which it did not choose.",
    )
  })

  test("private code: a free model that may train is said so; free or no-training is never evidence of quality", () => {
    const trainer = assess(
      chosen("vector/acme/coder:free", { free: true, freeModel: { source: "shared", dataPolicy: "may-train" } }),
    )
    expect(trainer.models[0]).toMatchObject({ status: "unvetted", mayTrain: true })
    expect(modelEvidenceNotes(trainer)).toEqual([
      `\`vector/acme/coder:free\` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. \`vector/acme/coder:free\` is labelled "${FREE_MODEL_TRAINING_LABEL}": its provider may log the code it is sent and use it to train models. Don't use it for private code. Vector used it because --model names it, and does not switch a chosen model.`,
    ])
    // A policy Vector has not reviewed counts as may-train, as everywhere else.
    expect(
      assess(chosen("vector/acme/new:free", { free: true, freeModel: { source: "shared", dataPolicy: "unreviewed" } }))
        .models[0]!.mayTrain,
    ).toBe(true)

    const safe = assess(
      chosen("vector/acme/coder:free", {
        free: true,
        freeModel: { source: "shared", dataPolicy: "no-training" },
        choice: { explicit: false, setting: 'an available free model not labelled "May train on your prompts"' },
      }),
    )
    expect(safe.models[0]).toMatchObject({ status: "unvetted", mayTrain: false })
    expect(modelEvidenceNotes(safe)).toEqual([
      '`vector/acme/coder:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free, and from a provider that does not train on prompts, is not evidence of review quality. No review model is set, so Vector used an available free model not labelled "May train on your prompts".',
    ])

    // A free model without Vector's reviewed record is only free: no label, and no claim that it does not train.
    const unrecorded = assess(chosen("openrouter/acme/coder:free", { free: true }))
    expect(unrecorded.models[0]).toMatchObject({ status: "unvetted", mayTrain: false })
    expect(modelEvidenceNotes(unrecorded)).toEqual([
      "`openrouter/acme/coder:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. Vector used it because --model names it, and does not switch a chosen model.",
    ])

    // A certified model is still flagged when its provider may train on the code.
    const certified = assess(chosen(SONNET, { free: true, freeModel: { source: "shared", dataPolicy: "may-train" } }))
    expect(certified.models[0]!.status).toBe("certified")
    expect(modelEvidenceNotes(certified)[0]).toStartWith(`\`${SONNET}\` is labelled "${FREE_MODEL_TRAINING_LABEL}"`)
  })

  test("a triage model is covered by its pipeline's certificate and speaks only when retired, routed or may train", () => {
    const triage = chosen("acme/cheap", { choice: { explicit: true, setting: "triageModel in .vector/review.json" } })
    const covered = assess(chosen(SONNET), {
      certificates: [cert({ triage: "acme/cheap" })],
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage,
    })
    expect(covered.models.map((entry) => entry.status)).toEqual(["certified", "certified"])
    expect(modelEvidenceNotes(covered)).toEqual([])

    const retired = assess(chosen(SONNET), {
      certificates: [cert({ triage: "acme/cheap" })],
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage: { ...triage, status: "deprecated" },
    })
    expect(retired.models.map((entry) => entry.status)).toEqual(["certified", "retired"])
    expect(modelEvidenceNotes(retired)).toEqual([
      "`acme/cheap` is retired by its provider, so no evaluation applies to it. Choose a current model. Vector used it because triageModel in .vector/review.json names it, and does not switch a chosen model.",
    ])
  })
})
