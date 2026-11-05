#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Report } from "../../packages/core/src/review/eval-report"
import { certify, type EvidenceScope, type ModelCertificate } from "../../packages/core/src/review/model-evidence"

// Model evidence (VectorScope plan, VS-07): turns a held-out report whose gate passed into a model certificate, for the
// owner to approve. The certificate names the report file by digest, the frozen manifest by its freeze digest, the gate
// by its digest, and the scope every one of the candidate's runs was replayed in (runner, pipeline revision, prompts,
// review settings and triage model), from the replay artifacts. It expires on the date given, at most
// MAX_CERTIFICATE_DAYS after the owner's approval.
//
// It reads files and sends nothing. Printing a certificate certifies nothing: a review reads only the certificates in
// MODEL_EVIDENCE (packages/core/src/review/model-evidence.ts), and one goes there only with the owner's approval of the
// report (D12). Until then every model stays unvetted.

const USAGE = `Usage: bun script/vectorscope-eval/certify.ts --report <path> --outputs <path> --manifest <path> --id <id>
    --collected <YYYY-MM-DD> --approved <YYYY-MM-DD> --expires <YYYY-MM-DD> [options]

  --report <path>        The JSON report report.ts --out wrote for the held-out split
  --outputs <path>       A replay artifact, or a directory of them, of the candidate's runs (repeatable)
  --manifest <path>      The frozen dataset manifest the runs came from
  --id <id>              The certificate's id
  --collected <date>     The day the candidate's results were collected
  --approved <date>      The day the owner approved the report
  --expires <date>       The first day the certificate no longer covers
  --variant <name>       The model variant the runs used, if any
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
// desktop's (desktop.ts) both record the model and the scope.
type Artifact = {
  version: 1
  adapter: string
  label: string
  models: { review: { id: string } }
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
  const manifest = (await Bun.file(resolve(text("manifest")!)).json()) as { freeze?: { digest?: unknown } }
  const artifacts = (
    await Promise.all(
      outputs
        .flatMap((path) => jsonFiles(resolve(path)))
        .map(async (file) => ({ file, value: await Bun.file(file).json() })),
    )
  ).filter((entry): entry is { file: string; value: Artifact } => isArtifact(entry.value))
  const candidate = report.decision?.candidate
  // The candidate's runs: its runner's artifacts of its model. The report names an engine replay's runs "engine".
  const runs = candidate
    ? artifacts.filter(
        (entry) => entry.value.adapter === candidate.variant && entry.value.models.review.id === candidate.model,
      )
    : []
  const unscoped = runs.filter((entry) => !entry.value.scope)
  const result = certify({
    id: text("id")!,
    report,
    reportDigest: `sha256:${createHash("sha256").update(reportText).digest("hex")}`,
    manifest: typeof manifest.freeze?.digest === "string" ? manifest.freeze.digest : "",
    collected: text("collected")!,
    scopes: runs.flatMap((entry) => (entry.value.scope ? [entry.value.scope] : [])),
    ...(text("variant") ? { variant: text("variant")! } : {}),
    ...(text("vector") ? { vector: text("vector")! } : {}),
    approved: { by: "owner", date: text("approved")! },
    expires: text("expires")!,
  })
  const problems = [
    ...(typeof manifest.freeze?.digest === "string" ? [] : ["the manifest has no freeze digest"]),
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
