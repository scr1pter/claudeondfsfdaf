#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Report } from "../../packages/core/src/review/eval-report"
import { certify, type EvidenceScope, type ModelCertificate } from "../../packages/core/src/review/model-evidence"
import type { ReplayVariant } from "../../packages/engine/src/review/eval"
import { replayVariant, variantAdapter, variantProblems } from "./replay"

// Model evidence (VectorScope plan, VS-07): turns a held-out report whose gate passed into a model certificate, for the
// owner to approve. The certificate names the report file by digest, the frozen manifest by its freeze digest, the gate
// by its digest, and the scope every one of the candidate's runs was replayed in (runner, pipeline revision, prompts,
// review settings, triage model and route), from the replay artifacts. The model variant comes from those artifacts
// too, and the manifest must be the one the report was built from. It expires on the date given, at most
// MAX_CERTIFICATE_DAYS after the owner's approval.
//
// It reads files and sends nothing. Printing a certificate certifies nothing: a review reads only the certificates in
// MODEL_EVIDENCE (packages/core/src/review/model-evidence.ts), and one goes there only with the owner's approval of the
// report (D12). Until then every model stays unvetted.

const USAGE = `Usage: bun script/vectorscope-eval/certify.ts --report <path> --outputs <path> --manifest <path> --id <id>
    --collected <YYYY-MM-DD> --approved <YYYY-MM-DD> --expires <YYYY-MM-DD> [options]

  --report <path>        The JSON report report.ts --out wrote for the held-out split
  --outputs <path>       A replay artifact, or a directory of them, of the candidate's runs (repeatable)
  --manifest <path>      The frozen dataset manifest the runs came from, the one the report records
  --id <id>              The certificate's id
  --collected <date>     The day the candidate's results were collected
  --approved <date>      The day the owner approved the report
  --expires <date>       The first day the certificate no longer covers
  --variant <name>       The model variant the runs used, if any; their artifacts record it, and this only checks it
  --vector <commit>      The Vector commit the runs replayed
  --help                 Print this message
`

const OPTIONS = {
  report: { type: "string" },
  outputs: { type: "string", multiple: true },
  manifest: { type: "string" },
  id: { type: "string" },
  collected: { type: "string" },
  approved: { type: "string" },
  expires: { type: "string" },
  variant: { type: "string" },
  vector: { type: "string" },
  help: { type: "boolean" },
} as const

// A replay artifact as far as a certificate needs it: the engine's (packages/engine/src/review/eval.ts) and the
// desktop's (desktop.ts) both record the model, its variant, the pipeline variant the eval asked for and the scope.
type Artifact = {
  version: 1
  adapter: string
  label: string
  models: { review: { id: string; variant?: string } }
  variant?: ReplayVariant // applied: false when it never reached the desktop runner
  scope?: EvidenceScope
}

export async function main(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const text = (name: Exclude<keyof typeof OPTIONS, "outputs" | "help">) =>
    typeof values[name] === "string" ? values[name] : undefined
  const outputs = (Array.isArray(values.outputs) ? values.outputs : []).filter((value) => typeof value === "string")
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  if (unknown.length || parsed.positionals.length) return usage("Unknown option or argument.")
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  const missing = (["report", "manifest", "id", "collected", "approved", "expires"] as const).filter(
    (name) => !text(name),
  )
  if (missing.length || !outputs.length)
    return usage(
      `Give ${[...missing.map((name) => `--${name}`), ...(outputs.length ? [] : ["--outputs"])].join(", ")}.`,
    )

  const reportText = await Bun.file(resolve(text("report")!)).text()
  const report = JSON.parse(reportText) as Report
  const manifestText = await Bun.file(resolve(text("manifest")!)).text()
  const manifest = JSON.parse(manifestText) as { freeze?: { digest?: unknown } }
  // report.ts records the manifest it read as "<path> sha256 <hex>"; the certificate must name that one.
  const manifestSha = createHash("sha256").update(manifestText).digest("hex")
  const recordedSha = /\bsha256 ([0-9a-f]{64})$/.exec(report.sources?.manifest ?? "")?.[1]
  const artifacts = (
    await Promise.all(
      outputs
        .flatMap((path) => jsonFiles(resolve(path)))
        .map(async (file) => ({ file, value: await Bun.file(file).json() })),
    )
  ).filter((entry): entry is { file: string; value: Artifact } => isArtifact(entry.value))
  const candidate = report.decision?.candidate
  // The candidate's runs: the artifacts of its model whose pipeline variant is the report's (replayVariant, such as
  // "engine" or "engine:shared-verify"). A desktop replay whose variant never reached the runner ran without it, and
  // a variant record the registry does not bear out (variantProblems) may not be the run it names.
  const asked = candidate
    ? artifacts.filter(
        (entry) =>
          entry.value.models.review.id === candidate.model &&
          entry.value.adapter === variantAdapter(candidate.variant) &&
          replayVariant(entry.value.adapter, entry.value.variant) === candidate.variant,
      )
    : []
  const unapplied = asked.filter((entry) => entry.value.variant?.applied === false)
  const runs = asked.filter((entry) => entry.value.variant?.applied !== false)
  const unscoped = runs.filter((entry) => !entry.value.scope)
  // The model variant is the runs' own, never only the operator's word: --variant can only confirm it.
  const variants = [...new Set(runs.map((entry) => entry.value.models.review.variant ?? ""))]
  const variant = variants.length === 1 && variants[0] ? variants[0] : undefined
  const claimed = text("variant")
  const result = certify({
    id: text("id")!,
    report,
    reportDigest: `sha256:${createHash("sha256").update(reportText).digest("hex")}`,
    manifest: typeof manifest.freeze?.digest === "string" ? manifest.freeze.digest : "",
    collected: text("collected")!,
    scopes: runs.flatMap((entry) => (entry.value.scope ? [entry.value.scope] : [])),
    ...(variant ? { variant } : {}),
    ...(text("vector") ? { vector: text("vector")! } : {}),
    approved: { by: "owner", date: text("approved")! },
    expires: text("expires")!,
  })
  const problems = [
    ...(typeof manifest.freeze?.digest === "string" ? [] : ["the manifest has no freeze digest"]),
    ...(recordedSha === undefined
      ? ["the report does not record the manifest it was built from"]
      : recordedSha === manifestSha
        ? []
        : [
            `${text("manifest")} is not the manifest the report was built from (sha256 ${manifestSha}, the report's ${recordedSha})`,
          ]),
    ...(variants.length > 1
      ? [`the candidate's runs used different model variants (${variants.map((item) => item || "none").join(", ")})`]
      : []),
    ...(claimed !== undefined && variants.length === 1 && claimed !== (variant ?? "")
      ? [`--variant ${claimed} is not the model variant the candidate's runs used (${variant ?? "none"})`]
      : []),
    ...unapplied.map((entry) => `${entry.file} asked for the variant, but it never reached the runner`),
    ...runs.flatMap((entry) =>
      variantProblems(entry.value.adapter, entry.value.variant).map((problem) => `${entry.file}: ${problem}`),
    ),
    ...unscoped.map((entry) => `${entry.file} records no evidence scope (made before VS-07), so it is left out`),
    ...result.problems,
  ]
  if (!result.certificate || problems.length)
    return { code: 1, stdout: "", stderr: `No certificate:\n${problems.map((line) => `  ${line}`).join("\n")}\n` }
  return {
    code: 0,
    stdout:
      JSON.stringify(result.certificate satisfies ModelCertificate, null, 2) +
      `\n\nNothing is certified until this is added to MODEL_EVIDENCE in packages/core/src/review/model-evidence.ts with the owner's approval. Offline: no request was sent.\n`,
    stderr: "",
  }
}

function usage(problem: string) {
  return { code: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` }
}

function jsonFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => join(path, name))
}

function isArtifact(value: unknown): value is Artifact {
  const item = value as Artifact | undefined
  return (
    !!item &&
    typeof item === "object" &&
    item.version === 1 &&
    (item.adapter === "engine" || item.adapter === "desktop") &&
    typeof item.models?.review?.id === "string"
  )
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
