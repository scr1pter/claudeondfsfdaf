import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ReviewClient, ReviewMessage, ReviewModel } from "../../packages/app/src/features/pull-requests/ai-review"
import { parseReviewConfig } from "../../packages/core/src/review/config"
import { findingKey, VARIANT_KEYS, VARIANT_NAME, type SliceUtilisation } from "../../packages/core/src/review/eval"
import { TOKEN_KINDS } from "../../packages/core/src/review/eval-report"
import { evidenceScope } from "../../packages/core/src/review/model-evidence"
import { estimateCostUsd } from "../../packages/core/src/review/plan"
import { VERIFY_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import { DEFAULT_REVIEW_CONFIG } from "../../packages/core/src/review/types"
import { Ledger, type Limits } from "./budget"
import { gitEnv, loadManifest, type Case, type Manifest } from "./dataset"
import type {
  ProjectedPass,
  ProjectionRecord,
  ReplayVariant,
  VariantRecord,
} from "../../packages/engine/src/review/eval"
import { candidateDiff, desktopReplay, withReviewSettings } from "./desktop"
import {
  ADAPTERS,
  admitReplay,
  checkoutDirectory,
  main,
  pairProblems,
  PILOT,
  pilotProblems,
  pilotRemaining,
  prepareCheckout,
  projectedPassCosts,
  projectedRun,
  projectionProblems,
  replayBudget,
  replayCharge,
  replayPlan,
  replayVariant,
  resolveVariant,
  triagePairProblem,
  unreplayable,
  unreplayableCases,
  utilisationProblems,
  variantAdapter,
  variantNames,
  variantProblems,
  variantRecord,
  VARIANTS,
  type PlannedReplay,
  type VariantEntry,
} from "./replay"

// The replay driver without any model or network: the plan it builds from the seed manifest, and checkouts prepared
// from a local repository whose later history holds the fix.

const root = mkdtempSync(join(tmpdir(), "vectorscope-replay-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mirror = buildMirror(join(root, "mirror"))

function buildMirror(dir: string, extra: Record<string, string> = {}, headExtra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    git("add", "--all")
    git("commit", "--quiet", "-m", message)
    return git("rev-parse", "HEAD")
  }
  git("init", "--quiet", "--initial-branch=main")
  const base = commit("base", { "app.py": "def total(items):\n    return sum(items)\n", ...extra })
  const head = commit("candidate", { "app.py": "def total(items):\n    return sum(items[1:])\n", ...headExtra })
  const fix = commit("fix", { "app.py": "def total(items):\n    # every item counts\n    return sum(items)\n" })
  return { dir, base, head, fix }
}

const view = { repository: "https://github.com/example/fixture", base: mirror.base, head: mirror.head }

function inCheckout(dir: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-C", dir, ...args], { env: gitEnv(), stdout: "pipe", stderr: "pipe" })
}

describe("the replay plan", () => {
  test("builds each case's replay input from its view alone, untrusted, on a writer's request", async () => {
    const seed = (await loadManifest()) as Manifest
    const plan = replayPlan(seed, { split: "development" })
    const development = seed.cases.filter((item) => item.split === "development")
    expect(plan.map((entry) => entry.id)).toEqual(development.map((item) => item.id))
    for (const [index, entry] of plan.entries()) {
      const item = development[index]!
      expect(entry.case).toEqual({
        label: item.id,
        base: item.candidate.base,
        head: item.candidate.head,
        trust: "untrusted",
        trigger: "command",
        repository: {
          owner: item.repository.url.split("/")[3],
          repo: item.repository.url.split("/")[4],
          url: item.repository.url,
        },
      })
      // Nothing of the fix or the labels reaches the replay input.
      const sent = JSON.stringify(entry.case)
      if (item.fix) expect(sent).not.toContain(item.fix.sha)
      for (const defect of item.labels.defects) {
        expect(sent).not.toContain(defect.cause)
        expect(sent).not.toContain(defect.summary)
      }
      expect(entry.mirror).toBeUndefined()
    }
  })

  test("refuses held-out cases from a manifest that is not frozen, and plans the desktop adapter too", async () => {
    const heldOut = await main(["--split", "held-out"])
    expect(heldOut.code).toBe(1)
    expect(heldOut.stderr).toContain("frozen")
    const desktop = await main(["--adapter", "desktop"])
    expect(desktop.code).toBe(0)
    expect(desktop.stdout).toContain(`Adapter desktop: ${ADAPTERS.desktop.detail}`)
    expect(desktop.stdout).toContain("Dry run: no model request was sent.")
    expect(ADAPTERS.desktop.ready).toBe(true)
  })

  // VS-22c: a multi-commit sequence or a case with review feedback needs the engine half the VS-22a follow-up defers
  // (a sequence mode, ReplayCase comments and threads). Until it lands the plan fails closed on the case's split rather
  // than replay it as a plain base..head review.
  test("refuses a split holding a case the replay cannot feed yet, and plans every other split", async () => {
    const seed = (await loadManifest()) as Manifest
    const first = seed.cases.find((item) => item.split === "development" && item.kind === "bug")!
    const earlier = { sha: "f".repeat(40), date: "2000-01-01T00:00:00Z" }
    const sequenced: Case = {
      ...first,
      traits: [...(first.traits ?? []), "incremental"],
      candidate: { ...first.candidate, commits: [earlier, { sha: first.candidate.head, date: first.candidate.date }] },
      labels: {
        ...first.labels,
        defects: first.labels.defects.map((defect) => ({ ...defect, introducedAt: first.candidate.head })),
      },
    }
    const manifest = { ...seed, cases: seed.cases.map((item) => (item.id === first.id ? sequenced : item)) }
    const sequenceReason = "it is a multi-commit sequence, and ReviewEval.replay has no sequence mode yet"
    expect(unreplayable(sequenced)).toBe(sequenceReason)
    expect(unreplayable(first)).toBeUndefined()
    expect(
      unreplayable({
        candidate: sequenced.candidate,
        feedback: { source: "synthetic", comments: [] },
      }),
    ).toBe(`${sequenceReason}; it carries review feedback, which ReviewEval.replay does not feed in yet`)
    expect(unreplayableCases(manifest, "development")).toEqual([`${first.id}: ${sequenceReason}`])
    expect(unreplayableCases(manifest, "calibration")).toEqual([])
    expect(() => replayPlan(manifest, { split: "development" })).toThrow(
      `The development split has cases the replay cannot run yet:\n  ${first.id}: ${sequenceReason}`,
    )
    expect(replayPlan(manifest, { split: "calibration" })).toEqual(replayPlan(seed, { split: "calibration" }))
    // The seed holds none, so its plans are as they were.
    expect(unreplayableCases(seed, "development")).toEqual([])
    const path = join(root, "sequence-manifest.json")
    writeFileSync(path, JSON.stringify(manifest))
    const refused = await main(["--manifest", path])
    expect(refused).toEqual({
      code: 1,
      stdout: "",
      stderr: `The development split has cases the replay cannot run yet:\n  ${first.id}: ${sequenceReason}\n`,
    })
    expect((await main(["--manifest", path, "--split", "calibration"])).code).toBe(0)
  })

  test("the dry run lists the development cases and says nothing was sent", async () => {
    const result = await main([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("development case(s)")
    expect(result.stdout).toMatch(/Manifest sha256 [0-9a-f]{64}/)
    expect(result.stdout).toContain("Dry run: no model request was sent.")
  })
})

describe("replay checkouts", () => {
  test("are named by a digest of the case id, which the reviewer never sees", () => {
    const directory = checkoutDirectory(join(root, "prepared"), "hono-jwt-time-truncation")
    expect(dirname(directory)).toBe(join(root, "prepared"))
    expect(basename(directory)).toMatch(/^case-[0-9a-f]{16}$/)
    expect(directory).not.toContain("jwt")
    expect(checkoutDirectory(root, "a")).not.toBe(checkoutDirectory(root, "b"))
  })

  test("run no smudge filter, hook or other setting from the user's git config on the dataset's content", () => {
    // A dataset whose files ask for git-lfs, and a user whose global config would run a filter and hooks on them.
    const lfs = buildMirror(join(root, "lfs-mirror"), { ".gitattributes": "*.py filter=lfs diff=lfs merge=lfs\n" })
    const home = join(root, "home")
    const hooks = join(home, "hooks")
    const marker = join(root, "ran")
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch "${marker}-hook"\n`, { mode: 0o755 })
    writeFileSync(
      join(home, ".gitconfig"),
      `[core]\n\thooksPath = ${hooks}\n[filter "lfs"]\n\tsmudge = sh -c 'touch "${marker}-smudge" && cat'\n\trequired = true\n`,
    )
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = home
    try {
      const directory = join(root, "lfs-checkout")
      expect(
        prepareCheckout({ mirror: lfs.dir, view: { ...view, base: lfs.base, head: lfs.head }, directory }),
      ).toEqual([])
      expect(readFileSync(join(directory, "app.py"), "utf8")).toBe("def total(items):\n    return sum(items)\n")
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    expect(existsSync(`${marker}-hook`)).toBe(false)
    expect(existsSync(`${marker}-smudge`)).toBe(false)
  })

  test("hold the candidate and its history but not the fix, with the base checked out", () => {
    const directory = join(root, "checkout")
    expect(prepareCheckout({ mirror: mirror.dir, view, directory })).toEqual([])
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.head}^{commit}`).exitCode).toBe(0)
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.base}^{commit}`).exitCode).toBe(0)
    expect(inCheckout(directory, "cat-file", "-e", `${mirror.fix}^{commit}`).exitCode).not.toBe(0)
    expect(inCheckout(directory, "rev-parse", "HEAD").stdout.toString().trim()).toBe(mirror.base)
    expect(readFileSync(join(directory, "app.py"), "utf8")).toBe("def total(items):\n    return sum(items)\n")
    expect(inCheckout(directory, "remote").stdout.toString().trim()).toBe("")
  })

  test("refuse an existing directory, a remote URL and abbreviated commits", () => {
    expect(prepareCheckout({ mirror: mirror.dir, view, directory: mirror.dir })).toEqual([
      `${mirror.dir} already exists`,
    ])
    expect(prepareCheckout({ mirror: "https://github.com/example/fixture", view, directory: join(root, "a") })).toEqual(
      ["https://github.com/example/fixture is not a local mirror directory"],
    )
    expect(
      prepareCheckout({
        mirror: mirror.dir,
        view: { ...view, head: mirror.head.slice(0, 7) },
        directory: join(root, "b"),
      }),
    ).toEqual([`not full commit SHAs: ${mirror.head.slice(0, 7)}`])
  })
})

describe("replay admission", () => {
  // $10 total, $1 reserve, $3 per case: three cases fit.
  const limits: Limits = { totalUsd: 10, caseUsd: 3, reserveUsd: 1 }
  const priced = { id: "test/review", costKind: "priced" as const, price: { input: 3, output: 15 } }

  test("reserves the case's whole bound and hands it to Review.run as the review's cap", () => {
    const ledger = Ledger.open({ limits })
    const first = admitReplay(ledger, { id: "case-a", models: [priced] })
    if (!first.admitted) throw new Error(first.detail)
    expect(first.config).toEqual({ maxCostUsd: 3 })
    expect(first.ticket.reservedUsd).toBe(3)
    expect(ledger.summary().outstandingUsd).toBe(3)
    admitReplay(ledger, { id: "case-b", models: [priced] })
    admitReplay(ledger, { id: "case-c", models: [priced] })
    expect(admitReplay(ledger, { id: "case-d", models: [priced] })).toMatchObject({ admitted: false, reason: "budget" })
  })

  // Phase 1 review: the case key had no variant, so a variant's replay of a case hit the bound the frozen pipeline's
  // replay of it had reserved.
  test("admits the frozen pipeline and a variant on one case separately, each with its own bound and config", () => {
    const ledger = Ledger.open({ limits })
    const legacy = admitReplay(ledger, { id: "case-a", models: [priced] })
    const shared = admitReplay(ledger, { id: "case-a", models: [priced], variant: "engine:shared-verify" })
    if (!legacy.admitted || !shared.admitted) throw new Error("both replays should be admitted")
    // The variant's record goes to the replay as its variant, so the artifact names the variant it was admitted for.
    expect(legacy.config).toEqual({ maxCostUsd: 3 })
    expect(legacy.variant).toBeUndefined()
    expect(shared.config).toEqual({ maxCostUsd: 3 })
    expect(shared.variant).toEqual({ name: "engine:shared-verify", keys: { verifyPolicy: "shared" } })
    expect(ledger.summary().outstandingUsd).toBe(6)
    expect(ledger.entries.flatMap((entry) => (entry.type === "admit" ? [entry.case] : []))).toEqual([
      "engine test/review case-a#1",
      "engine:shared-verify test/review case-a#1",
    ])
    expect(replayVariant("engine")).toBe("engine")
    expect(replayVariant("engine", { verifyPolicy: "legacy" })).toBe("engine")
    expect(replayVariant("desktop", { verifyPolicy: "shared" })).toBe("desktop:shared-verify")
    expect(variantAdapter("engine:shared-verify")).toBe("engine")
    // A second replay of the same variant and case is still held to that case's one bound.
    expect(admitReplay(ledger, { id: "case-a", models: [priced], variant: "engine:shared-verify" })).toMatchObject({
      admitted: false,
      reason: "case",
    })
    // The frozen pipeline's own name is the frozen pipeline, under the same case.
    expect(admitReplay(ledger, { id: "case-a", models: [priced], variant: "engine" })).toMatchObject({
      admitted: false,
      reason: "case",
    })
  })

  // VS-21a: a name whose package has not landed would replay the frozen pipeline under its name.
  test("refuses a pending, unknown, malformed or desktop variant before the ledger sees it", () => {
    const ledger = Ledger.open({ limits })
    const before = ledger.entries.length
    for (const [variant, detail] of [
      ["engine:trivial-skip", "registered for VS-24 wiring, which has not landed"],
      ["desktop:cross-family", "registered for VS-29a's desktop half, after VS-10, which has not landed"],
      ["engine:verify", "not a registered variant"],
      ["engine:shared-verify=test/review", "is not a variant name"],
      ["desktop:shared-verify", "admitReplay admits engine replays"],
    ] as const)
      expect(admitReplay(ledger, { id: "case-a", models: [priced], variant })).toEqual({
        admitted: false,
        reason: "variant",
        detail: expect.stringContaining(detail),
      })
    expect(ledger.entries.length).toBe(before)
    expect(admitReplay(ledger, { id: "case-a", models: [priced] })).toMatchObject({ admitted: true })
  })

  // VS-29a: the cross-family variant is made by its models, the review model then a triage model other than it, and
  // the ledger's case key and model name the pair.
  const triage = { id: "test/triage", costKind: "priced" as const, price: { input: 1, output: 2 } }

  test("admits engine:cross-family with the review model then a distinct triage model, and records the pair", () => {
    const ledger = Ledger.open({ limits })
    const pair = admitReplay(ledger, { id: "case-a", models: [priced, triage], variant: "engine:cross-family" })
    if (!pair.admitted) throw new Error(pair.detail)
    expect(pair.config).toEqual({ maxCostUsd: 3 })
    expect(pair.variant).toEqual({ name: "engine:cross-family", keys: {}, models: "triage-pair" })
    const recorded = variantRecord("engine:cross-family")
    expect(recorded.ok && recorded.record).toEqual(pair.variant)
    expect(ledger.entries.flatMap((entry) => (entry.type === "admit" ? [[entry.case, entry.model]] : []))).toEqual([
      ["engine:cross-family test/review + test/triage case-a#1", "test/review + test/triage"],
    ])
  })

  test("refuses engine:cross-family without two distinct models, before the ledger sees it", () => {
    const ledger = Ledger.open({ limits })
    const before = ledger.entries.length
    const other = { ...triage, id: "test/other" }
    for (const models of [[priced], [priced, priced], [priced, triage, other], []])
      expect(admitReplay(ledger, { id: "case-a", models, variant: "engine:cross-family" })).toEqual({
        admitted: false,
        reason: "variant",
        detail: expect.stringContaining("engine:cross-family is made by its models"),
      })
    expect(ledger.entries.length).toBe(before)
    // The frozen pipeline with a triage model is unchanged: the pair check is the pair variant's alone.
    expect(admitReplay(ledger, { id: "case-a", models: [priced, triage] })).toMatchObject({ admitted: true })
    // A pair whose triage model has no price cannot be bounded, as for any other variant.
    const free = { id: "test/free", costKind: "free" as const }
    expect(admitReplay(ledger, { id: "case-b", models: [priced, free], variant: "engine:cross-family" })).toMatchObject(
      { admitted: false, reason: "unpriced" },
    )
  })

  test("refuses a model without a price, and the ledger stops admitting", () => {
    const ledger = Ledger.open({ limits })
    const free = { id: "test/free", costKind: "free" as const }
    expect(admitReplay(ledger, { id: "case-a", models: [priced, free] })).toMatchObject({
      admitted: false,
      reason: "unpriced",
    })
    expect(admitReplay(ledger, { id: "case-b", models: [priced] })).toMatchObject({ admitted: false, reason: "halted" })
  })

  test("settles at the attempts' reported cost and keeps unsettled or incomplete attempts as uncertain", () => {
    const attempts = [
      { admitted: true, estimateUsd: 0.4, settled: { costUsd: 0.3, complete: true } },
      { admitted: true, estimateUsd: 0.5, settled: { costUsd: 0.1, complete: false } },
      { admitted: true, estimateUsd: 0.2 },
      { admitted: false, estimateUsd: 0.9 },
    ]
    const charge = replayCharge(attempts)
    expect(charge.basis).toBe("replay")
    expect(charge.costUsd).toBeCloseTo(0.4)
    expect(charge.uncertainUsd).toBeCloseTo(0.6)

    const ledger = Ledger.open({ limits })
    const replay = admitReplay(ledger, { id: "case-a", models: [priced] })
    if (!replay.admitted) throw new Error(replay.detail)
    replay.settle({ attempts })
    const summary = ledger.summary()
    expect(summary.spentUsd).toBeCloseTo(0.4)
    expect(summary.uncertainUsd).toBeCloseTo(0.6)
    expect(summary.outstandingUsd).toBe(0)
  })

  test("a replay that produced no artifact keeps its whole bound, and a replay over its cap stops the ledger", () => {
    const ledger = Ledger.open({ limits })
    const failed = admitReplay(ledger, { id: "case-a", models: [priced] })
    if (!failed.admitted) throw new Error(failed.detail)
    expect(failed.settle()).toMatchObject({ uncertainUsd: 3, basis: "none" })
    const over = admitReplay(ledger, { id: "case-b", models: [priced] })
    if (!over.admitted) throw new Error(over.detail)
    over.settle({ attempts: [{ admitted: true, estimateUsd: 2.5, settled: { costUsd: 3.4, complete: true } }] })
    expect(ledger.summary().overshootUsd).toBeCloseTo(0.4)
    expect(admitReplay(ledger, { id: "case-c", models: [priced] })).toMatchObject({ admitted: false, reason: "halted" })
  })

  test("the dry run says how many cases a budget could admit", async () => {
    expect(replayBudget(4, limits)).toMatchObject({ worstUsd: 12, admissibleUsd: 9, fit: 3 })
    const result = await main(["--budget-usd", "50", "--case-budget-usd", "0.75"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Each case reserves its $0.7500 bound before it starts")
    expect((await main(["--budget-usd", "50"])).code).toBe(2)
    expect((await main(["--budget-usd", "1", "--case-budget-usd", "5"])).code).toBe(2)
  })
})

// VS-21a: every variant name maps to its settings, and a name whose package has not landed is refused, never run as
// the frozen pipeline.
describe("the variant registry", () => {
  const entries: [string, VariantEntry][] = Object.entries(VARIANTS)

  test("names the contract's variants by runner and suffix, with no '=' and no model id", () => {
    expect(variantNames("engine")).toEqual([
      "engine",
      "engine:shared-verify",
      "engine:privacy-zdr",
      "engine:trivial-skip",
      "engine:impact-graph",
      "engine:cards-brain",
      "engine:guardrail-strict",
      "engine:depth-auto",
      "engine:lenses-high",
      "engine:cross-family",
      "engine:precise",
      // Addendum A §1a's, for the packages whose first part has landed.
      "engine:holdback-secrets",
      "engine:team-guarded",
      "engine:scope-introduced",
      "engine:rule-strict",
      "engine:verify-cert",
      "engine:explore-slice",
    ])
    for (const adapter of ["engine", "desktop"] as const)
      for (const name of variantNames(adapter)) {
        expect(name).toMatch(VARIANT_NAME)
        expect(name).not.toContain("=")
        expect(variantAdapter(name)).toBe(adapter)
      }
  })

  test("old names still resolve, and a variant's record names it again", () => {
    expect(resolveVariant("engine")).toEqual({ ok: true, name: "engine", adapter: "engine", keys: {}, frozen: true })
    for (const [adapter, name] of [
      ["engine", "engine:shared-verify"],
      ["desktop", "desktop:shared-verify"],
    ] as const) {
      const resolved = resolveVariant(name)
      expect(resolved).toEqual({
        ok: true,
        name,
        adapter,
        keys: { verifyPolicy: "shared" },
        frozen: false,
      })
      if (!resolved.ok) continue
      const record = { name: resolved.name, keys: resolved.keys }
      expect(replayVariant(resolved.adapter, record)).toBe(name)
      expect(variantProblems(resolved.adapter, record)).toEqual([])
    }
    expect(resolveVariant("desktop")).toMatchObject({ ok: true, frozen: true })
    // VS-06's records, in artifacts written before VS-21a, name the same runs.
    expect(replayVariant("engine")).toBe("engine")
    expect(replayVariant("engine", { verifyPolicy: "legacy" })).toBe("engine")
    expect(replayVariant("engine", { verifyPolicy: "shared" })).toBe("engine:shared-verify")
    expect(replayVariant("desktop", { verifyPolicy: "shared", applied: false })).toBe("desktop:shared-verify")
    expect(variantProblems("engine", { verifyPolicy: "shared" })).toEqual([])
  })

  test("a built half sets keys its runner applies, and a pending half names the package it waits for", () => {
    const built = entries.flatMap(([suffix, entry]) =>
      (["engine", "desktop"] as const).flatMap((adapter) =>
        "from" in entry[adapter] ? [{ name: `${adapter}:${suffix}`, adapter, entry }] : [],
      ),
    )
    expect(built.map((item) => item.name)).toEqual([
      "engine:shared-verify",
      "desktop:shared-verify",
      "engine:cross-family",
    ])
    for (const item of built) {
      const keys = Object.keys(item.entry.keys ?? {})
      expect(keys.length > 0 || item.entry.models !== undefined).toBe(true)
      const allowed: readonly string[] = VARIANT_KEYS[item.adapter]
      for (const key of keys) expect(allowed).toContain(key)
    }
    const pending = entries.flatMap(([suffix, entry]) =>
      (["engine", "desktop"] as const).flatMap((adapter) => {
        const half = entry[adapter]
        return "pending" in half ? [{ name: `${adapter}:${suffix}`, package: half.pending }] : []
      }),
    )
    expect(pending).toHaveLength(2 * entries.length - 3)
    for (const item of pending)
      expect(resolveVariant(item.name)).toEqual({
        ok: false,
        reason: "pending",
        package: item.package,
        detail: expect.stringContaining("so it is refused"),
      })
    // Each pending engine half names the package that wires its key into the runner, not one that only adds its type.
    expect(
      Object.fromEntries(
        pending.filter((item) => item.name.startsWith("engine:")).map((item) => [item.name, item.package]),
      ),
    ).toEqual({
      "engine:privacy-zdr": "VS-23c",
      "engine:trivial-skip": "VS-24 wiring",
      "engine:impact-graph": "VS-25b wiring",
      "engine:cards-brain": "VS-26",
      "engine:guardrail-strict": "VS-27c",
      "engine:depth-auto": "VS-28 wiring",
      "engine:lenses-high": "VS-28 wiring",
      "engine:precise": "VS-31",
      "engine:holdback-secrets": "VS-34 wiring",
      "engine:team-guarded": "VS-35 wiring",
      "engine:scope-introduced": "VS-42 wiring",
      "engine:rule-strict": "VS-43 wiring",
      "engine:verify-cert": "VS-44 wiring",
      "engine:explore-slice": "VS-49 wiring",
    })
    // Addendum A's entries are pending on both runners and set no key yet, and an addendum name whose package has not
    // begun here is still unknown.
    for (const suffix of [
      "holdback-secrets",
      "team-guarded",
      "scope-introduced",
      "rule-strict",
      "verify-cert",
      "explore-slice",
    ] as const) {
      const entry: VariantEntry = VARIANTS[suffix]
      expect(Object.hasOwn(entry, "keys") || Object.hasOwn(entry, "models")).toBe(false)
      expect(resolveVariant(`desktop:${suffix}`)).toMatchObject({ ok: false, reason: "pending" })
    }
    expect(resolveVariant("engine:rereview-focused")).toMatchObject({ ok: false, reason: "unknown" })
    // The cross-family pair is made by its models, never by a key. Its engine half is built (VS-29a); its desktop half
    // waits for VS-10, since the desktop adapter takes one model and refuses a keyless variant.
    expect(VARIANTS["cross-family"]).toMatchObject({ models: "triage-pair" })
    expect(Object.hasOwn(VARIANTS["cross-family"], "keys")).toBe(false)
    expect(resolveVariant("engine:cross-family")).toEqual({
      ok: true,
      name: "engine:cross-family",
      adapter: "engine",
      keys: {},
      models: "triage-pair",
      frozen: false,
    })
    expect(pending).toContainEqual({ name: "desktop:cross-family", package: "VS-29a's desktop half, after VS-10" })
  })

  test("a variant made by its models needs the review model, then a triage model other than it (VS-29a)", () => {
    const pair = { name: "engine:cross-family", keys: {}, models: "triage-pair" as const }
    expect(variantProblems("engine", pair)).toEqual([])
    expect(variantProblems("engine", { name: pair.name, keys: {} })).toEqual([
      'its variant engine:cross-family set {"keys":{}}, not the registry\'s {"keys":{},"models":"triage-pair"}',
    ])
    expect(variantProblems("engine", { ...pair, keys: { verifyPolicy: "shared" } })).toHaveLength(1)
    expect(triagePairProblem("engine:cross-family", ["a/review", "b/triage"])).toBeUndefined()
    for (const [models, named] of [
      [["a/review"], "a/review"],
      [["a/review", "a/review"], "a/review + a/review"],
      [[], "no model"],
      [["a/review", "b/triage", "c/other"], "a/review + b/triage + c/other"],
    ] as const)
      expect(triagePairProblem("engine:cross-family", models)).toBe(
        `engine:cross-family is made by its models: it needs the review model, then a triage model other than it, not ${named}.`,
      )
    // A tripwire, not wanted behaviour: two models of one lab pass today, because the same-lab refusal waits for
    // codium's labOf (contract §0.5) and no stopgap was built. When labOf merges, this pair is refused and this line
    // changes with it.
    expect(triagePairProblem("engine:cross-family", ["vendor-a/x", "vendor-a/y"])).toBeUndefined()
  })

  test("refuses malformed names and names it does not know, prototype names included", () => {
    for (const name of [
      "",
      "engine=vendor/model",
      "engine:shared-verify=vendor/model",
      "engine/shared-verify",
      "Engine",
      "engine:",
      "engine::shared-verify",
      "engine:shared-verify:x",
      " engine",
      "engine:Shared-verify",
      "engine:shared_verify",
      "engine:__proto__",
    ])
      expect(resolveVariant(name)).toMatchObject({ ok: false, reason: "malformed" })
    for (const name of ["codium", "codium:shared-verify", "constructor", "engine:constructor", "engine:tostring"])
      expect(resolveVariant(name)).toMatchObject({ ok: false, reason: "unknown" })
  })

  test("checks an artifact's record against the registry", () => {
    expect(variantProblems("engine")).toEqual([])
    expect(variantProblems("engine", { name: "engine:shared-verify", keys: { verifyPolicy: "legacy" } })).toEqual([
      'its variant engine:shared-verify set {"keys":{"verifyPolicy":"legacy"}}, not the registry\'s {"keys":{"verifyPolicy":"shared"}}',
    ])
    expect(
      variantProblems("engine", {
        name: "engine:shared-verify",
        keys: { verifyPolicy: "shared" },
        models: "triage-pair",
      }),
    ).toHaveLength(1)
    expect(variantProblems("engine", { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" } })).toEqual([
      "its variant desktop:shared-verify is another runner's, not engine's",
    ])
    expect(variantProblems("engine", { name: "engine", keys: {} })).toEqual([
      "its variant record names the frozen pipeline, engine, which has none",
    ])
    expect(variantProblems("engine", { name: "engine:trivial-skip", keys: {} })[0]).toContain(
      "registered for VS-24 wiring",
    )
    expect(variantProblems("engine", { name: "engine:bogus", keys: {} })[0]).toContain("not a registered variant")
    // A pending name carrying a built variant's keys, which ReviewEval.replay would run, is still pending.
    expect(variantProblems("engine", { name: "engine:privacy-zdr", keys: { verifyPolicy: "shared" } })[0]).toContain(
      "engine:privacy-zdr is registered for VS-23c, which has not landed",
    )
  })

  test("reads a hand-edited record that is not an object, or has no string name, without throwing", () => {
    // An artifact is untrusted JSON: what its variant holds is not known to be a record.
    const untyped = (value: unknown) => value as ReplayVariant
    for (const value of ["engine:shared-verify", 1, true, null]) {
      expect(replayVariant("engine", untyped(value))).toBe("engine")
      expect(variantProblems("engine", untyped(value))).toEqual(["its variant record is not an object"])
    }
    expect(replayVariant("engine", untyped({ name: 1, keys: {} }))).toBe("engine")
    expect(variantProblems("engine", untyped({ name: 1, keys: {} }))).toEqual([
      "its variant record's name is not a string",
    ])
    expect(variantProblems("engine", untyped({ name: "engine:shared-verify" }))[0]).toContain("not the registry's")
  })
})

// The desktop runner on the same kind of case the engine replay test uses, through a fake client: no engine server,
// no Electron and no model. A paid desktop replay is not wired.
describe("the desktop replay", () => {
  const LABEL = "example-fixture-label-91c2"
  const planned: PlannedReplay = {
    id: LABEL,
    split: "development",
    case: {
      label: LABEL,
      base: mirror.base,
      head: mirror.head,
      trust: "untrusted",
      trigger: "command",
      repository: { owner: "example", repo: "fixture", url: view.repository },
    },
  }
  const model: ReviewModel = {
    providerID: "test",
    modelID: "reviewer",
    context: 100_000,
    price: { input: 3, output: 15 },
    costKind: "priced",
  }
  const bug = {
    path: "app.py",
    line: 2,
    severity: "blocking",
    category: "bug",
    title: "The first item is left out of the total",
    body: "items[1:] skips the first item, so total() under-counts.",
    confidence: 0.95,
  }
  const answer = (structured: unknown): ReviewMessage => ({
    info: {
      role: "assistant",
      providerID: "test",
      modelID: "reviewer",
      cost: 0.004,
      tokens: { input: 1_200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
      structured,
    },
    parts: [],
  })

  // A stand-in for the SDK client on an engine server whose instance is the prepared checkout, at the base.
  function fakeClient(directory: string, findings: object[] = [bug]) {
    const prompts: string[] = []
    const replies = new Map<string, ReviewMessage[]>()
    let sessions = 0
    const client: ReviewClient = {
      session: {
        create: async () => ({ data: { id: `ses_${++sessions}` } }),
        prompt: async (input) => {
          const text = (input.parts ?? []).map((part) => part.text).join("\n")
          prompts.push(text)
          const message =
            input.format?.schema === VERIFY_JSON_SCHEMA
              ? answer({
                  results: [...text.matchAll(/<untrusted_candidate id="([^"]+)"/g)].map((match) => ({
                    id: match[1],
                    verdict: "confirmed",
                    reason: "Checked against the code.",
                  })),
                })
              : answer({
                  summary: "total() now skips the first item.",
                  risk: "high",
                  files: [{ path: "app.py", note: "slice" }],
                  findings,
                })
          replies.set(input.sessionID, [...(replies.get(input.sessionID) ?? []), message])
          return { data: message }
        },
        update: async () => ({ data: true }),
        abort: async () => ({ data: true }),
        messages: async (input) => ({ data: replies.get(input.sessionID) ?? [] }),
      },
      file: {
        read: async ({ path }) => {
          const file = join(directory, path)
          return { data: { type: "text", content: existsSync(file) ? readFileSync(file, "utf8") : "" } }
        },
      },
      vcs: { get: async () => ({ data: { branch: undefined } }) },
    }
    return { client, prompts }
  }

  test("runs the desktop runner through a recording client and keeps the engine replay's artifact shape", async () => {
    const directory = checkoutDirectory(join(root, "desktop"), planned.id)
    expect(prepareCheckout({ mirror: mirror.dir, view, directory })).toEqual([])
    const diff = candidateDiff(directory, view)
    expect(diff).toContain("+    return sum(items[1:])")
    const fake = fakeClient(directory)

    const artifact = await desktopReplay({
      planned,
      directory,
      diff,
      model,
      client: fake.client,
      source: { vector: "a".repeat(40), manifest: "b".repeat(64) },
      now: () => Date.UTC(2026, 10, 4),
    })

    expect(artifact.error).toBeUndefined()
    expect(artifact).toMatchObject({
      version: 1,
      label: LABEL,
      adapter: "desktop",
      repetition: 1,
      source: { repository: view.repository, base: mirror.base, head: mirror.head, vector: "a".repeat(40) },
      // The checkout is at the base, so the runner rebuilt the change from the diff and trusted neither.
      trust: "untrusted",
      authored: "untrusted",
      models: { review: { id: "test/reviewer", costKind: "priced", price: { input: 3, output: 15 } } },
    })
    // What a model certificate made from this replay would cover (VS-07): the desktop runner under the defaults.
    expect(artifact.scope).toEqual(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }))
    // The final placed findings, where the desktop would put them, as the engine replay records them.
    expect(artifact.placed.map((item) => [item.path, item.line, item.side, item.source, item.verified])).toEqual([
      ["app.py", 2, "RIGHT", "review", true],
    ])
    // Every prompt, by pass and digest, with what it reported spending.
    expect(artifact.attempts.map((attempt) => [attempt.pass, attempt.format, attempt.answered])).toEqual([
      ["vectorscope.review", "report", true],
      ["vectorscope.verify", "verify", true],
    ])
    for (const attempt of artifact.attempts) {
      expect(attempt.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(attempt.model).toBe("test/reviewer")
      expect(attempt).toMatchObject({ costUsd: 0.004, tokens: { input: 1_200, output: 80 } })
    }
    expect(artifact.passes).toHaveLength(2)
    expect(artifact.sessions.map((session) => session.pass)).toEqual(["vectorscope.review", "vectorscope.verify"])
    // What Post would send, recorded and never sent.
    expect(artifact.proposed?.untrusted).toBe(true)
    expect(artifact.proposed?.comments.map((comment) => [comment.path, comment.line])).toEqual([["app.py", 2]])
    // The case id names the artifact only: no prompt, session or directory the runner saw carries it.
    for (const text of fake.prompts) expect(text).not.toContain(LABEL)
    expect(JSON.stringify(artifact.sessions)).not.toContain(LABEL)
    expect(directory).not.toContain(LABEL)
    // And nothing of the fix is reachable from what the runner read.
    for (const text of fake.prompts) expect(text).not.toContain("every item counts")
  })

  test("records a failed run instead of throwing", async () => {
    const broken: ReviewClient = {
      ...fakeClient(root).client,
      session: {
        ...fakeClient(root).client.session,
        create: async () => Promise.reject(new Error("the engine server is gone")),
      },
    }
    const artifact = await desktopReplay({ planned, directory: root, diff: "", model, client: broken })
    expect(artifact.outcome).toBeUndefined()
    expect(artifact.error).toContain("no changes to review")
    expect(artifact.placed).toEqual([])
  })

  // VS-21c: each prompt call's start and duration, on the replay's clock, closing VS-21a's per-pass timing deferral.
  test("times each prompt call from the first one's start, and its passes carry the same times", async () => {
    const directory = checkoutDirectory(join(root, "desktop-timed"), planned.id)
    expect(prepareCheckout({ mirror: mirror.dir, view, directory })).toEqual([])
    const clock = { now: 1_000 }
    const artifact = await desktopReplay({
      planned,
      directory,
      diff: candidateDiff(directory, view),
      model,
      client: fakeClient(directory).client,
      now: () => (clock.now += 10),
    })
    expect(artifact.error).toBeUndefined()
    const [review, verify] = artifact.attempts
    expect(review?.startMs).toBe(0)
    expect(review?.ms).toBeGreaterThan(0)
    expect(verify?.startMs).toBeGreaterThanOrEqual((review?.startMs ?? 0) + (review?.ms ?? 0))
    expect(verify?.ms).toBeGreaterThan(0)
    expect(artifact.passes.map((entry) => [entry.pass, entry.startMs, entry.ms])).toEqual(
      artifact.attempts.map((attempt) => [attempt.pass, attempt.startMs, attempt.ms]),
    )
  })

  // VS-06: the verify policy replayed as a variant, as the engine replay takes it, so both runners can be compared.
  test("replays a verify policy variant as the case's own review.json would carry it, keeping the base's verify", async () => {
    // The base sets "verify": "blocking", which the desktop's legacy rule reads as "all" and the shared policy does not.
    const settled = buildMirror(join(root, "mirror-settings"), { ".vector/review.json": '{"verify":"blocking"}' })
    const caseView = { repository: view.repository, base: settled.base, head: settled.head }
    const concern = { ...bug, severity: "concern", title: "total() of an empty list is not tested" }
    const replay = async (name: string, variant?: Pick<VariantRecord, "name" | "keys">) => {
      const directory = checkoutDirectory(join(root, `desktop-${name}`), planned.id)
      expect(prepareCheckout({ mirror: settled.dir, view: caseView, directory })).toEqual([])
      return desktopReplay({
        planned: { ...planned, case: { ...planned.case, base: settled.base, head: settled.head } },
        directory,
        diff: candidateDiff(directory, caseView),
        model,
        client: fakeClient(directory, [bug, concern]).client,
        ...(variant ? { variant } : {}),
      })
    }
    const legacy = await replay("legacy")
    const resolved = resolveVariant("desktop:shared-verify")
    if (!resolved.ok) throw new Error(resolved.detail)
    const shared = await replay("shared", { name: resolved.name, keys: resolved.keys })
    for (const artifact of [legacy, shared]) expect(artifact.error).toBeUndefined()
    expect(legacy.variant).toBeUndefined()
    expect(shared.variant).toEqual({ name: "desktop:shared-verify", keys: { verifyPolicy: "shared" }, applied: true })
    expect(variantProblems("desktop", shared.variant)).toEqual([])
    // A variant the desktop runner does not apply in full, or one that sets nothing, is not handed to it: the run is
    // the frozen pipeline's, and the artifact says so.
    for (const [index, variant] of [
      { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" as const, nits: true } },
      { name: "desktop:trivial-skip", keys: {} },
      { name: "desktop:shared-verify", keys: { verifyPolicy: undefined } },
    ].entries()) {
      const unapplied = await replay(`unapplied-${index}`, variant)
      expect(unapplied.error).toBeUndefined()
      expect(unapplied.variant).toEqual({ ...variant, applied: false })
      expect(unapplied.scope).toEqual(legacy.scope)
      expect(unapplied.outcome?.verification).toEqual(legacy.outcome?.verification)
    }
    // Each artifact's evidence scope is of the settings the runner read: the base's, with the variant over them.
    const settings = (json: object) => parseReviewConfig({ json: JSON.stringify(json), trigger: "desktop" }).config
    expect(legacy.scope).toEqual(evidenceScope({ adapter: "desktop", config: settings({ verify: "blocking" }) }))
    expect(shared.scope).toEqual(
      evidenceScope({ adapter: "desktop", config: settings({ verify: "blocking", verifyPolicy: "shared" }) }),
    )
    expect(shared.scope.policy).not.toBe(legacy.scope.policy)
    // Legacy double-checks both findings; under the shared policy the base's "blocking" means blocking.
    expect(legacy.outcome?.verification).toEqual({ checked: 2, rejected: 0, status: "ok" })
    expect(shared.outcome?.verification).toEqual({ checked: 1, rejected: 0, status: "ok" })
    expect(legacy.placed.map((item) => [item.severity, item.verified])).toEqual([
      ["blocking", true],
      ["concern", true],
    ])
    expect(shared.placed.map((item) => [item.severity, item.verified])).toEqual([
      ["blocking", true],
      ["concern", false],
    ])
  })

  // Phase 1 review: the wrapper used to answer every read of review.json, the changed file's own reads included.
  test("a case whose change edits review.json gets no variant: its own text, the default settings, applied false", async () => {
    const edited = buildMirror(
      join(root, "mirror-edits-settings"),
      { ".vector/review.json": '{"verify":"blocking"}\n' },
      { ".vector/review.json": '{"verify":"off"}\n' },
    )
    const caseView = { repository: view.repository, base: edited.base, head: edited.head }
    const replay = async (name: string, variant?: Pick<VariantRecord, "name" | "keys">) => {
      const directory = checkoutDirectory(join(root, `desktop-edits-${name}`), planned.id)
      expect(prepareCheckout({ mirror: edited.dir, view: caseView, directory })).toEqual([])
      const fake = fakeClient(directory)
      const artifact = await desktopReplay({
        planned: { ...planned, case: { ...planned.case, base: edited.base, head: edited.head } },
        directory,
        diff: candidateDiff(directory, caseView),
        model,
        client: fake.client,
        ...(variant ? { variant } : {}),
      })
      return { artifact, prompts: fake.prompts }
    }
    const legacy = await replay("legacy")
    const shared = await replay("shared", { name: "desktop:shared-verify", keys: { verifyPolicy: "shared" } })
    for (const run of [legacy, shared]) expect(run.artifact.error).toBeUndefined()
    expect(legacy.artifact.variant).toBeUndefined()
    expect(shared.artifact.variant).toEqual({
      name: "desktop:shared-verify",
      keys: { verifyPolicy: "shared" },
      applied: false,
    })
    // The runner ran under the defaults, and the scope says so, not the base's file or the variant.
    for (const run of [legacy, shared])
      expect(run.artifact.scope).toEqual(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }))
    // The changed file is rebuilt from its own text, as without the variant, so both runs review the same change.
    const settingsFile = (run: typeof legacy) =>
      run.artifact.outcome?.checkout.headFiles.find((file) => file.path === ".vector/review.json")
    expect(settingsFile(shared)).toEqual({ path: ".vector/review.json", text: '{"verify":"off"}\n', exact: true })
    expect(shared.artifact.outcome?.checkout).toEqual(legacy.artifact.outcome?.checkout)
    expect(shared.prompts).toEqual(legacy.prompts)
  })

  test("the variant's settings go over the file's own, and the artifact says whether the runner read them", async () => {
    const files: Record<string, string> = {
      ".vector/review.json": '﻿{"verify":"off","verifyPolicy":"legacy"}',
      "app.py": "print(1)\n",
    }
    const inner = fakeClient(root).client
    const settings = (text: string | undefined) =>
      withReviewSettings(
        {
          ...inner,
          file: { read: async ({ path }) => ({ data: { type: "text", content: text ?? files[path] ?? "" } }) },
        },
        { verifyPolicy: "shared" },
      )
    const read = async (client: ReturnType<typeof settings>, path: string) =>
      (await client.client.file.read({ path })).data?.content
    const kept = settings(undefined)
    expect(kept.served()).toBe(false)
    expect(await read(kept, "app.py")).toBe("print(1)\n")
    expect(kept.served()).toBe(false)
    expect(JSON.parse((await read(kept, ".vector/review.json"))!)).toEqual({ verify: "off", verifyPolicy: "shared" })
    expect(kept.served()).toBe(true)
    // Only the first read is the settings read; a later one, such as a finding naming the file, gets the file as it is.
    expect(await read(kept, ".vector/review.json")).toBe(files[".vector/review.json"])
    // A missing file, or one that is not a JSON object, reads as the variant's keys alone.
    for (const text of ["", "not json", "[1, 2]"])
      expect(JSON.parse((await read(settings(text), ".vector/review.json"))!)).toEqual({ verifyPolicy: "shared" })
  })
})

describe("projection records (VS-21b)", () => {
  const pass = (name: ProjectedPass["pass"], overrides: Partial<ProjectedPass> = {}): ProjectedPass => ({
    pass: name,
    model: "lmstudio/test-model",
    maxSteps: name === "verify" ? 10 : 15,
    status: "ok",
    digest: "d".repeat(64),
    chars: 1_000,
    requests: [
      {
        seq: 1,
        phase: "turn",
        estimateUsd: 0.01,
        digest: "e".repeat(64),
        chars: 13,
        tokens: 4,
        stepUsd: 0.001,
        body: '{"model":"m"}',
      },
    ],
    promptTokens: 4,
    usd: { low: 0.01, high: 0.05 },
    unsent: 0,
    unadmitted: 0,
    ...overrides,
  })
  const record = (overrides: Partial<ProjectionRecord> = {}): ProjectionRecord => ({
    version: 1,
    kind: "projection",
    label: "case",
    repetition: 1,
    runtime: {
      node: "v22",
      platform: "linux",
      arch: "x64",
      isolation: { pure: true, projectConfig: false, trusted: false, lsp: false, formatter: false, snapshot: false },
    },
    source: { base: "a".repeat(40), head: "b".repeat(40), mergeBase: "a".repeat(40) },
    trust: "untrusted",
    trigger: "command",
    config: { digest: "c".repeat(64) },
    scope: evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG }),
    rules: { digest: "f".repeat(64) },
    context: { digest: "0".repeat(64) },
    models: {
      review: { id: "lmstudio/test-model", context: 100_000, costKind: "priced", price: { input: 1, output: 1 } },
    },
    files: { reviewed: ["src/a.ts"], skipped: [] },
    cap: { maxCostUsd: 1, over: [] },
    passes: [pass("review"), pass("security"), pass("verify")],
    unattributed: 0,
    egress: { attempts: 3, outside: 0 },
    ...overrides,
  })

  test("a whole projection has no problem, and the decisions the cap refused are not one", () => {
    expect(projectionProblems(record())).toEqual([])
    expect(
      projectionProblems(
        record({
          cap: { maxCostUsd: 0.001, over: [{ pass: "review", phase: "turn", site: "pass", estimateUsd: 0.01 }] },
        }),
      ),
    ).toEqual([])
    expect(
      projectionProblems(record({ variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } } })),
    ).toEqual([])
  })

  test("names what keeps a record from showing every pass's body", () => {
    const [request] = pass("review").requests
    if (!request) throw new Error("expected a request")
    expect(projectionProblems(null)).toEqual(["the projection is not an object"])
    expect(projectionProblems({ ...record(), kind: "replay" })).toEqual(["it is not a version 1 projection record"])
    expect(projectionProblems({ ...record(), passes: "all" })).toEqual(["its passes are not a list"])
    expect(projectionProblems(record({ passes: [] }))).toEqual(["it planned no pass for 1 reviewed files"])
    expect(projectionProblems(record({ passes: [], files: { reviewed: [], skipped: [] } }))).toEqual([])
    // A record with no pass and no files to tell it planned none for nothing.
    const { files: _files, ...unfiled } = record({ passes: [] })
    expect(projectionProblems(unfiled)).toEqual(["its files are not a record"])
    expect(projectionProblems({ ...record({ passes: [] }), files: { reviewed: "src/a.ts" } })).toEqual([
      "its files are not a record",
    ])
    expect(
      projectionProblems(record({ passes: [pass("review"), pass("verify", { status: "skipped", requests: [] })] })),
    ).toEqual(["verify sent no request, so its body was not projected"])
    expect(projectionProblems(record({ passes: [pass("review", { status: "stopped" })] }))).toEqual([
      "review did not finish (stopped)",
    ])
    expect(projectionProblems(record({ passes: [pass("review", { status: undefined })] }))).toEqual([
      "review did not finish (undefined)",
    ])
    expect(projectionProblems(record({ passes: [pass("review", { requests: [{ ...request, body: "" }] })] }))).toEqual([
      "review's request 1 has no body",
    ])
    expect(projectionProblems(record({ passes: [pass("review", { requests: [{ ...request, chars: 99 }] })] }))).toEqual(
      ["review's request 1 does not count its body's characters"],
    )
    expect(projectionProblems(record({ passes: [pass("review", { usd: undefined })] }))).toEqual([
      "review has no dollar estimate (no price snapshot)",
    ])
    expect(projectionProblems(record({ passes: [pass("review", { unsent: 1, unadmitted: 2 })] }))).toEqual([
      "review has 1 admitted attempts no request carried",
      "review sent 2 requests no admitted attempt accounts for",
    ])
    expect(projectionProblems(record({ unattributed: 1 }))).toEqual(["1 requests name no session any attempt names"])
    const { unattributed: _unattributed, ...uncounted } = record()
    expect(projectionProblems(uncounted)).toEqual(["it has no unattributed count"])
    expect(projectionProblems(record({ egress: { attempts: 4, outside: 1 } }))).toEqual([
      "1 connections went outside this computer",
    ])
    const { egress: _egress, ...unguarded } = record()
    expect(projectionProblems(unguarded)).toEqual(["it has no egress record"])
    expect(projectionProblems({ ...record(), egress: { outside: 0 } })).toEqual(["it has no egress record"])
    // Zero outside means nothing from a log that saw none of the passes' requests: Vector Local's guard, installed
    // while Vector Local is off, logs nothing.
    expect(projectionProblems(record({ egress: { attempts: 0, outside: 0 } }))).toEqual([
      "its egress log saw none of its 3 requests, so no strict guard recorded the run",
    ])
    expect(
      projectionProblems(
        record({ passes: [], files: { reviewed: [], skipped: [] }, egress: { attempts: 0, outside: 0 } }),
      ),
    ).toEqual([])
    // A pending variant's name carrying a built one's keys is the registry's problem, as in report.ts.
    const pending = { name: "engine:privacy-zdr", keys: { verifyPolicy: "shared" as const } }
    expect(variantProblems("engine", pending)).not.toEqual([])
    expect(projectionProblems(record({ variant: pending }))).toEqual(variantProblems("engine", pending))
  })

  // VS-21c: what the report reads of a record, summed over its passes.
  test("a projected run sums its passes' dollars and tokens and names its variant, case and models", () => {
    const capped = record({
      variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } },
      cap: { maxCostUsd: 0.001, over: [{ pass: "review", phase: "turn", site: "pass", estimateUsd: 0.01 }] },
      passes: [pass("review"), pass("verify", { usd: { low: 0.02, high: 0.1 }, promptTokens: 6 })],
    })
    const projected = projectedRun(capped)
    expect(projected).toEqual({
      variant: "engine:shared-verify",
      model: "lmstudio/test-model",
      models: ["lmstudio/test-model"],
      case: "case",
      repetition: 1,
      usd: { low: expect.any(Number), high: expect.any(Number) },
      tokens: { first: 10, sent: 8 },
      passes: 2,
      requests: 2,
      over: 1,
      outside: 0,
    })
    expect(projected.usd.low).toBeCloseTo(0.03)
    expect(projected.usd.high).toBeCloseTo(0.15)
    expect(projectedRun(record()).variant).toBe("engine")
  })

  // VS-21e: what report.ts and the entry point's --cost-split read of a record, each pass at its own model's price.
  test("projected pass costs split each priced pass's bands by kind, adding up to the pass and to the run", () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const triagePrice = { input: 1.25, output: 10, cacheRead: 0.125 }
    const triage = { id: "lmstudio/triage-model", context: 100_000, costKind: "priced" as const, price: triagePrice }
    const banded = (name: ProjectedPass["pass"], model: string, promptTokens: number, maxSteps: number) =>
      pass(name, {
        model,
        maxSteps,
        promptTokens,
        usd: estimateCostUsd({ promptTokens, maxSteps, price: model === triage.id ? triagePrice : price }),
      })
    const { promptTokens: _promptTokens, usd: _usd, ...unpriced } = pass("lens")
    const priced = record({
      variant: { name: "engine:cross-family", keys: {}, models: "triage-pair" },
      models: { review: { ...record().models.review, price }, triage },
      passes: [
        banded("review", triage.id, 5000, 15),
        banded("security", triage.id, 4200, 10),
        banded("verify", "lmstudio/test-model", 3100, 10),
        unpriced,
      ],
    })
    const costs = projectedPassCosts(priced)
    expect(costs.map((entry) => [entry.variant, entry.model, entry.case, entry.repetition, entry.pass])).toEqual([
      ["engine:cross-family", "lmstudio/test-model", "case", 1, "review"],
      ["engine:cross-family", "lmstudio/test-model", "case", 1, "security"],
      ["engine:cross-family", "lmstudio/test-model", "case", 1, "verify"],
    ])
    const total = (kinds: Record<(typeof TOKEN_KINDS)[number], number>) =>
      TOKEN_KINDS.reduce((sum, kind) => sum + kinds[kind], 0)
    for (const [index, entry] of costs.entries()) {
      if (entry.basis !== "projected") throw new Error("expected a projected pass")
      const usd = priced.passes[index].usd!
      expect(total(entry.cached)).toBe(usd.low)
      expect(total(entry.uncached)).toBe(usd.high)
    }
    const run = projectedRun(priced)
    expect(costs.reduce((sum, entry) => sum + (entry.basis === "projected" ? total(entry.cached) : 0), 0)).toBeCloseTo(
      run.usd.low,
      12,
    )
    expect(
      costs.reduce((sum, entry) => sum + (entry.basis === "projected" ? total(entry.uncached) : 0), 0),
    ).toBeCloseTo(run.usd.high, 12)
    // The triage model's passes read its cache rate; verify reads the review model's.
    const [review, , verify] = costs
    if (review?.basis !== "projected" || verify?.basis !== "projected") throw new Error("expected projected passes")
    expect(review.cached.cacheRead).toBeCloseTo((4 * 5000 * 0.125) / 1_000_000, 15)
    expect(verify.cached.cacheRead).toBeCloseTo((4 * 3100 * 0.3) / 1_000_000, 15)
    // A pass whose model has no price snapshot in the record has no estimate, and so no split.
    expect(projectedPassCosts(record({ passes: [pass("review", { model: "lmstudio/other-model" })] }))).toEqual([])
    // A hand-edited record whose steps, prompt tokens or rates are not finite numbers of 0 or more passes
    // projectionProblems, which reads none of them, but has no split, rather than a $NaN one.
    const edited = (changes: Record<string, unknown>, rates: Record<string, unknown> = {}) =>
      record({
        models: { review: { ...record().models.review, price: { ...price, ...rates } } },
        passes: [{ ...banded("verify", "lmstudio/test-model", 3100, 10), ...changes }],
      } as unknown as Partial<ProjectionRecord>)
    expect(projectedPassCosts(edited({}))).toHaveLength(1)
    for (const malformed of [
      edited({ maxSteps: "10" }),
      edited({ promptTokens: Number.NaN }),
      edited({ promptTokens: -1 }),
      edited({}, { input: "3" }),
      edited({}, { output: Number.POSITIVE_INFINITY }),
      edited({}, { cacheRead: null }),
      edited({}, { cacheWrite: -0.5 }),
    ]) {
      expect(projectionProblems(malformed)).toEqual([])
      expect(projectedPassCosts(malformed)).toEqual([])
    }
  })

  // VS-29a: a cross-family projection records the pair, the review model first, and the report reads both.
  test("a cross-family record names the pair: the review model, then the triage model of its first pass", () => {
    const triage = { id: "lmstudio/triage-model", context: 100_000, costKind: "priced" as const }
    const pair = record({
      variant: { name: "engine:cross-family", keys: {}, models: "triage-pair" },
      scope: evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG, triage: triage.id }),
      models: { ...record().models, triage: { ...triage, price: { input: 1, output: 2 } } },
      passes: [pass("review", { model: triage.id }), pass("security", { model: triage.id }), pass("verify")],
    })
    expect(projectionProblems(pair)).toEqual([])
    expect(projectedRun(pair)).toMatchObject({
      variant: "engine:cross-family",
      model: "lmstudio/test-model",
      models: ["lmstudio/test-model", "lmstudio/triage-model"],
    })
  })

  // VS-29a: report.ts and certify.ts read records back as untrusted JSON, so a record named for the pair must show it:
  // a triage model other than the review model, which its scope names too.
  test("a record read back under a variant made by its models must show the pair, and any other needs none", () => {
    const triage = { id: "lmstudio/triage-model", context: 100_000, costKind: "priced" as const }
    const variant = { name: "engine:cross-family", keys: {}, models: "triage-pair" as const }
    const scope = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG, triage: triage.id })
    const models = { ...record().models, triage: { ...triage, price: { input: 1, output: 2 } } }
    const passes = [pass("review", { model: triage.id }), pass("security", { model: triage.id }), pass("verify")]
    expect(pairProblems(record({ variant, scope, models, passes }))).toEqual([])
    // A hand-edited or buggy record: no triage model, the review model as its own triage model, a scope that names
    // another triage model or none.
    const scopeless = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
    const unpaired = record({ variant, scope: scopeless, passes })
    expect(pairProblems(unpaired)).toEqual(["its variant is made by its models, but it records no triage model"])
    expect(projectionProblems(unpaired)).toContain("its variant is made by its models, but it records no triage model")
    const review = record().models.review
    expect(pairProblems(record({ variant, scope, models: { review, triage: review }, passes }))).toEqual([
      'its variant is made by its models, but its triage model is its review model, "lmstudio/test-model"',
      'its variant is made by its models, but its evidence scope names "lmstudio/triage-model", not its triage model "lmstudio/test-model"',
    ])
    expect(pairProblems(record({ variant, scope: scopeless, models, passes }))).toEqual([
      'its variant is made by its models, but its evidence scope names no triage model, not its triage model "lmstudio/triage-model"',
    ])
    // A replay artifact is read the same way, field by field.
    expect(
      pairProblems({ variant, scope, models: { review: { id: "a/review" }, triage: { id: "a/review" } } }),
    ).toEqual([
      'its variant is made by its models, but its triage model is its review model, "a/review"',
      'its variant is made by its models, but its evidence scope names "lmstudio/triage-model", not its triage model "a/review"',
    ])
    // Any other variant, the frozen pipeline included, needs no pair, and a triage model it has is not checked here.
    expect(pairProblems(record())).toEqual([])
    expect(
      pairProblems(record({ variant: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } } })),
    ).toEqual([])
    expect(pairProblems(record({ models: { review, triage: review } }))).toEqual([])
    for (const value of [undefined, null, "x", 1, [], { variant: "engine:cross-family" }])
      expect(pairProblems(value)).toEqual([])
  })
})

// VS-21c: the entry point's variant records, and the D5 pilot's limits on a paid replay.
describe("the entry point's variants and the pilot's limits", () => {
  test("a variant record is the registry's, the frozen pipeline has none, and only the engine's names pass", () => {
    expect(variantRecord("engine")).toEqual({ ok: true, name: "engine" })
    expect(variantRecord("engine:shared-verify")).toEqual({
      ok: true,
      name: "engine:shared-verify",
      record: { name: "engine:shared-verify", keys: { verifyPolicy: "shared" } },
    })
    // VS-29a: the cross-family pair's record carries its model requirement and no key.
    expect(variantRecord("engine:cross-family")).toEqual({
      ok: true,
      name: "engine:cross-family",
      record: { name: "engine:cross-family", keys: {}, models: "triage-pair" },
    })
    expect(variantRecord("desktop:cross-family")).toEqual({
      ok: false,
      detail: expect.stringContaining("registered for VS-29a's desktop half, after VS-10"),
    })
    expect(variantRecord("desktop")).toEqual({
      ok: false,
      detail: "desktop runs on the desktop runner; replays and projections here run the engine.",
    })
    expect(variantRecord("engine:privacy-zdr")).toEqual({
      ok: false,
      detail: expect.stringContaining("registered for VS-23c"),
    })
    expect(variantRecord("not a name")).toEqual({ ok: false, detail: expect.stringContaining("is not a variant name") })
    // admitReplay keeps its own wording for a desktop name, and hands out the same record.
    const ledger = Ledger.open({ limits: { totalUsd: 10, caseUsd: 1, reserveUsd: 1 } })
    const models = [{ id: "lmstudio/test-model", costKind: "priced" as const, price: { input: 1, output: 1 } }]
    expect(admitReplay(ledger, { id: "c", models, variant: "desktop" })).toEqual({
      admitted: false,
      reason: "variant",
      detail: "admitReplay admits engine replays, not desktop.",
    })
    const admitted = admitReplay(ledger, { id: "c", models, variant: "engine:shared-verify" })
    if (!admitted.admitted) throw new Error(admitted.detail)
    const recorded = variantRecord("engine:shared-verify")
    expect(recorded.ok && recorded.record).toEqual(admitted.variant)
    ledger.close()
  })

  test("a paid replay is the D5 pilot: $50 in all, $0.75 a case, one repetition, the development split", () => {
    expect(PILOT).toEqual({ totalUsd: 50, caseUsd: 0.75, repeat: 1, split: "development" })
    const limits = { totalUsd: 50, caseUsd: 0.75, reserveUsd: 5 }
    expect(pilotProblems({ limits, repeat: 1, split: "development" })).toEqual([])
    expect(pilotProblems({ limits: { ...limits, totalUsd: 60 }, repeat: 1, split: "development" })).toEqual([
      "a paid replay's budget is at most the D5 pilot's $50, not $60",
    ])
    expect(pilotProblems({ limits: { ...limits, caseUsd: 1 }, repeat: 1, split: "development" })).toEqual([
      "a paid replay's case bound is at most the D5 pilot's $0.75, not $1",
    ])
    expect(pilotProblems({ limits, repeat: 2, split: "development" })).toEqual([
      "a paid replay runs each case once, as the D5 pilot does, not 2 times",
    ])
    expect(pilotProblems({ limits, repeat: 1, split: "held-out" })).toEqual([
      "a paid replay runs the development split only, as the D5 pilot does, not held-out",
    ])
    // A smaller pilot is within the limits.
    expect(
      pilotProblems({ limits: { totalUsd: 10, caseUsd: 0.5, reserveUsd: 1 }, repeat: 1, split: "development" }),
    ).toEqual([])
  })

  test("a pilot's dispatches share its $50: each budget is at most what the earlier ones left", () => {
    const limits = { totalUsd: 30, caseUsd: 0.75, reserveUsd: 3 }
    expect(pilotRemaining(0)).toBe(50)
    expect(pilotRemaining(12.34)).toBe(37.66)
    expect(pilotRemaining(50)).toBe(0)
    expect(pilotRemaining(61)).toBe(0)
    expect(pilotProblems({ limits, repeat: 1, split: "development", spentUsd: 20 })).toEqual([])
    expect(pilotProblems({ limits, repeat: 1, split: "development", spentUsd: 20.01 })).toEqual([
      "a paid replay's budget is at most what is left of the D5 pilot's $50 after the $20.01 its earlier dispatches settled, $29.99, not $30",
    ])
    // Once the $50 is settled, no budget fits.
    expect(
      pilotProblems({ limits: { ...limits, totalUsd: 1 }, repeat: 1, split: "development", spentUsd: 50 }),
    ).toHaveLength(1)
    // With nothing settled before, the whole $50 is this dispatch's, as before.
    expect(
      pilotProblems({ limits: { ...limits, totalUsd: 50 }, repeat: 1, split: "development", spentUsd: 0 }),
    ).toEqual([])
  })
})

// VS-49's slice utilisation record, over synthetic artifacts: nothing writes one before the VS-49 wiring observer, so
// these check that a record bears out the artifact it sits in, never what the observer would measure.
describe("slice utilisation records (VS-49)", () => {
  const listBug = {
    path: "src/list.ts",
    line: 3,
    title: "last() reads past the end",
    evidence: ["src/list.ts:3", "src/slice/dep.ts:20"],
  }
  const listNit = { path: "src/list.ts", line: 5, endLine: 6, title: "Rename the helper" }
  const authBug = {
    path: "src/auth/session.ts",
    line: 2,
    title: "token() is not verified",
    quotes: [{ path: "", line: 2, side: "RIGHT", code: "return input" }],
  }
  const [bugKey, nitKey, authKey] = [listBug, listNit, authBug].map((finding) => findingKey(finding))
  // The related-code call sites first, then the slice's own locations after them, as context.locations quotes them.
  const SLICE = ["src/slice/dep.ts:20", "src/slice/other.ts:4"]
  const LOCATIONS = ["src/use.ts:8", "src/caller.ts:12", ...SLICE]
  const nothingRead = { inside: [], outside: [] }
  const WHOLE: SliceUtilisation = {
    slice: SLICE,
    passes: [
      {
        pass: "review",
        // Every call counts, the errored read too.
        tools: { read: 3, grep: 1, StructuredOutput: 1 },
        reads: { inside: ["src/slice/dep.ts"], outside: ["src/list.ts"] },
        sliceGreps: 1,
        findings: [
          { key: bugKey, places: ["diff", "slice"], approximate: true },
          { key: nitKey, places: ["diff"], approximate: false },
        ],
      },
      {
        pass: "security",
        tools: { StructuredOutput: 1 },
        reads: nothingRead,
        sliceGreps: 0,
        findings: [{ key: authKey, places: ["diff"], approximate: false }],
      },
      { pass: "verify", tools: {}, reads: nothingRead, sliceGreps: 0, findings: [] },
      {
        pass: "lens",
        lens: "access",
        tools: { read: 1 },
        reads: { inside: [], outside: ["src/auth/session.ts"] },
        sliceGreps: 0,
        findings: [{ key: authKey, places: ["diff", "read"], approximate: false }],
        // A related-code site is a location it received too; it may cite one it found by reading.
        received: ["src/use.ts:8", "src/slice/dep.ts:20"],
        cited: ["src/auth/session.ts:2"],
      },
    ],
  }
  const TOOLS = [
    { pass: "review", tool: "read", status: "completed", input: { filePath: "src/list.ts" } },
    { pass: "review", tool: "read", status: "completed", input: { filePath: "src/slice/dep.ts" } },
    { pass: "review", tool: "read", status: "error", input: { filePath: "src/missing.ts" } },
    { pass: "review", tool: "grep", status: "completed", input: { pattern: "lastItem" } },
    { pass: "review", tool: "StructuredOutput", status: "completed", input: {} },
    { pass: "security", tool: "StructuredOutput", status: "completed", input: {} },
    { pass: "lens", tool: "read", status: "completed", input: { filePath: "src/auth/session.ts" } },
    // A call no pass is named for belongs to none.
    { tool: "read", status: "completed", input: { filePath: "src/unattributed.ts" } },
  ]
  const SPECIALISTS = [
    { name: "review", status: "ok", steps: 3 },
    { name: "security", status: "ok", steps: 1 },
    { name: "verify", status: "ok", steps: 1 },
    { name: "lens", lens: "access", status: "ok", steps: 2 },
  ]
  // An engine replay artifact as far as the check reads it, with a tier1 record standing for a built slice.
  function measured(utilisation: unknown, overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      adapter: "engine",
      label: "case",
      context: { digest: "c", related: 2, history: 0, instructions: false, headFiles: 2, locations: LOCATIONS },
      tier1: { tokens: 120, ms: 40, stages: { candidates: 3, gated: 2, confirmed: 2, packed: 2 } },
      tools: TOOLS,
      outcome: { report: { findings: [listBug, listNit, authBug] }, specialists: SPECIALISTS },
      utilisation,
      ...overrides,
    }
  }
  const label = (entry: { pass: string; lens?: string }) => (entry.lens ? `${entry.pass} (${entry.lens})` : entry.pass)
  // The whole record with the named entry changed, or left out when `change` is undefined.
  function edited(name: string, change?: Record<string, unknown>, record = WHOLE) {
    return {
      ...record,
      passes: record.passes.flatMap((entry) =>
        label(entry) !== name ? [entry] : change === undefined ? [] : [{ ...entry, ...change }],
      ),
    }
  }

  test("a replay without one has no problem, and a record that bears out its artifact has none", () => {
    expect(utilisationProblems(measured(undefined))).toEqual([])
    for (const value of [undefined, null, "x", 1, []]) expect(utilisationProblems(value)).toEqual([])
    expect(utilisationProblems(measured(WHOLE))).toEqual([])
    // A run with no slice: no tier1, an empty slice, nothing read inside it and no slice grep or place.
    const sliceless = {
      slice: [],
      passes: [
        { ...WHOLE.passes[0], reads: { inside: [], outside: ["src/list.ts", "src/slice/dep.ts"] }, sliceGreps: 0 },
        ...WHOLE.passes.slice(1),
      ].map((entry) => ({
        ...entry,
        findings: entry.findings.map((item) => ({ ...item, places: item.places.filter((place) => place !== "slice") })),
      })),
    }
    expect(utilisationProblems(measured(sliceless, { tier1: undefined }))).toEqual([])
    // A built slice that came out empty (an abstention) is measured the same way.
    expect(utilisationProblems(measured(sliceless))).toEqual([])
  })

  test("counts every tool call of a pass by name, whatever its status, and a pass with calls needs an entry", () => {
    // Leaving the errored read out is a miscount.
    expect(
      utilisationProblems(measured(edited("review", { tools: { read: 2, grep: 1, StructuredOutput: 1 } }))),
    ).toEqual([
      `its slice utilisation counts the tool calls of pass "review" as "StructuredOutput" 1, "grep" 1, "read" 2, not the "StructuredOutput" 1, "grep" 1, "read" 3 its artifact records`,
    ])
    // A pass with recorded calls and no entry miscounts them as none.
    expect(utilisationProblems(measured(edited("security")))).toEqual([
      `its slice utilisation counts the tool calls of pass "security" as no call, not the "StructuredOutput" 1 its artifact records`,
    ])
    // A record of a call the artifact never made.
    expect(utilisationProblems(measured(edited("verify", { tools: { read: 1 } })))).toEqual([
      `its slice utilisation counts the tool calls of pass "verify" as "read" 1, not the no call its artifact records`,
    ])
    // Several lens entries share the "lens" pass's recorded calls.
    const lenses: SliceUtilisation = {
      ...WHOLE,
      passes: [
        ...WHOLE.passes,
        { pass: "lens", lens: "resource", tools: {}, reads: nothingRead, sliceGreps: 0, findings: [] },
      ],
    }
    const twoLenses = {
      outcome: { ...measured(WHOLE).outcome, specialists: [...SPECIALISTS, { name: "lens", lens: "resource" }] },
    }
    expect(utilisationProblems(measured(lenses, twoLenses))).toEqual([])
    expect(utilisationProblems(measured(edited("lens (resource)", { tools: { read: 1 } }, lenses), twoLenses))).toEqual(
      [`its slice utilisation counts the tool calls of pass "lens" as "read" 2, not the "read" 1 its artifact records`],
    )
    // Counts are positive whole numbers by name.
    for (const tools of [{ read: 0 }, { read: 1.5 }, { read: "3" }, [3], null])
      expect(utilisationProblems(measured(edited("lens (access)", { tools })))).toContain(
        `its slice utilisation's entry "lens" ("access") does not count its tool calls by name in positive whole numbers`,
      )
  })

  test("counts tool names that an object's prototype also has", () => {
    const tools = [
      ...TOOLS,
      { pass: "verify", tool: "constructor", status: "completed", input: {} },
      { pass: "verify", tool: "__proto__", status: "completed", input: {} },
    ]
    // JSON.parse makes "__proto__" an own key, as reading a saved artifact does.
    const counted = JSON.parse('{"constructor": 1, "__proto__": 1}')
    expect(utilisationProblems(measured(edited("verify", { tools: counted }), { tools }))).toEqual([])
    expect(utilisationProblems(measured(edited("verify", { tools: { constructor: 2 } }), { tools }))).toEqual([
      `its slice utilisation counts the tool calls of pass "verify" as "constructor" 2, not the "__proto__" 1, "constructor" 1 its artifact records`,
    ])
  })

  test("reads hold every completed read call of the pass, one spelling per path, each once", () => {
    const reads = (inside: string[], outside: string[]) =>
      utilisationProblems(measured(edited("review", { reads: { inside, outside } })))
    // However the model typed a path, it is one path.
    expect(reads(["./src/slice/dep.ts"], ["src\\list.ts"])).toEqual([])
    expect(reads(["src/slice/../slice/dep.ts"], ["./src/list.ts"])).toEqual([])
    // A recorded read typed with "./" is the same read.
    const typed: unknown = JSON.parse(JSON.stringify(TOOLS).replace('"src/list.ts"', '"./src/list.ts"'))
    expect(utilisationProblems(measured(WHOLE, { tools: typed }))).toEqual([])
    // Reads are a lower bound: one through another tool, or of an errored read's file, may be added.
    expect(reads(["src/slice/dep.ts"], ["src/list.ts", "src/missing.ts", "src/via-bash.ts"])).toEqual([])
    // A completed read left out is not.
    expect(reads(["src/slice/dep.ts"], [])).toEqual([
      `its slice utilisation's reads for pass "review" leave out "src/list.ts", which its completed read calls read`,
    ])
    // Each read once, never both inside and outside.
    expect(reads(["src/slice/dep.ts"], ["src/list.ts", "./src/list.ts"])).toEqual([
      `its slice utilisation's entry "review" lists a read twice, or both inside and outside the slice`,
    ])
    expect(reads(["src/slice/dep.ts"], ["src/list.ts", "src/slice/dep.ts"])).toEqual([
      `its slice utilisation's entry "review" lists a read twice, or both inside and outside the slice`,
    ])
  })

  test("the slice is the record's own: quoted in the context, empty without tier1, and the only home of an inside read", () => {
    expect(utilisationProblems(measured({ ...WHOLE, slice: [...SLICE, "src/elsewhere.ts:1"] }))).toEqual([
      `its slice utilisation's slice names "src/elsewhere.ts:1", which its context does not quote`,
    ])
    expect(utilisationProblems(measured({ ...WHOLE, slice: [...SLICE, SLICE[0]] }))).toEqual([
      "its slice utilisation names a slice location twice",
    ])
    // A tier1 record is an object: a hand-edited null, list or string stands for none.
    for (const tier1 of [undefined, null, [], "x", 1])
      expect(utilisationProblems(measured(WHOLE, { tier1 }))).toEqual([
        "its slice utilisation names a slice, but its artifact records no tier1 slice",
      ])
    // A related-code call site is quoted in the context but is not the slice's, so a read of it is outside.
    expect(
      utilisationProblems(
        measured(edited("review", { reads: { inside: ["src/slice/dep.ts", "src/use.ts"], outside: ["src/list.ts"] } })),
      ),
    ).toEqual([
      `its slice utilisation's entry "review" reads "src/use.ts" as inside the slice, but no slice location names it`,
    ])
    // With no slice, nothing is inside it, no grep names its names and no evidence falls in it.
    expect(utilisationProblems(measured({ ...WHOLE, slice: [] }))).toEqual([
      `its slice utilisation's entry "review" reads "src/slice/dep.ts" as inside the slice, but no slice location names it`,
      `its slice utilisation's entry "review" counts greps for slice names, but it names no slice`,
      `its slice utilisation's entry "review" places "${bugKey}" in the slice, but it names no slice`,
    ])
    // Slice greps are tool calls of the entry.
    for (const sliceGreps of [6, -1, 1.5, "1"])
      expect(utilisationProblems(measured(edited("review", { sliceGreps })))).toContain(
        `its slice utilisation's entry "review" counts ${JSON.stringify(sliceGreps)} slice greps, not a whole number from 0 to its 5 tool calls`,
      )
  })

  test("places every proposed finding by key, once per entry, only on a pass that proposes findings", () => {
    const review = WHOLE.passes[0]
    const findings = (items: unknown[]) => utilisationProblems(measured(edited("review", { findings: items })))
    expect(findings(review.findings.slice(0, 1))).toEqual([
      `its slice utilisation does not place the proposed finding(s) "${nitKey}"`,
    ])
    expect(findings([...review.findings, { key: "000000000000", places: [], approximate: false }])).toEqual([
      `its slice utilisation's entry "review" places "000000000000", which is no finding its outcome proposed`,
    ])
    expect(findings([...review.findings, review.findings[1]])).toEqual([
      `its slice utilisation's entry "review" places "${nitKey}" twice`,
    ])
    expect(
      utilisationProblems(
        measured(edited("verify", { findings: [{ key: bugKey, places: ["diff"], approximate: false }] })),
      ),
    ).toEqual([`its slice utilisation's entry "verify" places findings, but that pass proposes none`])
    // Places are distinct, known and in order.
    for (const places of [["slice", "diff"], ["diff", "diff"], ["elsewhere"]])
      expect(findings([review.findings[0], { key: nitKey, places, approximate: false }])).toEqual([
        `its slice utilisation's entry "review" places "${nitKey}" at ${places.map((place) => JSON.stringify(place)).join(", ")}, not distinct places in the order diff, slice, read`,
      ])
    // Evidence in a read file needs a read.
    expect(
      utilisationProblems(
        measured(edited("security", { findings: [{ key: authKey, places: ["read"], approximate: false }] })),
      ),
    ).toEqual([`its slice utilisation's entry "security" places "${authKey}" in a file it read, but lists no read`])
    // Approximate is a placement worked out from legacy evidence strings: a finding of that key must carry some. A
    // finding with no evidence at all is not approximate, and whether one with strings is stays the observer's call.
    expect(findings([review.findings[0], { key: nitKey, places: ["diff"], approximate: true }])).toEqual([
      `its slice utilisation's entry "review" calls the placement of "${nitKey}" approximate, but no finding of that key has legacy evidence strings`,
    ])
    expect(findings([{ ...review.findings[0], approximate: false }, review.findings[1]])).toEqual([])
    const quoted = edited("security", { findings: [{ key: authKey, places: ["diff"], approximate: true }] })
    expect(utilisationProblems(measured(quoted))).toEqual([
      `its slice utilisation's entry "security" calls the placement of "${authKey}" approximate, but no finding of that key has legacy evidence strings`,
    ])
    // Two proposed findings may share a key (review's and security's reports are merged): either one's strings count.
    const merged = {
      report: { findings: [listBug, listNit, authBug, { ...authBug, evidence: ["src/auth/session.ts:2"] }] },
    }
    expect(utilisationProblems(measured(quoted, { outcome: { ...merged, specialists: SPECIALISTS } }))).toEqual([])
    // A proposed finding with no key cannot be placed, so it is listed rather than passed over.
    const unkeyed = {
      report: { findings: [listBug, { ...listNit, endLine: "6" }, authBug, { title: "No path", line: 1 }] },
      specialists: SPECIALISTS,
    }
    expect(utilisationProblems(measured(WHOLE, { outcome: unkeyed }))).toEqual([
      `its slice utilisation's entry "review" places "${nitKey}", which is no finding its outcome proposed`,
      "its outcome's proposed finding 2 has no path, title and line (or a non-numeric endLine) to key it by, so its slice utilisation cannot place it",
      "its outcome's proposed finding 4 has no path, title and line (or a non-numeric endLine) to key it by, so its slice utilisation cannot place it",
    ])
  })

  test("an entry names a pass its outcome ran, a lens by its lens, and only a lens has received and cited locations", () => {
    const lens = WHOLE.passes[3]
    // The record is untrusted JSON, so a lens that is no ReviewLens is still checked against the passes that ran.
    expect(utilisationProblems(measured(edited("lens (access)", { lens: "injection" })))).toEqual([
      `its slice utilisation's entry "lens" ("injection") names no pass its outcome ran`,
    ])
    expect(utilisationProblems(measured(edited("lens (access)", { lens: undefined })))).toEqual([
      `its slice utilisation's entry "lens" names no pass its outcome ran`,
      `its slice utilisation's entry "lens" is a lens pass with no lens`,
    ])
    expect(utilisationProblems(measured(edited("review", { lens: "access" })))).toEqual([
      `its slice utilisation's entry "review" ("access") names no pass its outcome ran`,
      `its slice utilisation's entry "review" ("access") names a lens, but is no lens pass`,
    ])
    expect(utilisationProblems(measured({ ...WHOLE, passes: [...WHOLE.passes, lens] }))).toEqual([
      `its slice utilisation lists entry "lens" ("access") twice`,
      `its slice utilisation counts the tool calls of pass "lens" as "read" 2, not the "read" 1 its artifact records`,
    ])
    expect(
      utilisationProblems(measured({ ...WHOLE, passes: [...WHOLE.passes, { ...WHOLE.passes[2], pass: "repro" }] })),
    ).toEqual([`its slice utilisation's entry "repro" names no pass its outcome ran`])
    expect(utilisationProblems(measured(edited("review", { received: [], cited: [] })))).toEqual([
      `its slice utilisation's entry "review" lists received or cited locations, which only a lens pass has`,
    ])
    expect(utilisationProblems(measured(edited("lens (access)", { received: ["src/nowhere.ts:1"] })))).toEqual([
      `its slice utilisation's entry "lens" ("access") received "src/nowhere.ts:1", which its context does not quote`,
    ])
    expect(utilisationProblems(measured(edited("lens (access)", { received: [SLICE[0], SLICE[0]] })))).toEqual([
      `its slice utilisation's entry "lens" ("access") does not list what it received as distinct locations`,
    ])
    expect(utilisationProblems(measured(edited("lens (access)", { cited: "src/auth/session.ts:2" })))).toEqual([
      `its slice utilisation's entry "lens" ("access") does not list what it cited as distinct locations`,
    ])
    // A lens that places no finding cites nothing; security's places the finding instead.
    expect(utilisationProblems(measured(edited("lens (access)", { findings: [] })))).toEqual([
      `its slice utilisation's entry "lens" ("access") cites locations, but places no finding`,
    ])
    // Received and cited are optional.
    expect(utilisationProblems(measured(edited("lens (access)", { received: undefined, cited: undefined })))).toEqual(
      [],
    )
  })

  test("a hand-edited record is listed, never thrown on", () => {
    const shape = ["its slice utilisation is not a record of the slice's locations and a list of passes"]
    for (const utilisation of [null, "x", 1, [], {}, { slice: [1], passes: [] }, { slice: [], passes: {} }])
      expect(utilisationProblems(measured(utilisation))).toEqual(shape)
    expect(utilisationProblems(measured({ slice: [], passes: [null, 3, "review"] }))).toEqual([
      "its slice utilisation's entry 1 is not an object",
      "its slice utilisation's entry 2 is not an object",
      "its slice utilisation's entry 3 is not an object",
      `its slice utilisation counts the tool calls of pass "review" as no call, not the "StructuredOutput" 1, "grep" 1, "read" 3 its artifact records`,
      `its slice utilisation's reads for pass "review" leave out "src/list.ts", "src/slice/dep.ts", which its completed read calls read`,
      `its slice utilisation counts the tool calls of pass "security" as no call, not the "StructuredOutput" 1 its artifact records`,
      `its slice utilisation counts the tool calls of pass "lens" as no call, not the "read" 1 its artifact records`,
      `its slice utilisation's reads for pass "lens" leave out "src/auth/session.ts", which its completed read calls read`,
      `its slice utilisation does not place the proposed finding(s) "${bugKey}", "${nitKey}", "${authKey}"`,
    ])
    const broken = { pass: "verify", tools: {}, reads: "none", sliceGreps: 0, findings: [null, { key: 5 }] }
    expect(utilisationProblems(measured(edited("verify", broken)))).toEqual([
      `its slice utilisation's entry "verify" does not list its reads inside and outside the slice`,
      `its slice utilisation's entry "verify" places findings, but that pass proposes none`,
      `its slice utilisation's entry "verify" places a finding without a key, a list of places and whether it is approximate`,
      `its slice utilisation's entry "verify" places a finding without a key, a list of places and whether it is approximate`,
    ])
    // An artifact whose other fields are not what the engine writes: nothing ran and nothing was proposed.
    const odd = { context: null, tools: "x", outcome: { report: { findings: [{ path: 1, title: null }, "x"] } } }
    expect(() => utilisationProblems(measured(WHOLE, odd))).not.toThrow()
    expect(utilisationProblems(measured(WHOLE, odd))).toContain(
      `its slice utilisation's slice names "src/slice/dep.ts:20", which its context does not quote`,
    )
    expect(utilisationProblems(measured(WHOLE, odd))).toContain(
      `its slice utilisation's entry "review" names no pass its outcome ran`,
    )
    expect(utilisationProblems(measured(WHOLE, odd))).toContain(
      "its outcome's proposed finding 2 has no path, title and line (or a non-numeric endLine) to key it by, so its slice utilisation cannot place it",
    )
    // A value String() cannot convert, an own toString that is no function, is shown, never converted.
    const opaque: unknown = JSON.parse('{"toString": 1}')
    const opaqueTools = [...TOOLS, { pass: "verify", tool: opaque, status: "completed", input: {} }]
    expect(utilisationProblems(measured(edited("verify", { sliceGreps: opaque }), { tools: opaqueTools }))).toEqual([
      `its slice utilisation's entry "verify" counts {"toString":1} slice greps, not a whole number from 0 to its 0 tool calls`,
      `its slice utilisation counts the tool calls of pass "verify" as no call, not the ${JSON.stringify('{"toString":1}')} 1 its artifact records`,
    ])
    const opaquePass = {
      pass: opaque,
      tools: {},
      reads: nothingRead,
      sliceGreps: 0,
      findings: [WHOLE.passes[0].findings[1]],
    }
    expect(utilisationProblems(measured({ ...WHOLE, passes: [...WHOLE.passes, opaquePass] }))).toEqual([
      "its slice utilisation's entry 5 names no pass its outcome ran",
      "its slice utilisation's entry 5 places findings, but that pass proposes none",
    ])
  })

  test("shows what a record supplies quoted and cut short, and compares it in full", () => {
    // A newline cannot start a report line of its own, and a long value is cut to 200 characters.
    const forged = "src/x.ts:1\n- every check passed"
    const long = `src/${"a".repeat(500)}.ts:1`
    const problems = utilisationProblems(measured({ ...WHOLE, slice: [...SLICE, forged, long] }))
    expect(problems).toEqual([
      `its slice utilisation's slice names ${JSON.stringify(forged)}, which its context does not quote`,
      `its slice utilisation's slice names ${JSON.stringify(long).slice(0, 200)}..., which its context does not quote`,
    ])
    expect(problems.filter((problem) => problem.includes("\n") || problem.length > 300)).toEqual([])
    // Two pass names cut to the same text are still two passes, not one listed twice.
    const prefix = "p".repeat(300)
    const shownPass = `${JSON.stringify(prefix).slice(0, 200)}...`
    const extra = ["1", "2"].map((end) => ({
      pass: `${prefix}${end}`,
      tools: {},
      reads: nothingRead,
      sliceGreps: 0,
      findings: [],
    }))
    expect(utilisationProblems(measured({ ...WHOLE, passes: [...WHOLE.passes, ...extra] }))).toEqual([
      `its slice utilisation's entry ${shownPass} names no pass its outcome ran`,
      `its slice utilisation's entry ${shownPass} names no pass its outcome ran`,
    ])
    // Tool names that differ past the cut are counted apart.
    const named = [...TOOLS, { pass: "verify", tool: `${prefix}a`, status: "completed", input: {} }]
    const tool = `${JSON.stringify(`${prefix}a`).slice(0, 200)}...`
    expect(utilisationProblems(measured(edited("verify", { tools: { [`${prefix}b`]: 1 } }), { tools: named }))).toEqual(
      [
        `its slice utilisation counts the tool calls of pass "verify" as ${tool} 1, not the ${tool} 1 its artifact records`,
      ],
    )
  })
})
