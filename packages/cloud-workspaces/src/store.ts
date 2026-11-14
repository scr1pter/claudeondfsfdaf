import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type WorkspaceState = "creating" | "running" | "stopped" | "error"

/** Server-only record. Always project through publicWorkspace before sending a response. */
export type WorkspaceRecord = {
  id: string
  ownerId: string
  repository: string
  branch: string
  title: string
  state: WorkspaceState
  createdAt: number
  updatedAt: number
  revision: number
  runtimeId: string | null
  enginePassword: string
  idempotencyKey: string
  modelCalls: number
  runningSince: number | null
  baseCommit: string | null
}

export type StoreErrorCode =
  | "invalid_input"
  | "quota_exceeded"
  | "idempotency_conflict"
  | "invalid_transition"
  | "schema_unsupported"

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code)
    this.name = "StoreError"
  }
}

export function publicWorkspace(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    repository: workspace.repository,
    branch: workspace.branch,
    title: workspace.title,
    state: workspace.state,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    revision: workspace.revision,
  }
}

const columns = `id, owner_id AS ownerId, repository, branch, title, state,
  created_at AS createdAt, updated_at AS updatedAt, revision,
  runtime_id AS runtimeId, engine_password AS enginePassword,
  idempotency_key AS idempotencyKey, model_calls AS modelCalls, running_since AS runningSince,
  base_commit AS baseCommit`

export class WorkspaceStore {
  private readonly database: Database
  private readonly statements: ReturnType<typeof prepare>
  private readonly maxActive: number
  private readonly maxTotal: number
  private readonly now: () => number

  constructor(options: { path: string; maxActivePerAccount: number; maxTotalPerAccount?: number; now?: () => number }) {
    this.maxActive = integer(options.maxActivePerAccount, 1, 1000)
    this.maxTotal = integer(options.maxTotalPerAccount ?? 20, this.maxActive, 100_000)
    this.now = options.now ?? Date.now
    // The path is trusted service configuration. No request can select a local repository or DB path.
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    this.database = new Database(options.path, { create: true, strict: true })
    try {
      if (options.path !== ":memory:") chmodSync(options.path, 0o600)
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
      const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
      if (version !== 0 && version !== 1) throw new StoreError("schema_unsupported")
      this.database
        .transaction(() => {
          this.database.exec(`
          CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY NOT NULL,
            owner_id TEXT NOT NULL,
            repository TEXT NOT NULL,
            branch TEXT NOT NULL,
            title TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('creating', 'running', 'stopped', 'error')),
            created_at INTEGER NOT NULL CHECK (created_at >= 0),
            updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            runtime_id TEXT,
            engine_password TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
            running_since INTEGER CHECK (running_since IS NULL OR running_since >= created_at),
            base_commit TEXT CHECK (base_commit IS NULL OR (length(base_commit) = 40 AND base_commit NOT GLOB '*[^0-9a-f]*')),
            CHECK (state != 'running' OR (runtime_id IS NOT NULL AND running_since IS NOT NULL)),
            UNIQUE (owner_id, idempotency_key)
          );
          CREATE INDEX IF NOT EXISTS workspace_owner_state ON workspace(owner_id, state);
          PRAGMA user_version = 1;
        `)
          // Earlier development databases have no recorded original commit. Keep it unknown, never reconstruct it
          // from a repository that an agent may already have changed.
          if (
            !this.database
              .query<{ name: string }, []>("PRAGMA table_info(workspace)")
              .all()
              .some((column) => column.name === "base_commit")
          ) {
            this.database.exec(
              "ALTER TABLE workspace ADD COLUMN base_commit TEXT CHECK (base_commit IS NULL OR (length(base_commit) = 40 AND base_commit NOT GLOB '*[^0-9a-f]*'))",
            )
          }
        })
        .immediate()
      this.statements = prepare(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  create(
    ownerId: string,
    input: { repository: string; branch: string; title: string; enginePassword: string; idempotencyKey: string },
  ) {
    ownerId = uuid(ownerId)
    const key = uuid(input.idempotencyKey)
    const repository = validRepository(input.repository)
    const branch = validBranch(input.branch)
    const title = text(input.title, 160)
    if (!/^[\x21-\x7e]{32,256}$/.test(input.enginePassword)) throw new StoreError("invalid_input")
    return this.database
      .transaction(() => {
        const previous = this.statements.idempotent.get(ownerId, key)
        if (previous) {
          if (previous.repository !== repository || previous.branch !== branch || previous.title !== title)
            throw new StoreError("idempotency_conflict")
          return { workspace: previous, created: false }
        }
        const count = this.statements.count.get(ownerId)!
        if (count.active >= this.maxActive || count.total >= this.maxTotal) throw new StoreError("quota_exceeded")
        const workspace = this.statements.insert.get(
          randomUUID(),
          ownerId,
          repository,
          branch,
          title,
          this.timestamp(),
          input.enginePassword,
          key,
        )!
        return { workspace, created: true }
      })
      .immediate()
  }

  get(ownerId: string, id: string) {
    return this.statements.owned.get(uuid(ownerId), uuid(id)) ?? undefined
  }

  list(ownerId: string) {
    return this.statements.list.all(uuid(ownerId))
  }

  /** Trusted service recovery/reaper only; never expose this enumeration as an account API. */
  active() {
    return this.statements.active.all()
  }

  transition(
    ownerId: string,
    id: string,
    input: {
      expectedState: WorkspaceState
      expectedRevision: number
      state: WorkspaceState
      runtimeId?: string | null
      baseCommit?: string | null
    },
  ) {
    ownerId = uuid(ownerId)
    id = uuid(id)
    integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER)
    return this.database
      .transaction(() => {
        const current = this.statements.owned.get(ownerId, id)
        if (!current || current.state !== input.expectedState || current.revision !== input.expectedRevision)
          return undefined
        if (!transitions[current.state].includes(input.state)) throw new StoreError("invalid_transition")
        const runtimeId = input.runtimeId === undefined ? current.runtimeId : input.runtimeId
        if (runtimeId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(runtimeId))
          throw new StoreError("invalid_input")
        const baseCommit =
          input.baseCommit === undefined
            ? current.baseCommit
            : input.baseCommit === null
              ? null
              : commit(input.baseCommit)
        if (current.baseCommit !== null && baseCommit !== current.baseCommit) throw new StoreError("invalid_transition")
        if (input.state === "running" && runtimeId === null) throw new StoreError("invalid_transition")
        if (input.state === "creating" && current.state !== "creating") {
          if (this.statements.count.get(ownerId)!.active >= this.maxActive) throw new StoreError("quota_exceeded")
        }
        const at = Math.max(current.updatedAt, this.timestamp())
        const runningSince =
          input.state === "running" ? (current.state === "running" ? current.runningSince : at) : null
        return (
          this.statements.transition.get(
            input.state,
            runtimeId,
            at,
            runningSince,
            baseCommit,
            ownerId,
            id,
            input.expectedState,
            input.expectedRevision,
          ) ?? undefined
        )
      })
      .immediate()
  }

  delete(ownerId: string, id: string, expectedRevision: number) {
    return (
      this.statements.remove.run(uuid(ownerId), uuid(id), integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER))
        .changes === 1
    )
  }

  /** Reserve before contacting a model; a failed/unknown request still consumes its reservation. */
  reserveModel(ownerId: string, id: string, limit: number) {
    return (
      this.statements.reserve.run(this.timestamp(), uuid(ownerId), uuid(id), integer(limit, 1, 100_000)).changes === 1
    )
  }

  close() {
    this.database.close()
  }

  private timestamp() {
    return integer(this.now(), 0, Number.MAX_SAFE_INTEGER)
  }
}

const transitions: Record<WorkspaceState, readonly WorkspaceState[]> = {
  creating: ["creating", "running", "stopped", "error"],
  running: ["running", "stopped", "error"],
  stopped: ["creating"],
  error: ["creating", "stopped"],
}

function prepare(database: Database) {
  return {
    owned: database.query<WorkspaceRecord, [string, string]>(
      `SELECT ${columns} FROM workspace WHERE owner_id = ? AND id = ?`,
    ),
    list: database.query<WorkspaceRecord, [string]>(
      `SELECT ${columns} FROM workspace WHERE owner_id = ? ORDER BY created_at DESC, id`,
    ),
    active: database.query<WorkspaceRecord, []>(
      `SELECT ${columns} FROM workspace WHERE state IN ('creating', 'running') ORDER BY updated_at, id`,
    ),
    idempotent: database.query<WorkspaceRecord, [string, string]>(
      `SELECT ${columns} FROM workspace WHERE owner_id = ? AND idempotency_key = ?`,
    ),
    count: database.query<{ total: number; active: number }, [string]>(
      "SELECT count(*) AS total, coalesce(sum(state IN ('creating', 'running')), 0) AS active FROM workspace WHERE owner_id = ?",
    ),
    insert: database.query<WorkspaceRecord, [string, string, string, string, string, number, string, string]>(`
      INSERT INTO workspace (id, owner_id, repository, branch, title, state, created_at, updated_at, engine_password, idempotency_key)
      VALUES (?1, ?2, ?3, ?4, ?5, 'creating', ?6, ?6, ?7, ?8) RETURNING ${columns}
    `),
    transition: database.query<
      WorkspaceRecord,
      [WorkspaceState, string | null, number, number | null, string | null, string, string, WorkspaceState, number]
    >(`
      UPDATE workspace SET state = ?, runtime_id = ?, updated_at = ?, running_since = ?, base_commit = ?, revision = revision + 1
      WHERE owner_id = ? AND id = ? AND state = ? AND revision = ? RETURNING ${columns}
    `),
    remove: database.query<never, [string, string, number]>(
      "DELETE FROM workspace WHERE owner_id = ? AND id = ? AND revision = ? AND state IN ('stopped', 'error')",
    ),
    reserve: database.query<never, [number, string, string, number]>(`
      UPDATE workspace SET model_calls = model_calls + 1, updated_at = max(updated_at, ?), revision = revision + 1
      WHERE owner_id = ? AND id = ? AND state = 'running' AND model_calls < ?
    `),
  }
}

function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new StoreError("invalid_input")
  return value
}

function commit(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new StoreError("invalid_input")
  return value.toLowerCase()
}

function uuid(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    throw new StoreError("invalid_input")
  return value.toLowerCase()
}

function text(value: string, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new StoreError("invalid_input")
  return value
}

function validRepository(value: string) {
  text(value, 140)
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value))
    throw new StoreError("invalid_input")
  if ([".", ".."].includes(value.split("/")[1]!)) throw new StoreError("invalid_input")
  return value.toLowerCase()
}

function validBranch(value: string) {
  text(value, 200)
  if (
    value.startsWith("-") ||
    value === "@" ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*\[\\]/.test(value) ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new StoreError("invalid_input")
  return value
}
