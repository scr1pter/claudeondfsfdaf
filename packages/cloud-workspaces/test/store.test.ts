import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { publicWorkspace, StoreError, WorkspaceStore } from "../src/store"

const owner = "d285fc6c-4be3-4adf-89c4-c06db4967db4"
const other = "eb631ca5-754d-4666-af0c-e93259a4de74"
const roots: string[] = []
const stores: WorkspaceStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function filename() {
  const root = mkdtempSync(join(tmpdir(), "vector-workspace-store-"))
  roots.push(root)
  return join(root, "state", "workspaces.sqlite")
}

function store(
  options: { path?: string; maxActivePerAccount?: number; maxTotalPerAccount?: number; now?: () => number } = {},
) {
  const value = new WorkspaceStore({ path: filename(), maxActivePerAccount: 2, ...options })
  stores.push(value)
  return value
}

function input(patch: Partial<Parameters<WorkspaceStore["create"]>[1]> = {}) {
  return {
    repository: "VectorDevAI/example",
    branch: "main",
    title: "Example workspace",
    enginePassword: "fixture-password-not-a-real-secret-0123456789",
    idempotencyKey: randomUUID(),
    ...patch,
  }
}

function run(value: WorkspaceStore, id: string) {
  const current = value.get(owner, id)!
  return value.transition(owner, id, {
    expectedState: current.state,
    expectedRevision: current.revision,
    state: "running",
    runtimeId: "runtime-fixture",
  })!
}

test("metadata, secret, model reservation and states survive a new object without automatic resume", () => {
  const path = filename()
  const first = store({ path, maxActivePerAccount: 3, now: () => 1000 })
  const creating = first.create(owner, input()).workspace
  const running = run(first, first.create(owner, input()).workspace.id)
  expect(first.reserveModel(owner, running.id, 2)).toBe(true)
  first.close()
  stores.splice(stores.indexOf(first), 1)

  const second = store({ path, maxActivePerAccount: 3, now: () => 900 })
  expect(second.get(owner, creating.id)).toEqual(creating)
  const restored = second.get(owner, running.id)!
  expect(restored.state).toBe("running")
  expect(restored.runtimeId).toBe("runtime-fixture")
  expect(restored.enginePassword).toBe(running.enginePassword)
  expect(restored.modelCalls).toBe(1)
  expect(restored.runningSince).toBe(1000)
  expect(restored.revision).toBe(running.revision + 1)
  expect(
    second
      .active()
      .map((value) => value.id)
      .sort(),
  ).toEqual([creating.id, running.id].sort())
  expect(second.reserveModel(owner, running.id, 2)).toBe(true)
  expect(second.reserveModel(owner, running.id, 2)).toBe(false)
  expect(second.get(owner, running.id)!.updatedAt).toBe(1000)

  const observer = new Database(path, { readonly: true })
  expect(observer.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
  observer.close()
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("every account read and write isolates ownership; public projection contains no private fields", () => {
  const value = store()
  const record = run(value, value.create(owner, input()).workspace.id)
  expect(value.get(other, record.id)).toBeUndefined()
  expect(value.list(other)).toEqual([])
  expect(
    value.transition(other, record.id, {
      expectedState: "running",
      expectedRevision: record.revision,
      state: "stopped",
    }),
  ).toBeUndefined()
  expect(value.reserveModel(other, record.id, 5)).toBe(false)
  expect(value.delete(other, record.id, record.revision)).toBe(false)
  expect(value.get(owner, record.id)).toEqual(record)
  expect(publicWorkspace(record)).toEqual({
    id: record.id,
    repository: "vectordevai/example",
    branch: "main",
    title: record.title,
    state: "running",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  })
  expect(Object.keys(publicWorkspace(record)).sort()).toEqual([
    "branch",
    "createdAt",
    "id",
    "repository",
    "revision",
    "state",
    "title",
    "updatedAt",
  ])
  // Mutating a returned object never writes back to durable ownership or secrets.
  record.ownerId = other
  record.enginePassword = "changed"
  expect(value.get(owner, record.id)!.ownerId).toBe(owner)
  expect(value.get(owner, record.id)!.enginePassword).not.toBe("changed")
})

test("idempotency is scoped to the owner, preserves its original secret and rejects changed intent", () => {
  const value = store({ maxActivePerAccount: 1 })
  const request = input()
  const first = value.create(owner, request)
  const repeated = value.create(owner, { ...request, enginePassword: "another-fixture-secret-01234567890123456789" })
  expect(first.created).toBe(true)
  expect(repeated).toEqual({ workspace: first.workspace, created: false })
  expect(value.create(other, request).workspace.id).not.toBe(first.workspace.id)
  for (const patch of [{ repository: "vectordevai/other" }, { branch: "feature/x" }, { title: "Other" }])
    expect(() => value.create(owner, { ...request, ...patch })).toThrow(new StoreError("idempotency_conflict"))
  expect(value.list(owner)).toHaveLength(1)
})

test("active quota counts creating and running, is per account and applies to explicit restart", () => {
  const value = store({ maxActivePerAccount: 1 })
  const first = value.create(owner, input()).workspace
  expect(() => value.create(owner, input())).toThrow(new StoreError("quota_exceeded"))
  const running = run(value, first.id)
  expect(() => value.create(owner, input())).toThrow(new StoreError("quota_exceeded"))
  const stopped = value.transition(owner, first.id, {
    expectedState: "running",
    expectedRevision: running.revision,
    state: "stopped",
  })!
  const second = value.create(owner, input()).workspace
  expect(() =>
    value.transition(owner, stopped.id, {
      expectedState: "stopped",
      expectedRevision: stopped.revision,
      state: "creating",
      runtimeId: null,
    }),
  ).toThrow(new StoreError("quota_exceeded"))
  expect(value.create(other, input()).created).toBe(true)
  expect(value.delete(owner, second.id, second.revision)).toBe(false)
})

test("stopped and errored workspaces retain total quota until an owned revision-checked deletion", () => {
  const value = store({ maxActivePerAccount: 1, maxTotalPerAccount: 2 })
  const first = value.create(owner, input()).workspace
  const stopped = value.transition(owner, first.id, {
    expectedState: "creating",
    expectedRevision: first.revision,
    state: "stopped",
  })!
  const second = value.create(owner, input()).workspace
  const failed = value.transition(owner, second.id, {
    expectedState: "creating",
    expectedRevision: second.revision,
    state: "error",
  })!
  expect(() => value.create(owner, input())).toThrow(new StoreError("quota_exceeded"))
  expect(value.delete(other, stopped.id, stopped.revision)).toBe(false)
  expect(value.delete(owner, stopped.id, stopped.revision - 1)).toBe(false)
  expect(value.delete(owner, stopped.id, stopped.revision)).toBe(true)
  expect(value.delete(owner, failed.id, failed.revision)).toBe(true)
  expect(value.create(owner, input()).created).toBe(true)
})

test("lifecycle compare-and-swap rejects stale state and ABA revisions, including from another DB connection", () => {
  const path = filename()
  const first = store({ path })
  const second = store({ path })
  const creating = first.create(owner, input()).workspace
  // A running workspace must have a witnessed runtime identity.
  expect(() =>
    first.transition(owner, creating.id, {
      expectedState: "creating",
      expectedRevision: creating.revision,
      state: "running",
    }),
  ).toThrow(new StoreError("invalid_transition"))
  const running = run(first, creating.id)
  expect(
    second.transition(owner, creating.id, {
      expectedState: "creating",
      expectedRevision: creating.revision,
      state: "error",
    }),
  ).toBeUndefined()
  const stopped = second.transition(owner, running.id, {
    expectedState: "running",
    expectedRevision: running.revision,
    state: "stopped",
  })!
  const restarted = first.transition(owner, running.id, {
    expectedState: "stopped",
    expectedRevision: stopped.revision,
    state: "creating",
    runtimeId: null,
  })!
  expect(restarted.state).toBe("creating")
  expect(
    first.transition(owner, creating.id, {
      expectedState: "creating",
      expectedRevision: creating.revision,
      state: "error",
    }),
  ).toBeUndefined()
  expect(() =>
    first.transition(owner, restarted.id, {
      expectedState: "creating",
      expectedRevision: restarted.revision,
      state: "stopped",
      runtimeId: "../runtime",
    }),
  ).toThrow(new StoreError("invalid_input"))
  expect(first.get(owner, restarted.id)).toEqual(restarted)
})

test("model reservations are durable, account-scoped, running-only, and invalidate a stale reaper revision", () => {
  const path = filename()
  const first = store({ path })
  const second = store({ path })
  const created = first.create(owner, input()).workspace
  expect(first.reserveModel(owner, created.id, 2)).toBe(false)
  const running = run(first, created.id)
  expect(first.reserveModel(owner, running.id, 2)).toBe(true)
  expect(second.reserveModel(owner, running.id, 2)).toBe(true)
  expect(first.reserveModel(owner, running.id, 2)).toBe(false)
  expect(second.get(owner, running.id)!.modelCalls).toBe(2)
  expect(
    first.transition(owner, running.id, {
      expectedState: "running",
      expectedRevision: running.revision,
      state: "stopped",
    }),
  ).toBeUndefined()
  const current = first.get(owner, running.id)!
  const stopped = first.transition(owner, current.id, {
    expectedState: "running",
    expectedRevision: current.revision,
    state: "stopped",
  })!
  expect(second.reserveModel(owner, current.id, 2)).toBe(false)
  const restarting = first.transition(owner, current.id, {
    expectedState: "stopped",
    expectedRevision: stopped.revision,
    state: "creating",
    runtimeId: null,
  })!
  run(first, restarting.id)
  expect(second.reserveModel(owner, current.id, 2)).toBe(false)
})

test("model activity and same-state updates cannot extend the hard lifetime of a running workspace", () => {
  let at = 1000
  const value = store({ now: () => at })
  const running = run(value, value.create(owner, input()).workspace.id)
  expect(running.runningSince).toBe(1000)
  at = 5000
  expect(value.reserveModel(owner, running.id, 3)).toBe(true)
  const active = value.get(owner, running.id)!
  expect(active.updatedAt).toBe(5000)
  expect(active.runningSince).toBe(1000)
  at = 9000
  const unchanged = value.transition(owner, active.id, {
    expectedState: "running",
    expectedRevision: active.revision,
    state: "running",
  })!
  expect(unchanged.runningSince).toBe(1000)
  const stopped = value.transition(owner, unchanged.id, {
    expectedState: "running",
    expectedRevision: unchanged.revision,
    state: "stopped",
  })!
  expect(stopped.runningSince).toBeNull()
  const creating = value.transition(owner, stopped.id, {
    expectedState: "stopped",
    expectedRevision: stopped.revision,
    state: "creating",
    runtimeId: null,
  })!
  at = 10_000
  expect(run(value, creating.id).runningSince).toBe(10_000)
})

test("the trusted original commit is private, durable and immutable across lifecycle updates", () => {
  const path = filename()
  const value = store({ path })
  const created = value.create(owner, input()).workspace
  expect(created.baseCommit).toBeNull()
  const original = "abcd0123".repeat(5)
  for (const baseCommit of ["main", "a".repeat(39), "a".repeat(41), "g".repeat(40)])
    expect(() =>
      value.transition(owner, created.id, {
        expectedState: "creating",
        expectedRevision: created.revision,
        state: "creating",
        baseCommit,
      }),
    ).toThrow(new StoreError("invalid_input"))
  expect(
    value.transition(other, created.id, {
      expectedState: "creating",
      expectedRevision: created.revision,
      state: "creating",
      baseCommit: original,
    }),
  ).toBeUndefined()
  const pinned = value.transition(owner, created.id, {
    expectedState: "creating",
    expectedRevision: created.revision,
    state: "creating",
    baseCommit: original.toUpperCase(),
  })!
  expect(pinned.baseCommit).toBe(original)
  for (const baseCommit of [null, "f".repeat(40)])
    expect(() =>
      value.transition(owner, pinned.id, {
        expectedState: "creating",
        expectedRevision: pinned.revision,
        state: "creating",
        baseCommit,
      }),
    ).toThrow(new StoreError("invalid_transition"))
  const running = value.transition(owner, pinned.id, {
    expectedState: "creating",
    expectedRevision: pinned.revision,
    state: "running",
    runtimeId: "runtime-fixture",
    baseCommit: original,
  })!
  const stopped = value.transition(owner, running.id, {
    expectedState: "running",
    expectedRevision: running.revision,
    state: "stopped",
  })!
  expect(stopped.baseCommit).toBe(original)
  expect(Object.keys(publicWorkspace(stopped))).not.toContain("baseCommit")
  value.close()
  stores.splice(stores.indexOf(value), 1)
  const reopened = store({ path })
  expect(reopened.get(owner, stopped.id)!.baseCommit).toBe(original)
  expect(reopened.get(other, stopped.id)).toBeUndefined()
})

test("an older development database upgrades without inventing the repository's original commit", () => {
  const path = join(dirname(dirname(filename())), "older.sqlite")
  const database = new Database(path, { create: true })
  const id = randomUUID()
  database.exec(`
    CREATE TABLE workspace (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
      title TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, runtime_id TEXT, engine_password TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0, running_since INTEGER,
      UNIQUE(owner_id, idempotency_key)
    );
    PRAGMA user_version = 1;
  `)
  database
    .query(
      "INSERT INTO workspace (id,owner_id,repository,branch,title,state,created_at,updated_at,runtime_id,engine_password,idempotency_key) VALUES (?,?,?,?,?,'stopped',1000,1000,?,?,?)",
    )
    .run(
      id,
      owner,
      "fixture/project",
      "main",
      "Existing workspace",
      "runtime-fixture",
      input().enginePassword,
      randomUUID(),
    )
  database.close()
  const value = store({ path })
  const restored = value.get(owner, id)!
  expect(restored.state).toBe("stopped")
  expect(restored.baseCommit).toBeNull()
  expect(restored.runtimeId).toBe("runtime-fixture")
  expect(restored.modelCalls).toBe(0)
  expect(value.list(owner)).toHaveLength(1)
})

test("rejects repository paths, invalid refs, malformed actors and unsupported schemas", () => {
  const value = store()
  for (const repository of ["/tmp/repo", "../repo", "file:///tmp/repo", "owner/repo/extra", "owner/.."])
    expect(() => value.create(owner, input({ repository }))).toThrow(new StoreError("invalid_input"))
  for (const branch of ["--help", "../main", "main.lock", "refs//heads", "main\nother", "a@{b", "a:b"])
    expect(() => value.create(owner, input({ branch }))).toThrow(new StoreError("invalid_input"))
  expect(() => value.list("not-an-account")).toThrow(new StoreError("invalid_input"))
  expect(() => value.create(owner, input({ idempotencyKey: "replay" }))).toThrow(new StoreError("invalid_input"))
  const path = join(dirname(dirname(filename())), "future.sqlite")
  const database = new Database(path, { create: true })
  database.exec("PRAGMA user_version = 2")
  database.close()
  expect(() => new WorkspaceStore({ path, maxActivePerAccount: 1 })).toThrow(new StoreError("schema_unsupported"))
})

type Contender = { created?: boolean; id?: string; code?: string }

async function contenders(path: string, requests: ReturnType<typeof input>[], maxActivePerAccount: number) {
  // Separate workers use independent SQLite connections and start only after every connection is ready.
  const url = URL.createObjectURL(
    new Blob(
      [
        `
    import { WorkspaceStore, StoreError } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    self.onmessage = ({ data }) => {
      const store = new WorkspaceStore(data.options);
      self.onmessage = () => {
        let result;
        try {
          const value = store.create(data.owner, data.request);
          result = { created: value.created, id: value.workspace.id };
        } catch (error) {
          if (!(error instanceof StoreError)) throw error;
          result = { code: error.code };
        } finally { store.close(); }
        self.postMessage(result);
      };
      self.postMessage({ ready: true });
    };
  `,
      ],
      { type: "text/javascript" },
    ),
  )
  const workers: Worker[] = []
  const ready: Promise<void>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Workspace store contenders did not settle.")), 10_000)
  })
  try {
    const results = requests.map((request) => {
      const worker = new Worker(url, { type: "module" })
      workers.push(worker)
      let admitted!: () => void
      let failed!: (error: unknown) => void
      ready.push(
        new Promise<void>((resolve, reject) => {
          admitted = resolve
          failed = reject
        }),
      )
      const result = new Promise<Contender>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<{ ready?: boolean } & Contender>) => {
          if (event.data.ready) return admitted()
          resolve(event.data)
        }
        worker.onerror = (error) => {
          failed(error)
          reject(error)
        }
      })
      worker.postMessage({ options: { path, maxActivePerAccount }, owner, request })
      return result
    })
    const completed = Promise.all(results)
    await Promise.race([Promise.all(ready), completed.then(() => undefined), deadline])
    for (const worker of workers) worker.postMessage({ run: true })
    return await Promise.race([completed, deadline])
  } finally {
    clearTimeout(timer)
    await Promise.all(workers.map((worker) => worker.terminate()))
    URL.revokeObjectURL(url)
  }
}

test("simultaneous account-idempotent creates commit one workspace and preserve the active slot", async () => {
  const path = filename()
  store({ path, maxActivePerAccount: 1 })
  const request = input()
  const results = await contenders(path, [request, request, request, request], 1)
  expect(results.filter((result) => result.created)).toHaveLength(1)
  expect(new Set(results.map((result) => result.id)).size).toBe(1)
  expect(results.every((result) => result.code === undefined)).toBe(true)
}, 15_000)

test("simultaneous distinct creates cannot oversubscribe an account's active quota", async () => {
  const path = filename()
  const value = store({ path, maxActivePerAccount: 2 })
  const results = await contenders(path, [input(), input(), input(), input()], 2)
  expect(results.filter((result) => result.created)).toHaveLength(2)
  expect(results.filter((result) => result.code === "quota_exceeded")).toHaveLength(2)
  expect(value.list(owner)).toHaveLength(2)
}, 15_000)
