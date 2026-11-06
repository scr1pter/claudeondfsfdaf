import { writeFileSync, readFileSync } from 'node:fs';
import {
  id, now, fail, json, body, workspaceContext, requireRole as enforceRole, transaction as atomic,
  listEntities, getEntity, saveEntity, deleteEntity, activity, listActivity,
  getRevision, nextNumber, getFulfillment, saveFulfillment, members,
  attachmentPath, removeOwnedFile,
  type WorkspaceContext, type Role,
} from '../core/index.ts';

type Customer = { id: string; name: string; email: string; company: string; notes: string; createdAt: string; updatedAt: string };
type Product = { id: string; sku: string; name: string; description: string; priceCents: number; stock: number; createdAt: string; updatedAt: string };
type Line = { productId: string; sku: string; name: string; unitPriceCents: number; quantity: number; lineTotalCents: number };
type Order = { id: string; number: string; customerId: string; status: 'draft' | 'fulfilled' | 'cancelled'; items: Line[]; totalCents: number; createdAt: string; updatedAt: string; fulfilledAt: string | null };
type Invoice = { id: string; number: string; orderId: string; customerId: string; billTo: { name: string; email: string; company: string }; status: 'draft' | 'sent' | 'paid' | 'void'; currency: 'USD'; items: Line[]; subtotalCents: number; totalCents: number; createdAt: string; paidAt: string | null };
type Movement = { id: string; productId: string; delta: number; reason: string; kind: 'adjustment' | 'fulfillment'; orderId: string | null; createdBy: string; createdAt: string };
type Project = { id: string; name: string; description: string; createdAt: string; updatedAt: string };
type Task = { id: string; projectId: string; title: string; description: string; status: 'todo' | 'in_progress' | 'done'; priority: 'low' | 'medium' | 'high'; assigneeId: string | null; dueDate: string | null; createdAt: string; updatedAt: string };
type Comment = { id: string; taskId: string; body: string; author: { id: string; name: string }; createdAt: string };
type Attachment = { id: string; entityType: 'customer' | 'order' | 'task'; entityId: string; fileName: string; size: number; mimeType: string; createdBy: string; createdAt: string };
type RecordBody = Record<string, unknown>;
const managers: Role[] = ['owner', 'manager'];
const writers: Role[] = ['owner', 'manager', 'member'];
const orderStatuses = ['draft', 'fulfilled', 'cancelled'] as const;
const invoiceStatuses = ['draft', 'sent', 'paid', 'void'] as const;
const taskStatuses = ['todo', 'in_progress', 'done'] as const;
const priorities = ['low', 'medium', 'high'] as const;

function fields(value: RecordBody, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(400, 'invalid_field', `Field ${key} is not permitted.`);
  }
}
function text(value: unknown, label: string, required = false, max = 100000): string {
  if (typeof value !== 'string') fail(400, 'invalid_input', `${label} must be a string.`);
  if (value.length > max || (required && !value.trim())) fail(400, 'invalid_input', `${label} is required and must be at most ${max} characters.`);
  return required ? value.trim() : value;
}
function ref(value: unknown, label: string): string { return text(value, label, true, 200); }
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'invalid_input', `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(400, 'invalid_input', `${label} is invalid.`);
  return value as T;
}
function email(value: unknown): string {
  const result = text(value, 'Email', false, 320).trim();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'invalid_email', 'Email must be valid.');
  return result;
}
function entity<T extends { id: string }>(ctx: WorkspaceContext, type: string, entityId: string): T {
  const value = getEntity<T>(ctx.workspaceId, type, entityId);
  if (!value) fail(404, 'not_found', `${type} not found.`);
  return value;
}
function rows<T extends { id: string }>(ctx: WorkspaceContext, type: string): T[] { return listEntities<T>(ctx.workspaceId, type); }
function changed<T extends { id: string }>(ctx: WorkspaceContext, type: string, value: T, action: string): T {
  saveEntity(ctx.workspaceId, type, value);
  activity(ctx, action, type, value.id);
  return value;
}
function removed(ctx: WorkspaceContext, type: string, entityId: string): void {
  deleteEntity(ctx.workspaceId, type, entityId);
  activity(ctx, `${type}.deleted`, type, entityId);
}
function uniqueCustomer(ctx: WorkspaceContext, value: Customer): void {
  if (value.email && rows<Customer>(ctx, 'customer').some(c => c.id !== value.id && c.email.toLowerCase() === value.email.toLowerCase())) fail(409, 'duplicate_email', 'A customer with this email already exists.');
}
function customerValues(input: RecordBody, previous?: Customer): Pick<Customer, 'name' | 'email' | 'company' | 'notes'> {
  fields(input, ['name', 'email', 'company', 'notes']);
  return {
    name: input.name === undefined && previous ? previous.name : text(input.name, 'Name', true, 500),
    email: input.email === undefined ? previous?.email ?? '' : email(input.email),
    company: input.company === undefined ? previous?.company ?? '' : text(input.company, 'Company', false, 1000),
    notes: input.notes === undefined ? previous?.notes ?? '' : text(input.notes, 'Notes'),
  };
}
function productValues(input: RecordBody, previous?: Product): Pick<Product, 'sku' | 'name' | 'description' | 'priceCents'> {
  fields(input, ['sku', 'name', 'description', 'priceCents']);
  return {
    sku: input.sku === undefined && previous ? previous.sku : text(input.sku, 'SKU', true, 200).toUpperCase(),
    name: input.name === undefined && previous ? previous.name : text(input.name, 'Name', true, 500),
    description: input.description === undefined ? previous?.description ?? '' : text(input.description, 'Description'),
    priceCents: input.priceCents === undefined && previous ? previous.priceCents : integer(input.priceCents, 'Price cents', 0, 100000000),
  };
}
function snapshotItems(ctx: WorkspaceContext, value: unknown): Line[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) fail(400, 'invalid_items', 'Provide 1 to 50 distinct products.');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, 'invalid_items', 'Each item must be an object.');
    const row = item as RecordBody;
    fields(row, ['productId', 'quantity']);
    const productId = ref(row.productId, 'Product');
    if (seen.has(productId)) fail(400, 'duplicate_product', 'Order products must be distinct.');
    seen.add(productId);
    const quantity = integer(row.quantity, 'Quantity', 1, 10000);
    const product = entity<Product>(ctx, 'product', productId);
    return { productId, sku: product.sku, name: product.name, unitPriceCents: product.priceCents, quantity, lineTotalCents: product.priceCents * quantity };
  });
}
function dueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'invalid_date', 'Due date must be a valid YYYY-MM-DD date or null.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(400, 'invalid_date', 'Due date must be a valid calendar date.');
  return value;
}
function taskValues(ctx: WorkspaceContext, input: RecordBody, previous?: Task): Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assigneeId' | 'dueDate'> {
  fields(input, ['title', 'description', 'status', 'priority', 'assigneeId', 'dueDate']);
  const assigneeId = input.assigneeId === undefined ? previous?.assigneeId ?? null : input.assigneeId === null ? null : ref(input.assigneeId, 'Assignee');
  if (assigneeId !== null && !members(ctx.workspaceId).some(member => member.userId === assigneeId)) fail(404, 'not_found', 'Assignee not found in this workspace.');
  return {
    title: input.title === undefined && previous ? previous.title : text(input.title, 'Title', true, 1000),
    description: input.description === undefined ? previous?.description ?? '' : text(input.description, 'Description'),
    status: input.status === undefined ? previous?.status ?? 'todo' : choice(input.status, taskStatuses, 'Status'),
    priority: input.priority === undefined ? previous?.priority ?? 'medium' : choice(input.priority, priorities, 'Priority'),
    assigneeId,
    dueDate: input.dueDate === undefined ? previous?.dueDate ?? null : dueDate(input.dueDate),
  };
}
function filteredTasks(ctx: WorkspaceContext, url: URL, projectId?: string): Task[] {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const status = url.searchParams.get('status');
  const priority = url.searchParams.get('priority');
  const assigneeId = url.searchParams.get('assigneeId');
  if (status) choice(status, taskStatuses, 'Status');
  if (priority) choice(priority, priorities, 'Priority');
  const selectedProject = projectId ?? url.searchParams.get('projectId');
  if (selectedProject) entity<Project>(ctx, 'project', selectedProject);
  if (assigneeId && !members(ctx.workspaceId).some(member => member.userId === assigneeId)) fail(404, 'not_found', 'Assignee not found in this workspace.');
  return rows<Task>(ctx, 'task').filter(task => (!selectedProject || task.projectId === selectedProject)
    && (!status || task.status === status) && (!priority || task.priority === priority)
    && (!assigneeId || task.assigneeId === assigneeId)
    && (!q || `${task.title}\n${task.description}`.toLowerCase().includes(q)));
}

// Metadata deletion is transactional; owned file cleanup runs immediately after commit.
function deleteAttachments(ctx: WorkspaceContext, type: Attachment['entityType'], entityId: string, files: string[]): void {
  for (const attachment of rows<Attachment>(ctx, 'attachment').filter(a => a.entityType === type && a.entityId === entityId)) {
    removed(ctx, 'attachment', attachment.id);
    files.push(attachment.id);
  }
}
function deleteTask(ctx: WorkspaceContext, taskId: string, files: string[]): void {
  for (const comment of rows<Comment>(ctx, 'comment').filter(c => c.taskId === taskId)) removed(ctx, 'comment', comment.id);
  deleteAttachments(ctx, 'task', taskId, files);
  removed(ctx, 'task', taskId);
}
function cleanFiles(files: string[]): void { for (const fileId of files) removeOwnedFile(fileId); }
function noContent(): Response { return new Response(null, { status: 204 }); }

async function uploadForm(request: Request): Promise<FormData> {
  const max = 2 * 1048576 + 65536;
  const contentType = request.headers.get('content-type') ?? '';
  const boundaryMatch = /\bboundary=(?:"([^"\r\n]+)"|([^;\s\r\n]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!/^multipart\/form-data\b/i.test(contentType) || !boundary || boundary.length > 200) fail(400, 'invalid_multipart', 'A valid multipart upload is required.');
  if (Number(request.headers.get('content-length')) > max) fail(413, 'file_too_large', 'Attachment must be at most 2 MiB.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_multipart', 'A multipart body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try { part = await reader.read(); } catch { return fail(400, 'invalid_multipart', 'The upload body could not be read.'); }
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      fail(413, 'file_too_large', 'Attachment must be at most 2 MiB.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // Inspect raw part headers: Bun may truncate a CR/LF-bearing filename before
  // exposing File.name, so validating only the parsed name is insufficient.
  const raw = new TextDecoder('latin1').decode(bytes);
  const marker = `--${boundary}`;
  let position = raw.indexOf(marker);
  if (position < 0) fail(400, 'invalid_multipart', 'Multipart boundary is missing.');
  while (position >= 0) {
    const start = position + marker.length;
    if (raw.slice(start, start + 2) === '--') break;
    if (raw.slice(start, start + 2) !== '\r\n') fail(400, 'invalid_multipart', 'Invalid multipart headers.');
    const end = raw.indexOf('\r\n\r\n', start + 2);
    if (end < 0 || end - start > 16384) fail(400, 'invalid_multipart', 'Invalid multipart headers.');
    const headers = raw.slice(start + 2, end);
    const filename = /\bfilename\s*=\s*"([^"]*)"/i.exec(headers)?.[1];
    if (filename && /[\r\n]|%0[ad]/i.test(filename)) fail(400, 'invalid_filename', 'File names cannot contain CR or LF.');
    for (const line of headers.split('\r\n')) {
      if (!/^(?:Content-Disposition|Content-Type):[^\r\n]*$/i.test(line)) fail(400, 'invalid_multipart', 'Invalid multipart header or filename injection.');
    }
    const next = raw.indexOf(`\r\n${marker}`, end + 4);
    if (next < 0) fail(400, 'invalid_multipart', 'Multipart closing boundary is missing.');
    position = next + 2;
  }
  try { return await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { return fail(400, 'invalid_multipart', 'A valid multipart upload is required.'); }
}

/** All workspace requests authenticate and resolve membership before reading data. */
export async function handleBusiness(request: Request, url: URL): Promise<Response | null> {
  const match = /^\/api\/w\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return null;
  let workspaceId: string;
  let path: string[];
  try {
    workspaceId = decodeURIComponent(match[1]);
    path = (match[2] ?? '').split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch { return fail(400, 'invalid_path', 'Invalid URL encoding.'); }
  const ctx = workspaceContext(request, workspaceId);
  let mutationRoles: Role[] | null = null;
  function requireRole(context: WorkspaceContext, allowed: Role[]): void {
    mutationRoles = allowed;
    enforceRole(context, allowed);
  }
  function transaction<T>(write: () => T): T {
    return atomic(() => {
      // A request body/upload can be held open while another client revokes
      // its session, membership or role. Authorization and the actual write
      // must therefore share this synchronous database transaction.
      const current = workspaceContext(request, workspaceId);
      if (!mutationRoles) fail(500, 'authorization_guard', 'Mutation permissions were not configured.');
      enforceRole(current, mutationRoles);
      Object.assign(ctx, current);
      return write();
    });
  }
  const method = request.method;
  const [resource, entityId, action] = path;

  if (resource === 'customers') {
    if (path.length === 1 && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({ customers: rows<Customer>(ctx, 'customer').filter(c => !q || `${c.name}\n${c.email}\n${c.company}`.toLowerCase().includes(q)) });
    }
    if (path.length === 1 && method === 'POST') {
      requireRole(ctx, writers);
      const input = await body(request);
      const customer = transaction(() => {
        const stamp = now();
        const value: Customer = { id: id(), ...customerValues(input), createdAt: stamp, updatedAt: stamp };
        uniqueCustomer(ctx, value);
        return changed(ctx, 'customer', value, 'customer.created');
      });
      return json({ customer }, 201);
    }
    if (path.length === 2 && method === 'GET') return json({ customer: entity<Customer>(ctx, 'customer', entityId) });
    if (path.length === 2 && method === 'PATCH') {
      requireRole(ctx, writers);
      const input = await body(request);
      const customer = transaction(() => {
        const old = entity<Customer>(ctx, 'customer', entityId);
        const value = { ...old, ...customerValues(input, old), updatedAt: now() };
        uniqueCustomer(ctx, value);
        return changed(ctx, 'customer', value, 'customer.updated');
      });
      return json({ customer });
    }
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, writers);
      const files: string[] = [];
      transaction(() => {
        entity<Customer>(ctx, 'customer', entityId);
        if (rows<Order>(ctx, 'order').some(o => o.customerId === entityId) || rows<Invoice>(ctx, 'invoice').some(i => i.customerId === entityId)) fail(409, 'customer_referenced', 'Customer is referenced by an order or invoice.');
        deleteAttachments(ctx, 'customer', entityId, files);
        removed(ctx, 'customer', entityId);
      });
      cleanFiles(files);
      return noContent();
    }
  }

  if (resource === 'products') {
    if (path.length === 1 && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({ products: rows<Product>(ctx, 'product').filter(p => !q || `${p.sku}\n${p.name}\n${p.description}`.toLowerCase().includes(q)) });
    }
    if ((path.length === 1 && method === 'POST') || (path.length === 2 && method === 'PATCH')) {
      requireRole(ctx, managers);
      const input = await body(request);
      const product = transaction(() => {
        const old = method === 'PATCH' ? entity<Product>(ctx, 'product', entityId) : undefined;
        const stamp = now();
        const value: Product = { id: old?.id ?? id(), stock: old?.stock ?? 0, createdAt: old?.createdAt ?? stamp, updatedAt: stamp, ...productValues(input, old) };
        if (rows<Product>(ctx, 'product').some(p => p.id !== value.id && p.sku.toUpperCase() === value.sku)) fail(409, 'duplicate_sku', 'This SKU already exists.');
        return changed(ctx, 'product', value, old ? 'product.updated' : 'product.created');
      });
      return json({ product }, method === 'POST' ? 201 : 200);
    }
    if (path.length === 2 && method === 'GET') return json({ product: entity<Product>(ctx, 'product', entityId) });
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, managers);
      transaction(() => {
        entity<Product>(ctx, 'product', entityId);
        if (rows<Movement>(ctx, 'movement').some(m => m.productId === entityId) || rows<Order>(ctx, 'order').some(o => o.items.some(i => i.productId === entityId))) fail(409, 'product_referenced', 'Product is referenced by stock movements or orders.');
        removed(ctx, 'product', entityId);
      });
      return noContent();
    }
  }

  if (resource === 'stock-movements' && path.length === 1) {
    if (method === 'GET') {
      const productId = url.searchParams.get('productId');
      if (productId) entity<Product>(ctx, 'product', productId);
      return json({ movements: rows<Movement>(ctx, 'movement').filter(m => !productId || m.productId === productId) });
    }
    if (method === 'POST') {
      requireRole(ctx, managers);
      const input = await body(request);
      fields(input, ['productId', 'delta', 'reason']);
      const productId = ref(input.productId, 'Product');
      const delta = integer(input.delta, 'Delta', -1000000000, 1000000000);
      if (delta === 0) fail(400, 'invalid_delta', 'Delta must be nonzero.');
      const reason = text(input.reason, 'Reason', true, 2000);
      const result = transaction(() => {
        const old = entity<Product>(ctx, 'product', productId);
        const stock = old.stock + delta;
        if (stock < 0 || stock > 1000000000) fail(409, 'stock_conflict', 'Resulting stock must be between 0 and 1000000000.');
        const stamp = now();
        const product = { ...old, stock, updatedAt: stamp };
        const movement: Movement = { id: id(), productId, delta, reason, kind: 'adjustment', orderId: null, createdBy: ctx.user.id, createdAt: stamp };
        saveEntity(ctx.workspaceId, 'product', product);
        saveEntity(ctx.workspaceId, 'movement', movement);
        activity(ctx, 'stock.adjusted', 'product', productId);
        return { movement, product };
      });
      return json(result, 201);
    }
  }

  if (resource === 'orders') {
    if (path.length === 1 && method === 'GET') {
      const status = url.searchParams.get('status');
      if (status) choice(status, orderStatuses, 'Status');
      return json({ orders: rows<Order>(ctx, 'order').filter(o => !status || o.status === status) });
    }
    if ((path.length === 1 && method === 'POST') || (path.length === 2 && method === 'PATCH')) {
      requireRole(ctx, managers);
      const input = await body(request);
      fields(input, ['customerId', 'items']);
      const order = transaction(() => {
        const old = method === 'PATCH' ? entity<Order>(ctx, 'order', entityId) : undefined;
        if (old && old.status !== 'draft') fail(409, 'order_state', 'Only draft orders can be edited.');
        const customerId = input.customerId === undefined && old ? old.customerId : ref(input.customerId, 'Customer');
        entity<Customer>(ctx, 'customer', customerId);
        const items = snapshotItems(ctx, input.items === undefined && old
          ? old.items.map(line => ({ productId: line.productId, quantity: line.quantity }))
          : input.items);
        const stamp = now();
        const value: Order = { id: old?.id ?? id(), number: old?.number ?? nextNumber(ctx.workspaceId, 'ORD'), customerId, status: 'draft', items, totalCents: items.reduce((sum, line) => sum + line.lineTotalCents, 0), createdAt: old?.createdAt ?? stamp, updatedAt: stamp, fulfilledAt: null };
        return changed(ctx, 'order', value, old ? 'order.updated' : 'order.created');
      });
      return json({ order }, method === 'POST' ? 201 : 200);
    }
    if (path.length === 2 && method === 'GET') return json({ order: entity<Order>(ctx, 'order', entityId) });
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, managers);
      const files: string[] = [];
      transaction(() => {
        const order = entity<Order>(ctx, 'order', entityId);
        if (order.status !== 'draft') fail(409, 'order_state', 'Only draft orders can be deleted.');
        deleteAttachments(ctx, 'order', entityId, files);
        removed(ctx, 'order', entityId);
      });
      cleanFiles(files);
      return noContent();
    }
    if (path.length === 3 && action === 'cancel' && method === 'POST') {
      requireRole(ctx, managers);
      // This command has no client-controlled business fields.
      if (request.headers.get('content-type')?.includes('application/json')) fields(await body(request), []);
      const order = transaction(() => {
        const old = entity<Order>(ctx, 'order', entityId);
        if (old.status !== 'draft') fail(409, 'order_state', 'Only draft orders can be cancelled.');
        return changed(ctx, 'order', { ...old, status: 'cancelled' as const, updatedAt: now() }, 'order.cancelled');
      });
      return json({ order });
    }
    if (path.length === 3 && action === 'fulfill' && method === 'POST') {
      requireRole(ctx, managers);
      const input = await body(request);
      fields(input, ['idempotencyKey']);
      const key = text(input.idempotencyKey, 'Idempotency key', false, 100);
      if (key.length < 8 || !key.trim()) fail(400, 'invalid_key', 'Idempotency key must be 8 to 100 characters.');
      const result = transaction(() => {
        const old = entity<Order>(ctx, 'order', entityId);
        const previous = getFulfillment(ctx.workspaceId, key);
        if (previous) {
          if (previous.orderId !== entityId) fail(409, 'idempotency_conflict', 'This key was used for another order.');
          return { order: previous.order, replayed: true };
        }
        if (old.status !== 'draft') fail(409, 'order_state', 'Only draft orders can be fulfilled.');
        const products = old.items.map(line => {
          const product = entity<Product>(ctx, 'product', line.productId);
          if (product.stock < line.quantity) fail(409, 'insufficient_stock', `Insufficient stock for ${line.sku}.`);
          return product;
        });
        const stamp = now();
        old.items.forEach((line, index) => {
          const product = products[index];
          saveEntity(ctx.workspaceId, 'product', { ...product, stock: product.stock - line.quantity, updatedAt: stamp });
          const movement: Movement = { id: id(), productId: line.productId, delta: -line.quantity, reason: `Fulfilled ${old.number}`, kind: 'fulfillment', orderId: old.id, createdBy: ctx.user.id, createdAt: stamp };
          saveEntity(ctx.workspaceId, 'movement', movement);
        });
        const order: Order = { ...old, status: 'fulfilled', fulfilledAt: stamp, updatedAt: stamp };
        changed(ctx, 'order', order, 'order.fulfilled');
        saveFulfillment(ctx.workspaceId, key, order.id, order);
        return { order, replayed: false };
      });
      return json(result);
    }
  }

  if (resource === 'invoices') {
    if (path.length === 1 && method === 'GET') {
      const status = url.searchParams.get('status');
      if (status) choice(status, invoiceStatuses, 'Status');
      return json({ invoices: rows<Invoice>(ctx, 'invoice').filter(i => !status || i.status === status) });
    }
    if (path.length === 1 && method === 'POST') {
      requireRole(ctx, managers);
      const input = await body(request);
      fields(input, ['orderId']);
      const orderId = ref(input.orderId, 'Order');
      const invoice = transaction(() => {
        const order = entity<Order>(ctx, 'order', orderId);
        if (order.status !== 'fulfilled') fail(409, 'order_state', 'Invoice requires a fulfilled order.');
        if (rows<Invoice>(ctx, 'invoice').some(i => i.orderId === orderId)) fail(409, 'duplicate_invoice', 'This order already has an invoice.');
        const customer = entity<Customer>(ctx, 'customer', order.customerId);
        const items = order.items.map(line => ({ ...line }));
        const totalCents = items.reduce((sum, line) => sum + line.lineTotalCents, 0);
        const value: Invoice = { id: id(), number: nextNumber(ctx.workspaceId, 'INV'), orderId, customerId: customer.id, billTo: { name: customer.name, email: customer.email, company: customer.company }, status: 'draft', currency: 'USD', items, subtotalCents: totalCents, totalCents, createdAt: now(), paidAt: null };
        return changed(ctx, 'invoice', value, 'invoice.created');
      });
      return json({ invoice }, 201);
    }
    if (path.length === 2 && method === 'GET') return json({ invoice: entity<Invoice>(ctx, 'invoice', entityId) });
    if (path.length === 2 && method === 'PATCH') {
      requireRole(ctx, managers);
      const input = await body(request);
      fields(input, ['status']);
      const status = choice(input.status, invoiceStatuses, 'Status');
      const invoice = transaction(() => {
        const old = entity<Invoice>(ctx, 'invoice', entityId);
        const allowed = old.status === 'draft' ? ['sent', 'void'] : old.status === 'sent' ? ['paid', 'void'] : [];
        if (!allowed.includes(status)) fail(409, 'invoice_state', 'This invoice status transition is not allowed.');
        return changed(ctx, 'invoice', { ...old, status, paidAt: status === 'paid' ? now() : old.paidAt }, `invoice.${status}`);
      });
      return json({ invoice });
    }
  }

  if (resource === 'projects') {
    if (path.length === 1 && method === 'GET') return json({ projects: rows<Project>(ctx, 'project') });
    if ((path.length === 1 && method === 'POST') || (path.length === 2 && method === 'PATCH')) {
      requireRole(ctx, writers);
      const input = await body(request);
      fields(input, ['name', 'description']);
      const project = transaction(() => {
        const old = method === 'PATCH' ? entity<Project>(ctx, 'project', entityId) : undefined;
        const stamp = now();
        const value: Project = { id: old?.id ?? id(), name: input.name === undefined && old ? old.name : text(input.name, 'Name', true, 500), description: input.description === undefined ? old?.description ?? '' : text(input.description, 'Description'), createdAt: old?.createdAt ?? stamp, updatedAt: stamp };
        return changed(ctx, 'project', value, old ? 'project.updated' : 'project.created');
      });
      return json({ project }, method === 'POST' ? 201 : 200);
    }
    if (path.length === 2 && method === 'GET') return json({ project: entity<Project>(ctx, 'project', entityId) });
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, writers);
      const files: string[] = [];
      transaction(() => {
        entity<Project>(ctx, 'project', entityId);
        for (const task of rows<Task>(ctx, 'task').filter(t => t.projectId === entityId)) deleteTask(ctx, task.id, files);
        removed(ctx, 'project', entityId);
      });
      cleanFiles(files);
      return noContent();
    }
    if (path.length === 3 && action === 'tasks' && method === 'GET') {
      entity<Project>(ctx, 'project', entityId);
      return json({ tasks: filteredTasks(ctx, url, entityId) });
    }
    if (path.length === 3 && action === 'tasks' && method === 'POST') {
      requireRole(ctx, writers);
      const input = await body(request);
      const task = transaction(() => {
        entity<Project>(ctx, 'project', entityId);
        const stamp = now();
        const value: Task = { id: id(), projectId: entityId, ...taskValues(ctx, input), createdAt: stamp, updatedAt: stamp };
        return changed(ctx, 'task', value, 'task.created');
      });
      return json({ task }, 201);
    }
  }

  if (resource === 'tasks') {
    if (path.length === 1 && method === 'GET') return json({ tasks: filteredTasks(ctx, url) });
    if (path.length === 2 && method === 'GET') return json({ task: entity<Task>(ctx, 'task', entityId) });
    if (path.length === 2 && method === 'PATCH') {
      requireRole(ctx, writers);
      const input = await body(request);
      const task = transaction(() => {
        const old = entity<Task>(ctx, 'task', entityId);
        return changed(ctx, 'task', { ...old, ...taskValues(ctx, input, old), updatedAt: now() }, 'task.updated');
      });
      return json({ task });
    }
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, writers);
      const files: string[] = [];
      transaction(() => {
        entity<Task>(ctx, 'task', entityId);
        deleteTask(ctx, entityId, files);
      });
      cleanFiles(files);
      return noContent();
    }
    if (path.length === 3 && action === 'comments' && method === 'GET') {
      entity<Task>(ctx, 'task', entityId);
      return json({ comments: rows<Comment>(ctx, 'comment').filter(c => c.taskId === entityId) });
    }
    if (path.length === 3 && action === 'comments' && method === 'POST') {
      requireRole(ctx, writers);
      const input = await body(request);
      fields(input, ['body']);
      const content = text(input.body, 'Comment', true, 2000);
      const comment = transaction(() => {
        entity<Task>(ctx, 'task', entityId);
        const value: Comment = { id: id(), taskId: entityId, body: content, author: { id: ctx.user.id, name: ctx.user.name }, createdAt: now() };
        return changed(ctx, 'comment', value, 'comment.created');
      });
      return json({ comment }, 201);
    }
  }
  if (resource === 'comments' && path.length === 2 && method === 'DELETE') {
    requireRole(ctx, writers);
    transaction(() => {
      const comment = entity<Comment>(ctx, 'comment', entityId);
      if (!managers.includes(ctx.role) && comment.author.id !== ctx.user.id) fail(403, 'forbidden', 'Only the author or a manager can delete this comment.');
      removed(ctx, 'comment', entityId);
    });
    return noContent();
  }

  if (resource === 'import' && entityId === 'customers' && path.length === 2 && method === 'POST') {
    requireRole(ctx, writers);
    const input = await body(request);
    fields(input, ['csv']);
    const csv = text(input.csv, 'CSV', false, 1048576);
    if (new TextEncoder().encode(csv).length > 1048576) fail(400, 'csv_too_large', 'CSV must be at most 1 MiB.');
    const parsed = parseCsv(csv);
    if (!parsed.length || parsed[0].join(',') !== 'name,email,company,notes' || parsed[0].length !== 4) fail(400, 'csv_header', 'CSV header must be name,email,company,notes.');
    if (parsed.length - 1 > 200) fail(400, 'csv_rows', 'CSV must contain at most 200 data rows.');
    const values = parsed.slice(1).map(row => {
      if (row.length !== 4) fail(400, 'csv_columns', 'Each CSV row must have four columns.');
      return customerValues({ name: row[0], email: row[1], company: row[2], notes: row[3] });
    });
    transaction(() => {
      const emails = new Set(rows<Customer>(ctx, 'customer').filter(c => c.email).map(c => c.email.toLowerCase()));
      for (const value of values) {
        if (value.email && emails.has(value.email.toLowerCase())) fail(409, 'duplicate_email', 'CSV contains an existing or duplicate email.');
        if (value.email) emails.add(value.email.toLowerCase());
      }
      for (const value of values) {
        const stamp = now();
        changed(ctx, 'customer', { id: id(), ...value, createdAt: stamp, updatedAt: stamp }, 'customer.created');
      }
      activity(ctx, 'customers.imported', 'customer', ctx.workspaceId);
    });
    return json({ imported: values.length }, 201);
  }
  if (resource === 'export.csv' && path.length === 1 && method === 'GET') {
    const type = choice(url.searchParams.get('type'), ['customers', 'products', 'orders', 'invoices', 'tasks'] as const, 'Export type');
    const columns = {
      customers: ['id', 'name', 'email', 'company', 'notes'],
      products: ['id', 'sku', 'name', 'description', 'priceCents', 'stock'],
      orders: ['id', 'number', 'customerId', 'status', 'totalCents'],
      invoices: ['id', 'number', 'orderId', 'status', 'totalCents'],
      tasks: ['id', 'projectId', 'title', 'description', 'status', 'priority', 'assigneeId', 'dueDate'],
    }[type];
    const records = rows<{ id: string } & Record<string, unknown>>(ctx, type.slice(0, -1));
    const csv = [columns.join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\r\n') + '\r\n';
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${type}.csv"`, 'X-Content-Type-Options': 'nosniff' } });
  }

  if (resource === 'attachments') {
    if (path.length === 1 && method === 'GET') {
      const entityType = choice(url.searchParams.get('entityType'), ['customer', 'order', 'task'] as const, 'Entity type');
      const parentId = ref(url.searchParams.get('entityId'), 'Entity ID');
      entity(ctx, entityType, parentId);
      return json({ attachments: rows<Attachment>(ctx, 'attachment').filter(a => a.entityType === entityType && a.entityId === parentId) });
    }
    if (path.length === 1 && method === 'POST') {
      requireRole(ctx, writers);
      const form = await uploadForm(request);
      for (const key of form.keys()) if (!['file', 'entityType', 'entityId'].includes(key) || form.getAll(key).length !== 1) fail(400, 'invalid_field', 'Upload must contain one file, entityType and entityId only.');
      const file = form.get('file');
      if (!(file instanceof File)) fail(400, 'file_required', 'A file is required.');
      const entityType = choice(form.get('entityType'), ['customer', 'order', 'task'] as const, 'Entity type');
      const parentId = ref(form.get('entityId'), 'Entity ID');
      if (file.size > 2 * 1048576) fail(413, 'file_too_large', 'Attachment must be at most 2 MiB.');
      const fileName = file.name;
      if (!fileName || /[\r\n\x00-\x1f\x7f/\\]|%0[ad]/i.test(fileName) || fileName === '.' || fileName === '..') fail(400, 'invalid_filename', 'File name must be a safe basename without control characters.');
      const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
      const mimeTypes: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      const mimeType = mimeTypes[extension];
      if (!mimeType) fail(415, 'unsupported_file', 'Allowed file types: txt, md, csv, pdf, png, jpg and jpeg.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const attachmentId = id();
      let written = false;
      let attachment: Attachment;
      try {
        attachment = transaction(() => {
          entity(ctx, entityType, parentId);
          writeFileSync(attachmentPath(attachmentId), bytes, { flag: 'wx' });
          written = true;
          const value: Attachment = { id: attachmentId, entityType, entityId: parentId, fileName, size: bytes.length, mimeType, createdBy: ctx.user.id, createdAt: now() };
          return changed(ctx, 'attachment', value, 'attachment.created');
        });
      } catch (error) {
        if (written) removeOwnedFile(attachmentId);
        throw error;
      }
      return json({ attachment }, 201);
    }
    if (path.length === 3 && action === 'download' && method === 'GET') {
      const attachment = entity<Attachment>(ctx, 'attachment', entityId);
      let bytes: Buffer;
      try { bytes = readFileSync(attachmentPath(attachment.id)); } catch { return fail(404, 'not_found', 'Attachment file not found.'); }
      const fallback = attachment.fileName.replace(/[^\x20-\x7e]|["\\;]/g, '_');
      const encoded = encodeURIComponent(attachment.fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(bytes, { headers: { 'Content-Type': attachment.mimeType, 'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
    }
    if (path.length === 2 && method === 'DELETE') {
      requireRole(ctx, writers);
      transaction(() => {
        const attachment = entity<Attachment>(ctx, 'attachment', entityId);
        if (!managers.includes(ctx.role) && attachment.createdBy !== ctx.user.id) fail(403, 'forbidden', 'Only the author or a manager can delete this attachment.');
        removed(ctx, 'attachment', entityId);
      });
      removeOwnedFile(entityId);
      return noContent();
    }
  }

  if (resource === 'activity' && path.length === 1 && method === 'GET') {
    const raw = url.searchParams.get('limit');
    if (raw !== null && !/^\d+$/.test(raw)) fail(400, 'invalid_limit', 'Limit must be an integer from 1 to 500.');
    const limit = raw === null ? 50 : integer(Number(raw), 'Limit', 1, 500);
    return json({ activity: listActivity(ctx.workspaceId, limit) });
  }
  if (resource === 'sync' && path.length === 1 && method === 'GET') return json({ revision: getRevision(ctx.workspaceId) });
  if (resource === 'summary' && path.length === 1 && method === 'GET') {
    const products = rows<Product>(ctx, 'product');
    const orders = rows<Order>(ctx, 'order');
    const invoices = rows<Invoice>(ctx, 'invoice');
    const tasks = rows<Task>(ctx, 'task');
    return json({ customers: rows<Customer>(ctx, 'customer').length, products: products.length, lowStockProducts: products.filter(p => p.stock <= 5).length, openOrders: orders.filter(o => o.status === 'draft').length, fulfilledOrders: orders.filter(o => o.status === 'fulfilled').length, revenueCents: invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + i.totalCents, 0), unpaidCents: invoices.filter(i => i.status === 'draft' || i.status === 'sent').reduce((sum, i) => sum + i.totalCents, 0), openTasks: tasks.filter(t => t.status !== 'done').length, completedTasks: tasks.filter(t => t.status === 'done').length });
  }
  return null;
}

function csvCell(value: unknown): string {
  let result = value == null ? '' : String(value);
  if (typeof value === 'string' && (/^[\t\r]/.test(result) || /^[\s]*[=+\-@]/.test(result))) result = `'${result}`;
  return /[",\r\n]/.test(result) ? `"${result.replace(/"/g, '""')}"` : result;
}

/** Strict RFC4180 state machine, including embedded CRLF, commas and escaped quotes. */
function parseCsv(input: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let ended = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    ended = false;
    if (state === 'quoted') {
      if (character === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else state = 'closed';
      } else field += character;
      continue;
    }
    if (character === ',') { row.push(field); field = ''; state = 'start'; continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && input[index + 1] === '\n') index++;
      row.push(field); records.push(row); row = []; field = ''; state = 'start'; ended = true;
      continue;
    }
    if (state === 'closed') fail(400, 'invalid_csv', 'Unexpected character after a quoted CSV field.');
    if (character === '"') {
      if (state !== 'start') fail(400, 'invalid_csv', 'Quotes must enclose a complete CSV field.');
      state = 'quoted';
    } else { field += character; state = 'plain'; }
  }
  if (state === 'quoted') fail(400, 'invalid_csv', 'CSV contains an unterminated quoted field.');
  if (!ended && (input.length > 0 || row.length || field)) { row.push(field); records.push(row); }
  return records;
}
