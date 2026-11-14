import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { SAFETY } from "./contracts"
import type { LiveRun } from "./live"
import { DELTA, archivable, bootstrap, build, changes, markdown, type Arm, type Measure, type Meta } from "./report"
import { HARNESS_BASE, REPO_ROOT, render, type Variant } from "./variants"

const BASE = await Bun.file(join(REPO_ROOT, HARNESS_BASE)).text()
const EMOJI = "Only use emojis if the user explicitly requests it."
const DONE = SAFETY.find((item) => item.source === HARNESS_BASE && item.clause === "verify.done")!.sentence
const META: Meta = {
  date: "2026-10-25",
  revision: "abc1234",
  command: "run.ts",
  suites: ["scripted", "footprint", "replay"],
  live: false,
  dryRun: false,
}

const variant = (id: string, patches: Variant["patches"] = []): Variant => ({
  id,
  description: `The ${id} variant.`,
  agent: "build",
  base: HARNESS_BASE,
  patches,
})
const IDENTITY = variant("identity")
const TRIM = variant("trim", [{ find: `${EMOJI} `, replace: "" }])
const UNVERIFIED = variant(
  "unverified",
  SAFETY.filter((item) => item.source === HARNESS_BASE && item.clause.startsWith("verify.")).map((item) => ({
    find: item.sentence,
    replace: "",
  })),
)

const measure = (usd: number, passed?: number): Measure => ({
  runs: 2,
  ...(passed === undefined ? {} : { passed }),
  inputTokens: usd * 1e5,
  outputTokens: 10,
  cacheRead: 5,
  usd,
})
const arm = (scale = 1, passed = 2, live?: readonly LiveRun[]): Arm => ({
  suites: { scripted: measure(0.02 * scale, passed), footprint: measure(0.04 * scale), replay: measure(0.06 * scale) },
  ...(live ? { live } : {}),
})
const runs = (passes: number, total: number, task = "bugfix") =>
  Array.from(
    { length: total },
    (_, at): LiveRun => ({ task, attempt: at + 1, outcome: at < passes ? "pass" : "fail", usd: 0.1 }),
  )
const report = async (arms: Partial<Record<"identity" | "trim" | "unverified", Arm>>, baseline = arm(), meta = META) =>
  build({
    meta,
    baseline,
    variants: await Promise.all(
      [IDENTITY, TRIM, UNVERIFIED].flatMap((item) =>
        arms[item.id as keyof typeof arms]
          ? [
              render(item, { explore: true }).then((rendered) => ({
                variant: item,
                rendered,
                arm: arms[item.id as keyof typeof arms]!,
              })),
            ]
          : [],
      ),
    ),
  })
const byId = (built: Awaited<ReturnType<typeof report>>, id: string) => built.variants.find((item) => item.id === id)!

describe("the report", () => {
  test("lists every removed or changed sentence, tagged with the clause it states or uncovered", () => {
    const rendered = BASE.replace(DONE, "")
      .replace(EMOJI, "Use emojis only when asked.")
      .replace("# Code References", "# Code References\nCite files as path:line.")
    const found = changes(BASE, rendered, IDENTITY)
    expect(found).toContainEqual({
      kind: "removed",
      before: DONE,
      clauses: [{ id: "verify.done", kept: false }],
      safety: true,
    })
    expect(found).toContainEqual({
      kind: "changed",
      before: EMOJI,
      after: "Use emojis only when asked.",
      clauses: [],
      safety: false,
    })
    expect(found).toContainEqual({ kind: "added", after: "Cite files as path:line.", clauses: [], safety: false })
    expect(found).toHaveLength(3)
    expect(changes(BASE, BASE, IDENTITY)).toEqual([])
  })

  test("a changed safety sentence is never taken as still stated: the owner is asked to read it", async () => {
    const loop = SAFETY.find((item) => item.source === HARNESS_BASE && item.clause === "verify.loop")!.sentence
    const reworded = variant("reworded", [
      { find: loop, replace: "For a bounded fix, investigate, edit and verify the changes with the tests." },
    ])
    const negated = variant("negated", [{ find: loop, replace: "Do not verify the changes; skip the tests." }])
    const built = await build({
      meta: META,
      baseline: arm(),
      variants: [
        { variant: IDENTITY, rendered: BASE, arm: arm() },
        { variant: reworded, rendered: await render(reworded, { explore: true }), arm: arm(0.9) },
        { variant: negated, rendered: await render(negated, { explore: true }), arm: arm(0.8) },
      ],
    })
    const text = markdown(built)
    expect(text).not.toContain("verify.loop (still stated)")
    expect(text).toContain("verify.loop (reworded: read it and confirm it still says the same)")
    expect(text).toContain("verify.loop (dropped)")
    expect(byId(built, "negated")).toMatchObject({ candidate: false })
    expect(byId(built, "negated").reasons).toContain("no longer states verify.loop")
  })

  test("a cheaper variant that keeps every clause is a candidate, and never promotable without live runs", async () => {
    const built = await report({ identity: arm(), trim: arm(0.9), unverified: arm(0.8) })
    expect(built.status).toBe("valid")
    expect(byId(built, "trim")).toMatchObject({ candidate: true, promotable: false, reasons: ["it has no live runs"] })
    expect(byId(built, "trim").coverage.share).toBe(1)
    // Cheaper still, but it no longer states its verification clauses.
    expect(byId(built, "unverified")).toMatchObject({ candidate: false, promotable: false })
    expect(byId(built, "unverified").reasons).toContain("no longer states verify.report, verify.loop, verify.done")
    expect(byId(built, "identity").candidate).toBe(false)
  })

  test("a lower scripted pass rate, a costlier offline suite or a suite that did not run rules a candidate out", async () => {
    expect(byId(await report({ identity: arm(), trim: arm(0.9, 1) }), "trim").reasons).toEqual([
      "scripted pass rate is below the baseline's",
    ])
    const costlier = arm(0.9)
    const replay = await report({ identity: arm(), trim: { suites: { ...costlier.suites, replay: measure(0.07) } } })
    expect(byId(replay, "trim").reasons).toEqual(["costs more than the baseline on replay"])
    const partial = await report({ identity: arm(), trim: arm(0.9) }, arm(), {
      ...META,
      suites: ["scripted", "footprint"],
    })
    expect(byId(partial, "trim").reasons).toEqual(["the replay suite did not run"])
  })

  test("is invalid when identity moves any deterministic suite, and then nothing is a candidate", async () => {
    const moved = arm()
    const built = await report({
      identity: { suites: { ...moved.suites, footprint: measure(0.0401) } },
      trim: arm(0.9),
    })
    expect(built.status).toBe("invalid")
    expect(built.invalid[0]).toContain("identity moved the footprint suite")
    expect(byId(built, "trim").candidate).toBe(false)
    expect(markdown(built)).toContain("**Invalid**")
  })

  test("promotes only when the lower bound of the live Δpass interval is at least -δ, and the control is quiet", async () => {
    // Twenty runs of a task that passes 18 times leave an interval too wide to rule out a drop of more than δ.
    const wide = await report(
      { identity: arm(1, 2, runs(18, 20)), trim: arm(0.9, 2, runs(18, 20)) },
      arm(1, 2, runs(18, 20)),
      { ...META, live: true },
    )
    expect(byId(wide, "trim").live!.low).toBeLessThan(-DELTA)
    expect(byId(wide, "trim").promotable).toBe(false)

    const solid = await report(
      { identity: arm(1, 2, runs(40, 40)), trim: arm(0.9, 2, runs(40, 40)) },
      arm(1, 2, runs(40, 40)),
      { ...META, live: true },
    )
    expect(byId(solid, "trim")).toMatchObject({ candidate: true, promotable: true, reasons: [] })

    const worse = await report(
      { identity: arm(1, 2, runs(40, 40)), trim: arm(0.9, 2, runs(30, 40)) },
      arm(1, 2, runs(40, 40)),
      { ...META, live: true },
    )
    expect(byId(worse, "trim").promotable).toBe(false)
    expect(byId(worse, "trim").reasons[0]).toContain(`below -${DELTA}`)

    // The identity control lost a quarter of its runs: the live numbers are noise, so nothing is promotable.
    const noisy = await report(
      { identity: arm(1, 2, runs(30, 40)), trim: arm(0.9, 2, runs(40, 40)) },
      arm(1, 2, runs(40, 40)),
      { ...META, live: true },
    )
    expect(noisy.control?.noise).toBe(true)
    expect(byId(noisy, "trim").promotable).toBe(false)
    expect(markdown(noisy)).toContain("Live noise too high")
  })

  test("a live run the spend cap cut short, or arms short of five measured runs of a task, promotes nothing", async () => {
    // --live-tasks a,b, five repeats: the cap tripped after task b's first baseline run, so b has one run in all.
    const plan = {
      model: "anthropic/claude-sonnet-4-5",
      tasks: ["a", "b"],
      repeat: 5,
      maxSpend: 1,
      spent: 1.02,
      stopped: true,
    }
    const stopped = await report(
      { identity: arm(1, 2, runs(5, 5, "a")), trim: arm(0.9, 2, runs(5, 5, "a")) },
      arm(1, 2, [...runs(5, 5, "a"), ...runs(1, 1, "b")]),
      { ...META, live: true, liveRun: plan },
    )
    expect(byId(stopped, "trim")).toMatchObject({ candidate: true, promotable: false })
    expect(byId(stopped, "trim").reasons).toContain(
      "the live run stopped at the spend cap ($1.02 of $1) before it finished",
    )
    expect(byId(stopped, "trim").reasons).toContain("it has fewer than 5 measured live runs of b")
    const text = markdown(stopped)
    expect(text).toContain("**Live run stopped at the spend cap ($1.0200 of $1): nothing is promotable.**")
    expect(text).toContain("- baseline: a 5, b 1")
    expect(text).toContain("- trim: a 5, b 0")

    // The plan finished, but errors left the variant without task b: its mix is not the baseline's.
    const finished = { ...plan, spent: 0.5, stopped: false }
    const errored = await report(
      { identity: arm(1, 2, [...runs(5, 5, "a"), ...runs(5, 5, "b")]), trim: arm(0.9, 2, runs(5, 5, "a")) },
      arm(1, 2, [...runs(5, 5, "a"), ...runs(5, 5, "b")]),
      { ...META, live: true, liveRun: finished },
    )
    expect(byId(errored, "trim").promotable).toBe(false)
    expect(byId(errored, "trim").reasons).toEqual(["it has fewer than 5 measured live runs of b"])
  })

  test("the bootstrap is deterministic, stratified by task, and leaves unmeasured runs out", () => {
    const baseline = [...runs(8, 10, "a"), ...runs(2, 10, "b")]
    const variant = [
      ...runs(9, 10, "a"),
      ...runs(2, 10, "b"),
      { task: "b", attempt: 11, outcome: "unavailable" as const, usd: 0 },
    ]
    const first = bootstrap(baseline, variant)
    expect(bootstrap(baseline, variant)).toEqual(first)
    expect(first.mean).toBeCloseTo(0.05, 10)
    expect(first.low).toBeLessThanOrEqual(first.mean)
    expect(first.high).toBeGreaterThanOrEqual(first.mean)
  })

  test("markdown names the base, lists the sentences and prints the diff to apply by hand", async () => {
    const text = markdown(await report({ identity: arm(), trim: arm(0.9) }))
    expect(text).toContain(`base \`${HARNESS_BASE}\``)
    expect(text).toContain(`- removed: "${EMOJI}" — uncovered`)
    expect(text).toContain(`--- a/${HARNESS_BASE}`)
    expect(text).toContain(`-- Only use emojis if the user explicitly requests it.`)
    expect(text).toContain("never writes under `packages/`")
  })

  test("--archive refuses live and replay results and allows the scripted and footprint suites", () => {
    expect(archivable({ suites: ["scripted", "footprint"], live: false })).toBeUndefined()
    expect(archivable({ suites: ["scripted", "replay"], live: false })).toContain("replay")
    expect(archivable({ suites: ["scripted"], live: true })).toContain("live")
  })
})
