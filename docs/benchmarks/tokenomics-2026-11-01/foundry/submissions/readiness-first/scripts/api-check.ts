import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const root = process.env.DATA_DIR!;
const artifacts = join(root, 'browser-verification');
const browserState = JSON.parse(readFileSync(join(artifacts, 'state.json'), 'utf8'));
const base = `http://127.0.0.1:${process.env.PORT}`;
const checks: string[] = [];
let assertions = 0;
async function call(path: string, method = 'GET', body?: any, expected = 200, cookie = browserState.cookies) {
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const value = res.status === 204 ? null : res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); assertions++;
  if (expected >= 400) { assert.ok(value.error.code && value.error.message); assertions++; }
  return { value, res };
}
const stage = process.argv[2] || 'before';
if (stage === 'before') {
  await call('/api/health', 'GET', undefined, 200, '');
  const { workspace } = (await call('/api/workspaces', 'POST', { name: 'API verification' }, 201)).value;
  const W = (p: string) => `/api/w/${workspace.id}${p}`;
  const foreignW = browserState.wid;
  const customer = (await call(W('/customers'), 'POST', { name: 'Concurrency Studio', email: 'concurrency@example.invalid' }, 201)).value.customer;
  const product = (await call(W('/products'), 'POST', { sku: 'RACE-01', name: 'Shared stock', priceCents: 12345 }, 201)).value.product;
  const second = (await call(W('/products'), 'POST', { sku: 'RACE-02', name: 'Second line', priceCents: 67 }, 201)).value.product;
  await call(W('/stock-movements'), 'POST', { productId: product.id, delta: 10, reason: 'Opening balance' }, 201);
  const orders = await Promise.all([1, 2].map(() => call(W('/orders'), 'POST', { customerId: customer.id, items: [{ productId: product.id, quantity: 7 }] }, 201)));
  const race = await Promise.all(orders.map((o, i) => fetch(base + W(`/orders/${o.value.order.id}/fulfill`), { method: 'POST', headers: { Cookie: browserState.cookies, 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: `network-race-key-${i}` }) })));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]); assertions++;
  assert.equal((await call(W(`/products/${product.id}`))).value.product.stock, 3); assertions++;
  const order = (await call(W('/orders'), 'POST', { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }, { productId: second.id, quantity: 2 }] }, 201)).value.order;
  const beforeRevision = (await call(W('/sync'))).value.revision;
  const beforeMovements = (await call(W('/stock-movements'))).value.movements.length;
  await call(W(`/orders/${order.id}/fulfill`), 'POST', { idempotencyKey: 'persistent-network-key' }, 409);
  assert.equal((await call(W('/sync'))).value.revision, beforeRevision); assertions++;
  assert.equal((await call(W('/stock-movements'))).value.movements.length, beforeMovements); assertions++;
  assert.equal((await call(W(`/products/${product.id}`))).value.product.stock, 3); assertions++;
  await call(W('/stock-movements'), 'POST', { productId: second.id, delta: 20, reason: 'Second line received' }, 201);
  const sameKey = await Promise.all(Array.from({ length: 12 }, () => call(W(`/orders/${order.id}/fulfill`), 'POST', { idempotencyKey: 'persistent-network-key' })));
  assert.equal(sameKey.filter(r => !r.value.replayed).length, 1); assertions++;
  assert.equal(sameKey.filter(r => r.value.replayed).length, 11); assertions++;
  assert.equal((await call(W('/stock-movements'))).value.movements.filter((m: any) => m.orderId === order.id).length, 2); assertions++;
  assert.equal((await call(W(`/products/${product.id}`))).value.product.stock, 2); assertions++;
  checks.push('Real HTTP: two competing orders return 200/409; twelve concurrent same-key calls apply once; two-line failed fulfillment is atomic and retryable');

  const numbered = await Promise.all(Array.from({ length: 12 }, () => call(W('/orders'), 'POST', { customerId: customer.id, items: [{ productId: second.id, quantity: 1 }] }, 201)));
  assert.equal(new Set(numbered.map(r => r.value.order.number)).size, 12); assertions++;
  const invoice = (await call(W('/invoices'), 'POST', { orderId: order.id }, 201)).value.invoice;
  assert.equal(invoice.totalCents, 12479); assertions++;
  await call(W(`/invoices/${invoice.id}`), 'PATCH', { status: 'sent' }); await call(W(`/invoices/${invoice.id}`), 'PATCH', { status: 'paid' });
  const invoiceNumbers = await Promise.all(numbered.slice(0, 8).map(async r => { await call(W(`/orders/${r.value.order.id}/fulfill`), 'POST', { idempotencyKey: 'number-' + r.value.order.id }); return call(W('/invoices'), 'POST', { orderId: r.value.order.id }, 201); }));
  assert.equal(new Set(invoiceNumbers.map(r => r.value.invoice.number)).size, 8); assertions++;
  checks.push('Concurrent order/invoice numbering is unique; cents-exact paid invoice is 12,479 cents');

  const project = (await call(W('/projects'), 'POST', { name: 'Network delivery' }, 201)).value.project;
  const task = (await call(W(`/projects/${project.id}/tasks`), 'POST', { title: 'Persist this task', priority: 'high', assigneeId: browserState.ownerId, dueDate: '2026-12-01' }, 201)).value.task;
  await call(W(`/tasks/${task.id}/comments`), 'POST', { body: 'A durable network comment.' }, 201);
  const bytes = new Uint8Array([0, 1, 2, 10, 13, 128, 254, 255]);
  const upload = new FormData(); upload.set('file', new File([bytes], 'durable-proof.pdf')); upload.set('entityType', 'task'); upload.set('entityId', task.id);
  const attachment = (await call(W('/attachments'), 'POST', upload, 201)).value.attachment;
  const foreignCustomer = (await call(`/api/w/${foreignW}/customers`)).value.customers[0];
  const foreignProduct = (await call(`/api/w/${foreignW}/products`)).value.products[0];
  const r0 = (await call(W('/sync'))).value.revision;
  await call(W('/orders'), 'POST', { customerId: foreignCustomer.id, items: [{ productId: product.id, quantity: 1 }] }, 404);
  await call(W('/orders'), 'POST', { customerId: customer.id, items: [{ productId: foreignProduct.id, quantity: 1 }] }, 404);
  await call(W(`/tasks/${task.id}`), 'PATCH', { title: 'Do not write', dueDate: '2026-02-30' }, 400);
  assert.equal((await call(W(`/tasks/${task.id}`))).value.task.title, 'Persist this task'); assertions++;
  await call(W(`/products/${product.id}`), 'PATCH', { stock: 99 }, 400);
  await call(W(`/invoices/${invoice.id}`), 'PATCH', { totalCents: 1 }, 400);
  await call(W('/customers'), 'POST', { name: 'Bad ownership', workspaceId: foreignW }, 400);
  const malformed = await fetch(base + W('/customers'), { method: 'POST', headers: { Cookie: browserState.cookies, 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400); assertions++;
  assert.equal((await call(W('/sync'))).value.revision, r0); assertions++;
  // Multipart names are inspected after the runtime parser normalizes them.
  for (const name of ['../escape.txt', 'folder\\escape.txt', 'bad\r\nname.txt']) {
    const form = new FormData(); form.set('file', new File(['safe owned bytes'], name)); form.set('entityType', 'task'); form.set('entityId', task.id);
    const res = await fetch(base + W('/attachments'), { method: 'POST', headers: { Cookie: browserState.cookies }, body: form });
    assert.ok([201, 400].includes(res.status), `Filename ${JSON.stringify(name)} returned ${res.status}: ${[201, 400].includes(res.status) ? '' : await res.text()}`); assertions++;
    if (res.status === 201) { const a = (await res.json()).attachment; assert.ok(!/[\\/\r\n]/.test(a.fileName) && !a.fileName.includes('..')); assertions++; await call(W('/attachments/' + a.id), 'DELETE', undefined, 204); }
  }
  checks.push('HTTP malformed input, protected fields, cross-workspace references and task patches roll back; traversal/injected filenames stay owned');
  const invite = (await call(W('/invites'), 'POST', { email: 'restart-invite@example.invalid', role: 'read_only' }, 201)).value.invite;
  const outsiderEmail = `isolation.${Date.now()}@example.invalid`;
  const outsider = await call('/api/auth/signup', 'POST', { name: 'Synthetic Outsider', email: outsiderEmail, password: 'Another-synthetic-password-2026' }, 201, '');
  const outsiderCookie = outsider.res.headers.get('set-cookie')!.split(';')[0];
  for (const path of ['/customers', '/sync', '/activity', `/attachments/${attachment.id}/download`]) await call(W(path), 'GET', undefined, 404, outsiderCookie);
  const selection = (await call('/api/auth/me', 'GET', undefined, 200, outsiderCookie)).value.activeWorkspaceId;
  await call('/api/workspaces/' + workspace.id + '/select', 'POST', {}, 404, outsiderCookie);
  assert.equal((await call('/api/auth/me', 'GET', undefined, 200, outsiderCookie)).value.activeWorkspaceId, selection); assertions++;
  await call('/api/workspaces/' + browserState.wid + '/select', 'POST', {});
  const state = { workspaceId: workspace.id, orderId: order.id, fulfilledOrder: sameKey[0].value.order, invoiceId: invoice.id, taskId: task.id, attachment, summary: (await call(W('/summary'))).value, revision: (await call(W('/sync'))).value.revision, inviteId: invite.id, inviteToken: invite.token, checks, assertions };
  writeFileSync(join(artifacts, 'api-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, stage, assertions, checks }, null, 2));
} else {
  const saved = JSON.parse(readFileSync(join(artifacts, 'api-state.json'), 'utf8'));
  const W = (p: string) => `/api/w/${saved.workspaceId}${p}`;
  await call('/api/health', 'GET', undefined, 200, '');
  assert.equal((await call('/api/auth/me')).value.activeWorkspaceId, browserState.wid); assertions++;
  assert.deepEqual((await call(W('/summary'))).value, saved.summary); assertions++;
  assert.equal((await call(W('/sync'))).value.revision, saved.revision); assertions++;
  const replay = (await call(W(`/orders/${saved.orderId}/fulfill`), 'POST', { idempotencyKey: 'persistent-network-key' })).value;
  assert.equal(replay.replayed, true); assert.deepEqual(replay.order, saved.fulfilledOrder); assertions += 2;
  assert.equal((await call(W('/sync'))).value.revision, saved.revision); assertions++;
  const download = await fetch(base + W(`/attachments/${saved.attachment.id}/download`), { headers: { Cookie: browserState.cookies } });
  assert.equal(download.status, 200); assert.deepEqual(new Uint8Array(await download.arrayBuffer()), new Uint8Array([0, 1, 2, 10, 13, 128, 254, 255])); assertions += 2;
  assert.equal((await call(W(`/tasks/${saved.taskId}/comments`))).value.comments[0].body, 'A durable network comment.'); assertions++;
  assert.ok((await call(W('/activity?limit=500'))).value.activity.some((a: any) => a.action === 'invoice.paid')); assertions++;
  const invitee = await call('/api/auth/signup', 'POST', { name: 'Restart Invitee', email: 'restart-invite@example.invalid', password: 'Restart-synthetic-password-2026' }, 201, '');
  const cookie = invitee.res.headers.get('set-cookie')!.split(';')[0];
  await call('/api/invites/accept', 'POST', { token: saved.inviteToken }, 200, cookie);
  await call(W('/products'), 'POST', { sku: 'NO', name: 'No', priceCents: 1 }, 403, cookie);
  await call('/api/auth/logout', 'POST', {}, 204, cookie);
  await call('/api/auth/me', 'GET', undefined, 401, cookie);
  const db = new Database(join(root, 'foundry.sqlite'), { readonly: true });
  const users = db.query('SELECT email,password_hash FROM users').all() as { email: string; password_hash: string }[];
  assert.ok(users.every(u => u.email.endsWith('example.invalid') && u.password_hash.startsWith('$argon2id$'))); assertions++;
  assert.equal((db.query('PRAGMA integrity_check').get() as any).integrity_check, 'ok'); assertions++;
  db.close();
  checks.push('Full server restart preserves browser session, workspace selection, analytics, paid invoices, task comments, exact attachment bytes and idempotency without new revision');
  checks.push('Pre-restart invitation can be accepted after restart; read-only enforcement and server-side logout revocation pass');
  checks.push(`Independent SQLite inspection: ${users.length} synthetic accounts, salted Argon2id hashes and integrity_check=ok`);
  console.log(JSON.stringify({ ok: true, stage, assertions, checks }, null, 2));
}
