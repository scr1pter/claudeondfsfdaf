import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type Role = 'owner' | 'manager' | 'member' | 'read_only';
export type User = { id: string; name: string; email: string };
export type AuthContext = { user: User; sessionId: string };
export type WorkspaceContext = AuthContext & { workspaceId: string; role: Role };

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: responseHeaders });
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    fail(400, 'invalid_json', 'A valid JSON object is required.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'invalid_json', 'A JSON object is required.');
  }
  return value as Record<string, unknown>;
}

export function id(): string { return randomBytes(16).toString('hex'); }
export function now(): string { return new Date().toISOString(); }

// The default is deliberately a sibling of the source tree, not a source artifact.
const sourceRoot = realpathSync(resolve(import.meta.dir, '../..'));
const configuredDir = resolve(process.env.DATA_DIR?.trim() || resolve(process.cwd(), '../.foundry-data'));
function insideSource(path: string): boolean {
  const suffix = relative(sourceRoot, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}
if (insideSource(configuredDir)) throw new Error('DATA_DIR must be outside the authored source tree.');
mkdirSync(configuredDir, { recursive: true });
export const dataDir: string = realpathSync(configuredDir);
if (insideSource(dataDir)) throw new Error('DATA_DIR must not resolve inside the authored source tree.');

function assertRegularOwnedPath(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Owned storage paths must be regular files.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const databasePath = join(dataDir, 'foundry.sqlite');
assertRegularOwnedPath(databasePath);
export const db = new Database(databasePath, { create: true, strict: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member', 'read_only')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_owner ON memberships(workspace_id) WHERE role = 'owner';
  CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
  CREATE TRIGGER IF NOT EXISTS only_original_owner_insert BEFORE INSERT ON memberships
    WHEN NEW.role = 'owner' AND NEW.user_id != (SELECT owner_user_id FROM workspaces WHERE id = NEW.workspace_id)
    BEGIN SELECT RAISE(ABORT, 'Original owner is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS original_owner_update BEFORE UPDATE ON memberships
    WHEN (OLD.role = 'owner' AND (NEW.role != 'owner' OR NEW.user_id != OLD.user_id OR NEW.workspace_id != OLD.workspace_id))
      OR (NEW.role = 'owner' AND NEW.user_id != (SELECT owner_user_id FROM workspaces WHERE id = NEW.workspace_id))
    BEGIN SELECT RAISE(ABORT, 'Original owner is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS original_owner_delete BEFORE DELETE ON memberships
    WHEN OLD.role = 'owner'
    BEGIN SELECT RAISE(ABORT, 'Original owner is immutable'); END;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('manager', 'member', 'read_only')),
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by TEXT REFERENCES users(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS invites_workspace ON invites(workspace_id);
  CREATE TABLE IF NOT EXISTS entities (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    PRIMARY KEY (workspace_id, type, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS activity (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id),
    actor_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id, sequence DESC);
  CREATE TABLE IF NOT EXISTS counters (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('ORD', 'INV')),
    value INTEGER NOT NULL CHECK (value > 0),
    PRIMARY KEY (workspace_id, kind)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS idempotency (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
  ) STRICT;
`);

export function transaction<T>(fn: () => T): T {
  // Bun uses savepoints when a transaction is already active. No async callbacks:
  // all authorization, writes, activity and revision changes commit together.
  return db.transaction(() => {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Core transactions require synchronous callbacks.');
    }
    return result;
  }).immediate();
}

export function listEntities<T extends { id: string }>(workspaceId: string, type: string): T[] {
  const rows = db.query<{ data: string }, [string, string]>(
    'SELECT data FROM entities WHERE workspace_id = ? AND type = ? ORDER BY rowid',
  ).all(workspaceId, type);
  return rows.map(row => JSON.parse(row.data) as T);
}

export function getEntity<T extends { id: string }>(workspaceId: string, type: string, entityId: string): T | null {
  const row = db.query<{ data: string }, [string, string, string]>(
    'SELECT data FROM entities WHERE workspace_id = ? AND type = ? AND id = ?',
  ).get(workspaceId, type, entityId);
  return row ? JSON.parse(row.data) as T : null;
}

export function saveEntity<T extends { id: string }>(workspaceId: string, type: string, value: T): void {
  db.query(`INSERT INTO entities (workspace_id, type, id, data) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, type, id) DO UPDATE SET data = excluded.data`).run(
    workspaceId, type, value.id, JSON.stringify(value),
  );
}

export function deleteEntity(workspaceId: string, type: string, entityId: string): void {
  db.query('DELETE FROM entities WHERE workspace_id = ? AND type = ? AND id = ?').run(workspaceId, type, entityId);
}

export function activity(ctx: WorkspaceContext, action: string, entityType: string, entityId: string): void {
  transaction(() => {
    db.query(`INSERT INTO activity (id, workspace_id, action, entity_type, entity_id, actor_id, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id(), ctx.workspaceId, action, entityType, entityId, ctx.user.id, ctx.user.name, now());
    db.query('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').run(ctx.workspaceId);
  });
}

export function listActivity(workspaceId: string, limit: number): unknown[] {
  const bounded = Number.isInteger(limit) ? Math.min(500, Math.max(1, limit)) : 50;
  return db.query(`SELECT id, action, entity_type AS entityType, entity_id AS entityId,
    actor_id AS actorId, actor_name AS actorName, created_at AS createdAt
    FROM activity WHERE workspace_id = ? ORDER BY sequence DESC LIMIT ?`).all(workspaceId, bounded);
}

export function getRevision(workspaceId: string): number {
  return db.query<{ revision: number }, [string]>('SELECT revision FROM workspaces WHERE id = ?').get(workspaceId)?.revision ?? 0;
}

export function nextNumber(workspaceId: string, kind: string): string {
  if (kind !== 'ORD' && kind !== 'INV') fail(400, 'invalid_number_kind', 'Number kind must be ORD or INV.');
  return transaction(() => {
    const row = db.query<{ value: number }, [string, string]>(`INSERT INTO counters (workspace_id, kind, value) VALUES (?, ?, 1)
      ON CONFLICT (workspace_id, kind) DO UPDATE SET value = value + 1 RETURNING value`).get(workspaceId, kind)!;
    return `${kind}-${String(row.value).padStart(6, '0')}`;
  });
}

export function getFulfillment(workspaceId: string, key: string): { orderId: string; order: unknown } | null {
  const row = db.query<{ order_id: string; result: string }, [string, string]>(
    'SELECT order_id, result FROM idempotency WHERE workspace_id = ? AND key = ?',
  ).get(workspaceId, key);
  return row ? { orderId: row.order_id, order: JSON.parse(row.result) as unknown } : null;
}

export function saveFulfillment(workspaceId: string, key: string, orderId: string, order: unknown): void {
  transaction(() => {
    if (getFulfillment(workspaceId, key)) fail(409, 'idempotency_conflict', 'This idempotency key is already recorded.');
    db.query('INSERT INTO idempotency (workspace_id, key, order_id, result, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, key, orderId, JSON.stringify(order), now());
  });
}

export function members(workspaceId: string): { userId: string; name: string; email: string; role: Role }[] {
  return db.query<{ userId: string; name: string; email: string; role: Role }, [string]>(
    `SELECT u.id AS userId, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at, u.id`,
  ).all(workspaceId);
}

export function attachmentPath(attachmentId: string): string {
  if (!/^[a-f0-9]{32}$/.test(attachmentId)) fail(400, 'invalid_file_id', 'An opaque generated file ID is required.');
  const path = join(dataDir, `${attachmentId}.blob`);
  assertRegularOwnedPath(path);
  return path;
}

export function removeOwnedFile(attachmentId: string): void {
  const path = attachmentPath(attachmentId);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const sessionDays = 30;
const sessionSeconds = sessionDays * 24 * 60 * 60;
const cookieName = 'foundry_session';

function cookie(token: string, maxAge = sessionSeconds): string {
  return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function requireAuth(request: Request): AuthContext {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim());
  const sessionId = values.find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
  if (!/^[a-f0-9]{64}$/.test(sessionId)) fail(401, 'unauthenticated', 'Sign in to continue.');
  const user = db.query<User, [string, string]>(`SELECT u.id, u.name, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, now());
  if (!user) fail(401, 'unauthenticated', 'Your session is missing or expired. Sign in again.');
  return { user, sessionId };
}

export function workspaceContext(request: Request, workspaceId: string): WorkspaceContext {
  const auth = requireAuth(request);
  const membership = db.query<{ role: Role }, [string, string]>(
    'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?',
  ).get(workspaceId, auth.user.id);
  if (!membership) fail(404, 'workspace_not_found', 'Workspace not found.');
  return { ...auth, workspaceId, role: membership.role };
}

export function requireRole(ctx: WorkspaceContext, allowed: Role[]): void {
  if (!allowed.includes(ctx.role)) fail(403, 'forbidden', 'Your workspace role does not allow this action.');
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(400, 'invalid_input', `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

function emailAddress(value: unknown): string {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'Enter a valid email address.');
  return email;
}

function passwordInput(value: unknown, signup: boolean): string {
  if (typeof value !== 'string' || value.length < (signup ? 12 : 1) || value.length > 1024) {
    fail(400, 'invalid_password', signup ? 'Password must contain 12 to 1024 characters.' : 'Password is required.');
  }
  return value;
}

function inviteRole(value: unknown): Exclude<Role, 'owner'> {
  if (value !== 'manager' && value !== 'member' && value !== 'read_only') {
    fail(400, 'invalid_role', 'Role must be manager, member, or read_only.');
  }
  return value;
}

type Workspace = { id: string; name: string; role: Role };
function workspaces(userId: string): Workspace[] {
  return db.query<Workspace, [string]>(`SELECT w.id, w.name, m.role FROM workspaces w
    JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at, w.id`).all(userId);
}

function workspaceFor(userId: string, workspaceId: string): Workspace {
  const workspace = db.query<Workspace, [string, string]>(`SELECT w.id, w.name, m.role FROM workspaces w
    JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? AND w.id = ?`).get(userId, workspaceId);
  if (!workspace) fail(404, 'workspace_not_found', 'Workspace not found.');
  return workspace;
}

function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  db.query('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now(), new Date(Date.now() + sessionSeconds * 1000).toISOString());
  return token;
}

function createWorkspace(auth: AuthContext, name: string): Workspace {
  const workspaceId = id();
  const createdAt = now();
  db.query('INSERT INTO workspaces (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(workspaceId, name, auth.user.id, createdAt);
  db.query('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(workspaceId, auth.user.id, 'owner', createdAt);
  db.query('UPDATE users SET active_workspace_id = ? WHERE id = ?').run(workspaceId, auth.user.id);
  activity({ ...auth, workspaceId, role: 'owner' }, 'workspace.created', 'workspace', workspaceId);
  return { id: workspaceId, name, role: 'owner' };
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export async function handleIdentity(request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/auth/signup' && method === 'POST') {
    const input = await body(request);
    const name = text(input.name, 'Name');
    const email = emailAddress(input.email);
    const password = passwordInput(input.password, true);
    // Perform the genuinely salted, expensive hash outside the SQLite write lock.
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    return transaction(() => {
      if (db.query('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
        fail(409, 'email_exists', 'An account with this email already exists.');
      }
      const user: User = { id: id(), name, email };
      db.query('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, user.name, user.email, passwordHash, now());
      const sessionId = createSession(user.id);
      const workspace = createWorkspace({ user, sessionId }, `${name} workspace`);
      return json({ user, workspace }, 201, { 'Set-Cookie': cookie(sessionId) });
    });
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const input = await body(request);
    const email = emailAddress(input.email);
    const password = passwordInput(input.password, false);
    const row = db.query<User & { password_hash: string }, [string]>(
      'SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE',
    ).get(email);
    if (!row || !await Bun.password.verify(password, row.password_hash)) {
      fail(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    return transaction(() => {
      const token = createSession(row.id);
      return json({ user: { id: row.id, name: row.name, email: row.email } }, 200, { 'Set-Cookie': cookie(token) });
    });
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return transaction(() => {
      const auth = requireAuth(request);
      const available = workspaces(auth.user.id);
      const selected = db.query<{ active_workspace_id: string | null }, [string]>(
        'SELECT active_workspace_id FROM users WHERE id = ?',
      ).get(auth.user.id)?.active_workspace_id;
      const activeWorkspaceId = available.find(workspace => workspace.id === selected)?.id ?? available[0]?.id ?? null;
      if (selected !== activeWorkspaceId) {
        db.query('UPDATE users SET active_workspace_id = ? WHERE id = ?').run(activeWorkspaceId, auth.user.id);
      }
      return json({ user: auth.user, activeWorkspaceId, workspaces: available });
    });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const auth = requireAuth(request);
    db.query('DELETE FROM sessions WHERE id = ?').run(auth.sessionId);
    return json(null, 204, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/workspaces' && method === 'GET') {
    const auth = requireAuth(request);
    return json({ workspaces: workspaces(auth.user.id) });
  }
  if (path === '/api/workspaces' && method === 'POST') {
    requireAuth(request);
    const input = await body(request);
    const name = text(input.name, 'Workspace name');
    return transaction(() => json({ workspace: createWorkspace(requireAuth(request), name) }, 201));
  }
  const select = /^\/api\/workspaces\/([^/]+)\/select$/.exec(path);
  if (select && method === 'POST') {
    return transaction(() => {
      const ctx = workspaceContext(request, select[1]);
      const workspace = workspaceFor(ctx.user.id, ctx.workspaceId);
      db.query('UPDATE users SET active_workspace_id = ? WHERE id = ?').run(ctx.workspaceId, ctx.user.id);
      return json({ workspace });
    });
  }
  if (path === '/api/invites/accept' && method === 'POST') {
    requireAuth(request);
    const input = await body(request);
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(token)) fail(404, 'invite_not_found', 'Invite not found.');
    return transaction(() => {
      const auth = requireAuth(request);
      const invite = db.query<{
        id: string; workspace_id: string; email: string; role: Role; expires_at: string; consumed_at: string | null;
      }, [string]>('SELECT id, workspace_id, email, role, expires_at, consumed_at FROM invites WHERE token_hash = ?').get(tokenHash(token));
      if (!invite || invite.email.toLowerCase() !== auth.user.email.toLowerCase()) fail(404, 'invite_not_found', 'Invite not found.');
      if (invite.consumed_at) fail(409, 'invite_consumed', 'This invite has already been accepted.');
      if (invite.expires_at <= now()) fail(404, 'invite_expired', 'This invite has expired.');
      if (db.query('SELECT user_id FROM memberships WHERE workspace_id = ? AND user_id = ?').get(invite.workspace_id, auth.user.id)) {
        fail(409, 'already_member', 'You already belong to this workspace.');
      }
      const timestamp = now();
      db.query('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(invite.workspace_id, auth.user.id, invite.role, timestamp);
      db.query('UPDATE invites SET consumed_at = ?, consumed_by = ? WHERE id = ?').run(timestamp, auth.user.id, invite.id);
      db.query('UPDATE users SET active_workspace_id = ? WHERE id = ?').run(invite.workspace_id, auth.user.id);
      activity({ ...auth, workspaceId: invite.workspace_id, role: invite.role }, 'invite.accepted', 'invite', invite.id);
      return json({ workspace: workspaceFor(auth.user.id, invite.workspace_id) });
    });
  }
  const memberRoute = /^\/api\/w\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
  if (memberRoute) {
    const workspaceId = memberRoute[1];
    const targetId = memberRoute[2];
    if (!targetId && method === 'GET') {
      workspaceContext(request, workspaceId);
      return json({ members: members(workspaceId) });
    }
    if (targetId && (method === 'PATCH' || method === 'DELETE')) {
      requireRole(workspaceContext(request, workspaceId), ['owner']);
      const input = method === 'PATCH' ? await body(request) : null;
      return transaction(() => {
        const ctx = workspaceContext(request, workspaceId);
        requireRole(ctx, ['owner']);
        const target = members(workspaceId).find(member => member.userId === targetId);
        if (!target) fail(404, 'member_not_found', 'Member not found.');
        if (target.role === 'owner') {
          if (method === 'DELETE' || input?.role !== 'owner') fail(409, 'original_owner', 'The original owner cannot be removed or demoted.');
          return json({ member: target });
        }
        if (method === 'PATCH') {
          const role = inviteRole(input?.role);
          db.query('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, workspaceId, targetId);
          activity(ctx, 'member.role_changed', 'member', targetId);
          return json({ member: { ...target, role } });
        }
        db.query('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(workspaceId, targetId);
        db.query('UPDATE users SET active_workspace_id = NULL WHERE id = ? AND active_workspace_id = ?').run(targetId, workspaceId);
        activity(ctx, 'member.removed', 'member', targetId);
        return json(null, 204);
      });
    }
  }
  const inviteRoute = /^\/api\/w\/([^/]+)\/invites$/.exec(path);
  if (inviteRoute && (method === 'GET' || method === 'POST')) {
    const workspaceId = inviteRoute[1];
    requireRole(workspaceContext(request, workspaceId), ['owner']);
    if (method === 'GET') {
      const invites = db.query(`SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt,
        consumed_at AS consumedAt FROM invites WHERE workspace_id = ? ORDER BY created_at DESC, id`).all(workspaceId);
      return json({ invites });
    }
    const input = await body(request);
    const email = emailAddress(input.email);
    const role = inviteRole(input.role);
    return transaction(() => {
      const ctx = workspaceContext(request, workspaceId);
      requireRole(ctx, ['owner']);
      if (members(workspaceId).some(member => member.email.toLowerCase() === email)) {
        fail(409, 'already_member', 'This user already belongs to the workspace.');
      }
      const token = randomBytes(32).toString('hex');
      const inviteId = id();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.query(`INSERT INTO invites (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(inviteId, workspaceId, email, role, tokenHash(token), ctx.user.id, createdAt, expiresAt);
      activity(ctx, 'invite.created', 'invite', inviteId);
      return json({ invite: { id: inviteId, email, role, token, expiresAt } }, 201);
    });
  }
  return null;
}
