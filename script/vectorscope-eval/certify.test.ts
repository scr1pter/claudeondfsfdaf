import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_GATE, gateDigest } from "../../packages/core/src/review/eval-report"
import {
  certificateProblems,
  evidenceScope,
  MODEL_EVIDENCE,
  type ModelCertificate,
} from "../../packages/core/src/review/model-evidence"
import { DEFAULT_REVIEW_CONFIG } from "../../packages/core/src/review/types"
import { main } from "./certify"

// certify.ts over synthetic files: a held-out report whose gate passed, the candidate's replay artifacts and a frozen
// manifest. Nothing here is a real result, and MODEL_EVIDENCE stays empty.

const root = mkdtempSync(join(tmpdir(), "vectorscope-certify-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MODEL = "acme/reviewer"
const SCOPE = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
const FREEZE = `sha256:${"b".repeat(64)}`

const report = (overrides: { outcome?: string; eligible?: boolean; variant?: string } = {}) => ({
  title: "VectorScope eval: held-out",
  split: "held-out",
  frozen: true,
  gate: { config: DEFAULT_GATE, digest: gateDigest(DEFAULT_GATE) },
  decision: {
    decision: DEFAULT_GATE.decision,
    candidate: { variant: overrides.variant ?? "engine", model: MODEL },
    outcome: overrides.outcome ?? "pass",
    rules: [],
    release:
      overrides.eligible === false ? { eligible: false, reasons: ["not frozen"] } : { eligible: true, reasons: [] },
  },
  problems: [],
})

const artifact = (label: string, extra: object = {}) => ({
  version: 1,
  label,
  adapter: "engine",
  models: { review: { id: MODEL } },
  scope: SCOPE,
  ...extra,
})

// The report records the manifest it was built from, as report.ts does ("<path> sha256 <hex>"), unless `sources` says
// otherwise.
function files(name: string, input: { report: object; artifacts: object[]; manifest?: object; sources?: object }) {
  const dir = join(root, name)
  mkdirSync(join(dir, "outputs"), { recursive: true })
  const manifestText = JSON.stringify(input.manifest ?? { freeze: { date: "2026-12-01", digest: FREEZE } })
  const sources = input.sources ?? {
    manifest: `manifest.json sha256 ${createHash("sha256").update(manifestText).digest("hex")}`,
  }
  const reportText = JSON.stringify({ ...input.report, sources }, null, 2)
  writeFileSync(join(dir, "report.json"), reportText)
  writeFileSync(join(dir, "manifest.json"), manifestText)
  input.artifacts.forEach((item, index) => writeFileSync(join(dir, "outputs", `${index}.json`), JSON.stringify(item)))
  return {
    reportDigest: `sha256:${createHash("sha256").update(reportText).digest("hex")}`,
    args: (extra: string[] = []) => [
      "--report",
      join(dir, "report.json"),
      "--outputs",
      join(dir, "outputs"),
      "--manifest",
      join(dir, "manifest.json"),
      "--id",
      "vs-2026-12-reviewer",
      "--collected",
      "2026-12-01",
      "--approved",
      "2026-12-02",
      "--expires",
      "2027-02-01",
      ...extra,
    ],
  }
}

describe("certify.ts", () => {
  test("prints a valid certificate tied to the report, manifest, gate and the runs' scope, and certifies nothing", async () => {
    const set = files("pass", {
      report: report(),
      // Another model's artifact is not one of the candidate's runs.
      artifacts: [artifact("a"), artifact("b"), { ...artifact("c"), models: { review: { id: "acme/other" } } }],
    })
    const result = await main(set.args(["--vector", "c".repeat(40)]))
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    const certificate = JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\n"))) as ModelCertificate
    expect(certificateProblems(certificate)).toEqual([])
    expect(certificate).toEqual({
      version: 1,
      id: "vs-2026-12-reviewer",
      model: MODEL,
      adapters: ["engine"],
      pipeline: SCOPE.pipeline,
      prompts: SCOPE.prompts,
      policy: SCOPE.policy,
      evaluation: {
        report: set.reportDigest,
        manifest: FREEZE,
        split: "held-out",
        decision: DEFAULT_GATE.decision,
        gate: gateDigest(DEFAULT_GATE),
        collected: "2026-12-01",
        vector: "c".repeat(40),
      },
      approved: { by: "owner", date: "2026-12-02" },
      expires: "2027-02-01",
    })
    expect(result.stdout).toContain("Nothing is certified until this is added to MODEL_EVIDENCE")
    expect(MODEL_EVIDENCE).toEqual([])
  })

  test("refuses a gate that did not pass, an unfrozen manifest, mixed scopes and artifacts without a scope", async () => {
    const failed = await main(
      files("review", { report: report({ outcome: "review" }), artifacts: [artifact("a")] }).args(),
    )
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain("the gate's outcome is review, not pass")

    const unfrozen = await main(
      files("unfrozen", { report: report(), artifacts: [artifact("a")], manifest: {} }).args(),
    )
    expect(unfrozen.code).toBe(1)
    expect(unfrozen.stderr).toContain("the manifest has no freeze digest")

    const mixed = await main(
      files("mixed", {
        report: report(),
        artifacts: [artifact("a"), artifact("b", { scope: { ...SCOPE, policy: "0".repeat(16) } })],
      }).args(),
    )
    expect(mixed.code).toBe(1)
    expect(mixed.stderr).toContain("replayed under different pipelines, prompts, settings or triage models")

    const old = await main(files("old", { report: report(), artifacts: [artifact("a", { scope: undefined })] }).args())
    expect(old.code).toBe(1)
    expect(old.stderr).toContain("records no evidence scope (made before VS-07)")
    expect(old.stderr).toContain("no replay scope was given for the candidate's runs")

    const long = await main(
      files("long", { report: report(), artifacts: [artifact("a")] }).args(["--expires", "2027-12-01"]),
    )
    expect(long.code).toBe(1)
    expect(long.stderr).toContain("days after approved.date")

    expect((await main(["--report", "x"])).code).toBe(2)
  })

  // Phase 1 review: the variant and the manifest came from the operator's flags alone.
  test("takes the model variant from the runs, and refuses mixed variants or a --variant they do not bear out", async () => {
    const high = (label: string) => artifact(label, { models: { review: { id: MODEL, variant: "high" } } })
    const certificate = (result: { stdout: string }) =>
      JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\n"))) as ModelCertificate
    // Left out, the variant is the runs' own; given, it must agree.
    const implied = await main(files("variant", { report: report(), artifacts: [high("a"), high("b")] }).args())
    expect(implied.stderr).toBe("")
    expect(certificate(implied).variant).toBe("high")
    const confirmed = await main(
      files("variant-confirmed", { report: report(), artifacts: [high("a")] }).args(["--variant", "high"]),
    )
    expect(certificate(confirmed).variant).toBe("high")

    const wrong = await main(
      files("variant-wrong", { report: report(), artifacts: [high("a")] }).args(["--variant", "low"]),
    )
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain("--variant low is not the model variant the candidate's runs used (high)")
    const invented = await main(
      files("variant-invented", { report: report(), artifacts: [artifact("a")] }).args(["--variant", "high"]),
    )
    expect(invented.code).toBe(1)
    expect(invented.stderr).toContain("--variant high is not the model variant the candidate's runs used (none)")
    const mixed = await main(files("variant-mixed", { report: report(), artifacts: [high("a"), artifact("b")] }).args())
    expect(mixed.code).toBe(1)
    expect(mixed.stderr).toContain("the candidate's runs used different model variants (high, none)")
  })

  test("refuses a manifest other than the one the report was built from", async () => {
    const other = await main(
      files("manifest-other", {
        report: report(),
        artifacts: [artifact("a")],
        sources: { manifest: `manifest.json sha256 ${"d".repeat(64)}` },
      }).args(),
    )
    expect(other.code).toBe(1)
    expect(other.stderr).toContain("is not the manifest the report was built from")
    const unrecorded = await main(
      files("manifest-unrecorded", { report: report(), artifacts: [artifact("a")], sources: {} }).args(),
    )
    expect(unrecorded.code).toBe(1)
    expect(unrecorded.stderr).toContain("the report does not record the manifest it was built from")
  })

  test("a pipeline variant's certificate covers that variant's runs only", async () => {
    const shared = (label: string) =>
      artifact(label, { variant: { verifyPolicy: "shared" }, scope: { ...SCOPE, policy: "1".repeat(16) } })
    // The frozen pipeline's runs of the same model are not the shared variant's, and do not mix their scope in.
    const result = await main(
      files("pipeline-variant", {
        report: report({ variant: "engine:shared-verify" }),
        artifacts: [shared("a"), shared("b"), artifact("a"), artifact("b")],
      }).args(),
    )
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\n"))).policy).toBe("1".repeat(16))
    // A desktop replay whose variant never reached the runner is not one of the variant's runs.
    const unapplied = await main(
      files("pipeline-unapplied", {
        report: report({ variant: "desktop:shared-verify" }),
        artifacts: [true, false].map((applied, index) => ({
          ...shared(String(index)),
          adapter: "desktop",
          variant: { verifyPolicy: "shared", applied },
          scope: { ...SCOPE, adapter: "desktop", policy: "1".repeat(16) },
        })),
      }).args(),
    )
    expect(unapplied.code).toBe(1)
    expect(unapplied.stderr).toContain("asked for the variant, but it never reached the runner")
  })

  // VS-21a: the record names the variant and every key it set, and must be the registry's.
  test("takes VS-21a's variant record, and refuses one the registry does not bear out", async () => {
    const named = (label: string, keys: object) =>
      artifact(label, {
        variant: { name: "engine:shared-verify", keys },
        scope: { ...SCOPE, policy: "1".repeat(16) },
      })
    const matching = await main(
      files("record-matching", {
        report: report({ variant: "engine:shared-verify" }),
        artifacts: [named("a", { verifyPolicy: "shared" }), named("b", { verifyPolicy: "shared" })],
      }).args(),
    )
    expect(matching.stderr).toBe("")
    expect(matching.code).toBe(0)
    const mismatched = await main(
      files("record-mismatched", {
        report: report({ variant: "engine:shared-verify" }),
        artifacts: [named("a", { verifyPolicy: "shared" }), named("b", { verifyPolicy: "legacy" })],
      }).args(),
    )
    expect(mismatched.code).toBe(1)
    expect(mismatched.stderr).toContain("1.json: its variant engine:shared-verify set")
    expect(mismatched.stderr).toContain("not the registry's")
    // A hand-edited record that is not an object names the frozen pipeline and is refused, not thrown on.
    const primitive = await main(
      files("record-primitive", {
        report: report(),
        artifacts: [artifact("a"), artifact("b", { variant: "engine:shared-verify" })],
      }).args(),
    )
    expect(primitive.code).toBe(1)
    expect(primitive.stderr).toContain("1.json: its variant record is not an object")
  })

  // VS-29a: a run named for the cross-family pair must show it, a triage model its scope names too, as report.ts reads it.
  test("refuses a cross-family run that does not show its pair", async () => {
    const scope = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG, triage: "other/triage" })
    const variant = { name: "engine:cross-family", keys: {}, models: "triage-pair" }
    const paired = (label: string) =>
      artifact(label, { variant, scope, models: { review: { id: MODEL }, triage: { id: "other/triage" } } })
    const matching = await main(
      files("pair-matching", {
        report: report({ variant: "engine:cross-family" }),
        artifacts: [paired("a"), paired("b")],
      }).args(),
    )
    expect(matching.stderr).toBe("")
    expect(matching.code).toBe(0)
    const unpaired = await main(
      files("pair-unpaired", {
        report: report({ variant: "engine:cross-family" }),
        artifacts: [paired("a"), artifact("b", { variant, scope })],
      }).args(),
    )
    expect(unpaired.code).toBe(1)
    expect(unpaired.stderr).toContain("1.json: its variant is made by its models, but it records no triage model")
  })
})
