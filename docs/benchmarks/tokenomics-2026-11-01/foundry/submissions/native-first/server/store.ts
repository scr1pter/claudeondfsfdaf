import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";

export const dataDir = resolve(process.env.DATA_DIR || ".foundry-data");
mkdirSync(join(dataDir, "attachments"), { recursive: true });
export const db = new Database(join(dataDir, "foundry.sqlite"), { create: true });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL, active_workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 order_sequence INTEGER NOT NULL DEFAULT 0, invoice_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memberships (
 workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
 PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL,
 token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS records (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS record_scope ON records(workspace_id,kind);
CREATE TABLE IF NOT EXISTS activity (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
 entity_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_scope ON activity(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS idempotency (
 workspace_id TEXT NOT NULL, key TEXT NOT NULL, order_id TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(workspace_id,key)
);`);

export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
export const one = (sql: string, ...params: any[]) => db.query(sql).get(...params) as Row | null;
export const all = (sql: string, ...params: any[]) => db.query(sql).all(...params) as Row[];
export const run = (sql: string, ...params: any[]) => db.query(sql).run(...params);
export function list(w: string, kind: string): Row[] {
  return all("SELECT data FROM records WHERE workspace_id=? AND kind=? ORDER BY rowid DESC LIMIT 5000", w, kind).map(r => JSON.parse(r.data));
}
export function get(w: string, kind: string, key: string): Row {
  const row = one("SELECT data FROM records WHERE workspace_id=? AND kind=? AND id=?", w, kind, key);
  if (!row) fail(404, "not_found", "This record was not found in this workspace.");
  return JSON.parse(row.data);
}
export function save(w: string, kind: string, data: Row) {
  run("INSERT INTO records(id,workspace_id,kind,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", data.id, w, kind, JSON.stringify(data));
  return data;
}
export function remove(w: string, kind: string, key: string) {
  for (const a of list(w, "attachment").filter(a => a.entityType === kind && a.entityId === key)) {
    unlinkOwned(a.id);
    run("DELETE FROM records WHERE id=? AND workspace_id=?", a.id, w);
  }
  run("DELETE FROM records WHERE id=? AND workspace_id=? AND kind=?", key, w, kind);
}
export function unlinkOwned(key: string) {
  try { unlinkSync(join(dataDir, "attachments", key)); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
export function text(v: any, field: string, required = false, max = 10000): string {
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) fail(400, "invalid_input", `${field} must be ${required ? "a nonempty" : "a"} string (maximum ${max} characters).`);
  return v;
}
export function integer(v: any, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(400, "invalid_input", `${field} must be an integer between ${min} and ${max}.`);
  return v;
}
export function choice(v: any, field: string, choices: string[]) {
  if (typeof v !== "string" || !choices.includes(v)) fail(400, "invalid_input", `Invalid ${field}.`);
  return v;
}
export function fields(b: Row, allowed: string[]) {
  if (!b || typeof b !== "object" || Array.isArray(b)) fail(400, "invalid_input", "A JSON object is required.");
  for (const k of Object.keys(b)) if (!allowed.includes(k) && k !== "workspaceId" && k !== "userId") fail(400, "protected_field", `The field ${k} cannot be changed here.`);
}
export function email(v: any, required = false) {
  const value = text(v, "Email", required, 254).trim().toLowerCase();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, "invalid_email", "Enter a valid email address.");
  return value;
}
export function event(w: string, user: Row, action: string, kind: string, key: string) {
  run("INSERT INTO activity VALUES(?,?,?,?,?,?,?,?)", id(), w, action, kind, key, user.id, user.name, now());
  run("UPDATE workspaces SET revision=revision+1 WHERE id=?", w);
}
export function memberships(userId: string) {
  return all("SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.rowid", userId);
}
export function makeWorkspace(name: string, userId: string) {
  const w = { id: id(), name, role: "owner" };
  run("INSERT INTO workspaces(id,name,owner_id) VALUES(?,?,?)", w.id, w.name, userId);
  run("INSERT INTO memberships VALUES(?,?,?)", w.id, userId, "owner");
  run("UPDATE users SET active_workspace_id=? WHERE id=?", w.id, userId);
  return w;
}
export function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += c;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === "," || c === "\n" || c === "\r") {
      row.push(value); value = ""; closed = false;
      if (c !== ",") {
        if (c === "\r" && input[i + 1] === "\n") i++;
        rows.push(row); row = [];
      }
    } else {
      if (closed || c === '"') fail(400, "invalid_csv", "Malformed CSV quoting.");
      value += c;
    }
  }
  if (quoted) fail(400, "invalid_csv", "Unterminated CSV quote.");
  if (value || row.length || closed) { row.push(value); rows.push(row); }
  return rows;
}
export function csvCell(value: any): string {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
