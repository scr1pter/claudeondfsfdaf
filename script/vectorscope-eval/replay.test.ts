import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ReviewClient, ReviewMessage, ReviewModel } from "../../packages/app/src/features/pull-requests/ai-review"
import { parseReviewConfig } from "../../packages/core/src/review/config"
import { evidenceScope } from "../../packages/core/src/review/model-evidence"
import { VERIFY_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import { DEFAULT_REVIEW_CONFIG } from "../../packages/core/src/review/types"
import { Ledger, type Limits } from "./budget"
import { gitEnv, loadManifest, type Manifest } from "./dataset"
import { candidateDiff, desktopReplay, withReviewSettings } from "./desktop"
import {
  ADAPTERS,
  admitReplay,
  checkoutDirectory,
  main,
  prepareCheckout,
  replayBudget,
  replayCharge,
  replayPlan,
  type PlannedReplay,
} from "./replay"

// The replay driver without any model or network: the plan it builds from the seed manifest, and checkouts prepared
// from a local repository whose later history holds the fix.

const root = mkdtempSync(join(tmpdir(), "vectorscope-replay-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mirror = buildMirror(join(root, "mirror"))

function buildMirror(dir: string, extra: Record<string, string> = {}) {
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
  const head = commit("candidate", { "app.py": "def total(items):\n    return sum(items[1:])\n" })
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

  // VS-06: the verify policy replayed as a variant, as the engine replay takes it, so both runners can be compared.
  test("replays a verify policy variant as the case's own review.json would carry it, keeping the base's verify", async () => {
    // The base sets "verify": "blocking", which the desktop's legacy rule reads as "all" and the shared policy does not.
    const settled = buildMirror(join(root, "mirror-settings"), { ".vector/review.json": '{"verify":"blocking"}' })
    const caseView = { repository: view.repository, base: settled.base, head: settled.head }
    const concern = { ...bug, severity: "concern", title: "total() of an empty list is not tested" }
    const replay = async (name: string, config?: { verifyPolicy: "legacy" | "shared" }) => {
      const directory = checkoutDirectory(join(root, `desktop-${name}`), planned.id)
      expect(prepareCheckout({ mirror: settled.dir, view: caseView, directory })).toEqual([])
      return desktopReplay({
        planned: { ...planned, case: { ...planned.case, base: settled.base, head: settled.head } },
        directory,
        diff: candidateDiff(directory, caseView),
        model,
        client: fakeClient(directory, [bug, concern]).client,
        ...(config ? { config } : {}),
      })
    }
    const legacy = await replay("legacy")
    const shared = await replay("shared", { verifyPolicy: "shared" })
    for (const artifact of [legacy, shared]) expect(artifact.error).toBeUndefined()
    expect(legacy.variant).toBeUndefined()
    expect(shared.variant).toEqual({ verifyPolicy: "shared", applied: true })
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
    // A missing file, or one that is not a JSON object, reads as the variant's keys alone.
    for (const text of ["", "not json", "[1, 2]"])
      expect(JSON.parse((await read(settings(text), ".vector/review.json"))!)).toEqual({ verifyPolicy: "shared" })
  })
})
