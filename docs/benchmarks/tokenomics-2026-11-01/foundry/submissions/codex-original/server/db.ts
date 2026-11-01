import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const dataDir = resolve(process.env.DATA_DIR || '.foundry-data');
mkdirSync(join(dataDir, 'attachments'), { recursive: true });
export const db = new Database(join(dataDir, 'foundry.sqlite'), { create: true });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, active_workspace_id TEXT);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entities_workspace ON entities(workspace_id,kind);
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS idempotency (workspace_id TEXT NOT NULL, key TEXT NOT NULL, order_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(workspace_id,key));
CREATE TABLE IF NOT EXISTS counters (workspace_id TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(workspace_id,kind));
CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, workspace_id TEXT NOT NULL, data TEXT NOT NULL);`);
export type Row = Record<string, any>;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const one = (sql: string, ...args: any[]): Row | null => db.query(sql).get(...args) as Row | null;
export const all = (sql: string, ...args: any[]): Row[] => db.query(sql).all(...args) as Row[];
export const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export function fail(status: number, message: string, code = status === 409 ? 'conflict' : status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_input'): never { throw new ApiError(status, code, message); }
export function get(w: string, kind: string, id: string): Row {
  const r = one('SELECT data FROM entities WHERE workspace_id=? AND kind=? AND id=?', w, kind, id);
  if (!r) fail(404, 'This record could not be found in this workspace.');
  return JSON.parse(r.data);
}
export const list = (w: string, kind: string): Row[] => all('SELECT data FROM entities WHERE workspace_id=? AND kind=? ORDER BY rowid DESC', w, kind).map(r => JSON.parse(r.data));
export function put(w: string, kind: string, value: Row) { run('INSERT INTO entities(id,workspace_id,kind,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', value.id, w, kind, JSON.stringify(value)); return value; }
export function remove(w: string, kind: string, id: string) { run('DELETE FROM entities WHERE workspace_id=? AND kind=? AND id=?', w, kind, id); }
export function event(w: string, user: Row, action: string, entityType: string, entityId: string) {
  const entry = { id: uid(), action, entityType, entityId, actorId: user.id, actorName: user.name, createdAt: now() };
  run('INSERT INTO activity(id,workspace_id,data) VALUES(?,?,?)', entry.id, w, JSON.stringify(entry));
  run('UPDATE workspaces SET revision=revision+1 WHERE id=?', w);
}
export function number(w: string, kind: string, prefix: string) {
  run('INSERT INTO counters(workspace_id,kind,value) VALUES(?,?,1) ON CONFLICT(workspace_id,kind) DO UPDATE SET value=value+1', w, kind);
  return `${prefix}-${String(one('SELECT value FROM counters WHERE workspace_id=? AND kind=?', w, kind)!.value).padStart(6, '0')}`;
}
export const filePath = (id: string) => join(dataDir, 'attachments', id);
export function deleteFiles(w: string, type: string, id: string) {
  for (const a of list(w, 'attachment').filter(a => a.entityType === type && a.entityId === id)) {
    if (existsSync(filePath(a.id))) unlinkSync(filePath(a.id));
    remove(w, 'attachment', a.id);
  }
}
export const tx = <T>(fn: () => T): T => db.transaction(fn).immediate();
