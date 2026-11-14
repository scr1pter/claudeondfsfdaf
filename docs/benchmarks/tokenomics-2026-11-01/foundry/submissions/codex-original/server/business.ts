import { all, one, run, uid, now, get, list, put, remove, event, number, tx, fail, deleteFiles, filePath, type Row } from './db';
import { keys, str, email, integer, choice, date, parseCsv, csvCell } from './validation';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export type Context = { w: string; user: Row; role: string };
export function permit(c: Context, level: 'owner' | 'manage' | 'write' = 'write') {
  if (!(level === 'owner' ? ['owner'] : level === 'manage' ? ['owner', 'manager'] : ['owner', 'manager', 'member']).includes(c.role)) fail(403, 'Your workspace role does not allow this action.');
}
export const json = (data: any, status = 200) => Response.json(data, { status });
const singular: Record<string, string> = { customers: 'customer', products: 'product', orders: 'order', invoices: 'invoice', projects: 'project', tasks: 'task' };
function customer(w: string, b: Row, old?: Row) {
  keys(b, ['name', 'email', 'company', 'notes']); const v = { ...old };
  for (const k of ['name', 'email', 'company', 'notes']) if (k in b || !old) v[k] = k === 'email' ? email(k in b ? b[k] : '') : str(k in b ? b[k] : '', k, k === 'name');
  if (v.email && list(w, 'customer').some(x => x.id !== old?.id && x.email.toLowerCase() === v.email)) fail(409, 'A customer with this email already exists.'); return v;
}
function product(w: string, b: Row, old?: Row) {
  keys(b, ['sku', 'name', 'description', 'priceCents']); const v = { ...old };
  for (const k of ['sku', 'name', 'description']) if (k in b || !old) v[k] = str(k in b ? b[k] : '', k, k !== 'description');
  v.sku = v.sku.trim().toUpperCase();
  if ('priceCents' in b || !old) v.priceCents = integer(b.priceCents, 'Price cents', 0, 100000000);
  if (list(w, 'product').some(x => x.id !== old?.id && x.sku.toUpperCase() === v.sku)) fail(409, 'This SKU is already in use.');
  if (!old) v.stock = 0; return v;
}
function order(w: string, b: Row, old?: Row) {
  keys(b, ['customerId', 'items']); const v = { ...old };
  if ('customerId' in b || !old) { v.customerId = str(b.customerId, 'Customer', true); get(w, 'customer', v.customerId); }
  if ('items' in b || !old) {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) fail(400, 'An order needs 1 to 50 distinct products.');
    const seen = new Set<string>();
    v.items = b.items.map((i: any) => {
      if (!i || typeof i !== 'object' || Array.isArray(i)) fail(400, 'Invalid order line.'); keys(i, ['productId', 'quantity']);
      const p = get(w, 'product', str(i.productId, 'Product', true)); if (seen.has(p.id)) fail(400, 'Products must be distinct.'); seen.add(p.id);
      const quantity = integer(i.quantity, 'Quantity', 1, 10000);
      return { productId: p.id, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity, lineTotalCents: p.priceCents * quantity };
    });
    v.totalCents = v.items.reduce((sum: number, x: Row) => sum + x.lineTotalCents, 0);
  } return v;
}
function project(b: Row, old?: Row) { keys(b, ['name', 'description']); const v = { ...old }; for (const k of ['name', 'description']) if (k in b || !old) v[k] = str(k in b ? b[k] : '', k, k === 'name'); return v; }
function task(w: string, b: Row, old?: Row) {
  keys(b, ['title', 'description', 'status', 'priority', 'assigneeId', 'dueDate']); const v = { ...old };
  for (const k of ['title', 'description']) if (k in b || !old) v[k] = str(k in b ? b[k] : '', k, k === 'title');
  if ('status' in b || !old) v.status = choice('status' in b ? b.status : 'todo', ['todo', 'in_progress', 'done'], 'Status');
  if ('priority' in b || !old) v.priority = choice('priority' in b ? b.priority : 'medium', ['low', 'medium', 'high'], 'Priority');
  if ('assigneeId' in b || !old) { v.assigneeId = b.assigneeId ?? null; if (v.assigneeId !== null && (typeof v.assigneeId !== 'string' || !one('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?', w, v.assigneeId))) fail(404, 'Assignee is not a workspace member.'); }
  if ('dueDate' in b || !old) v.dueDate = date(b.dueDate ?? null); return v;
}
const matchTasks = (rows: Row[], q: URLSearchParams) => rows.filter(x => (!q.get('q') || `${x.title} ${x.description}`.toLowerCase().includes(q.get('q')!.toLowerCase())) && ['status', 'priority', 'assigneeId', 'projectId'].every(k => !q.get(k) || x[k] === q.get(k)));

export async function business(req: Request, c: Context, path: string[], q: URLSearchParams, b: Row): Promise<Response> {
  const { w, user } = c; const [section, id, action] = path; const method = req.method;
  const mutation = (name: string, kind: string, entityId: string, fn: () => any, status = 200) => tx(() => { const result = fn(); event(w, user, name, kind, entityId); return json(result, status); });
  if (section === 'sync' && method === 'GET') return json({ revision: one('SELECT revision FROM workspaces WHERE id=?', w)!.revision });
  if (section === 'summary' && method === 'GET') {
    const ps = list(w, 'product'), os = list(w, 'order'), ins = list(w, 'invoice'), ts = list(w, 'task');
    return json({ customers: list(w, 'customer').length, products: ps.length, lowStockProducts: ps.filter(x => x.stock <= 5).length, openOrders: os.filter(x => x.status === 'draft').length, fulfilledOrders: os.filter(x => x.status === 'fulfilled').length, revenueCents: ins.filter(x => x.status === 'paid').reduce((n, x) => n + x.totalCents, 0), unpaidCents: ins.filter(x => ['draft', 'sent'].includes(x.status)).reduce((n, x) => n + x.totalCents, 0), openTasks: ts.filter(x => x.status !== 'done').length, completedTasks: ts.filter(x => x.status === 'done').length });
  }
  if (section === 'activity' && method === 'GET') { const n = q.has('limit') ? Number(q.get('limit')) : 50; integer(n, 'Limit', 1, 500); return json({ activity: all('SELECT data FROM activity WHERE workspace_id=? ORDER BY seq DESC LIMIT ?', w, n).map(x => JSON.parse(x.data)) }); }
  if (section === 'members') {
    if (method === 'GET' && !id) return json({ members: all('SELECT u.id AS userId,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? LIMIT 1000', w) });
    permit(c, 'owner'); if (!id) fail(404, 'Member not found.');
    if (!one('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?', w, id)) fail(404, 'Member not found.');
    if (one('SELECT owner_id FROM workspaces WHERE id=?', w)!.owner_id === id) fail(409, 'The original owner cannot be removed or demoted.');
    if (method === 'PATCH') { keys(b, ['role']); const role = choice(b.role, ['manager', 'member', 'read_only'], 'Role'); return mutation('member.updated', 'member', id, () => { run('UPDATE members SET role=? WHERE workspace_id=? AND user_id=?', role, w, id); return { member: { ...one('SELECT id AS userId,name,email FROM users WHERE id=?', id), role } }; }); }
    if (method === 'DELETE') { tx(() => { run('DELETE FROM members WHERE workspace_id=? AND user_id=?', w, id); event(w, user, 'member.removed', 'member', id); }); return new Response(null, { status: 204 }); }
  }
  if (section === 'invites' && !id) {
    permit(c, 'owner');
    if (method === 'GET') return json({ invites: all('SELECT id,email,role,expires_at AS expiresAt,consumed FROM invites WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1000', w) });
    if (method === 'POST') {
      keys(b, ['email', 'role']); const invite = { id: uid(), email: email(b.email, true), role: choice(b.role, ['manager', 'member', 'read_only'], 'Role'), token: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
      return mutation('invite.created', 'invite', invite.id, () => { run('INSERT INTO invites(id,workspace_id,email,role,token,expires_at) VALUES(?,?,?,?,?,?)', invite.id, w, invite.email, invite.role, invite.token, invite.expiresAt); return { invite }; }, 201);
    }
  }
  if (section === 'import' && id === 'customers' && method === 'POST') {
    permit(c); keys(b, ['csv']); const rows = parseCsv(b.csv); const header = rows.shift(); if (!header || header.length !== 4 || header.some((v, i) => v !== ['name', 'email', 'company', 'notes'][i])) fail(400, 'Expected header: name,email,company,notes.'); if (rows.length > 200) fail(400, 'Import at most 200 rows.');
    return mutation('customer.imported', 'customer', w, () => {
      const seen = new Set(list(w, 'customer').filter(x => x.email).map(x => x.email.toLowerCase()));
      const parsed = rows.map(r => { if (r.length !== 4) fail(400, 'Each CSV row must have four fields.'); const v = customer(w, { name: r[0], email: r[1], company: r[2], notes: r[3] }); if (v.email && seen.has(v.email)) fail(409, 'Duplicate email in CSV.'); if (v.email) seen.add(v.email); return { ...v, id: uid(), createdAt: now(), updatedAt: now() }; });
      for (const v of parsed) { put(w, 'customer', v); event(w, user, 'customer.created', 'customer', v.id); } return { imported: parsed.length };
    }, 201);
  }
  if (section === 'export.csv' && method === 'GET') {
    const type = q.get('type') || ''; const headers: Record<string, string[]> = { customers: ['id', 'name', 'email', 'company', 'notes'], products: ['id', 'sku', 'name', 'description', 'priceCents', 'stock'], orders: ['id', 'number', 'customerId', 'status', 'totalCents'], invoices: ['id', 'number', 'orderId', 'status', 'totalCents'], tasks: ['id', 'projectId', 'title', 'description', 'status', 'priority', 'assigneeId', 'dueDate'] };
    if (!headers[type]) fail(400, 'Invalid CSV export type.'); const h = headers[type]; return new Response([h.join(','), ...list(w, singular[type]).map(r => h.map(k => csvCell(r[k])).join(','))].join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="foundry-${type}.csv"` } });
  }
  if (section === 'stock-movements') {
    if (method === 'GET' && !id) { if (q.get('productId')) get(w, 'product', q.get('productId')!); return json({ movements: list(w, 'movement').filter(x => !q.get('productId') || x.productId === q.get('productId')).slice(0, 1000) }); }
    if (method === 'POST' && !id) {
      permit(c, 'manage'); keys(b, ['productId', 'delta', 'reason']); const productId = str(b.productId, 'Product', true), delta = integer(b.delta, 'Quantity change', -1000000000, 1000000000), reason = str(b.reason, 'Reason', true); if (delta === 0) fail(400, 'Quantity change cannot be zero.');
      const movement = { id: uid(), productId, delta, reason, kind: 'adjustment', orderId: null, createdBy: user.id, createdAt: now() };
      return mutation('stock.adjusted', 'product', productId, () => { const p = get(w, 'product', productId); if (p.stock + delta < 0 || p.stock + delta > 1000000000) fail(409, 'Stock would be outside the allowed range.'); p.stock += delta; p.updatedAt = now(); put(w, 'product', p); put(w, 'movement', movement); return { movement, product: p }; }, 201);
    }
  }
  if (section === 'attachments') {
    if (method === 'GET' && !id) { const type = choice(q.get('entityType'), ['customer', 'order', 'task'], 'Entity type'), entityId = str(q.get('entityId'), 'Entity', true); get(w, type, entityId); return json({ attachments: list(w, 'attachment').filter(x => x.entityType === type && x.entityId === entityId).slice(0, 1000) }); }
    if (method === 'POST' && !id) {
      permit(c);
      // Consume the body before rejecting it: early responses can reset a Windows upload connection.
      // Check original multipart headers before the platform parser normalizes unsafe filenames.
      const raw = await req.arrayBuffer(); if (raw.byteLength > 3 * 1024 * 1024) fail(413, 'Attachments must be 2 MiB or smaller.');
      const contentType = req.headers.get('content-type') || '';
      const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i); if (!boundary) fail(400, 'Malformed multipart upload.');
      for (const part of Buffer.from(raw).toString('latin1').split('--' + (boundary[1] || boundary[2]))) {
        const headerEnd = part.indexOf('\r\n\r\n'); if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        for (const line of headers.split('\r\n')) {
          if (!/^Content-Disposition:/i.test(line)) continue;
          const marker = /;\s*filename\s*=\s*"/i.exec(line);
          if (marker) { const rest = line.slice(marker.index + marker[0].length); const end = rest.indexOf('"'); if (end < 0 || /[\r\n]/.test(rest.slice(0, end))) fail(400, 'Attachment filenames cannot contain CR or LF.'); }
        }
      }
      const form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData(); const file = form.get('file'); const entityType = choice(form.get('entityType'), ['customer', 'order', 'task'], 'Entity type'), entityId = str(form.get('entityId'), 'Entity', true); get(w, entityType, entityId);
      if (!(file instanceof File)) fail(400, 'Choose a file to upload.');
      const fileName = file.name; if (!fileName || /[\r\n/\\]/.test(fileName) || fileName === '.' || fileName === '..') fail(400, 'Unsafe attachment filename.');
      const ext = fileName.toLowerCase().split('.').pop()!; const types: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
      if (!types[ext]) fail(415, 'Supported files: TXT, MD, CSV, PDF, PNG and JPG.'); if (file.size > 2 * 1024 * 1024) fail(413, 'Attachments must be 2 MiB or smaller.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Membership can change while the upload body is being read.
      const member = one('SELECT role FROM members WHERE workspace_id=? AND user_id=?', w, user.id); if (!member) fail(404, 'Workspace not found.'); permit({ ...c, role: member.role }); get(w, entityType, entityId);
      const attachment = { id: uid(), entityType, entityId, fileName, size: file.size, mimeType: types[ext], createdBy: user.id, createdAt: now() };
      try { writeFileSync(filePath(attachment.id), bytes); return mutation('attachment.created', 'attachment', attachment.id, () => ({ attachment: put(w, 'attachment', attachment) }), 201); } catch (e) { if (existsSync(filePath(attachment.id))) unlinkSync(filePath(attachment.id)); throw e; }
    }
    if (id) {
      const a = get(w, 'attachment', id);
      if (method === 'GET' && action === 'download') return new Response(Bun.file(filePath(id)), { headers: { 'Content-Type': a.mimeType, 'Content-Disposition': `attachment; filename="${a.fileName.replace(/["\\]/g, '_').replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, 'X-Content-Type-Options': 'nosniff' } });
      if (method === 'DELETE' && !action) { permit(c); if (a.createdBy !== user.id) permit(c, 'manage'); tx(() => { remove(w, 'attachment', id); event(w, user, 'attachment.deleted', 'attachment', id); }); if (existsSync(filePath(id))) unlinkSync(filePath(id)); return new Response(null, { status: 204 }); }
    }
  }
  if (section === 'comments' && id && method === 'DELETE') { permit(c); const r = get(w, 'comment', id); if (r.author.id !== user.id) permit(c, 'manage'); tx(() => { remove(w, 'comment', id); event(w, user, 'comment.deleted', 'comment', id); }); return new Response(null, { status: 204 }); }
  if (section === 'tasks' && id && action === 'comments') {
    get(w, 'task', id);
    if (method === 'GET') return json({ comments: list(w, 'comment').filter(x => x.taskId === id).slice(0, 1000).reverse() });
    if (method === 'POST') { permit(c); keys(b, ['body']); const comment = { id: uid(), taskId: id, body: str(b.body, 'Comment', true, 2000), author: { id: user.id, name: user.name }, createdAt: now() }; return mutation('comment.created', 'comment', comment.id, () => ({ comment: put(w, 'comment', comment) }), 201); }
  }
  if (section === 'projects' && id && action === 'tasks') {
    get(w, 'project', id);
    if (method === 'GET') return json({ tasks: matchTasks(list(w, 'task').filter(x => x.projectId === id), q).slice(0, 1000) });
    if (method === 'POST') { permit(c); const t = { ...task(w, b), id: uid(), projectId: id, createdAt: now(), updatedAt: now() }; return mutation('task.created', 'task', t.id, () => ({ task: put(w, 'task', t) }), 201); }
  }
  if (section === 'orders' && id && (action === 'fulfill' || action === 'cancel') && method === 'POST') {
    permit(c, 'manage');
    if (action === 'cancel') { keys(b, []); return mutation('order.cancelled', 'order', id, () => { const o = get(w, 'order', id); if (o.status !== 'draft') fail(409, 'Only a draft order can be cancelled.'); return { order: put(w, 'order', { ...o, status: 'cancelled', updatedAt: now() }) }; }); }
    keys(b, ['idempotencyKey']); const key = str(b.idempotencyKey, 'Idempotency key', true, 100); if (key.length < 8) fail(400, 'Idempotency key must be 8 to 100 characters.');
    return tx(() => {
      const o = get(w, 'order', id); const replay = one('SELECT order_id,result FROM idempotency WHERE workspace_id=? AND key=?', w, key);
      if (replay) { if (replay.order_id !== id) fail(409, 'This idempotency key was used for another order.'); return json({ order: JSON.parse(replay.result), replayed: true }); }
      if (o.status !== 'draft') fail(409, 'Only a draft order can be fulfilled.');
      const products = o.items.map((i: Row) => { const p = get(w, 'product', i.productId); if (p.stock < i.quantity) fail(409, `Not enough stock for ${p.sku}. Need ${i.quantity}, available ${p.stock}.`); return p; });
      o.items.forEach((i: Row, index: number) => { const p = products[index]; p.stock -= i.quantity; p.updatedAt = now(); put(w, 'product', p); put(w, 'movement', { id: uid(), productId: p.id, delta: -i.quantity, reason: `Fulfilled ${o.number}`, kind: 'fulfillment', orderId: id, createdBy: user.id, createdAt: now() }); });
      o.status = 'fulfilled'; o.fulfilledAt = now(); o.updatedAt = o.fulfilledAt; put(w, 'order', o);
      run('INSERT INTO idempotency(workspace_id,key,order_id,result) VALUES(?,?,?,?)', w, key, id, JSON.stringify(o)); event(w, user, 'order.fulfilled', 'order', id); return json({ order: o, replayed: false });
    });
  }
  if (section === 'invoices' && !id && method === 'POST') {
    permit(c, 'manage'); keys(b, ['orderId']); const orderId = str(b.orderId, 'Order', true);
    return tx(() => {
      const o = get(w, 'order', orderId); if (o.status !== 'fulfilled') fail(409, 'Fulfill the order before creating an invoice.'); if (list(w, 'invoice').some(x => x.orderId === orderId)) fail(409, 'This order already has an invoice.');
      const cu = get(w, 'customer', o.customerId); const invoice = { id: uid(), number: number(w, 'invoice', 'INV'), orderId, customerId: cu.id, billTo: { name: cu.name, email: cu.email, company: cu.company }, status: 'draft', currency: 'USD', items: o.items, subtotalCents: o.totalCents, totalCents: o.totalCents, createdAt: now(), paidAt: null };
      put(w, 'invoice', invoice); event(w, user, 'invoice.created', 'invoice', invoice.id); return json({ invoice }, 201);
    });
  }
  if (section === 'invoices' && id && method === 'PATCH' && !action) {
    permit(c, 'manage'); keys(b, ['status']); const status = choice(b.status, ['sent', 'paid', 'void'], 'Status');
    return mutation(`invoice.${status}`, 'invoice', id, () => { const i = get(w, 'invoice', id); const valid = i.status === 'draft' ? ['sent', 'void'] : i.status === 'sent' ? ['paid', 'void'] : []; if (!valid.includes(status)) fail(409, 'This invoice status transition is not allowed.'); i.status = status; if (status === 'paid') i.paidAt = now(); return { invoice: put(w, 'invoice', i) }; });
  }
  if (singular[section] && !action) {
    const kind = singular[section];
    if (method === 'GET') {
      if (id) return json({ [kind]: get(w, kind, id) }); let rows = list(w, kind);
      if (['customers', 'products'].includes(section) && q.get('q')) { const search = q.get('q')!.toLowerCase(); rows = rows.filter(x => (section === 'customers' ? [x.name, x.email, x.company] : [x.sku, x.name, x.description]).join(' ').toLowerCase().includes(search)); }
      if (['orders', 'invoices'].includes(section) && q.get('status')) rows = rows.filter(x => x.status === q.get('status'));
      if (section === 'tasks') rows = matchTasks(rows, q); return json({ [section]: rows.slice(0, 1000) });
    }
    permit(c, ['products', 'orders', 'invoices'].includes(section) ? 'manage' : 'write');
    if (method === 'POST' && !id && ['customers', 'products', 'orders', 'projects'].includes(section)) {
      return tx(() => {
        const val = kind === 'customer' ? customer(w, b) : kind === 'product' ? product(w, b) : kind === 'order' ? order(w, b) : project(b);
        const v = { ...val, id: uid(), createdAt: now(), updatedAt: now(), ...(kind === 'order' ? { status: 'draft', number: number(w, 'order', 'ORD'), fulfilledAt: null } : {}) };
        put(w, kind, v); event(w, user, `${kind}.created`, kind, v.id); return json({ [kind]: v }, 201);
      });
    }
    if (id && method === 'PATCH' && kind !== 'invoice') return mutation(`${kind}.updated`, kind, id, () => {
      const old = get(w, kind, id); if (kind === 'order' && old.status !== 'draft') fail(409, 'Only draft orders can be edited.');
      const v = kind === 'customer' ? customer(w, b, old) : kind === 'product' ? product(w, b, old) : kind === 'order' ? order(w, b, old) : kind === 'task' ? task(w, b, old) : project(b, old);
      v.updatedAt = now(); return { [kind]: put(w, kind, v) };
    });
    if (id && method === 'DELETE' && kind !== 'invoice') {
      tx(() => {
        const v = get(w, kind, id);
        if (kind === 'customer' && [...list(w, 'order'), ...list(w, 'invoice')].some(x => x.customerId === id)) fail(409, 'This customer is referenced by an order or invoice.');
        if (kind === 'product' && (list(w, 'movement').some(x => x.productId === id) || list(w, 'order').some(x => x.items.some((i: Row) => i.productId === id)))) fail(409, 'This product is referenced by stock movements or orders.');
        if (kind === 'order' && v.status !== 'draft') fail(409, 'Only draft orders can be deleted.');
        const deleteTask = (taskId: string) => { deleteFiles(w, 'task', taskId); for (const co of list(w, 'comment').filter(x => x.taskId === taskId)) remove(w, 'comment', co.id); remove(w, 'task', taskId); };
        if (kind === 'project') for (const t of list(w, 'task').filter(x => x.projectId === id)) deleteTask(t.id);
        if (kind === 'task') deleteTask(id); else { deleteFiles(w, kind, id); remove(w, kind, id); }
        event(w, user, `${kind}.deleted`, kind, id);
      }); return new Response(null, { status: 204 });
    }
  }
  fail(404, 'API route not found.');
}
