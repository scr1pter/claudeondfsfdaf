import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { createJobId, randomId } from "@vectordevai/schema/everywhere"
import { createLedger, ledgerFile, type RunnerLedger } from "./everywhere-ledger"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

installFetchGuard()

test("concurrent offers cannot overbook this computer's slot or daily cap", async () => {
  let stored: RunnerLedger | undefined
  const now = Date.now()
  const ledger = createLedger({ read: async () => stored, write: async (state) => { stored = structuredClone(state) }, now: () => now })
  const jobs = [createJobId(now), createJobId(now)]
  expect(await Promise.all(jobs.map((jid) => ledger.reserve(jid, { atOnce: 1, perDay: 1 })))).toEqual([true, false])
  await ledger.release(jobs[0]!)
  expect(await ledger.reserve(jobs[1]!, { atOnce: 1, perDay: 1 })).toBe(false)
  expect((await ledger.inspect()).count).toBe(1)
})

test("a new UTC day resets the counter but preserves interrupted jobs", async () => {
  let stored: RunnerLedger | undefined
  let now = Date.UTC(2026, 10, 11, 23, 59)
  const ledger = createLedger({ read: async () => stored, write: async (state) => { stored = state }, now: () => now })
  const jid = createJobId(now)
  await ledger.reserve(jid, { atOnce: 1, perDay: 1 })
  await ledger.update({ jid, startedAt: now, lease: randomId(), sessionID: "ses_unattended" })
  now += 120_000
  const restarted = createLedger({ read: async () => stored, write: async (state) => { stored = state }, now: () => now })
  expect((await restarted.inspect()).count).toBe(0)
  expect((await restarted.inspect()).jobs[0]?.jid).toBe(jid)
})

test("offer ids remain single use for an hour and damaged storage fails closed", async () => {
  let stored: unknown
  let now = Date.now()
  const ledger = createLedger({ read: async () => stored, write: async (state) => { stored = state }, now: () => now })
  const id = randomId()
  expect(await ledger.useOnce(id, now + 3_600_000)).toBe(true)
  expect(await ledger.useOnce(id, now + 3_600_000)).toBe(false)
  now += 3_600_001
  expect(await ledger.useOnce(id, now + 3_600_000)).toBe(true)
  stored = { jobs: "damaged" }
  await expect(ledger.reserve(createJobId(now), { atOnce: 1, perDay: 1 })).rejects.toThrow("invalid")
})

test("publication receipts require the exact reserved lease and survive slot release", async () => {
  let stored: RunnerLedger | undefined
  const now = Date.now()
  const ledger = createLedger({ read: async () => stored, write: async (state) => { stored = structuredClone(state) }, now: () => now })
  const jid = createJobId(now)
  const lease = randomId()
  await ledger.reserve(jid, { atOnce: 1, perDay: 20 })
  await ledger.update({ jid, lease, startedAt: now })
  await expect(ledger.remember({ jid, lease: randomId(), outcome: "changes" })).rejects.toThrow("no reservation")
  await ledger.remember({ jid, lease, outcome: "changes", summary: "Fixed retry handling." })
  await ledger.release(jid)
  expect((await ledger.inspect()).pending).toEqual([{ jid, lease, outcome: "changes", summary: "Fixed retry handling." }])
  expect(await ledger.reserve(jid, { atOnce: 1, perDay: 20 })).toBe(false)
  expect(await ledger.reserve(createJobId(now), { atOnce: 1, perDay: 20 })).toBe(true)
  await ledger.acknowledge({ jid, lease: randomId(), outcome: "changes" })
  expect((await ledger.inspect()).pending).toHaveLength(1)
  await ledger.acknowledge({ jid, lease, outcome: "changes" })
  expect((await ledger.inspect()).pending).toEqual([])
})

test("malformed or duplicate publication receipts fail closed instead of losing recovery state", async () => {
  const now = Date.now()
  const jid = createJobId(now)
  for (const pending of ["damaged", [{ jid, lease: "invalid", outcome: "changes" }], Array.from({ length: 2 }, () => ({ jid, lease: randomId(), outcome: "changes" }))]) {
    const ledger = createLedger({ read: async () => ({ day: new Date(now).toISOString().slice(0, 10), count: 1, jobs: [], offers: {}, pending }), write: async () => undefined, now: () => now })
    await expect(ledger.inspect()).rejects.toThrow("invalid")
  }
})

test("the private atomic file survives a fresh ledger instance and refuses corruption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everywhere-ledger-"))
  const file = path.join(directory, "jobs.json")
  const now = Date.now()
  try {
    const storage = ledgerFile(file)
    const original = createLedger({ ...storage, now: () => now })
    const jid = createJobId(now)
    expect(await original.reserve(jid, { atOnce: 1, perDay: 20 })).toBe(true)
    const lease = randomId()
    await original.update({ jid, lease, startedAt: now })
    await original.remember({ jid, lease, outcome: "changes", summary: "Fixed retry handling." })
    await original.release(jid)
    const reopened = createLedger({ ...ledgerFile(file), now: () => now })
    expect((await reopened.inspect()).jobs).toEqual([])
    expect((await reopened.inspect()).pending).toEqual([{ jid, lease, outcome: "changes", summary: "Fixed retry handling." }])
    expect(JSON.parse(await readFile(file, "utf8")).count).toBe(1)
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, "corrupt")
    await expect(reopened.inspect()).rejects.toThrow("could not be read")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
