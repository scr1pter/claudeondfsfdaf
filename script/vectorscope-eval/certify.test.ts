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

const report = (overrides: { outcome?: string; eligible?: boolean } = {}) => ({
  title: "VectorScope eval: held-out",
  split: "held-out",
  frozen: true,
  gate: { config: DEFAULT_GATE, digest: gateDigest(DEFAULT_GATE) },
  decision: {
    decision: DEFAULT_GATE.decision,
    candidate: { variant: "engine", model: MODEL },
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

function files(name: string, input: { report: object; artifacts: object[]; manifest?: object }) {
  const dir = join(root, name)
  mkdirSync(join(dir, "outputs"), { recursive: true })
  const reportText = JSON.stringify(input.report, null, 2)
  writeFileSync(join(dir, "report.json"), reportText)
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(input.manifest ?? { freeze: { date: "2026-12-01", digest: FREEZE } }),
  )
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
})
