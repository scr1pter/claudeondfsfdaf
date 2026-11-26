import { afterAll, afterEach, expect } from "bun:test"
import { randomUUID, createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectDirectory } from "@/connect/directory"
import { ConnectDirectoryRequest } from "@/connect/directory-request"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vector-directory-request-"))
const data = path.join(temporary, "data")
const testGlobal = Global.layerWith({
  home: path.join(temporary, "home"),
  data,
  state: path.join(temporary, "state"),
  cache: path.join(temporary, "cache"),
  config: path.join(temporary, "config"),
  bin: path.join(temporary, "bin"),
  log: path.join(temporary, "log"),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ConnectDirectoryRequest.node, Global.node]), [[Global.node, testGlobal]]),
)
const ledgerWith = (limits: Partial<ConnectDirectoryRequest.Limits>) =>
  AppNodeBuilder.build(LayerNode.group([ConnectDirectoryRequest.node, Global.node]), [
    [Global.node, testGlobal],
    [ConnectDirectoryRequest.node, ConnectDirectoryRequest.nodeWith(limits)],
  ])
// Small caps, so a full directory (3 keys) and a full ledger (4 keys) are cheap to reach.
const small = testEffect(ledgerWith({ maxKeys: 3, maxTotalKeys: 4, pruneLimit: 2 }))
const roomy = testEffect(ledgerWith({ maxKeys: 8, maxTotalKeys: 8, pruneLimit: 2 }))
const PROJECT = "directory-request-fixture"
// Directory receipts live under the process data root, apart from the ledger's own test root.
const receipts = path.join(
  Global.Path.data,
  "storage",
  ...ConnectDirectory.prefix({ projectID: PROJECT, directory: "/" }).slice(0, 2),
)
afterEach(async () => {
  await fs.rm(data, { recursive: true, force: true })
  await fs.rm(receipts, { recursive: true, force: true })
})
afterAll(() => fs.rm(temporary, { recursive: true, force: true }))

const input = (): Connect.DirectoryReviewInput => ({
  requestKey: randomUUID(),
  background: true,
  target: { kind: "branch", base: "main" },
})
const fixture = Effect.gen(function* () {
  const service = yield* ConnectDirectoryRequest.Service
  const directory = path.join(data, "workspace")
  yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
  const scope = { projectID: PROJECT, directory }
  const identity = yield* ConnectDirectory.capture(directory)
  const folder = path.join(
    data,
    "storage",
    ...ConnectDirectoryRequest.prefix({ projectID: scope.projectID, canonical: identity.canonical }),
  )
  return { service, scope, folder }
})
const refused = <A>(effect: Effect.Effect<A, ConnectDirectoryRequest.Error>) => effect.pipe(Effect.flip)
const worker = path.join(import.meta.dir, "../fixture/directory-request-worker.ts")
const child = (scope: ConnectDirectoryRequest.Scope, request: Connect.DirectoryReviewInput) =>
  new Promise<{ code: number; output: string; errors: string }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify({ data, scope, input: request })], {
      cwd: path.join(import.meta.dir, "../.."),
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    proc.stdout.on("data", (value) => output.push(Buffer.from(value)))
    proc.stderr.on("data", (value) => errors.push(Buffer.from(value)))
    proc.on("close", (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(output).toString(), errors: Buffer.concat(errors).toString() }),
    )
  })
const WorkerResult = Schema.Struct({
  kind: Schema.Literals(["reserved", "bound", "refused"]),
  code: Schema.optional(Schema.Literals(["pending", "mismatch", "unavailable", "consumed"])),
})

// A ledger worker that keeps running: its printed lines, one per step, and a stdin line for its held token.
const start = (request: {
  readonly scope: ConnectDirectoryRequest.Scope
  readonly input: Connect.DirectoryReviewInput
  readonly prepare?: string
  readonly writer?: ConnectDirectoryRequest.Writer
  readonly refuse?: ConnectDirectoryRequest.Reason
  readonly hold?: boolean
}) => {
  const proc = spawn(process.execPath, [worker, JSON.stringify({ data, ...request })], {
    cwd: path.join(import.meta.dir, "../.."),
  })
  const lines: unknown[] = []
  const partial = { text: "", errors: "" }
  proc.stdout.on("data", (chunk) => {
    const parts = (partial.text + String(chunk)).split("\n")
    partial.text = parts.pop() ?? ""
    lines.push(...parts.filter(Boolean).map((part): unknown => JSON.parse(part)))
  })
  proc.stderr.on("data", (chunk) => {
    partial.errors += String(chunk)
  })
  const closed = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)))
  return {
    lines,
    line: (index: number) =>
      pollWithTimeout(
        Effect.sync(() => lines[index]),
        "The ledger worker did not print its next step",
        "20 seconds",
      ),
    send: (text: string) => proc.stdin.write(`${text}\n`),
    exit: Effect.promise(() => closed).pipe(
      Effect.tap((code) => Effect.sync(() => expect(code, partial.errors).toBe(0))),
    ),
  }
}
const writer = { pid: process.pid, start: Math.floor(performance.timeOrigin) }
const grace = (graceMs: number) => Effect.provideService(ConnectDirectoryRequest.Options, { graceMs, writer })
// An owner's evidence for a stale prepared anchor, recording each anchor it was asked about.
const inspector = (evidence: ConnectDirectoryRequest.Evidence) => {
  const calls: ConnectDirectoryRequest.Prepared[] = []
  const inspect: ConnectDirectoryRequest.Inspect = (prepared) =>
    Effect.sync(() => {
      calls.push(prepared)
      return evidence
    })
  return { calls, inspect }
}
const readJson = (file: string) =>
  Effect.promise(async (): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8")))
const exists = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )
const CONSUMED = "This review start did not complete and no review ran. Start a new review."

it.live(
  "concurrent processes reserve one UUID once, including alternate UUID casing, and an exited pending winner is never replaced",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = input()
      const results = yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            child(f.scope, { ...request, requestKey: i % 2 ? request.requestKey.toUpperCase() : request.requestKey }),
          ),
        ),
      )
      for (const result of results) expect(result.code, result.errors).toBe(0)
      const rows = results.map((result) => {
        const line = result.output.trim().split("\n").at(-1)
        if (!line) throw new Error("The actual request-ledger worker returned no result")
        return Schema.decodeUnknownSync(WorkerResult)(JSON.parse(line))
      })
      expect(rows.filter((row) => row.kind === "reserved")).toHaveLength(1)
      expect(rows.filter((row) => row.kind === "refused" && row.code === "pending")).toHaveLength(5)
      expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("pending")
      const pointers = yield* Effect.promise(() =>
        fs.readdir(path.join(data, "storage/connect-directory-requests/by-key")),
      )
      expect(pointers).toEqual([`${request.requestKey}.json`])
    }),
  30_000,
)

it.live("payload and directory identity changes cannot move a consumed key or mint a second reservation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    const claimed = yield* f.service.reserve(f.scope, request)
    expect(claimed.kind).toBe("reserved")
    expect((yield* refused(f.service.reserve(f.scope, { ...request, target: { kind: "staged" } }))).code).toBe(
      "mismatch",
    )
    const other = path.join(data, "other-workspace")
    yield* Effect.promise(() => fs.mkdir(other))
    expect((yield* refused(f.service.reserve({ ...f.scope, directory: other }, request))).code).toBe("mismatch")
    yield* Effect.promise(async () => {
      await fs.rename(f.scope.directory, `${f.scope.directory}.original`)
      await fs.mkdir(f.scope.directory)
    })
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("mismatch")
  }),
)

it.live("the first writer owns a frozen cloned input and binding cannot be taken over or forgotten", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const target = { kind: "branch" as const, base: "main" }
    const request = { ...input(), target }
    const start = yield* f.service.reserve(f.scope, request)
    if (start.kind !== "reserved") throw new Error("No first writer")
    target.base = "changed-by-caller"
    expect(start.claim.input.target).toEqual({ kind: "branch", base: "main" })
    expect(Object.isFrozen(start.claim.input.target)).toBe(true)
    const binding = { anchorID: SessionID.create(), runID: Connect.RunID.create() }
    yield* f.service.bind(start.token, binding)
    const original = { ...request, target: { kind: "branch" as const, base: "main" } }
    const replay = yield* f.service.reserve(f.scope, { ...original, requestKey: original.requestKey.toUpperCase() })
    expect(replay.kind).toBe("bound")
    if (replay.kind !== "bound") throw new Error("No original binding")
    expect(replay.binding).toMatchObject(binding)
    expect(replay.binding.key).toBe(request.requestKey)
    const folder = path.join(data, "storage", ...ConnectDirectoryRequest.prefix(start.claim.scope))
    yield* Effect.promise(() => fs.rm(path.join(folder, "bindings", `${request.requestKey}.json`)))
    expect((yield* refused(f.service.reserve(f.scope, original))).code).toBe("pending")
    expect(Exit.isFailure(yield* f.service.bind(start.token, binding).pipe(Effect.exit))).toBe(true)
  }),
)

it.live("tampered or missing reservation/index state refuses rather than repairing a pending key", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    const start = yield* f.service.reserve(f.scope, request)
    if (start.kind !== "reserved") throw new Error("No first writer")
    const folder = path.join(data, "storage", ...ConnectDirectoryRequest.prefix(start.claim.scope))
    const slot = path.join(folder, "keys", `${request.requestKey}.json`)
    yield* Effect.promise(() => fs.appendFile(slot, " "))
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("unavailable")
    yield* Effect.promise(() => fs.rm(slot))
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("unavailable")
    yield* Effect.promise(() => fs.rm(path.join(folder, "index.json")))
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("unavailable")
    expect(
      yield* Effect.promise(() => fs.readdir(path.join(data, "storage/connect-directory-requests/by-key"))),
    ).toEqual([`${request.requestKey}.json`])
  }),
)

it.live("a failed O_EXCL binding remains consumed and cannot start a replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    const start = yield* f.service.reserve(f.scope, request)
    if (start.kind !== "reserved") throw new Error("No first writer")
    const folder = path.join(data, "storage", ...ConnectDirectoryRequest.prefix(start.claim.scope))
    yield* Effect.promise(() => fs.writeFile(path.join(folder, "bindings", `${request.requestKey}.json`), "{"))
    expect(
      (yield* refused(f.service.bind(start.token, { anchorID: SessionID.create(), runID: Connect.RunID.create() })))
        .code,
    ).toBe("unavailable")
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("unavailable")
  }),
)

it.live(
  "a missing global pointer cannot reuse the key in another directory even while the original scope retains it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = input()
      const start = yield* f.service.reserve(f.scope, request)
      if (start.kind !== "reserved") throw new Error("No original reservation")
      const root = path.join(data, "storage/connect-directory-requests")
      const pointer = path.join(root, "by-key", `${request.requestKey}.json`)
      yield* Effect.promise(() => fs.rm(pointer))
      const other = path.join(data, "different-workspace")
      yield* Effect.promise(() => fs.mkdir(other))
      expect((yield* refused(f.service.reserve({ ...f.scope, directory: other }, request))).code).toBe("unavailable")
      expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("unavailable")
      const original = path.join(data, "storage", ...ConnectDirectoryRequest.prefix(start.claim.scope))
      expect(yield* Effect.promise(() => fs.readdir(path.join(original, "keys")))).toEqual([
        `${request.requestKey}.json`,
      ])
      expect(yield* Effect.promise(() => fs.readdir(path.join(root, "by-key")))).toEqual([])
      expect(
        (yield* refused(f.service.bind(start.token, { anchorID: SessionID.create(), runID: Connect.RunID.create() })))
          .code,
      ).toBe("unavailable")
    }),
)

it.live("a missing independent global index never reconstructs or takes over retained pointers", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    yield* f.service.reserve(f.scope, request)
    const root = path.join(data, "storage/connect-directory-requests")
    yield* Effect.promise(() => fs.rm(path.join(root, "index.json")))
    const other = path.join(data, "different-workspace")
    yield* Effect.promise(() => fs.mkdir(other))
    expect((yield* refused(f.service.reserve({ ...f.scope, directory: other }, request))).code).toBe("unavailable")
    expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
    expect(yield* Effect.promise(() => fs.readdir(path.join(root, "by-key")))).toEqual([`${request.requestKey}.json`])
    yield* Effect.promise(() => fs.rm(path.join(root, "by-key", `${request.requestKey}.json`)))
    expect((yield* refused(f.service.reserve({ ...f.scope, directory: other }, request))).code).toBe("unavailable")
    expect(yield* Effect.promise(() => fs.readdir(path.join(root, "by-key")))).toEqual([])
  }),
)

it.live(
  "the finite scope cap keeps all pending tombstones and refuses another key without creating its global pointer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = input()
      const start = yield* f.service.reserve(f.scope, request)
      if (start.kind !== "reserved") throw new Error("No first writer")
      const folder = path.join(data, "storage", ...ConnectDirectoryRequest.prefix(start.claim.scope))
      const original = yield* Effect.promise(() =>
        fs.readFile(path.join(folder, "keys", `${request.requestKey}.json`), "utf8"),
      )
      const stored: unknown = JSON.parse(original)
      if (typeof stored !== "object" || stored === null) throw new Error("No actual reservation bytes")
      const entries = [{ key: request.requestKey, digest: createHash("sha256").update(original).digest("hex") }]
      for (let offset = 1; offset < ConnectDirectoryRequest.MAX_KEYS; offset += 64) {
        const values = Array.from({ length: Math.min(64, ConnectDirectoryRequest.MAX_KEYS - offset) }, () => {
          const key = randomUUID()
          const value = JSON.stringify({ ...stored, key })
          entries.push({ key, digest: createHash("sha256").update(value).digest("hex") })
          return { key, value }
        })
        yield* Effect.promise(() =>
          Promise.all(
            values.flatMap(({ key, value }) => [
              fs.writeFile(path.join(folder, "keys", `${key}.json`), value),
              fs.writeFile(path.join(data, "storage/connect-directory-requests/by-key", `${key}.json`), value),
            ]),
          ),
        )
      }
      yield* Effect.promise(() =>
        fs.writeFile(path.join(folder, "index.json"), JSON.stringify({ version: 1, entries })),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(data, "storage/connect-directory-requests/index.json"),
          JSON.stringify({ version: 1, entries }),
        ),
      )
      expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("pending")
      const next = input()
      expect((yield* refused(f.service.reserve(f.scope, next))).code).toBe("unavailable")
      expect(yield* Effect.promise(() => fs.readdir(path.join(folder, "keys")))).toHaveLength(
        ConnectDirectoryRequest.MAX_KEYS,
      )
      expect(
        yield* Effect.promise(() =>
          fs.lstat(path.join(data, "storage/connect-directory-requests/by-key", `${next.requestKey}.json`)).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  30_000,
)

it.live(
  "a live process's young prepared claim stays pending; after the grace its unreleased anchor is tombstoned and that process's bind is refused",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const request = input()
      const anchorID = SessionID.create()
      const held = start({ scope: f.scope, input: request, prepare: anchorID, hold: true })
      yield* held.line(2)
      expect(held.lines).toEqual([{ kind: "reserved" }, { step: "prepare", kind: "ok" }, { step: "hold", kind: "ok" }])
      const unreleased = inspector({ kind: "unreleased" })
      expect((yield* refused(f.service.reserve(f.scope, request, unreleased.inspect))).code).toBe("pending")
      expect(unreleased.calls).toEqual([])
      const answer = yield* refused(f.service.reserve(f.scope, request, unreleased.inspect).pipe(grace(0)))
      expect(answer).toMatchObject({ code: "consumed", message: CONSUMED })
      expect(unreleased.calls.map((call) => call.anchorID)).toEqual([anchorID])
      expect(yield* readJson(path.join(f.folder, "refused", `${request.requestKey}.json`))).toMatchObject({
        key: request.requestKey,
        reason: "abandoned",
        anchorID,
      })
      held.send(`bind ${Connect.RunID.create()}`)
      expect(yield* held.line(3)).toEqual({ step: "bind", kind: "refused", code: "consumed" })
      yield* held.exit
      expect(yield* exists(path.join(f.folder, "bindings", `${request.requestKey}.json`))).toBe(false)
    }),
  30_000,
)

it.live(
  "a prepared key whose writer exited reconciles once: no job is consumed, and a released job is bound",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const lost = input()
      yield* start({ scope: f.scope, input: lost, prepare: SessionID.create() }).exit
      const unreleased = inspector({ kind: "unreleased" })
      expect((yield* refused(f.service.reserve(f.scope, lost, unreleased.inspect))).code).toBe("consumed")
      expect((yield* refused(f.service.reserve(f.scope, lost, unreleased.inspect))).code).toBe("consumed")
      expect(unreleased.calls).toHaveLength(1)

      const kept = input()
      const anchorID = SessionID.create()
      yield* start({ scope: f.scope, input: kept, prepare: anchorID }).exit
      const runID = Connect.RunID.create()
      const released = inspector({ kind: "released", runID })
      const bound = yield* f.service.reserve(f.scope, kept, released.inspect)
      if (bound.kind !== "bound") throw new Error("The released job was not bound")
      expect(bound.binding).toMatchObject({ key: kept.requestKey, anchorID, runID })
      expect(released.calls.map((call) => call.anchorID)).toEqual([anchorID])
      expect(yield* readJson(path.join(f.folder, "bindings", `${kept.requestKey}.json`))).toMatchObject({ runID })
      expect((yield* f.service.reserve(f.scope, kept, released.inspect)).kind).toBe("bound")
      expect(released.calls).toHaveLength(1)
      expect(yield* exists(path.join(f.folder, "refused", `${kept.requestKey}.json`))).toBe(false)
    }),
  30_000,
)

it.live(
  "an earlier run of this pid and a writerless reservation past the grace reconcile; unknown evidence never writes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const earlier = input()
      yield* start({
        scope: f.scope,
        input: earlier,
        prepare: SessionID.create(),
        writer: { pid: process.pid, start: 1 },
      }).exit
      expect(
        (yield* refused(f.service.reserve(f.scope, earlier, inspector({ kind: "unreleased" }).inspect))).code,
      ).toBe("consumed")

      const bare = input()
      yield* start({ scope: f.scope, input: bare }).exit
      const never = inspector({ kind: "unreleased" })
      expect((yield* refused(f.service.reserve(f.scope, bare, never.inspect))).code).toBe("pending")
      expect((yield* refused(f.service.reserve(f.scope, bare, never.inspect).pipe(grace(0)))).code).toBe("consumed")
      expect(never.calls).toEqual([])
      const tombstone = yield* readJson(path.join(f.folder, "refused", `${bare.requestKey}.json`))
      expect(tombstone).toMatchObject({ key: bare.requestKey, reason: "abandoned" })
      expect(tombstone).not.toHaveProperty("anchorID")

      const unknown = input()
      yield* start({ scope: f.scope, input: unknown, prepare: SessionID.create() }).exit
      expect((yield* refused(f.service.reserve(f.scope, unknown, inspector({ kind: "unknown" }).inspect))).code).toBe(
        "unavailable",
      )
      // A stuck owner read is bounded while it holds the global lock: unavailable, no write, and the lock is free.
      const stuck = f.service
        .reserve(f.scope, unknown, () => Effect.never)
        .pipe(
          Effect.provideService(ConnectDirectoryRequest.Options, {
            graceMs: ConnectDirectoryRequest.GRACE_MS,
            writer,
            inspectMs: 50,
          }),
        )
      expect((yield* refused(stuck)).code).toBe("unavailable")
      expect((yield* refused(f.service.reserve(f.scope, unknown))).code).toBe("unavailable")
      for (const folder of ["refused", "bindings"])
        expect(yield* exists(path.join(f.folder, folder, `${unknown.requestKey}.json`))).toBe(false)
    }),
  30_000,
)

it.live("this process's live claim stays pending, and a refused or released claim is consumed at once", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    const claim = yield* f.service.reserve(f.scope, request)
    if (claim.kind !== "reserved") throw new Error("No first writer")
    const anchorID = SessionID.create()
    yield* f.service.prepare(claim.token, anchorID)
    const never = inspector({ kind: "released", runID: Connect.RunID.create() })
    expect((yield* refused(f.service.reserve(f.scope, request, never.inspect).pipe(grace(0)))).code).toBe("pending")
    yield* f.service.refuse(claim.token, { reason: "fence", anchorID })
    expect(yield* refused(f.service.reserve(f.scope, request, never.inspect))).toMatchObject({
      code: "consumed",
      message: CONSUMED,
    })
    expect(yield* readJson(path.join(f.folder, "refused", `${request.requestKey}.json`))).toMatchObject({
      reason: "fence",
      anchorID,
    })
    expect((yield* refused(f.service.prepare(claim.token, anchorID))).code).toBe("unavailable")
    expect((yield* refused(f.service.bind(claim.token, { anchorID, runID: Connect.RunID.create() }))).code).toBe(
      "unavailable",
    )
    expect(never.calls).toEqual([])

    const dropped = input()
    const second = yield* f.service.reserve(f.scope, dropped)
    if (second.kind !== "reserved") throw new Error("No second writer")
    yield* f.service.release(second.token)
    expect((yield* refused(f.service.reserve(f.scope, dropped, never.inspect))).code).toBe("consumed")
    expect(never.calls).toEqual([])
    expect(yield* readJson(path.join(f.folder, "refused", `${dropped.requestKey}.json`))).toMatchObject({
      reason: "abandoned",
    })
  }),
)

it.live("an interrupted bind settles as bound or consumed, never as a contradictory key", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (const delay of [0, 1, 2, 5]) {
      const request = input()
      const claim = yield* f.service.reserve(f.scope, request)
      if (claim.kind !== "reserved") throw new Error("No first writer")
      const anchorID = SessionID.create()
      yield* f.service.prepare(claim.token, anchorID)
      const fiber = yield* f.service
        .bind(claim.token, { anchorID, runID: Connect.RunID.create() })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep(`${delay} millis`)
      yield* Fiber.interrupt(fiber)
      yield* f.service.release(claim.token)
      const settled = yield* f.service
        .reserve(f.scope, request, inspector({ kind: "unreleased" }).inspect)
        .pipe(Effect.match({ onSuccess: (answer) => answer.kind, onFailure: (error) => error.code }))
      expect(["bound", "consumed"]).toContain(settled)
    }
  }),
)

it.live("partial, foreign or contradictory prepared and tombstone records stay unavailable with no write", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const request = input()
    const claim = yield* f.service.reserve(f.scope, request)
    if (claim.kind !== "reserved") throw new Error("No first writer")
    yield* f.service.release(claim.token)
    const file = (folder: string, key = request.requestKey) => path.join(f.folder, folder, `${key}.json`)
    const anchorID = SessionID.create()
    const record = claim.claim.record
    const stray = randomUUID()
    const cases: { name: string; files: Record<string, string>; folders?: string[] }[] = [
      { name: "partial prepared", files: { [file("prepared")]: "{" } },
      {
        name: "prepared with another nonce",
        files: {
          [file("prepared")]: JSON.stringify({
            ...record,
            nonce: randomUUID(),
            anchorID,
            writer: { pid: 1, start: 0 },
            preparedAt: 0,
          }),
        },
      },
      { name: "partial tombstone", files: { [file("refused")]: "{" } },
      {
        name: "binding beside a tombstone",
        files: {
          [file("bindings")]: JSON.stringify({ ...record, anchorID, runID: Connect.RunID.create() }),
          [file("refused")]: JSON.stringify({ ...record, reason: "fence", refusedAt: 0 }),
        },
      },
      {
        name: "prepared record of an unindexed key",
        files: {
          [file("prepared", stray)]: JSON.stringify({
            ...record,
            key: stray,
            anchorID,
            writer: { pid: 1, start: 0 },
            preparedAt: 0,
          }),
        },
      },
      {
        name: "tombstone of an unindexed key",
        files: { [file("refused", stray)]: JSON.stringify({ ...record, key: stray, reason: "run", refusedAt: 0 }) },
      },
      { name: "directory inside refused", files: {}, folders: [file("refused", stray)] },
    ]
    for (const item of cases) {
      yield* Effect.promise(async () => {
        await Promise.all(Object.entries(item.files).map(([target, text]) => fs.writeFile(target, text)))
        await Promise.all((item.folders ?? []).map((target) => fs.mkdir(target)))
      })
      const never = inspector({ kind: "unreleased" })
      expect((yield* refused(f.service.reserve(f.scope, request, never.inspect).pipe(grace(0)))).code, item.name).toBe(
        "unavailable",
      )
      expect(never.calls, item.name).toEqual([])
      const left = yield* Effect.promise(async () =>
        (
          await Promise.all(
            ["prepared", "refused", "bindings"].map((folder) => fs.readdir(path.join(f.folder, folder))),
          )
        ).flat(),
      )
      expect(left.length, item.name).toBe(Object.keys(item.files).length + (item.folders?.length ?? 0))
      yield* Effect.promise(() =>
        Promise.all(
          [...Object.keys(item.files), ...(item.folders ?? [])].map((target) => fs.rm(target, { recursive: true })),
        ),
      )
    }
    expect((yield* refused(f.service.reserve(f.scope, request))).code).toBe("consumed")
  }),
)

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const ledgerRoot = path.join(data, "storage/connect-directory-requests")
const Listed = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ key: Schema.String })),
  pruning: Schema.optional(Schema.Array(Schema.Struct({ key: Schema.String }))),
  admitting: Schema.optional(Schema.Struct({ key: Schema.String })),
})
const listed = (file: string) =>
  Effect.promise(async () => Schema.decodeUnknownSync(Listed)(JSON.parse(await fs.readFile(file, "utf8"))))
const keys = (file: string) => listed(file).pipe(Effect.map((value) => value.entries.map((entry) => entry.key).sort()))
// Another directory of the same project, with its ledger folder.
const scopeAt = (name: string) =>
  Effect.gen(function* () {
    const directory = path.join(data, name)
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    const scope = { projectID: PROJECT, directory }
    const identity = yield* ConnectDirectory.capture(directory)
    const folder = path.join(
      data,
      "storage",
      ...ConnectDirectoryRequest.prefix({ projectID: scope.projectID, canonical: identity.canonical }),
    )
    return { scope, folder }
  })
// Every place a key lives: its pointer, its slot and records, and both indexes.
const where = (folder: string, key: string) =>
  Effect.gen(function* () {
    const file = (base: string) => exists(path.join(base, `${key}.json`))
    return {
      pointer: yield* file(path.join(ledgerRoot, "by-key")),
      slot: yield* file(path.join(folder, "keys")),
      binding: yield* file(path.join(folder, "bindings")),
      prepared: yield* file(path.join(folder, "prepared")),
      refused: yield* file(path.join(folder, "refused")),
      global: (yield* keys(path.join(ledgerRoot, "index.json"))).includes(key),
      scope: (yield* keys(path.join(folder, "index.json"))).includes(key),
    }
  })
const pruned = {
  pointer: false,
  slot: false,
  binding: false,
  prepared: false,
  refused: false,
  global: false,
  scope: false,
}
const reserved = (
  service: ConnectDirectoryRequest.Interface,
  scope: ConnectDirectoryRequest.Scope,
  request = input(),
) =>
  Effect.gen(function* () {
    const start = yield* service.reserve(scope, request)
    if (start.kind !== "reserved") throw new Error("The ledger did not admit a new key")
    return { request, token: start.token, nonce: start.claim.record.nonce }
  })
const tombstoned = (service: ConnectDirectoryRequest.Interface, scope: ConnectDirectoryRequest.Scope) =>
  Effect.gen(function* () {
    const start = yield* reserved(service, scope)
    yield* service.refuse(start.token, { reason: "fence" })
    return start
  })
const receipt = (id: Connect.RunID, directory: string, state: "running" | { readonly ended: number }): Connect.Run => {
  const request = {
    id,
    to: "vectorscope",
    action: "review",
    requester: { kind: "user", agent: "build" },
    requestID: id,
    directory,
    background: true,
    target: { kind: "uncommitted" },
  } as const
  if (state === "running") return { id, request, status: "running", time: { created: 0, started: 0 } }
  return {
    id,
    request,
    status: "done",
    time: { created: 0, started: 0, ended: state.ended },
    result: { state: "cancelled", summary: "Cancelled.", findings: [], sessions: [], notes: [] },
  }
}
// A bound key, with the receipt the hub writes before it binds: done, still running, or none at all.
const boundWith = (
  service: ConnectDirectoryRequest.Interface,
  scope: ConnectDirectoryRequest.Scope,
  state?: "running" | { readonly ended: number },
) =>
  Effect.gen(function* () {
    const start = yield* reserved(service, scope)
    const anchorID = SessionID.create()
    const runID = Connect.RunID.create()
    if (state) {
      const token = yield* ConnectDirectory.issue({ sessionID: anchorID, ...scope })
      yield* ConnectDirectory.write(token, receipt(runID, scope.directory, state))
      ConnectDirectory.retire(token)
    }
    yield* service.bind(start.token, { anchorID, runID })
    return start
  })

it.effect("a settled key replays for its retention, then an admission prunes it and the key starts a new request", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* scopeAt("other-workspace")
    const a = yield* tombstoned(f.service, f.scope)
    const b = yield* boundWith(f.service, f.scope, { ended: DAY })
    const c = yield* boundWith(f.service, f.scope)
    const d = yield* boundWith(f.service, f.scope, "running")
    // A binding with no receipt folder at all has no evidence its receipt ever existed here.
    const e = yield* boundWith(f.service, other.scope)
    // Reserved now and tombstoned only at 29 days: it ages from the tombstone.
    const late = yield* reserved(f.service, f.scope)

    yield* TestClock.adjust(29 * DAY)
    yield* f.service.refuse(late.token, { reason: "fence" })
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* refused(f.service.reserve(f.scope, a.request))).code).toBe("consumed")
    for (const key of [b, c, d]) expect((yield* f.service.reserve(f.scope, key.request)).kind).toBe("bound")
    expect(yield* where(f.folder, a.request.requestKey)).toEqual({
      ...pruned,
      pointer: true,
      slot: true,
      refused: true,
      global: true,
      scope: true,
    })
    for (const key of [b, c, d])
      expect(yield* where(f.folder, key.request.requestKey)).toEqual({
        ...pruned,
        pointer: true,
        slot: true,
        binding: true,
        global: true,
        scope: true,
      })

    yield* TestClock.adjust(DAY + 1)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, a.request.requestKey)).toEqual(pruned)
    expect(yield* where(f.folder, c.request.requestKey)).toEqual(pruned)
    expect(yield* where(f.folder, b.request.requestKey)).toMatchObject({ pointer: true, binding: true, scope: true })
    expect(yield* where(f.folder, d.request.requestKey)).toMatchObject({ pointer: true, binding: true, scope: true })
    expect((yield* listed(path.join(ledgerRoot, "index.json"))).pruning).toBeUndefined()

    yield* TestClock.adjust(DAY)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, b.request.requestKey)).toEqual(pruned)
    expect((yield* f.service.reserve(f.scope, d.request)).kind).toBe("bound")
    expect((yield* f.service.reserve(other.scope, e.request)).kind).toBe("bound")
    expect((yield* refused(f.service.reserve(f.scope, late.request))).code).toBe("consumed")

    const again = yield* reserved(f.service, f.scope, a.request)
    expect(again.nonce).not.toBe(a.nonce)
    const fresh = yield* reserved(f.service, f.scope, b.request)
    expect(fresh.nonce).not.toBe(b.nonce)
    yield* f.service.release(again.token)
    yield* f.service.release(fresh.token)
  }),
)

it.effect("an open binding is inspected only after the existing age floor and never by a replay", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const old = yield* boundWith(f.service, f.scope, "running")
    const pending = yield* reserved(f.service, f.scope)
    yield* f.service.release(pending.token)
    const inspected: string[] = []
    const inspect: ConnectDirectoryRequest.InspectOpen = (binding) =>
      Effect.sync(() => {
        inspected.push(binding.key)
        return true
      })
    const admit = () =>
      f.service
        .reserve(f.scope, input(), undefined, inspect)
        .pipe(
          Effect.flatMap((start) =>
            start.kind === "reserved" ? f.service.release(start.token) : Effect.die("A new request must reserve"),
          ),
        )
    yield* TestClock.adjust(ConnectDirectoryRequest.RETENTION_MS - 1)
    yield* admit()
    const young = yield* boundWith(f.service, f.scope, "running")
    // Legacy index entries omit the age hint, so only the reservation can rule out an early lookup.
    for (const file of [path.join(ledgerRoot, "index.json"), path.join(f.folder, "index.json")]) {
      const index = yield* stored(file)
      yield* store(file, {
        ...index,
        entries: index.entries.map((entry) =>
          entry.key === young.request.requestKey ? { key: entry.key, digest: entry.digest } : entry,
        ),
      })
    }
    expect(inspected).toEqual([])
    yield* TestClock.adjust(1)
    expect((yield* f.service.reserve(f.scope, old.request, undefined, inspect)).kind).toBe("bound")
    expect(inspected).toEqual([])
    yield* admit()
    expect(inspected).toEqual([old.request.requestKey])
    expect(yield* where(f.folder, old.request.requestKey)).toEqual(pruned)
    expect(yield* where(f.folder, young.request.requestKey)).toMatchObject({ binding: true })
    expect(yield* where(f.folder, pending.request.requestKey)).toMatchObject({
      pointer: true,
      slot: true,
      refused: false,
    })
  }),
)

small.effect("a full directory prunes its oldest settled key past the replay window, never a younger one", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* tombstoned(f.service, f.scope)
    yield* TestClock.adjust(HOUR)
    const second = yield* tombstoned(f.service, f.scope)
    yield* TestClock.adjust(HOUR)
    const third = yield* boundWith(f.service, f.scope, { ended: 2 * HOUR })
    const next = input()
    expect((yield* refused(f.service.reserve(f.scope, next))).code).toBe("unavailable")
    expect((yield* refused(f.service.reserve(f.scope, first.request))).code).toBe("consumed")

    yield* TestClock.adjust(22 * HOUR + 30 * 60_000)
    const admitted = yield* reserved(f.service, f.scope, next)
    expect(yield* where(f.folder, first.request.requestKey)).toEqual(pruned)
    expect(yield* keys(path.join(f.folder, "index.json"))).toEqual(
      [second.request.requestKey, third.request.requestKey, next.requestKey].sort(),
    )
    expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
    expect((yield* refused(f.service.reserve(f.scope, second.request))).code).toBe("consumed")
    yield* f.service.release(admitted.token)
  }),
)

small.effect(
  "pending, prepared, live and young keys are never pruned, even when the directory and the ledger are full",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const other = yield* scopeAt("other-workspace")
      const live = yield* reserved(f.service, f.scope)
      const prepared = yield* reserved(f.service, f.scope)
      const anchorID = SessionID.create()
      yield* f.service.prepare(prepared.token, anchorID)
      yield* f.service.release(prepared.token)
      const reservation = yield* reserved(f.service, f.scope)
      yield* f.service.release(reservation.token)
      yield* TestClock.adjust(31 * DAY)
      const young = yield* tombstoned(f.service, other.scope)
      yield* TestClock.adjust(HOUR)

      const snapshot = Effect.promise(async () => {
        const folders = [
          path.join(ledgerRoot, "by-key"),
          ...[f.folder, other.folder].flatMap((folder) =>
            ["keys", "bindings", "prepared", "refused"].map((name) => path.join(folder, name)),
          ),
        ]
        const bytes = await Promise.all(
          folders.map(async (folder) =>
            Promise.all(
              (await fs.readdir(folder))
                .sort()
                .map(async (name) => [name, await fs.readFile(path.join(folder, name), "utf8")]),
            ),
          ),
        )
        return bytes
      })
      const before = yield* snapshot
      const indexes = Effect.all([
        keys(path.join(ledgerRoot, "index.json")),
        keys(path.join(f.folder, "index.json")),
        keys(path.join(other.folder, "index.json")),
      ])
      const listedBefore = yield* indexes
      expect(listedBefore[0]).toHaveLength(4)
      expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
      expect((yield* refused(f.service.reserve(other.scope, input()))).code).toBe("unavailable")
      expect(yield* snapshot).toEqual(before)
      expect(yield* indexes).toEqual(listedBefore)
      expect((yield* refused(f.service.reserve(other.scope, young.request))).code).toBe("consumed")
      yield* f.service.bind(live.token, { anchorID: SessionID.create(), runID: Connect.RunID.create() })
      expect(yield* where(f.folder, live.request.requestKey)).toMatchObject({
        binding: true,
        global: true,
        scope: true,
      })
    }),
)

roomy.effect("keys that can never be pruned do not starve an older settled key behind them", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    // Four stale reservations, twice what one scan may inspect, sort ahead of the tombstone.
    for (const _ of [1, 2, 3, 4]) yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    yield* TestClock.adjust(1)
    const settled = yield* tombstoned(f.service, f.scope)
    yield* TestClock.adjust(31 * DAY)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* where(f.folder, settled.request.requestKey)).refused).toBe(true)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* where(f.folder, settled.request.requestKey)).refused).toBe(true)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, settled.request.requestKey)).toEqual(pruned)
    expect(yield* keys(path.join(f.folder, "index.json"))).toHaveLength(7)
  }),
)

small.effect("the global index prunes settled keys of another directory, at most the prune limit per start", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* scopeAt("other-workspace")
    const foreign = [
      yield* tombstoned(f.service, other.scope),
      yield* boundWith(f.service, other.scope, { ended: 0 }),
      yield* tombstoned(f.service, other.scope),
    ].map((key) => key.request.requestKey)
    yield* TestClock.adjust(2 * HOUR)
    const local = yield* tombstoned(f.service, f.scope)
    const left = () =>
      keys(path.join(other.folder, "index.json")).pipe(
        Effect.map((list) => list.filter((key) => foreign.includes(key))),
      )

    yield* TestClock.adjust(23 * HOUR)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* left()).toHaveLength(2)
    expect((yield* where(f.folder, local.request.requestKey)).refused).toBe(true)

    yield* TestClock.adjust(30 * DAY)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* left()).toEqual([])
    for (const key of foreign) expect(yield* where(other.folder, key)).toEqual(pruned)
    expect((yield* where(f.folder, local.request.requestKey)).refused).toBe(true)

    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, local.request.requestKey)).toEqual(pruned)
  }),
)

// The index files as a crash would leave them, written by hand from the real ones.
const Stored = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({ key: Schema.String, digest: Schema.String, createdAt: Schema.optional(Schema.Number) }),
  ),
  cursor: Schema.optional(Schema.Unknown),
  pruning: Schema.optional(Schema.Array(Schema.Struct({ key: Schema.String, folder: Schema.Unknown }))),
  admitting: Schema.optional(Schema.Struct({ key: Schema.String, folder: Schema.Unknown })),
})
const stored = (file: string) => readJson(file).pipe(Effect.map(Schema.decodeUnknownSync(Stored)))
const store = (file: string, value: typeof Stored.Type) =>
  Effect.promise(() => fs.writeFile(file, JSON.stringify(value)))
const globalFile = path.join(ledgerRoot, "index.json")
const pointerOf = (key: string) => path.join(ledgerRoot, "by-key", `${key}.json`)
const folderOf = (key: string) =>
  readJson(pointerOf(key)).pipe(
    Effect.map((pointer) => Schema.decodeUnknownSync(Schema.Struct({ folder: Schema.Unknown }))(pointer).folder),
  )
// Moves a key from the global entries into the prune journal, as the prune's first write does.
const journal = (key: string) =>
  Effect.gen(function* () {
    const current = yield* stored(globalFile)
    yield* store(globalFile, {
      ...current,
      entries: current.entries.filter((entry) => entry.key !== key),
      pruning: [...(current.pruning ?? []), { key, folder: yield* folderOf(key) }],
    })
  })
const unscope = (folder: string, key: string) =>
  Effect.gen(function* () {
    const file = path.join(folder, "index.json")
    const current = yield* stored(file)
    yield* store(file, { ...current, entries: current.entries.filter((entry) => entry.key !== key) })
  })

it.live("a prune interrupted between its index rewrite and its file removals finishes on the next start", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* tombstoned(f.service, f.scope)
    const second = yield* tombstoned(f.service, f.scope)
    const third = yield* tombstoned(f.service, f.scope)
    const original = yield* Effect.promise(() => fs.readFile(globalFile, "utf8"))

    // A key gone from the index with no journal entry is unexplained: unavailable, and nothing is removed.
    const current = yield* stored(globalFile)
    yield* store(globalFile, {
      ...current,
      entries: current.entries.filter((entry) => entry.key !== first.request.requestKey),
    })
    expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
    expect(yield* where(f.folder, first.request.requestKey)).toMatchObject({
      pointer: true,
      slot: true,
      refused: true,
      scope: true,
    })
    yield* Effect.promise(() => fs.writeFile(globalFile, original))
    // So is an indexed key whose slot is missing: no journal explains it.
    const slot = path.join(f.folder, "keys", `${second.request.requestKey}.json`)
    const bytes = yield* Effect.promise(() => fs.readFile(slot, "utf8"))
    yield* Effect.promise(() => fs.rm(slot))
    expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
    yield* Effect.promise(() => fs.writeFile(slot, bytes))

    // Crashed right after the journal write: the next start finishes it, and the key is a new request.
    yield* journal(first.request.requestKey)
    const again = yield* reserved(f.service, f.scope, first.request)
    expect(again.nonce).not.toBe(first.nonce)
    expect(yield* exists(path.join(f.folder, "refused", `${first.request.requestKey}.json`))).toBe(false)
    expect((yield* stored(globalFile)).pruning).toBeUndefined()
    yield* f.service.release(again.token)

    // Crashed after the scope index rewrite: only the journal explains the files left behind, and it removes them.
    yield* journal(second.request.requestKey)
    yield* unscope(f.folder, second.request.requestKey)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, second.request.requestKey)).toEqual(pruned)

    // Crashed between the file removals: some files remain, the pointer is gone.
    yield* journal(third.request.requestKey)
    yield* unscope(f.folder, third.request.requestKey)
    yield* Effect.promise(() => fs.rm(path.join(f.folder, "refused", `${third.request.requestKey}.json`)))
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, third.request.requestKey)).toEqual(pruned)
    expect((yield* stored(globalFile)).pruning).toBeUndefined()
  }),
)

it.live("an admission interrupted before its scope index rolls back; one that wrote it rolls forward", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    const folder = yield* folderOf((yield* stored(globalFile)).entries[0]?.key ?? "")
    const intend = (key: string, digest: string) =>
      Effect.gen(function* () {
        const current = yield* stored(globalFile)
        yield* store(globalFile, {
          ...current,
          entries: [...current.entries, { key, digest, createdAt: Date.now() }],
          admitting: { key, folder },
        })
      })

    // Crashed after the intent, before the pointer: the key was never handed out and starts a new request.
    const early = input()
    yield* intend(early.requestKey, createHash("sha256").update("never written").digest("hex"))
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* stored(globalFile)).admitting).toBeUndefined()
    expect(yield* where(f.folder, early.requestKey)).toEqual(pruned)
    yield* f.service.release((yield* reserved(f.service, f.scope, early)).token)

    // Crashed after the pointer and a partial slot: both are removed.
    const late = input()
    yield* intend(late.requestKey, createHash("sha256").update("{").digest("hex"))
    yield* Effect.promise(async () => {
      await fs.writeFile(pointerOf(late.requestKey), "{")
      await fs.writeFile(path.join(f.folder, "keys", `${late.requestKey}.json`), "{")
    })
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, late.requestKey)).toEqual(pruned)

    // Crashed after the scope index named the key: it rolls forward, and the key reconciles like any stale one.
    const whole = yield* reserved(f.service, f.scope)
    yield* f.service.release(whole.token)
    const current = yield* stored(globalFile)
    yield* store(globalFile, { ...current, admitting: { key: whole.request.requestKey, folder } })
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* stored(globalFile)).admitting).toBeUndefined()
    expect((yield* refused(f.service.reserve(f.scope, whole.request))).code).toBe("consumed")
  }),
)

it.live("an open journal keeps a live claim's prepare and bind working until the next start finishes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const claim = yield* reserved(f.service, f.scope)
    const settled = yield* tombstoned(f.service, f.scope)
    yield* journal(settled.request.requestKey)
    yield* unscope(f.folder, settled.request.requestKey)
    const anchorID = SessionID.create()
    yield* f.service.prepare(claim.token, anchorID)
    yield* f.service.bind(claim.token, { anchorID, runID: Connect.RunID.create() })
    expect((yield* stored(globalFile)).pruning?.map((mark) => mark.key)).toEqual([settled.request.requestKey])
    expect((yield* where(f.folder, settled.request.requestKey)).refused).toBe(true)
    expect((yield* f.service.reserve(f.scope, claim.request)).kind).toBe("bound")
    expect(yield* where(f.folder, settled.request.requestKey)).toEqual(pruned)
  }),
)

small.effect("a corrupt journaled directory stays journaled while other directories admit and prune", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* scopeAt("other-workspace")
    const stuck = yield* tombstoned(f.service, other.scope)
    const settled = yield* tombstoned(f.service, f.scope)
    yield* journal(stuck.request.requestKey)
    yield* Effect.promise(() => fs.writeFile(path.join(other.folder, "index.json"), "{"))
    yield* TestClock.adjust(31 * DAY)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* where(f.folder, settled.request.requestKey)).toEqual(pruned)
    expect((yield* stored(globalFile)).pruning?.map((mark) => mark.key)).toEqual([stuck.request.requestKey])
    expect(yield* exists(pointerOf(stuck.request.requestKey))).toBe(true)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* stored(globalFile)).pruning?.map((mark) => mark.key)).toEqual([stuck.request.requestKey])
    expect((yield* refused(f.service.reserve(other.scope, stuck.request))).code).toBe("unavailable")
  }),
)

small.effect("a journaled key its own full directory cannot finish is never journaled twice", () =>
  Effect.gen(function* () {
    // Permissions do not hold for root or on Windows, so the failed index rewrite cannot be staged there.
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const f = yield* fixture
    const other = yield* scopeAt("other-workspace")
    const settled = [
      yield* tombstoned(f.service, f.scope),
      yield* tombstoned(f.service, f.scope),
      yield* tombstoned(f.service, f.scope),
    ].map((key) => key.request.requestKey)
    // The scope scan visits equal ages in key order, so this is the key it would pick first.
    const first = settled.toSorted()[0] ?? ""
    yield* journal(first)
    yield* TestClock.adjust(2 * DAY)
    // A read-only folder: the sweep reads its index but cannot rewrite it, so the key stays named there.
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => fs.chmod(f.folder, 0o500))
      expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
      expect((yield* refused(f.service.reserve(f.scope, input()))).code).toBe("unavailable")
      const marks = ((yield* stored(globalFile)).pruning ?? []).map((mark) => mark.key)
      expect(marks.filter((key) => key === first)).toHaveLength(1)
      expect(new Set(marks).size).toBe(marks.length)
      expect(yield* where(f.folder, first)).toMatchObject({ pointer: true, slot: true, refused: true, scope: true })
      yield* f.service.release((yield* reserved(f.service, other.scope)).token)
    }).pipe(Effect.ensuring(Effect.promise(() => fs.chmod(f.folder, 0o700))))
    // Writable again, the next start finishes every journaled key of that directory.
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect((yield* stored(globalFile)).pruning).toBeUndefined()
    for (const key of settled) expect(yield* where(f.folder, key)).toEqual(pruned)
  }),
)

small.effect("one admission prunes at most the prune limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const settled = [
      yield* tombstoned(f.service, f.scope),
      yield* tombstoned(f.service, f.scope),
      yield* tombstoned(f.service, f.scope),
    ].map((key) => key.request.requestKey)
    yield* TestClock.adjust(31 * DAY)
    const left = () =>
      keys(path.join(f.folder, "index.json")).pipe(Effect.map((list) => list.filter((key) => settled.includes(key))))
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* left()).toHaveLength(1)
    yield* f.service.release((yield* reserved(f.service, f.scope)).token)
    expect(yield* left()).toEqual([])
  }),
)

it.live("ledger limits outside their bounds are a defect when the layer builds", () =>
  Effect.gen(function* () {
    for (const limits of [
      { maxKeys: 0 },
      { maxKeys: 5, maxTotalKeys: 4 },
      { replayMs: 2, retentionMs: 1 },
      { pruneLimit: 65 },
    ]) {
      const exit = yield* Effect.gen(function* () {
        yield* ConnectDirectoryRequest.Service
      }).pipe(Effect.provide(ledgerWith(limits)), Effect.exit)
      expect(Exit.hasDies(exit), JSON.stringify(limits)).toBe(true)
    }
  }),
)
