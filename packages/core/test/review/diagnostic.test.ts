import { expect, test } from "bun:test"
import { diagnosticCitation, type DiagnosticEvidence, withDiagnosticEvidence } from "../../src/review/diagnostic"
import type { Finding } from "../../src/review/types"

test("a confirmed model finding retains its own identity and can cite colocated diagnostics once", () => {
  const finding: Finding = {
    path: "fixture.ts",
    line: 3,
    side: "RIGHT",
    source: "review",
    id: "test-fixture",
    severity: "concern",
    category: "security",
    confidence: 0.9,
    title: "Inspect added fixture value",
    body: "Synthetic observation.",
    evidence: ["fixture.ts:3"],
  }
  const source: DiagnosticEvidence = {
    rule: "secret-added",
    source: "offline-v1",
    path: finding.path,
    side: finding.side,
    line: finding.line,
  }
  expect(withDiagnosticEvidence([], [source])).toEqual([])
  expect(withDiagnosticEvidence([finding], [])).toEqual([finding])
  expect(withDiagnosticEvidence([finding], [source])).toEqual([finding])
  const cited = { ...finding, evidence: [...finding.evidence!, diagnosticCitation("secret-added")] }
  expect(withDiagnosticEvidence([cited], [source, source])).toEqual([
    { ...finding, diagnostics: [{ source: "offline-v1", rule: "secret-added" }] },
  ])
  expect(withDiagnosticEvidence([cited], [])).toEqual([finding])
  for (const partial of [
    { category: "bug" as const },
    { side: "LEFT" as const },
    { line: 4 },
    { evidence: [] },
    { path: "other.ts" },
  ]) {
    const row = { ...finding, ...partial }
    expect(
      withDiagnosticEvidence(
        [{ ...row, evidence: [...(row.evidence ?? []), diagnosticCitation("secret-added")] }],
        [source],
      ),
    ).toEqual([row])
  }
})
