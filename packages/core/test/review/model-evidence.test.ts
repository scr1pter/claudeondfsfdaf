import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { FREE_MODEL_TRAINING_LABEL } from "@vectordevai/core/free-model-choice"
import { DEFAULT_GATE, gateDigest } from "@vectordevai/core/review/eval-report"
import { parseReviewConfig } from "@vectordevai/core/review/config"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import { INPUT_REDACTION } from "@vectordevai/core/review/prompt"
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
// changes to the review pin. The slice's shared readers, BrainCode and BrainGraph, and its changed-symbol fallback
// determine which related code the engine sends under impact: "graph". The strict runner and private blob reader
// determine what evidence reaches the guardrail. Its shared rule pass also drives report.ts's offline re-selection.
// Each contributes to the pin. So does the rule citation check (VS-43a's citation.ts), pinned from the
// day it lands, as guardrail.ts is: it will decide what a review drops or strips. So is the change-risk band (VS-28c's
// risk.ts), pinned from the day it lands: once wired it decides which passes run under `depth: "auto"`. So is the
// runtime evidence contract (VS-30c's runtime.ts), pinned from the day it lands: once the VS-30 executor runs it,
// runtimeVerdict decides which findings are verified at runtime. So are guarded team memory's rules (VS-35a's team.ts),
// pinned from the day they land: once wired they decide which findings select.ts demotes and which dismissals become
// team memory. The batch planner, size skip and cursor validation now determine when a large change is
// reviewed and which files can retain coverage. Pin their contracts and the durable ReviewState reader.
// Pin the checkpoint writer fence too: a stale publisher must not displace durable batch coverage/accounting.
// verdict.ts and format.ts are left out: completeness decides wording and the verdict, not what a review finds or posts.
// The CLI apply step (cli/cmd/review.fix.ts, VS-12c) runs after selection. The shared executor (review/fix.ts)
// is pinned from SF-33 because it launches consented diagnostic evidence adapters. The owner fix API adapter (engine
// review/fix-owner.ts, VS-12d) and its wire schema (schema review-fix.ts) remain output-only. The review routes and
// owner files they extend stay pinned. So are the fix planner the CLI step shares with the desktop (core
// review/fix-plan.ts) and the desktop's fix adapter (app features/vectorscope/local-fix*.ts), for the same reason.
// The route rules' admission (VS-23b's engine review/route.ts) is pinned from the day it lands: it decides which models
// a review may send code to, and with privacy "zdr" whether it runs at all. The review sessions' permission rules (core
// review/permission.ts) are pinned from SF-14: they hold the credential files the reviewer's read tool may not open
// under holdback "secrets" (CREDENTIAL_FILES, which holdback.ts holds back from the prompt too), and so decide what a
// review may read.
// The first-request budget can stop a review before it creates a session. Pin its preparation inputs too: the
// cached model and hooks, the available tool definitions, the Brain context, and the GitHub handler that supplies
// the remaining spend and decides whether a stopped head is eligible for another review.
const REVIEW_PIPELINE_FILES = [
  "packages/engine/src/connect/hub.ts",
  "packages/engine/src/connect/adapters/vectorscope.ts",
  "packages/core/src/connect/policy.ts",
  "packages/engine/src/review/run.ts",
  "packages/engine/src/review/batch.ts",
  "packages/engine/src/review/batch-local.ts",
  "packages/core/src/review/checkpoint-lock.ts",
  "packages/engine/src/review/checks.ts",
  "packages/engine/src/review/diagnostic-adapter.ts",
  "packages/engine/src/review/fix.ts",
  "packages/engine/src/review/trivial.ts",
  "packages/engine/src/review/card-access.ts",
  "packages/engine/src/review/card-sources.ts",
  "packages/engine/src/review/context.ts",
  "packages/engine/src/review/eval.ts",
  "packages/engine/src/review/private-snapshot.ts",
  "packages/engine/src/review/strict-blobs.ts",
  "packages/engine/src/review/strict.ts",
  "packages/engine/src/review/read-authority.ts",
  "packages/engine/src/review/mcp.ts",
  "packages/engine/src/review/mcp-snapshot.ts",
  "packages/engine/src/review/service.ts",
  "packages/engine/src/review/git.ts",
  "packages/core/src/read-only-git.ts",
  "packages/engine/src/review/local-admission.ts",
  "packages/engine/src/review/local-run.ts",
  "packages/engine/src/review/lifecycle.ts",
  "packages/engine/src/session/session.ts",
  "packages/engine/src/session/posting.ts",
  "packages/core/src/session/audience.ts",
  "packages/core/src/public-session-share.ts",
  "packages/core/src/share/archive.ts",
  "packages/engine/src/server/routes/instance/httpapi/groups/session.ts",
  "packages/engine/src/server/routes/instance/httpapi/handlers/session.ts",
  "packages/engine/src/server/routes/instance/httpapi/handlers/session-errors.ts",
  "packages/core/src/review/request-store.ts",
  "packages/core/src/review/request.sql.ts",
  "packages/engine/src/review/owner.ts",
  "packages/engine/src/server/routes/instance/httpapi/groups/review.ts",
  "packages/engine/src/server/routes/instance/httpapi/handlers/review.ts",
  "packages/engine/src/server/routes/instance/httpapi/middleware/workspace-routing.ts",
  "packages/server/src/auth.ts",
  "packages/schema/src/review-run.ts",
  "packages/core/src/review/local-result.ts",
  "packages/engine/src/cli/cmd/review.ts",
  "packages/engine/src/cli/cmd/github.review.ts",
  "packages/engine/src/session/tools.ts",
  "packages/engine/src/session/prompt.ts",
  "packages/engine/src/session/system.ts",
  "packages/engine/src/agent/agent.ts",
  "packages/engine/src/review/model.ts",
  "packages/engine/src/review/author.ts",
  "packages/engine/src/review/route.ts",
  "packages/engine/src/config/agent.ts",
  "packages/engine/src/session/processor.ts",
  "packages/engine/src/session/admission.ts",
  "packages/engine/src/session/llm.ts",
  "packages/engine/src/session/llm/request.ts",
  "packages/engine/src/session/review-request-size.ts",
  "packages/engine/src/effect/instance-state.ts",
  "packages/engine/src/provider/provider.ts",
  "packages/engine/src/plugin/index.ts",
  "packages/engine/src/command/index.ts",
  "packages/engine/src/mcp/index.ts",
  "packages/engine/src/mcp/catalog.ts",
  "packages/engine/src/mcp/sdk.ts",
  "packages/engine/src/tool/registry.ts",
  "packages/engine/src/tool/task.ts",
  "packages/core/src/brain/brain.ts",
  "packages/core/src/brain/knowledge.ts",
  "packages/engine/src/tool/grep.ts",
  "packages/engine/src/tool/glob.ts",
  "packages/engine/src/tool/read.ts",
  "packages/engine/src/tool/external-directory.ts",
  "packages/app/src/features/pull-requests/ai-review.ts",
  "packages/core/src/review/plan.ts",
  "packages/core/src/review/skip.ts",
  "packages/core/src/review/state.ts",
  "packages/core/src/review/types.ts",
  "packages/core/src/review/pack.ts",
  "packages/core/src/review/select.ts",
  "packages/core/src/review/diff.ts",
  "packages/core/src/review/fingerprint.ts",
  "packages/core/src/review/prompt.ts",
  "packages/core/src/review/privacy.ts",
  "packages/core/src/review/holdback.ts",
  "packages/core/src/review/diagnostic.ts",
  "packages/core/src/review/permission.ts",
  "packages/core/src/review/trivial.ts",
  "packages/core/src/review/dispatch.ts",
  "packages/core/src/review/risk.ts",
  "packages/core/src/review/guardrail.ts",
  "packages/core/src/review/citation.ts",
  "packages/core/src/review/config.ts",
  "packages/core/src/v1/config/review.ts",
  "packages/core/src/review/schema.ts",
  "packages/core/src/review/runtime.ts",
  "packages/core/src/review/team.ts",
  "packages/engine/src/review/parse.ts",
  "packages/core/src/brain/code.ts",
  "packages/core/src/brain/graph.ts",
  "packages/core/src/review/symbols.ts",
  "packages/core/src/review/impact.ts",
  "packages/engine/src/review/impact.ts",
  "packages/engine/src/review/depth.ts",
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

  // Strict task text and the strict schemas enter the engine evidence digest together under the guardrail.
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
    // The default is stable. The strict task text changes only the strict evidence digests.
    expect(canonicalPrompts({ guardrail: "strict" }).join("\n")).toContain("five failure classes")
    expect(canonicalPrompts().join("\n")).not.toContain("five failure classes")
    expect(strict).toBe("3d07943f9c1aeb14")
    expect(both).toBe("c0fc3483470e13a6")
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
    const scopePrompts = canonicalPrompts({ guardrail: "strict", scopeGate: "introduced" })
    expect(scopePrompts.join("\n")).toContain("Claimed scope: introduced")
    expect(canonicalPrompts({ guardrail: "strict" }).join("\n")).not.toContain("Claimed scope:")
    expect(new Set([promptsDigest(), promptsDigest({ impact: "graph" }), strict, both, gated, gatedGraph]).size).toBe(6)
    // VS-42a held every earlier digest, and printed these (built at d268025c). VS-42 wiring moves them on purpose when
    // the report schema's `scope` field and the prompt clause join under the key.
    expect(strict).toBe("3d07943f9c1aeb14")
    expect(both).toBe("c0fc3483470e13a6")
    expect(gated).toBe("7f163aa259a0af52")
    expect(gatedGraph).toBe("0ded12711f48abb0")
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
    expect(strict).toBe("3d07943f9c1aeb14")
    expect(both).toBe("c0fc3483470e13a6")
    expect(gated).toBe("7f163aa259a0af52")
    expect(cert).toBe("162314cd774bdba0")
    expect(certGraph).toBe("9c058cf4aa603afa")
    expect(certGated).toBe("9a1d91fa6585f7c4")
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
    expect(promptsDigest({ guardrail: "strict" })).toBe("3d07943f9c1aeb14")
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced" })).toBe("7f163aa259a0af52")
    expect(promptsDigest({ guardrail: "strict", verifyEvidence: "certificate" })).toBe("162314cd774bdba0")
    expect(lenses).toBe("dd09332295a99649")
    expect(lensesGraph).toBe("31c1a0612c0f9541")
    expect(lensesStrict).toBe("d59056aebc5ae9b6")
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
    expect(promptsDigest({ guardrail: "strict" })).toBe("3d07943f9c1aeb14")
    expect(promptsDigest({ impact: "graph", guardrail: "strict" })).toBe("c0fc3483470e13a6")
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced" })).toBe("7f163aa259a0af52")
    expect(promptsDigest({ impact: "graph", guardrail: "strict", scopeGate: "introduced" })).toBe("0ded12711f48abb0")
    expect(promptsDigest({ guardrail: "strict", verifyEvidence: "certificate" })).toBe("162314cd774bdba0")
    expect(promptsDigest({ impact: "graph", guardrail: "strict", verifyEvidence: "certificate" })).toBe(
      "9c058cf4aa603afa",
    )
    expect(promptsDigest({ guardrail: "strict", scopeGate: "introduced", verifyEvidence: "certificate" })).toBe(
      "9a1d91fa6585f7c4",
    )
    expect(promptsDigest({ depth: "auto", lenses: "high" })).toBe("dd09332295a99649")
    expect(promptsDigest({ impact: "graph", depth: "auto", lenses: "high" })).toBe("31c1a0612c0f9541")
    expect(promptsDigest({ guardrail: "strict", depth: "auto", lenses: "high" })).toBe("d59056aebc5ae9b6")
    expect(runtime).toBe("7d9147298f5cdbaf")
    expect(runtimeGraph).toBe("3bf0c1afc17e08d9")
    expect(runtimeStrict).toBe("25d3e23719ca7204")
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
      { depth: "auto" as const },
      { depth: "auto" as const, lenses: "high" as const },
      // VS-34's holdback, which Review.run applies since SF-13b, counts as "secrets".
      { holdback: "secrets" as const },
      { impact: "graph" as const },
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
      // VS-24's token cap is a budget; the explicit default for the trivial gate has no policy effect.
      { maxInputTokens: 200_000 },
      { trivial: "review" as const },
      // The explicit default for impact is the existing grep context.
      { impact: "grep" as const },
      { guardrail: "off" as const },
      // Nor VS-42's scopeGate, with or without strict.
      { scopeGate: "off" as const },
      { scopeGate: "introduced" as const },
      // Nor VS-44's verifyEvidence, with or without strict.
      { verifyEvidence: "off" as const },
      { verifyEvidence: "certificate" as const },
      // Fixed depth and unapplied lens settings preserve the legacy policy.
      { depth: "fixed" as const },
      { lenses: "high" as const },
      // Nor VS-30's runtime, which no runner applies before the VS-30 executor.
      { runtime: "off" as const },
      { runtime: "ask" as const },
      // VS-34's holdback "off" is its default, which never counts.
      { holdback: "off" as const },
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).toBe(base)
  })

  test("only the engine's opt-in trivial skip changes its evidence policy; the default and desktop remain stable", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(base).toBe("70512122f41ec160")
    expect(EVIDENCE_POLICY_KEYS).toContain("trivial")
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("trivial")).toBe(false)
    for (const trivial of ["review", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, trivial })).toBe(base)
    const skip: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, trivial: "skip" }
    expect(policyDigest(skip)).not.toBe(base)
    expect(evidenceScope({ adapter: "engine", config: skip })).toEqual({ ...SCOPE, policy: policyDigest(skip) })
    expect(evidenceScope({ adapter: "desktop", config: skip })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    // Every other key keeps its digest behaviour: a changed value still moves it, with trivial set or not.
    expect(policyDigest({ ...skip, maxComments: 3 })).not.toBe(policyDigest(skip))
    expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, maxSteps: 31 })).not.toBe(base)
  })

  test("SF-26 evidence counts cards on the local engine and covers combined pass prompts", () => {
    const cards = { cards: "brain" as const }
    const depth = { depth: "auto" as const, lenses: "high" as const }
    const graph = { impact: "graph" as const }
    const held = { holdback: "secrets" as const }
    const strict = {
      guardrail: "strict" as const,
      scopeGate: "introduced" as const,
      verifyEvidence: "certificate" as const,
    }
    const scope = (adapter: "engine" | "desktop", overrides: Partial<ReviewConfig>) =>
      evidenceScope({ adapter, config: { ...DEFAULT_REVIEW_CONFIG, ...overrides } })
    expect(canonicalPrompts({ cards: "off" })).toEqual(canonicalPrompts())
    expect(promptsDigest({ cards: "off" })).toBe("5d59e9ee06077c23")
    expect(scope("engine", { cards: "off" })).toEqual(SCOPE)
    expect(scope("desktop", cards)).toEqual(scope("desktop", {}))
    for (const extra of [{}, graph, depth, held, strict, { ...graph, ...depth, ...held, ...strict }]) {
      const activated = { ...extra, ...cards }
      const engine = scope("engine", activated)
      expect(engine.prompts).toBe(promptsDigest(activated))
      expect(engine.policy).toBe(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...activated }))
      expect(engine.policy).not.toBe(scope("engine", extra).policy)
      expect(engine.prompts).not.toBe(scope("engine", extra).prompts)
      expect(scope("desktop", activated)).toEqual(scope("desktop", extra))
    }
    const shown = (keys: Parameters<typeof canonicalPrompts>[0]) =>
      canonicalPrompts(keys).filter((prompt) => prompt.includes("<untrusted_context_cards>"))
    expect(shown({})).toEqual([])
    expect(shown(cards)).toHaveLength(4)
    const combined = shown({ ...cards, ...graph, ...depth, ...held })
    expect(combined).toHaveLength(36)
    expect(combined.every((text) => text.includes(INPUT_REDACTION))).toBe(true)
    for (const lens of ["concurrency", "resource", "access", "data-integrity"]) {
      expect(
        combined.some(
          (text) => text.includes("Vector's " + lens + " reviewer.") && text.includes("<untrusted_impact>"),
        ),
      ).toBe(true)
    }
    expect(promptsDigest(cards)).toBe("33640ce9df53572f")
    expect(promptsDigest({ ...cards, ...depth })).toBe("5afccaf054dc13d1")
    expect(promptsDigest({ ...cards, ...graph, ...depth, ...held, ...strict })).toBe("d3b656ce92a51856")
  })

  test("size-skip keeps the default scope and batch coverage changes only the engine policy", () => {
    const standard = parseReviewConfig({})
    const skip = parseReviewConfig({ json: '{"largeChanges":"skip"}' })
    const batch = parseReviewConfig({ json: '{"largeChanges":"batch"}' })
    expect(skip).toEqual(standard)
    expect(batch.config.largeChanges).toBe("batch")
    for (const adapter of ["engine", "desktop"] as const) {
      const baseline = evidenceScope({ adapter, config: standard.config })
      expect(evidenceScope({ adapter, config: { ...skip.config, largeChanges: "skip" } })).toEqual(baseline)
      const configured = evidenceScope({ adapter, config: batch.config })
      if (adapter === "desktop") expect(configured).toEqual(baseline)
      else {
        expect(configured.policy).not.toBe(baseline.policy)
        expect(configured.prompts).toBe(baseline.prompts)
      }
    }
  })

  test("the applied input-token budget keeps existing evidence scopes and their policy digest", () => {
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("maxInputTokens")).toBe(false)
    for (const adapter of ["engine", "desktop"] as const)
      for (const maxInputTokens of [0, 1, 200_000]) {
        const config: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, maxInputTokens }
        expect(evidenceScope({ adapter, config })).toEqual(evidenceScope({ adapter, config: DEFAULT_REVIEW_CONFIG }))
      }
  })

  test("only the engine's graph review has impact evidence", () => {
    expect(EVIDENCE_POLICY_KEYS).toContain("impact")
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("impact")).toBe(false)
    for (const impact of ["grep", undefined] as const)
      expect(evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, impact } })).toEqual(SCOPE)

    const graph: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, impact: "graph" }
    expect(policyDigest(graph)).not.toBe(SCOPE.policy)
    expect(evidenceScope({ adapter: "engine", config: graph })).toEqual({
      ...SCOPE,
      policy: policyDigest(graph),
      prompts: promptsDigest({ impact: "graph" }),
    })
    const desktop = evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG })
    for (const trivial of ["skip", "review", undefined] as const)
      expect(evidenceScope({ adapter: "desktop", config: { ...graph, trivial } })).toEqual(desktop)
    const held: ReviewConfig = { ...graph, holdback: "secrets" }
    expect(evidenceScope({ adapter: "desktop", config: held })).toEqual(
      evidenceScope({ adapter: "desktop", config: { ...held, impact: "grep" } }),
    )
    expect(evidenceScope({ adapter: "engine", config: held }).prompts).toBe(
      promptsDigest({ impact: "graph", holdback: "secrets" }),
    )
  })

  test("the engine's strict evidence follows its enforced policy and includes the strict task", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("guardrail")).toBe(false)
    for (const guardrail of ["off", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, guardrail })).toBe(base)
    const strict: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" }
    const scope = evidenceScope({ adapter: "engine", config: strict })
    expect(scope.prompts).toBe(promptsDigest({ guardrail: "strict" }))
    expect(scope.policy).not.toBe(base)
    expect(scope.policy).toBe(
      policyDigest({
        ...strict,
        verifyPolicy: "shared",
        verify: "all",
        nits: false,
        minSeverity: "blocking",
      }),
    )
    expect(policyDigest({ ...strict, nits: true })).toBe(scope.policy)
    expect(policyDigest({ ...strict, maxComments: 3 })).not.toBe(scope.policy)
    expect(evidenceScope({ adapter: "desktop", config: { ...strict, impact: "graph" } })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
  })

  test("the introduced-by-change prompt and policy affect only strict engine evidence", () => {
    const strict: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" }
    const gated: ReviewConfig = { ...strict, scopeGate: "introduced" }
    const plain = evidenceScope({ adapter: "engine", config: strict })
    const applied = evidenceScope({ adapter: "engine", config: gated })
    expect(applied.policy).not.toBe(plain.policy)
    expect(applied.prompts).not.toBe(plain.prompts)
    expect(applied.prompts).toBe(promptsDigest(gated))
    expect(evidenceScope({ adapter: "engine", config: { ...strict, scopeGate: "off" } })).toEqual(plain)
    for (const guardrail of ["off", undefined] as const)
      expect(policyDigest({ ...gated, guardrail })).toBe(policyDigest(DEFAULT_REVIEW_CONFIG))
    expect(evidenceScope({ adapter: "desktop", config: gated })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    expect(policyDigest({ ...gated, maxComments: 3 })).not.toBe(applied.policy)
  })

  test("only a strict engine review records certificate verification in its evidence", () => {
    const strict: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, guardrail: "strict" }
    const cert: ReviewConfig = { ...strict, verifyEvidence: "certificate" }
    const scope = (config: ReviewConfig) => evidenceScope({ adapter: "engine", config })
    expect(EVIDENCE_POLICY_KEYS).toContain("verifyEvidence")
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("verifyEvidence")).toBe(false)
    expect(scope({ ...cert, guardrail: "off" })).toEqual(SCOPE)
    expect(scope({ ...strict, verifyEvidence: "off" })).toEqual(scope(strict))
    expect(scope(cert).prompts).toBe(promptsDigest(cert))
    expect(scope(cert).prompts).not.toBe(scope(strict).prompts)
    expect(scope(cert).policy).not.toBe(scope(strict).policy)
    const combined: ReviewConfig = { ...cert, scopeGate: "introduced", ruleCheck: "strict" }
    expect(scope(combined).prompts).toBe(promptsDigest(combined))
    for (const change of [{ ruleCheck: "off" }, { scopeGate: "off" }, { verifyEvidence: "off" }] as const) {
      const partial = scope({ ...combined, ...change })
      expect(partial.prompts).not.toBe(scope(combined).prompts)
      expect(partial.policy).not.toBe(scope(combined).policy)
    }
    expect(evidenceScope({ adapter: "desktop", config: combined })).toEqual(
      evidenceScope({ adapter: "desktop", config: { ...DEFAULT_REVIEW_CONFIG, ruleCheck: "strict" } }),
    )
  })

  test("automatic depth changes engine policy scope; fixed depth and the desktop keep their existing evidence", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    const auto = policyDigest({ ...DEFAULT_REVIEW_CONFIG, depth: "auto" })
    expect(auto).not.toBe(base)
    const active = { depth: "auto", lenses: "high" } as const
    const high = policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...active })
    expect(high).not.toBe(auto)
    expect(promptsDigest(active)).not.toBe(SCOPE.prompts)
    for (const key of ["depth", "lenses"] as const) {
      expect(EVIDENCE_POLICY_KEYS).toContain(key)
      expect(UNAPPLIED_REVIEW_KEYS).not.toContain(key)
    }
    for (const depth of ["auto", "fixed", undefined] as const) {
      for (const lenses of ["high", "off", undefined] as const) {
        const config = { ...DEFAULT_REVIEW_CONFIG, depth, lenses }
        const planned = depth === "auto" && lenses === "high"
        const policy = planned ? high : depth === "auto" ? auto : base
        expect(policyDigest(config)).toBe(policy)
        expect(evidenceScope({ adapter: "engine", config })).toEqual({
          ...SCOPE,
          policy,
          prompts: planned ? promptsDigest(active) : SCOPE.prompts,
        })
        expect(evidenceScope({ adapter: "desktop", config })).toEqual(
          evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
        )
      }
    }
    const strict = {
      guardrail: "strict",
      ruleCheck: "strict",
      scopeGate: "introduced",
      verifyEvidence: "certificate",
    } as const
    const combined = { ...DEFAULT_REVIEW_CONFIG, ...active, ...strict }
    expect(evidenceScope({ adapter: "engine", config: combined }).prompts).toBe(promptsDigest({ ...strict, ...active }))
    expect(promptsDigest({ ...strict, ...active })).not.toBe(promptsDigest(strict))
    expect(evidenceScope({ adapter: "desktop", config: combined })).toEqual(
      evidenceScope({ adapter: "desktop", config: { ...DEFAULT_REVIEW_CONFIG, ...strict } }),
    )
    expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, depth: "auto", nits: true })).not.toBe(auto)
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

  // VS-34: `holdback` is a policy key (a held-back file is not reviewed, and redacted values change what the model
  // reads). Review.run applies its payload half since SF-13b, so it left UNAPPLIED_REVIEW_KEYS: the policy digest counts
  // it as "secrets" only, and the prompts digest adds its input-redaction sentence (addendum A, VS-34 item 3) under
  // that key only. "off" or unset keeps every scope as it was.
  test("the scope counts VS-34's holdback only as secrets", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(base).toBe("70512122f41ec160")
    expect(EVIDENCE_POLICY_KEYS).toContain("holdback")
    expect((UNAPPLIED_REVIEW_KEYS as readonly string[]).includes("holdback")).toBe(false)
    for (const holdback of ["off", undefined] as const) {
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, holdback })).toBe(base)
      expect(evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, holdback } })).toEqual(SCOPE)
    }
    const held: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, holdback: "secrets" }
    expect(policyDigest(held)).not.toBe(base)
    const scope = evidenceScope({ adapter: "engine", config: held })
    expect(scope).toEqual({
      ...SCOPE,
      prompts: promptsDigest({ holdback: "secrets" }),
      policy: policyDigest(held),
    })
    expect(scope.prompts).not.toBe("5d59e9ee06077c23")
    expect(scope.pipeline).toBe(SCOPE.pipeline)
    // Beside the route setting and VS-30's runtime, which the scope does not read from the config: only holdback moves.
    const beside: ReviewConfig = { ...held, privacy: "zdr", runtime: "ask" }
    expect(evidenceScope({ adapter: "desktop", config: beside })).toEqual(
      evidenceScope({ adapter: "desktop", config: held }),
    )
    expect(policyDigest({ ...held, nits: true })).not.toBe(policyDigest(held))
  })

  // VS-34 item 3: the input-redaction sentence renders only under `holdback: "secrets"`, in the review and security
  // prompts with every input set, for both trusts, appended last; "off", and every other set of keys, keeps its digest.
  test("the prompts digest covers VS-34's input-redaction sentence under holdback: secrets only", () => {
    expect(promptsDigest({ holdback: "off" })).toBe(promptsDigest())
    expect(canonicalPrompts({ holdback: "off" })).toEqual(canonicalPrompts())
    expect(canonicalPrompts().join("\n")).not.toContain(INPUT_REDACTION)
    const held = canonicalPrompts({ holdback: "secrets" })
    expect(held.slice(0, -4)).toEqual(canonicalPrompts())
    expect(held.slice(-4).every((text) => text.split(INPUT_REDACTION).length === 2)).toBe(true)
    expect(held.slice(-4).map((text) => text.startsWith("You are Vector's security reviewer"))).toEqual([
      false,
      true,
      false,
      true,
    ])
    // With the other keys, the sentence's prompts still come last.
    const all = canonicalPrompts({
      impact: "graph",
      depth: "auto",
      lenses: "high",
      runtime: "ask",
      holdback: "secrets",
    })
    expect(all.slice(0, -4)).toEqual(
      canonicalPrompts({ impact: "graph", depth: "auto", lenses: "high", runtime: "ask" }),
    )
    const secrets = promptsDigest({ holdback: "secrets" })
    expect(promptsDigest({ holdback: "secrets" })).toBe(secrets)
    expect(
      new Set([
        promptsDigest(),
        secrets,
        promptsDigest({ impact: "graph" }),
        promptsDigest({ impact: "graph", holdback: "secrets" }),
        promptsDigest({ guardrail: "strict" }),
        promptsDigest({ guardrail: "strict", holdback: "secrets" }),
        promptsDigest({ runtime: "ask" }),
        promptsDigest({ runtime: "ask", holdback: "secrets" }),
      ]).size,
    ).toBe(8)
    // Every earlier digest holds.
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(promptsDigest({ impact: "graph" })).toBe("74a2111826c226b1")
    expect(promptsDigest({ guardrail: "strict" })).toBe("3d07943f9c1aeb14")
    expect(promptsDigest({ runtime: "ask" })).toBe("7d9147298f5cdbaf")
  })

  // VS-34's tool half (SF-14): under "secrets" the prompts digest also counts what the reviewer's tools may read and
  // show, so evidence scoped while only the payload half applied (SF-13b, printed at defd141b) no longer matches. The
  // canonical prompts are SF-13b's, and every other digest holds. The value is pinned, so a change to the tool half's
  // marker (the denies, the held paths' word, the tools that redact) moves it here and not only in the pipeline pin.
  test("the prompts digest counts VS-34's tool half under holdback: secrets, and nothing else moves", () => {
    const secrets = promptsDigest({ holdback: "secrets" })
    expect(secrets).toBe("7f25a74fe7a28f91")
    expect(secrets).not.toBe("2ea4244cd6d01e0b")
    expect(promptsDigest({ holdback: "off" })).toBe("5d59e9ee06077c23")
    expect(canonicalPrompts({ holdback: "secrets" }).slice(0, -4)).toEqual(canonicalPrompts())
    expect(policyDigest(DEFAULT_REVIEW_CONFIG)).toBe("70512122f41ec160")
    expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, holdback: "secrets" })).toBe("fc36732a7163e50b")
    expect(REVIEW_PIPELINE_REVISION).toBe(5)
    expect(
      evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, holdback: "secrets" } }).prompts,
    ).toBe(secrets)
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

test("offline diagnostics evidence identifies the Linux engine prompt and keeps desktop and disabled scopes stable", () => {
  const config = { ...DEFAULT_REVIEW_CONFIG, diagnostics: "offline" } as const
  const prompt = canonicalPrompts({ diagnostics: "offline" }).join("\n")
  expect(prompt).toContain("untrusted_offline_diagnostics")
  expect(prompt).toContain("vectorscope-diagnostic:offline-v1:secret-added")
  const ordinary = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
  const disabled = evidenceScope({
    adapter: "engine",
    config: { ...config, diagnostics: "off" },
    offlineDiagnostics: true,
  })
  const scanned = evidenceScope({ adapter: "engine", config, offlineDiagnostics: true })
  const redacted = evidenceScope({ adapter: "engine", config, offlineDiagnostics: false })
  expect(disabled).toEqual(ordinary)
  expect(scanned.prompts).not.toBe(redacted.prompts)
  expect(scanned.policy).not.toBe(redacted.policy)
  expect(redacted).toEqual(
    evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, holdback: "secrets" } }),
  )
  expect(evidenceScope({ adapter: "desktop", config })).toEqual(
    evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
  )
})
