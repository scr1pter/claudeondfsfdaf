import { afterAll, afterEach, expect } from "bun:test"
import { randomUUID, createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Schema } from "effect"
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
afterEach(() => fs.rm(data, { recursive: true, force: true }))
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
  const scope = { projectID: "directory-request-fixture", directory }
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
