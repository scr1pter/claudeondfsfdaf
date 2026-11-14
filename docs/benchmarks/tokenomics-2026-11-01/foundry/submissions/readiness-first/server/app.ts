import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

type Row = Record<string, any>;
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, message: string, code = status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid_input'): never { throw new ApiError(status, code, message); }
const id = () => crypto.randomUUID();
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const now = () => new Date().toISOString();
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers });
const text = (value: unknown, field: string, required = false, max = 10000): string => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${field} must be ${required ? 'nonempty ' : ''}text (maximum ${max} characters).`);
  return value as string;
};
const integer = (v: unknown, field: string, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(400, `${field} must be an integer from ${min} to ${max}.`);
  return v as number;
};
const choice = (v: unknown, field: string, values: string[]): string => {
  if (typeof v !== 'string' || !values.includes(v)) fail(400, `Invalid ${field}.`);
  return v as string;
};
const email = (v: unknown, required = false) => {
  const s = text(v, 'Email', required, 254).trim();
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'Enter a valid email address.');
  return s;
};
const fields = (body: Row, allowed: string[]) => {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(400, `Field ${key} cannot be changed here.`);
};
const roles = ['manager', 'member', 'read_only'];
const taskStatuses = ['todo', 'in_progress', 'done'];
const priorities = ['low', 'medium', 'high'];
const csvEscape = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && input[i + 1] === '\n') i++; }
    } else if (c === '"') {
      if (cell || closed) fail(400, 'Malformed CSV quoting.');
      quoted = true;
    } else { if (closed) fail(400, 'Unexpected text after CSV quote.'); cell += c; }
  }
  if (quoted) fail(400, 'Unclosed CSV quote.');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}

export function createApp(dataDir: string, frontendDir = resolve('dist')) {
  const root = resolve(dataDir);
  const filesDir = join(root, 'attachments');
  mkdirSync(filesDir, { recursive: true });
  const db = new Database(join(root, 'foundry.sqlite'), { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,active_workspace_id TEXT);
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,order_seq INTEGER NOT NULL DEFAULT 0,invoice_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE,role TEXT NOT NULL,token TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_workspace ON records(workspace_id,type);
    CREATE UNIQUE INDEX IF NOT EXISTS customer_email ON records(workspace_id,lower(json_extract(data,'$.email'))) WHERE type='customer' AND json_extract(data,'$.email')!='';
    CREATE UNIQUE INDEX IF NOT EXISTS product_sku ON records(workspace_id,lower(json_extract(data,'$.sku'))) WHERE type='product';
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_order ON records(workspace_id,json_extract(data,'$.orderId')) WHERE type='invoice';
    CREATE TABLE IF NOT EXISTS idempotency(workspace_id TEXT NOT NULL,key TEXT NOT NULL,order_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(workspace_id,key));
    CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id);
  `);
  const get = (sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
  const all = (sql: string, ...args: any[]) => db.query(sql).all(...args) as Row[];
  const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
  const list = (w: string, type: string): Row[] => all('SELECT data FROM records WHERE workspace_id=? AND type=? ORDER BY rowid DESC LIMIT 10000', w, type).map(r => JSON.parse(r.data));
  const find = (w: string, type: string, rid: string): Row => {
    const r = get('SELECT data FROM records WHERE workspace_id=? AND type=? AND id=?', w, type, rid);
    if (!r) fail(404, `${type} not found.`);
    return JSON.parse(r!.data);
  };
  const insert = (w: string, type: string, data: Row) => { run('INSERT INTO records VALUES(?,?,?,?)', data.id, w, type, JSON.stringify(data)); return data; };
  const save = (w: string, type: string, data: Row) => { run('UPDATE records SET data=? WHERE workspace_id=? AND type=? AND id=?', JSON.stringify(data), w, type, data.id); return data; };
  const workspaces = (uid: string) => all('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.rowid', uid);
  const publicUser = (u: Row) => ({ id: u.id, name: u.name, email: u.email });
  const newWorkspace = (name: string, uid: string) => {
    const wid = id();
    run('INSERT INTO workspaces(id,name,owner_id) VALUES(?,?,?)', wid, name, uid);
    run('INSERT INTO memberships VALUES(?,?,?)', wid, uid, 'owner');
    run('UPDATE users SET active_workspace_id=? WHERE id=?', wid, uid);
    return { id: wid, name, role: 'owner' };
  };
  const session = (uid: string) => {
    const sid = token();
    run('INSERT INTO sessions VALUES(?,?,?)', sid, uid, new Date(Date.now() + 30 * 86400000).toISOString());
    return { 'Set-Cookie': `foundry_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` };
  };
  const activity = (w: string, user: Row, action: string, type: string, eid: string) => {
    run('INSERT INTO activity VALUES(?,?,?,?,?,?,?,?)', id(), w, action, type, eid, user.id, user.name, now());
    run('UPDATE workspaces SET revision=revision+1 WHERE id=?', w);
  };
  const tx = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const cleanupFiles: string[] = [];
  const removeEntity = (w: string, type: string, eid: string) => {
    for (const a of list(w, 'attachment').filter(a => a.entityType === type && a.entityId === eid)) {
      run('DELETE FROM records WHERE id=? AND workspace_id=?', a.id, w); cleanupFiles.push(a.id);
    }
    run('DELETE FROM records WHERE id=? AND workspace_id=? AND type=?', eid, w, type);
  };
  const memberList = (w: string) => all('SELECT u.id AS userId,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.rowid', w);
  function customerData(b: Row, old?: Row) {
    fields(b, ['name', 'email', 'company', 'notes']);
    const data: Row = old ? { ...old } : { id: id(), email: '', company: '', notes: '', createdAt: now() };
    if (!old || 'name' in b) data.name = text(b.name, 'Name', true, 200).trim();
    if ('email' in b) data.email = email(b.email);
    for (const k of ['company', 'notes']) if (k in b) data[k] = text(b[k], k);
    data.updatedAt = now(); return data;
  }
  function productData(b: Row, old?: Row) {
    fields(b, ['sku', 'name', 'description', 'priceCents']);
    const d: Row = old ? { ...old } : { id: id(), description: '', stock: 0, createdAt: now() };
    if (!old || 'sku' in b) d.sku = text(b.sku, 'SKU', true, 100).trim().toUpperCase();
    if (!old || 'name' in b) d.name = text(b.name, 'Product name', true, 200).trim();
    if (!old || 'priceCents' in b) d.priceCents = integer(b.priceCents, 'Price', 0, 100000000);
    if ('description' in b) d.description = text(b.description, 'Description');
    d.updatedAt = now(); return d;
  }
  function orderData(w: string, b: Row, old?: Row) {
    fields(b, ['customerId', 'items']);
    const d: Row = old ? { ...old } : { id: id(), status: 'draft', fulfilledAt: null, createdAt: now() };
    if (!old || 'customerId' in b) { d.customerId = text(b.customerId, 'Customer', true); find(w, 'customer', d.customerId); }
    if (!old || 'items' in b) {
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) fail(400, 'Use 1 to 50 distinct products.');
      const seen = new Set<string>();
      d.items = b.items.map((item: Row) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, 'Invalid order item.');
        fields(item, ['productId', 'quantity']);
        const pid = text(item.productId, 'Product', true), qty = integer(item.quantity, 'Quantity', 1, 10000);
        if (seen.has(pid)) fail(400, 'Products must be distinct.'); seen.add(pid);
        const p = find(w, 'product', pid);
        return { productId: pid, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity: qty, lineTotalCents: p.priceCents * qty };
      });
    } else if ('customerId' in b) {
      d.items = d.items.map((item: Row) => { const p = find(w, 'product', item.productId); return { ...item, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, lineTotalCents: p.priceCents * item.quantity }; });
    }
    d.totalCents = d.items.reduce((sum: number, i: Row) => sum + i.lineTotalCents, 0); d.updatedAt = now();
    return d;
  }
  function taskData(w: string, b: Row, old?: Row) {
    fields(b, ['title', 'description', 'status', 'priority', 'assigneeId', 'dueDate']);
    const d: Row = old ? { ...old } : { id: id(), description: '', status: 'todo', priority: 'medium', assigneeId: null, dueDate: null, createdAt: now() };
    if (!old || 'title' in b) d.title = text(b.title, 'Title', true, 300).trim();
    if ('description' in b) d.description = text(b.description, 'Description');
    if ('status' in b) d.status = choice(b.status, 'status', taskStatuses);
    if ('priority' in b) d.priority = choice(b.priority, 'priority', priorities);
    if ('assigneeId' in b) {
      if (b.assigneeId !== null) {
        text(b.assigneeId, 'Assignee', true);
        if (!get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?', w, b.assigneeId)) fail(404, 'Assignee is not a workspace member.');
      }
      d.assigneeId = b.assigneeId;
    }
    if ('dueDate' in b) {
      if (b.dueDate !== null && (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || !Number.isFinite(Date.parse(b.dueDate)) || new Date(b.dueDate).toISOString().slice(0, 10) !== b.dueDate)) fail(400, 'Due date must be a valid YYYY-MM-DD date.');
      d.dueDate = b.dueDate;
    }
    d.updatedAt = now(); return d;
  }
  function deleteTask(w: string, taskId: string) {
    for (const c of list(w, 'comment').filter(c => c.taskId === taskId)) removeEntity(w, 'comment', c.id);
    removeEntity(w, 'task', taskId);
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname, method = req.method;
    if (path === '/api/health' && method === 'GET') return json({ ok: true });
    let b: Row = {};
    if (['POST', 'PATCH'].includes(method) && !req.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const raw = await req.text();
      if (Buffer.byteLength(raw) > 1100000) fail(413, 'Request is too large.', 'too_large');
      try { b = raw ? JSON.parse(raw) : {}; } catch { fail(400, 'Malformed JSON.'); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'Expected a JSON object.');
    }
    if (path === '/api/auth/signup' && method === 'POST') {
      fields(b, ['name', 'email', 'password']);
      const name = text(b.name, 'Name', true, 100).trim(), address = email(b.email, true).toLowerCase(), password = text(b.password, 'Password', true, 1024);
      if (password.length < 12) fail(400, 'Password must contain at least 12 characters.');
      const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
      return tx(() => {
        if (get('SELECT id FROM users WHERE email=?', address)) fail(409, 'An account with that email already exists.');
        const user = { id: id(), name, email: address };
        run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)', user.id, name, address, hash);
        const workspace = newWorkspace(`${name} workspace`, user.id);
        return json({ user, workspace }, 201, session(user.id));
      });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      fields(b, ['email', 'password']);
      const u = get('SELECT * FROM users WHERE email=?', email(b.email, true).toLowerCase());
      const password = text(b.password, 'Password', true, 1024);
      if (!u || !(await Bun.password.verify(password, u.password_hash))) fail(401, 'Email or password is incorrect.', 'unauthenticated');
      return json({ user: publicUser(u!) }, 200, session(u!.id));
    }
    const sid = req.headers.get('cookie')?.match(/(?:^|;\s*)foundry_session=([^;]+)/)?.[1];
    const u = sid ? get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?', sid, now()) : null;
    if (!u) fail(401, 'Sign in to continue.', 'unauthenticated');
    const user = u!;
    if (path === '/api/auth/me' && method === 'GET') return json({ user: publicUser(user), activeWorkspaceId: user.active_workspace_id, workspaces: workspaces(user.id) });
    if (path === '/api/auth/logout' && method === 'POST') {
      run('DELETE FROM sessions WHERE id=?', sid!);
      return new Response(null, { status: 204, headers: { 'Set-Cookie': 'foundry_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' } });
    }
    if (path === '/api/workspaces') {
      if (method === 'GET') return json({ workspaces: workspaces(user.id) });
      if (method === 'POST') { fields(b, ['name']); return tx(() => json({ workspace: newWorkspace(text(b.name, 'Workspace name', true, 150).trim(), user.id) }, 201)); }
    }
    const select = path.match(/^\/api\/workspaces\/([^/]+)\/select$/);
    if (select && method === 'POST') {
      const workspace = workspaces(user.id).find(w => w.id === select[1]);
      if (!workspace) fail(404, 'Workspace not found.');
      run('UPDATE users SET active_workspace_id=? WHERE id=?', select[1], user.id);
      return json({ workspace });
    }
    if (path === '/api/invites/accept' && method === 'POST') return tx(() => {
      fields(b, ['token']); const t = text(b.token, 'Invite token', true);
      const inv = get('SELECT * FROM invites WHERE token=? AND email=?', t, user.email);
      if (!inv) fail(404, 'Invitation not found for this email.');
      if (inv!.consumed) fail(409, 'This invitation has already been used.');
      if (inv!.expires_at < now()) fail(404, 'This invitation has expired.');
      run('INSERT OR IGNORE INTO memberships VALUES(?,?,?)', inv!.workspace_id, user.id, inv!.role);
      run('UPDATE invites SET consumed=1 WHERE id=?', inv!.id);
      run('UPDATE users SET active_workspace_id=? WHERE id=?', inv!.workspace_id, user.id);
      activity(inv!.workspace_id, user, 'member.joined', 'member', user.id);
      return json({ workspace: workspaces(user.id).find(w => w.id === inv!.workspace_id) });
    });
    const match = path.match(/^\/api\/w\/([^/]+)(\/.*)?$/);
    if (!match) fail(404, 'API route not found.');
    const w = match![1], route = match![2] || '/';
    const membership = get('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?', w, user.id);
    if (!membership) fail(404, 'Workspace not found.');
    const role = membership!.role;
    const canWrite = (kind = 'general') => {
      if (kind === 'owner' ? role !== 'owner' : kind === 'operations' ? !['owner', 'manager'].includes(role) : role === 'read_only') fail(403, 'Your role does not allow this action.', 'forbidden');
    };
    const ownDelete = (creator: string) => {
      canWrite(); if (!['owner', 'manager'].includes(role) && creator !== user.id) fail(403, 'Only the author or a manager can delete this.', 'forbidden');
    };
    const emit = (action: string, type: string, eid: string) => activity(w, user, action, type, eid);
    if (route === '/sync' && method === 'GET') return json({ revision: get('SELECT revision FROM workspaces WHERE id=?', w)!.revision });
    if (route === '/members' && method === 'GET') return json({ members: memberList(w) });
    const memberRoute = route.match(/^\/members\/([^/]+)$/);
    if (memberRoute && ['PATCH', 'DELETE'].includes(method)) return tx(() => {
      canWrite('owner'); const uid = memberRoute[1];
      if (!get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?', w, uid)) fail(404, 'Member not found.');
      if (get('SELECT owner_id FROM workspaces WHERE id=?', w)!.owner_id === uid) fail(409, 'The original owner cannot be removed or demoted.');
      if (method === 'PATCH') { fields(b, ['role']); const r = choice(b.role, 'role', roles); run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', r, w, uid); }
      else {
        run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', w, uid);
        for (const task of list(w, 'task').filter(t => t.assigneeId === uid)) save(w, 'task', { ...task, assigneeId: null, updatedAt: now() });
      }
      emit(method === 'PATCH' ? 'member.updated' : 'member.removed', 'member', uid);
      return method === 'DELETE' ? new Response(null, { status: 204 }) : json({ member: memberList(w).find(m => m.userId === uid) });
    });
    if (route === '/invites') {
      canWrite('owner');
      if (method === 'GET') return json({ invites: all('SELECT id,email,role,expires_at AS expiresAt,consumed FROM invites WHERE workspace_id=? ORDER BY rowid DESC', w) });
      if (method === 'POST') return tx(() => {
        fields(b, ['email', 'role']); const address = email(b.email, true).toLowerCase(), r = choice(b.role, 'role', roles);
        const invite = { id: id(), email: address, role: r, token: token(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
        run('INSERT INTO invites(id,workspace_id,email,role,token,expires_at) VALUES(?,?,?,?,?,?)', invite.id, w, address, r, invite.token, invite.expiresAt);
        emit('invite.created', 'invite', invite.id); return json({ invite }, 201);
      });
    }
    if (route === '/summary' && method === 'GET') {
      const products = list(w, 'product'), orders = list(w, 'order'), invoices = list(w, 'invoice'), tasks = list(w, 'task');
      return json({ customers: list(w, 'customer').length, products: products.length, lowStockProducts: products.filter(p => p.stock <= 5).length, openOrders: orders.filter(o => o.status === 'draft').length, fulfilledOrders: orders.filter(o => o.status === 'fulfilled').length, revenueCents: invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.totalCents, 0), unpaidCents: invoices.filter(i => ['draft', 'sent'].includes(i.status)).reduce((s, i) => s + i.totalCents, 0), openTasks: tasks.filter(t => t.status !== 'done').length, completedTasks: tasks.filter(t => t.status === 'done').length });
    }
    if (route === '/activity' && method === 'GET') {
      const value = url.searchParams.get('limit') ?? '50';
      if (!/^\d+$/.test(value)) fail(400, 'Invalid activity limit.');
      const limit = integer(Number(value), 'Limit', 1, 500);
      return json({ activity: all('SELECT id,action,entity_type AS entityType,entity_id AS entityId,actor_id AS actorId,actor_name AS actorName,created_at AS createdAt FROM activity WHERE workspace_id=? ORDER BY rowid DESC LIMIT ?', w, limit) });
    }
    if (route === '/import/customers' && method === 'POST') return tx(() => {
      canWrite(); fields(b, ['csv']); const csv = text(b.csv, 'CSV', true, 1048576);
      if (Buffer.byteLength(csv) > 1048576) fail(400, 'CSV exceeds 1MB.');
      const rows = parseCSV(csv);
      if (JSON.stringify(rows.shift()) !== JSON.stringify(['name', 'email', 'company', 'notes'])) fail(400, 'CSV header must be name,email,company,notes.');
      if (rows.length > 200) fail(400, 'Import at most 200 rows.');
      const seen = new Set(list(w, 'customer').map(c => c.email.toLowerCase()));
      const customers = rows.map(row => {
        if (row.length !== 4) fail(400, 'Each CSV row needs four columns.');
        const d = customerData(Object.fromEntries(['name', 'email', 'company', 'notes'].map((k, i) => [k, row[i]])));
        if (d.email && seen.has(d.email.toLowerCase())) fail(409, 'Duplicate customer email. Nothing was imported.');
        if (d.email) seen.add(d.email.toLowerCase()); return d;
      });
      for (const c of customers) { insert(w, 'customer', c); emit('customer.created', 'customer', c.id); }
      return json({ imported: customers.length }, 201);
    });
    if (route === '/export.csv' && method === 'GET') {
      const types: Record<string, string[]> = { customers: ['id', 'name', 'email', 'company', 'notes'], products: ['id', 'sku', 'name', 'description', 'priceCents', 'stock'], orders: ['id', 'number', 'customerId', 'status', 'totalCents'], invoices: ['id', 'number', 'orderId', 'status', 'totalCents'], tasks: ['id', 'projectId', 'title', 'description', 'status', 'priority', 'assigneeId', 'dueDate'] };
      const type = url.searchParams.get('type') || '', headers = types[type];
      if (!headers) fail(400, 'Invalid export type.');
      const csv = [headers.join(','), ...list(w, type.slice(0, -1)).map(r => headers.map(k => csvEscape(r[k])).join(','))].join('\r\n') + '\r\n';
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="foundry-${type}.csv"` } });
    }
    if (route === '/attachments' && method === 'POST') {
      canWrite();
      const raw = await req.arrayBuffer();
      if (raw.byteLength > 3 * 1024 * 1024) fail(413, 'Attachments must be 2 MiB or smaller.', 'too_large');
      const boundaryMatch = req.headers.get('content-type')?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
      const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
      if (!boundary) fail(400, 'Malformed multipart upload.');
      // Bun can truncate injected filenames during parsing. Validate original part headers first.
      for (const part of Buffer.from(raw).toString('latin1').split(`--${boundary}`).slice(1)) {
        const end = part.indexOf('\r\n\r\n');
        if (end === -1) continue;
        for (const match of part.slice(0, end).matchAll(/filename(?:\*)?\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/gi)) {
          if (/[\r\n]|%0[ad]/i.test(match[1] ?? match[2])) fail(400, 'Unsafe file name.');
        }
      }
      const form = await new Request(req.url, { method: 'POST', headers: req.headers, body: raw }).formData().catch(() => fail(400, 'Malformed multipart upload.'));
      const file = form.get('file'), entityType = choice(form.get('entityType'), 'entity type', ['customer', 'order', 'task']), entityId = text(form.get('entityId'), 'Entity', true);
      if (!(file instanceof File)) fail(400, 'Choose a file.');
      const upload = file as File;
      if (upload.size > 2 * 1024 * 1024) fail(413, 'Attachments must be 2 MiB or smaller.', 'too_large');
      if (/[\r\n/\\]/.test(upload.name) || upload.name === '.' || upload.name === '..' || !upload.name) fail(400, 'Unsafe file name.');
      const types: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      const mimeType = types[extname(upload.name).toLowerCase()];
      if (!mimeType) fail(415, 'Supported files: TXT, MD, CSV, PDF, PNG and JPEG.', 'unsupported_file');
      const bytes = new Uint8Array(await upload.arrayBuffer());
      return tx(() => {
        // Recheck membership after awaiting the multipart body.
        const m = get('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?', w, user.id);
        if (!m) fail(404, 'Workspace not found.'); if (m!.role === 'read_only') fail(403, 'Your role does not allow uploads.', 'forbidden');
        find(w, entityType, entityId);
        const attachment = { id: id(), entityType, entityId, fileName: upload.name, size: upload.size, mimeType, createdBy: user.id, createdAt: now() };
        writeFileSync(join(filesDir, attachment.id), bytes);
        try { insert(w, 'attachment', attachment); emit('attachment.created', 'attachment', attachment.id); } catch (e) { unlinkSync(join(filesDir, attachment.id)); throw e; }
        return json({ attachment }, 201);
      });
    }
    if (route === '/attachments' && method === 'GET') {
      const entityType = choice(url.searchParams.get('entityType'), 'entity type', ['customer', 'order', 'task']), entityId = text(url.searchParams.get('entityId'), 'Entity', true);
      find(w, entityType, entityId); return json({ attachments: list(w, 'attachment').filter(a => a.entityType === entityType && a.entityId === entityId) });
    }
    const attachmentRoute = route.match(/^\/attachments\/([^/]+)(\/download)?$/);
    if (attachmentRoute) {
      const a = find(w, 'attachment', attachmentRoute[1]);
      if (attachmentRoute[2] && method === 'GET') {
        return new Response(readFileSync(join(filesDir, a.id)), { headers: { 'Content-Type': a.mimeType, 'Content-Disposition': `attachment; filename="${a.fileName.replaceAll('"', '_').replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, 'X-Content-Type-Options': 'nosniff' } });
      }
      if (!attachmentRoute[2] && method === 'DELETE') return tx(() => { ownDelete(a.createdBy); run('DELETE FROM records WHERE id=? AND workspace_id=?', a.id, w); cleanupFiles.push(a.id); emit('attachment.deleted', 'attachment', a.id); return new Response(null, { status: 204 }); });
    }
    const stockRoute = route === '/stock-movements';
    if (stockRoute && method === 'GET') {
      const pid = url.searchParams.get('productId'); if (pid) find(w, 'product', pid);
      return json({ movements: list(w, 'movement').filter(m => !pid || m.productId === pid) });
    }
    if (stockRoute && method === 'POST') return tx(() => {
      canWrite('operations'); fields(b, ['productId', 'delta', 'reason']);
      const p = find(w, 'product', text(b.productId, 'Product', true));
      const delta = integer(b.delta, 'Quantity change', -1000000000, 1000000000), reason = text(b.reason, 'Reason', true, 1000).trim();
      if (!delta) fail(400, 'Quantity change cannot be zero.');
      if (p.stock + delta < 0 || p.stock + delta > 1000000000) fail(409, 'Stock must remain between 0 and 1,000,000,000.');
      const movement = { id: id(), productId: p.id, delta, reason, kind: 'adjustment', orderId: null, createdBy: user.id, createdAt: now() };
      p.stock += delta; p.updatedAt = now(); save(w, 'product', p); insert(w, 'movement', movement); emit('stock.adjusted', 'product', p.id);
      return json({ movement, product: p }, 201);
    });
    const actionRoute = route.match(/^\/orders\/([^/]+)\/(fulfill|cancel)$/);
    if (actionRoute && method === 'POST') return tx(() => {
      canWrite('operations'); const o = find(w, 'order', actionRoute[1]);
      if (actionRoute[2] === 'cancel') {
        fields(b, []); if (o.status !== 'draft') fail(409, 'Only draft orders can be cancelled.');
        o.status = 'cancelled'; o.updatedAt = now(); save(w, 'order', o); emit('order.cancelled', 'order', o.id); return json({ order: o });
      }
      fields(b, ['idempotencyKey']); const key = text(b.idempotencyKey, 'Idempotency key', true, 100);
      if (key.length < 8) fail(400, 'Idempotency key must have 8 to 100 characters.');
      const previous = get('SELECT * FROM idempotency WHERE workspace_id=? AND key=?', w, key);
      if (previous) { if (previous.order_id !== o.id) fail(409, 'This key belongs to another order.'); return json({ order: JSON.parse(previous.result), replayed: true }); }
      if (o.status !== 'draft') fail(409, 'Only draft orders can be fulfilled.');
      const products = o.items.map((i: Row) => { const p = find(w, 'product', i.productId); if (p.stock < i.quantity) fail(409, `Insufficient stock for ${p.sku}. Receive inventory and retry.`); return p; });
      o.items.forEach((item: Row, index: number) => {
        const p = products[index]; p.stock -= item.quantity; p.updatedAt = now(); save(w, 'product', p);
        insert(w, 'movement', { id: id(), productId: p.id, delta: -item.quantity, reason: `Fulfillment ${o.number}`, kind: 'fulfillment', orderId: o.id, createdBy: user.id, createdAt: now() });
      });
      o.status = 'fulfilled'; o.fulfilledAt = now(); o.updatedAt = o.fulfilledAt; save(w, 'order', o);
      run('INSERT INTO idempotency VALUES(?,?,?,?)', w, key, o.id, JSON.stringify(o)); emit('order.fulfilled', 'order', o.id);
      return json({ order: o, replayed: false });
    });
    const projectTasks = route.match(/^\/projects\/([^/]+)\/tasks$/);
    if ((route === '/tasks' || projectTasks) && method === 'GET') {
      if (projectTasks) find(w, 'project', projectTasks[1]);
      const filters = Object.fromEntries(url.searchParams);
      if (filters.status) choice(filters.status, 'status', taskStatuses);
      if (filters.priority) choice(filters.priority, 'priority', priorities);
      if (filters.projectId) find(w, 'project', filters.projectId);
      if (filters.assigneeId && !get('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?', w, filters.assigneeId)) fail(404, 'Assignee is not a workspace member.');
      const q = (filters.q || '').toLowerCase();
      return json({ tasks: list(w, 'task').filter(t => (!projectTasks || t.projectId === projectTasks[1]) && (!filters.projectId || t.projectId === filters.projectId) && (!filters.status || t.status === filters.status) && (!filters.priority || t.priority === filters.priority) && (!filters.assigneeId || t.assigneeId === filters.assigneeId) && `${t.title} ${t.description}`.toLowerCase().includes(q)) });
    }
    if (projectTasks && method === 'POST') return tx(() => { canWrite(); find(w, 'project', projectTasks[1]); const task: Row = { ...taskData(w, b), projectId: projectTasks[1] }; insert(w, 'task', task); emit('task.created', 'task', task.id); return json({ task }, 201); });
    const commentsRoute = route.match(/^\/tasks\/([^/]+)\/comments$/);
    if (commentsRoute) {
      find(w, 'task', commentsRoute[1]);
      if (method === 'GET') return json({ comments: list(w, 'comment').filter(c => c.taskId === commentsRoute[1]).reverse() });
      if (method === 'POST') return tx(() => {
        canWrite(); fields(b, ['body']); const comment = { id: id(), taskId: commentsRoute[1], body: text(b.body, 'Comment', true, 2000), author: { id: user.id, name: user.name }, createdAt: now() };
        insert(w, 'comment', comment); emit('comment.created', 'comment', comment.id); return json({ comment }, 201);
      });
    }
    const commentRoute = route.match(/^\/comments\/([^/]+)$/);
    if (commentRoute && method === 'DELETE') return tx(() => { const c = find(w, 'comment', commentRoute[1]); ownDelete(c.author.id); removeEntity(w, 'comment', c.id); emit('comment.deleted', 'comment', c.id); return new Response(null, { status: 204 }); });
    const collection = route.match(/^\/(customers|products|orders|invoices|projects|tasks)(?:\/([^/]+))?$/);
    if (collection) {
      const plural = collection[1], type = plural.slice(0, -1), rid = collection[2];
      if (method === 'GET') {
        if (rid) return json({ [type]: find(w, type, rid) });
        const q = (url.searchParams.get('q') || '').toLowerCase(), status = url.searchParams.get('status');
        if (status && type === 'order') choice(status, 'status', ['draft', 'fulfilled', 'cancelled']);
        if (status && type === 'invoice') choice(status, 'status', ['draft', 'sent', 'paid', 'void']);
        return json({ [plural]: list(w, type).filter(r => (!q || (type === 'customer' ? `${r.name} ${r.email} ${r.company}` : `${r.sku} ${r.name} ${r.description}`).toLowerCase().includes(q)) && (!status || r.status === status)) });
      }
      if (method === 'POST' && !rid && type !== 'task') return tx(() => {
        canWrite(['product', 'order', 'invoice'].includes(type) ? 'operations' : 'general');
        let d: Row;
        if (type === 'customer') d = customerData(b);
        else if (type === 'product') d = productData(b);
        else if (type === 'order') {
          d = orderData(w, b); run('UPDATE workspaces SET order_seq=order_seq+1 WHERE id=?', w); d.number = `ORD-${String(get('SELECT order_seq FROM workspaces WHERE id=?', w)!.order_seq).padStart(6, '0')}`;
        } else if (type === 'invoice') {
          fields(b, ['orderId']); const o = find(w, 'order', text(b.orderId, 'Order', true));
          if (o.status !== 'fulfilled') fail(409, 'Fulfill the order before creating an invoice.');
          if (list(w, 'invoice').some(i => i.orderId === o.id)) fail(409, 'This order already has an invoice.');
          const c = find(w, 'customer', o.customerId); run('UPDATE workspaces SET invoice_seq=invoice_seq+1 WHERE id=?', w);
          d = { id: id(), number: `INV-${String(get('SELECT invoice_seq FROM workspaces WHERE id=?', w)!.invoice_seq).padStart(6, '0')}`, orderId: o.id, customerId: c.id, billTo: { name: c.name, email: c.email, company: c.company }, status: 'draft', currency: 'USD', items: o.items, subtotalCents: o.totalCents, totalCents: o.totalCents, createdAt: now(), paidAt: null };
        } else {
          fields(b, ['name', 'description']); d = { id: id(), name: text(b.name, 'Project name', true, 200).trim(), description: 'description' in b ? text(b.description, 'Description') : '', createdAt: now(), updatedAt: now() };
        }
        insert(w, type, d); emit(`${type}.created`, type, d.id); return json({ [type]: d }, 201);
      });
      if (rid && method === 'PATCH') return tx(() => {
        canWrite(['product', 'order', 'invoice'].includes(type) ? 'operations' : 'general');
        const old = find(w, type, rid); let d: Row;
        if (type === 'customer') d = customerData(b, old);
        else if (type === 'product') d = productData(b, old);
        else if (type === 'order') { if (old.status !== 'draft') fail(409, 'Only draft orders can be edited.'); d = orderData(w, b, old); }
        else if (type === 'task') d = taskData(w, b, old);
        else if (type === 'invoice') {
          fields(b, ['status']); const status = choice(b.status, 'status', ['sent', 'paid', 'void']);
          if (!(old.status === 'draft' && ['sent', 'void'].includes(status) || old.status === 'sent' && ['paid', 'void'].includes(status))) fail(409, 'That invoice status transition is not allowed.');
          d = { ...old, status, paidAt: status === 'paid' ? now() : null };
        } else {
          fields(b, ['name', 'description']); d = { ...old, updatedAt: now() };
          if ('name' in b) d.name = text(b.name, 'Project name', true, 200).trim();
          if ('description' in b) d.description = text(b.description, 'Description');
        }
        save(w, type, d); emit(type === 'invoice' ? `invoice.${d.status}` : `${type}.updated`, type, rid); return json({ [type]: d });
      });
      if (rid && method === 'DELETE' && type !== 'invoice') return tx(() => {
        canWrite(['product', 'order'].includes(type) ? 'operations' : 'general'); const d = find(w, type, rid);
        if (type === 'customer' && (list(w, 'order').some(o => o.customerId === rid) || list(w, 'invoice').some(i => i.customerId === rid))) fail(409, 'This customer is referenced by an order or invoice.');
        if (type === 'product' && (list(w, 'movement').some(m => m.productId === rid) || list(w, 'order').some(o => o.items.some((i: Row) => i.productId === rid)))) fail(409, 'This product has stock history or order lines.');
        if (type === 'order' && d.status !== 'draft') fail(409, 'Only draft orders can be deleted.');
        if (type === 'project') for (const t of list(w, 'task').filter(t => t.projectId === rid)) deleteTask(w, t.id);
        if (type === 'task') deleteTask(w, rid); else removeEntity(w, type, rid);
        emit(`${type}.deleted`, type, rid); return new Response(null, { status: 204 });
      });
    }
    fail(404, 'API route not found.');
  }
  return {
    db,
    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        let response: Response;
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) response = await api(req, url);
        else {
          if (!['GET', 'HEAD'].includes(req.method)) return new Response('Not found', { status: 404 });
          let requested: string;
          try { requested = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
          const filePath = resolve(frontendDir, '.' + requested);
          if (!filePath.startsWith(resolve(frontendDir) + '/') && !filePath.startsWith(resolve(frontendDir) + '\\')) {
            if (requested !== '/') return new Response('Not found', { status: 404 });
          }
          const file = Bun.file(filePath);
          if (requested !== '/' && await file.exists() && !requested.endsWith('/')) response = new Response(file);
          else if (await Bun.file(join(frontendDir, 'index.html')).exists()) response = new Response(Bun.file(join(frontendDir, 'index.html')));
          else response = new Response('Run bun run build first.', { status: 503 });
          response.headers.set('Cache-Control', requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        }
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Referrer-Policy', 'same-origin');
        if (url.pathname.startsWith('/api')) response.headers.set('Cache-Control', 'no-store');
        return response;
      } catch (error) {
        if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
        if (error instanceof Error && /UNIQUE constraint/.test(error.message)) return json({ error: { code: 'conflict', message: 'A record with that email, SKU or reference already exists.' } }, 409);
        console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
        return json({ error: { code: 'internal_error', message: 'The request could not be completed.' } }, 500);
      } finally {
        while (cleanupFiles.length) { const file = join(filesDir, cleanupFiles.pop()!); if (existsSync(file)) { try { unlinkSync(file); } catch { /* Metadata is already removed; never expose an orphan. */ } } }
      }
    },
    close() { db.close(); },
  };
}
