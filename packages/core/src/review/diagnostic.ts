// Offline observations describe an exact rule and changed line. They carry no source text, dependency names,
// package versions or credential material. Only an independently accepted model finding can reach selection.
import type { Finding, Side } from "./types"

export const OFFLINE_DIAGNOSTIC_RULES = Object.freeze({
  "secret-added": "An added source line contains a credential-shaped value.",
  "manifest-without-lock": "A dependency declaration changed without a corresponding lockfile update in this change.",
  "integrity-removed": "An integrity field was removed from a dependency lockfile.",
} as const)

export type DiagnosticRule = keyof typeof OFFLINE_DIAGNOSTIC_RULES
export interface DiagnosticProvenance {
  readonly source: "offline-v1"
  readonly rule: DiagnosticRule
}
export interface DiagnosticEvidence extends DiagnosticProvenance {
  readonly path: string
  readonly side: Side
  readonly line: number
}

// Preserve model filtering. Attach a local rule only to a finding on its exact changed anchor explicitly citing
// that path and line as evidence; a model cannot declare its own provenance or use that of a neighboring anchor.
export function diagnosticCitation(rule: DiagnosticRule) {
  return "vectorscope-diagnostic:offline-v1:" + rule
}
export function diagnosticReference(value: string) {
  return value.startsWith("vectorscope-diagnostic:")
}

export function withDiagnosticEvidence(findings: Finding[], observations: readonly DiagnosticEvidence[]): Finding[] {
  return findings.map((finding) => {
    const evidence = finding.evidence ?? []
    const references = evidence.filter(diagnosticReference)
    if (!references.length) return finding
    // Private rule citations are never downstream file paths (notably to strict verification).
    const clean = { ...finding, evidence: evidence.filter((item) => !diagnosticReference(item)) }
    if (!evidence.includes(finding.path + ":" + finding.line)) return clean
    const matches = observations.filter(
      (item) =>
        references.includes(diagnosticCitation(item.rule)) &&
        item.path === finding.path &&
        item.line === finding.line &&
        item.side === finding.side &&
        (item.rule === "secret-added"
          ? finding.category === "security"
          : finding.category === "reliability" || finding.category === "security"),
    )
    return matches.length
      ? {
          ...clean,
          diagnostics: [...new Set(matches.map((item) => item.rule))].map((rule) => ({
            source: "offline-v1" as const,
            rule,
          })),
        }
      : clean
  })
}
