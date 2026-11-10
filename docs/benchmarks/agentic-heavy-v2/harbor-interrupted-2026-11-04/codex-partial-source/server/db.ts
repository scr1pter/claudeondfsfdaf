import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Every durable byte owned by Harbor lives in this directory. No application
// data is loaded from any other location.
export const dataDir = resolve(process.env.DATA_DIR || resolve(process.cwd(), "../support-data"));
mkdirSync(dataDir, { recursive: true });
const database = new Database(resolve(dataDir, "harbor.sqlite"), { create: true });
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
database.exec(`
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    job_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    PRIMARY KEY (job_id, sequence)
  );
`);

export type Entity = any;
const collections = new Set([
  "projects", "environments", "runbooks", "releases", "jobs", "artifacts",
  "incidents", "notes", "timeline", "actors", "sessions", "receipts",
]);
function collection(name: string) {
  if (!collections.has(name)) throw new Error(`Unknown local collection: ${name}`);
  return name;
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
const getRecord = database.query("SELECT data FROM records WHERE collection = ? AND id = ?");
const allRecords = database.query("SELECT data FROM records WHERE collection = ? ORDER BY rowid ASC");
const putRecord = database.query("INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data");
const deleteRecord = database.query("DELETE FROM records WHERE collection = ? AND id = ?");
export const store = {
  get(table: string, recordId: string): Entity | null {
    const row = getRecord.get(collection(table), recordId) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  },
  all(table: string): Entity[] {
    return (allRecords.all(collection(table)) as { data: string }[]).map(row => JSON.parse(row.data));
  },
  put(table: string, value: Entity): void {
    if (typeof value?.id !== "string" || !value.id) throw new Error("Durable records require an id");
    putRecord.run(collection(table), value.id, JSON.stringify(value));
  },
  remove(table: string, recordId: string): void { deleteRecord.run(collection(table), recordId); },
  transaction<T>(fn: () => T): T { return database.transaction(fn)(); },
};

const insertAudit = database.query("INSERT INTO audit_events(id,data) VALUES(?,?)");
const readAudit = database.query("SELECT sequence,data FROM audit_events ORDER BY sequence ASC");
export function audit(projectId: string | null, actorId: string | null, type: string, entityId: string, details: object): Entity {
  const event = { id: id(), projectId, actorId, type, entityId, details, createdAt: now() };
  const result = insertAudit.run(event.id, JSON.stringify(event));
  return { ...event, sequence: Number(result.lastInsertRowid) };
}
export function auditEvents(): Entity[] {
  return (readAudit.all() as { sequence: number; data: string }[]).map(row => ({ ...JSON.parse(row.data), sequence: row.sequence }));
}
const nextLog = database.query("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM job_logs WHERE job_id=?");
const insertLog = database.query("INSERT INTO job_logs(job_id,sequence,id,data) VALUES(?,?,?,?)");
const readLogs = database.query("SELECT data FROM job_logs WHERE job_id=? ORDER BY sequence ASC");
export function log(jobId: string, event: string, message: string): Entity {
  return store.transaction(() => {
    const sequence = (nextLog.get(jobId) as { sequence: number }).sequence;
    const entry = { id: id(), jobId, sequence, event, message, createdAt: now() };
    insertLog.run(jobId, sequence, entry.id, JSON.stringify(entry));
    return entry;
  });
}
export function jobLogs(jobId: string): Entity[] {
  return (readLogs.all(jobId) as { data: string }[]).map(row => JSON.parse(row.data));
}

store.transaction(() => {
  for (const actor of [
    { id: "admin", name: "Avery Admin", role: "admin" },
    { id: "operator", name: "Owen Operator", role: "operator" },
    { id: "viewer", name: "Val Viewer", role: "viewer" },
  ]) if (!store.get("actors", actor.id)) store.put("actors", actor);
});
