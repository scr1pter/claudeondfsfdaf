import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODIUM_RUN_HEADROOM_FLOOR_USD, codiumRunHeadroom } from "./codium-run-headroom"
import { createSpendLedger } from "./spend-limits"

// Lead ruling R2 (21 Nov 2026), A23's model edit race: a desktop run admitted as Codium carries the own-key headroom as
// its engine budget. These cases run the real ledger in a temporary folder.

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function newLedger() {
  const directory = await mkdtemp(join(tmpdir(), "vector-codium-headroom-"))
  directories.push(directory)
  return createSpendLedger({ userDataPath: directory })
}

const at = new Date(2026, 7, 19, 10, 0)

function spend(ledger: Awaited<ReturnType<typeof newLedger>>, runId: string, costUsd: number) {
  return ledger.recordSpend({
    projectPath: "/tmp/vector-codium-headroom",
    runId,
    provider: "anthropic",
    model: "claude-sonnet",
    source: "scheduled",
    costUsd,
    at,
  })
}

describe("the own-key headroom a run admitted as Codium carries", () => {
  test("is the budget an ordinary run would get, and holds none of it", async () => {
    const ledger = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 } } })
    await spend(ledger, "earlier", 4)

    // No per-run limit: an ordinary run would get half of the $6 left today.
    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "scheduled", at })).toBe(3)
    // Nothing was held: an own-key run checked next still sees the whole $6.
    expect((await ledger.checkAllowance({ runId: "own", source: "scheduled", at, reserve: true })).remainingUsd).toBe(6)
    // An ordinary reserving check does hold its share, which the Codium run's budget then reflects.
    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "scheduled", at })).toBe(1.5)
  })

  test("is the whole remaining headroom under a per-run limit", async () => {
    const ledger = await newLedger()
    await ledger.setPolicy({ unattended: { perRun: { usd: 5 }, perDay: { usd: 25 } } })
    await spend(ledger, "earlier", 22)

    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "scheduled", at })).toBe(3)
  })

  test("is a 1-cent floor once the own-key dollars are spent, so the run still starts", async () => {
    const ledger = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 } } })
    await spend(ledger, "earlier", 10)

    expect((await ledger.checkAllowance({ runId: "own", source: "scheduled", at })).allowed).toBe(false)
    expect(CODIUM_RUN_HEADROOM_FLOOR_USD).toBe(0.01)
    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "scheduled", at })).toBe(0.01)
  })

  test("is a 1-cent floor under an explicit zero limit", async () => {
    const ledger = await newLedger()
    await ledger.setPolicy({ interactive: { perMonth: { usd: 0 } } })

    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "parallel", at })).toBe(0.01)
  })

  test("is absent when no dollar limit applies, as for an own-key run", async () => {
    const ledger = await newLedger()

    // Interactive work ships uncapped.
    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "parallel", at })).toBeUndefined()
  })

  test("never moves the Codium check itself, which still reserves nothing and skips the windows", async () => {
    const ledger = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 } } })
    await spend(ledger, "earlier", 10)

    expect(
      await ledger.checkAllowance({ runId: "codium", source: "scheduled", at, reserve: true, billing: "codium" }),
    ).toEqual({ allowed: true, state: "ok", unmeasuredRuns: 0 })
    expect(await codiumRunHeadroom(ledger, { runId: "codium", source: "scheduled", at })).toBe(0.01)
  })
})
