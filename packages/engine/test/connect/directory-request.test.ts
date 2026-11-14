import { afterAll, afterEach, expect } from "bun:test"
import { randomUUID, createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectDirectoryRequest } from "@/connect/directory-request"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

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
  return { service, scope }
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
  code: Schema.optional(Schema.Literals(["pending", "mismatch", "unavailable"])),
})

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
