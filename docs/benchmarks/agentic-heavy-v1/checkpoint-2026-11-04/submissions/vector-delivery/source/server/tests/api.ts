import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic integration checks against the actual shared HTTP handler. Runtime
// artifacts are isolated underneath the external DATA_DIR, never in this tree.
const originalDir = process.env.DATA_DIR;
const runtimeRoot = resolve(originalDir || '../.foundry-data');
assert(existsSync(runtimeRoot), 'Create the external DATA_DIR parent before running this check.');
const testDir = mkdtempSync(join(runtimeRoot, 'backend-check-'));
process.env.DATA_DIR = testDir;
const { handleRequest } = await import('../index.ts');
const { db } = await import('../core/index.ts');
let checks = 0;
function equal(actual: unknown, expected: unknown): void { assert.deepEqual(actual, expected); checks++; }
function okay(value: unknown): asserts value { assert(value); checks++; }
type Payload = Record<string, any>;
type Reply = { response: Response; data: Payload };
async function call(method: string, path: string, input?: unknown, cookie?: string, expected = 200): Promise<Reply> {
  const headers = new Headers(cookie ? { cookie } : undefined);
  if (input !== undefined) headers.set('Content-Type', 'application/json');
  const response = await handleRequest(new Request(`http://127.0.0.1${path}`, {
    method, headers, body: input === undefined ? undefined : JSON.stringify(input),
  }));
  equal(response.status, expected);
  const data: Payload = response.status === 204 ? {} : await response.json();
  if (expected >= 400) { okay(data.error?.code); okay(data.error?.message); }
  return { response, data };
}
const password = 'Synthetic-Backend-Password-2026';

try {
  equal((await call('GET', '/api/health')).data, { ok: true });
  await call('GET', '/api/not-a-route', undefined, undefined, 404);
  await call('GET', '/api/auth/me', undefined, undefined, 401);
  const invalid = await handleRequest(new Request('http://127.0.0.1/api/auth/signup', { method: 'POST', body: '{broken' }));
  equal(invalid.status, 400);
  const owner = await call('POST', '/api/auth/signup', { name: 'Backend Synthetic', email: 'backend@example.invalid', password }, undefined, 201);
  const cookie = owner.response.headers.get('set-cookie')!.split(';')[0];
  const ownerId = owner.data.user.id as string;
  const workspaceId = owner.data.workspace.id as string;
  const w = `/api/w/${workspaceId}`;
  okay(cookie.split('=')[1].length >= 32);
  okay(owner.response.headers.get('set-cookie')!.includes('HttpOnly; SameSite=Lax; Path=/'));
  equal((await call('GET', '/api/auth/me', undefined, cookie)).data.activeWorkspaceId, workspaceId);
  await call('POST', '/api/auth/signup', { name: 'Duplicate', email: 'BACKEND@example.invalid', password }, undefined, 409);
  const hash = db.query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?').get(ownerId)!.password_hash;
  okay(hash.startsWith('$argon2id$'));
  okay(await Bun.password.verify(password, hash));

  const customer = (await call('POST', `${w}/customers`, { name: 'Synthetic Buyer', email: 'buyer@example.invalid', company: 'Synthetic Works' }, cookie, 201)).data.customer;
  await call('POST', `${w}/customers`, { name: 'Duplicate', email: 'BUYER@example.invalid' }, cookie, 409);
  await call('POST', `${w}/customers`, { name: '   ' }, cookie, 400);
  equal((await call('GET', `${w}/customers?q=SYNTHETIC`, undefined, cookie)).data.customers.length, 1);
  const product = (await call('POST', `${w}/products`, { sku: 'syn-a', name: 'Synthetic Part', priceCents: 1999 }, cookie, 201)).data.product;
  const second = (await call('POST', `${w}/products`, { sku: 'syn-b', name: 'Synthetic Fitting', priceCents: 101 }, cookie, 201)).data.product;
  equal(product.sku, 'SYN-A'); equal(product.stock, 0);
  await call('PATCH', `${w}/products/${product.id}`, { stock: 100 }, cookie, 400);
  await call('POST', `${w}/products`, { sku: 'bad', name: 'Bad', priceCents: 1.5 }, cookie, 400);
  await call('POST', `${w}/stock-movements`, { productId: product.id, delta: 10, reason: 'Synthetic receipt' }, cookie, 201);
  await call('POST', `${w}/stock-movements`, { productId: product.id, delta: -11, reason: 'Invalid' }, cookie, 409);
  await call('POST', `${w}/stock-movements`, { productId: product.id, delta: 0, reason: 'Invalid' }, cookie, 400);
  const order = (await call('POST', `${w}/orders`, { customerId: customer.id, items: [{ productId: product.id, quantity: 2 }, { productId: second.id, quantity: 3 }] }, cookie, 201)).data.order;
  equal(order.totalCents, 4301);
  await call('PATCH', `${w}/products/${product.id}`, { name: 'Changed catalog', priceCents: 9999 }, cookie);
  equal((await call('GET', `${w}/orders/${order.id}`, undefined, cookie)).data.order.items[0].unitPriceCents, 1999);
  const revision = (await call('GET', `${w}/sync`, undefined, cookie)).data.revision;
  await call('POST', `${w}/orders/${order.id}/fulfill`, { idempotencyKey: 'retry-key-0001' }, cookie, 409);
  equal((await call('GET', `${w}/sync`, undefined, cookie)).data.revision, revision);
  equal((await call('GET', `${w}/products/${product.id}`, undefined, cookie)).data.product.stock, 10);
  equal((await call('GET', `${w}/orders/${order.id}`, undefined, cookie)).data.order.status, 'draft');
  await call('POST', `${w}/stock-movements`, { productId: second.id, delta: 3, reason: 'Synthetic receipt' }, cookie, 201);
  const fulfilled = await call('POST', `${w}/orders/${order.id}/fulfill`, { idempotencyKey: 'retry-key-0001' }, cookie);
  equal(fulfilled.data.replayed, false);
  const fulfilledRevision = (await call('GET', `${w}/sync`, undefined, cookie)).data.revision;
  const replayed = await call('POST', `${w}/orders/${order.id}/fulfill`, { idempotencyKey: 'retry-key-0001' }, cookie);
  equal(replayed.data.order, fulfilled.data.order); equal(replayed.data.replayed, true);
  equal((await call('GET', `${w}/sync`, undefined, cookie)).data.revision, fulfilledRevision);
  await call('POST', `${w}/orders/${order.id}/fulfill`, { idempotencyKey: 'different-key' }, cookie, 409);
  await call('POST', `${w}/orders/${order.id}/cancel`, {}, cookie, 409);
  await call('DELETE', `${w}/customers/${customer.id}`, undefined, cookie, 409);
  const movements = (await call('GET', `${w}/stock-movements?productId=${product.id}`, undefined, cookie)).data.movements;
  equal(movements.filter((m: Payload) => m.kind === 'fulfillment').length, 1);
  equal(movements[1].createdBy, ownerId);
  await call('DELETE', `${w}/stock-movements/${movements[0].id}`, undefined, cookie, 404);

  const invoice = (await call('POST', `${w}/invoices`, { orderId: order.id }, cookie, 201)).data.invoice;
  equal(invoice.totalCents, 4301); equal(invoice.status, 'draft'); equal(invoice.paidAt, null);
  await call('POST', `${w}/invoices`, { orderId: order.id }, cookie, 409);
  await call('PATCH', `${w}/customers/${customer.id}`, { name: 'New customer name' }, cookie);
  equal((await call('GET', `${w}/invoices/${invoice.id}`, undefined, cookie)).data.invoice.billTo.name, 'Synthetic Buyer');
  await call('PATCH', `${w}/invoices/${invoice.id}`, { status: 'paid' }, cookie, 409);
  await call('PATCH', `${w}/invoices/${invoice.id}`, { totalCents: 1 }, cookie, 400);
  await call('PATCH', `${w}/invoices/${invoice.id}`, { status: 'sent' }, cookie);
  const paid = (await call('PATCH', `${w}/invoices/${invoice.id}`, { status: 'paid' }, cookie)).data.invoice;
  okay(paid.paidAt);
  equal((await call('GET', `${w}/summary`, undefined, cookie)).data.revenueCents, 4301);
  await call('PATCH', `${w}/invoices/${invoice.id}`, { status: 'void' }, cookie, 409);

  // Actual competing asynchronous handler calls must still serialize stock writes.
  const competing = await Promise.all([1, 2].map(async () => (await call('POST', `${w}/orders`, { customerId: customer.id, items: [{ productId: product.id, quantity: 5 }] }, cookie, 201)).data.order));
  const results = await Promise.all(competing.map(async (value: Payload, index: number) => {
    return handleRequest(new Request(`http://127.0.0.1${w}/orders/${value.id}/fulfill`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: `concurrent-${index}` }) }));
  }));
  equal(results.map(r => r.status).sort(), [200, 409]);
  equal((await call('GET', `${w}/products/${product.id}`, undefined, cookie)).data.product.stock, 3);
  const sameOrder = (await call('POST', `${w}/orders`, { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }, cookie, 201)).data.order;
  const sameResults = await Promise.all([1, 2].map(() => call('POST', `${w}/orders/${sameOrder.id}/fulfill`, { idempotencyKey: 'same-concurrent-key' }, cookie)));
  equal(sameResults.map(r => r.data.replayed).sort(), [false, true]);
  equal((await call('GET', `${w}/products/${product.id}`, undefined, cookie)).data.product.stock, 2);

  const outsider = await call('POST', '/api/auth/signup', { name: 'Other Synthetic', email: 'other@example.invalid', password }, undefined, 201);
  const otherCookie = outsider.response.headers.get('set-cookie')!.split(';')[0];
  const otherW = `/api/w/${outsider.data.workspace.id}`;
  await call('GET', `${w}/sync`, undefined, otherCookie, 404);
  await call('GET', `${w}/activity`, undefined, otherCookie, 404);
  const foreign = (await call('POST', `${otherW}/customers`, { name: 'Foreign', email: 'buyer@example.invalid' }, otherCookie, 201)).data.customer;
  const beforeForeign = (await call('GET', `${w}/orders`, undefined, cookie)).data.orders.length;
  await call('POST', `${w}/orders`, { customerId: foreign.id, items: [{ productId: product.id, quantity: 1 }] }, cookie, 404);
  equal((await call('GET', `${w}/orders`, undefined, cookie)).data.orders.length, beforeForeign);

  const project = (await call('POST', `${w}/projects`, { name: 'Synthetic Delivery' }, cookie, 201)).data.project;
  const task = (await call('POST', `${w}/projects/${project.id}/tasks`, { title: 'Synthetic task', description: 'Unique search phrase', priority: 'high', assigneeId: ownerId, dueDate: '2028-02-29' }, cookie, 201)).data.task;
  equal(task.status, 'todo');
  await call('PATCH', `${w}/tasks/${task.id}`, { title: 'Should not change', dueDate: '2026-02-29' }, cookie, 400);
  equal((await call('GET', `${w}/tasks/${task.id}`, undefined, cookie)).data.task.title, 'Synthetic task');
  await call('PATCH', `${w}/tasks/${task.id}`, { assigneeId: outsider.data.user.id }, cookie, 404);
  equal((await call('GET', `${w}/tasks?q=UNIQUE&status=todo&priority=high&assigneeId=${ownerId}&projectId=${project.id}`, undefined, cookie)).data.tasks.length, 1);
  const comment = (await call('POST', `${w}/tasks/${task.id}/comments`, { body: '<script>synthetic text</script>' }, cookie, 201)).data.comment;
  equal(comment.author.id, ownerId);
  equal((await call('GET', `${w}/tasks/${task.id}/comments`, undefined, cookie)).data.comments[0].body, '<script>synthetic text</script>');

  const csv = 'name,email,company,notes\r\n"CSV, Synthetic",csv@example.invalid,"Quoted ""company""","Line one\r\nLine two"\r\n=SUM(A1),formula@example.invalid,,@note\r\n';
  equal((await call('POST', `${w}/import/customers`, { csv }, cookie, 201)).data.imported, 2);
  const count = (await call('GET', `${w}/customers`, undefined, cookie)).data.customers.length;
  await call('POST', `${w}/import/customers`, { csv: 'name,email,company,notes\nFirst,new@example.invalid,,\nSecond,CSV@example.invalid,,' }, cookie, 409);
  await call('POST', `${w}/import/customers`, { csv: 'name,email,company,notes\nValid,new@example.invalid,,\n   ,bad@example.invalid,,' }, cookie, 400);
  equal((await call('GET', `${w}/customers`, undefined, cookie)).data.customers.length, count);
  const exported = await handleRequest(new Request(`http://127.0.0.1${w}/export.csv?type=customers`, { headers: { cookie } }));
  equal(exported.status, 200);
  okay(exported.headers.get('content-type')!.startsWith('text/csv'));
  const csvOutput = await exported.text();
  okay(csvOutput.includes('"CSV, Synthetic"')); okay(csvOutput.includes('"Quoted ""company"""')); okay(csvOutput.includes("'=SUM(A1)"));

  async function upload(file: File, parentId = task.id, expected = 201): Promise<Payload> {
    const form = new FormData(); form.set('file', file); form.set('entityType', 'task'); form.set('entityId', parentId);
    const response = await handleRequest(new Request(`http://127.0.0.1${w}/attachments`, { method: 'POST', headers: { cookie }, body: form }));
    equal(response.status, expected); return await response.json();
  }
  const bytes = new Uint8Array([0, 10, 13, 128, 255]);
  const attachment = (await upload(new File([bytes], 'synthetic.txt'))).attachment;
  const downloadUrl = `http://127.0.0.1${w}/attachments/${attachment.id}/download`;
  const download = await handleRequest(new Request(downloadUrl, { headers: { cookie } }));
  equal(download.status, 200); equal(new Uint8Array(await download.arrayBuffer()), bytes);
  equal((await handleRequest(new Request(downloadUrl, { headers: { cookie: otherCookie } }))).status, 404);
  await upload(new File(['x'], 'bad.html'), task.id, 415);
  await upload(new File([new Uint8Array(2 * 1048576 + 1)], 'too-big.txt'), task.id, 413);
  await upload(new File(['x'], 'safe.txt'), 'foreign-task', 404);

  const invite = (await call('POST', `${w}/invites`, { email: 'other@example.invalid', role: 'member' }, cookie, 201)).data.invite;
  await call('POST', '/api/invites/accept', { token: invite.token }, cookie, 404);
  await call('POST', '/api/invites/accept', { token: invite.token }, otherCookie);
  await call('POST', '/api/invites/accept', { token: invite.token }, otherCookie, 409);
  await call('POST', `${w}/products`, { sku: 'MEMBER', name: 'Forbidden', priceCents: 0 }, otherCookie, 403);
  await call('DELETE', `${w}/comments/${comment.id}`, undefined, otherCookie, 403);
  await call('DELETE', `${w}/attachments/${attachment.id}`, undefined, otherCookie, 403);
  await call('PATCH', `${w}/members/${outsider.data.user.id}`, { role: 'read_only' }, cookie);
  await call('POST', `${w}/customers`, { name: 'Forbidden' }, otherCookie, 403);
  await call('PATCH', `${w}/members/${ownerId}`, { role: 'manager' }, cookie, 409);
  await call('PATCH', `${w}/members/${outsider.data.user.id}`, { role: 'owner' }, cookie, 400);
  const activity = (await call('GET', `${w}/activity?limit=500`, undefined, cookie)).data.activity as Payload[];
  for (const action of ['customer.created', 'stock.adjusted', 'order.fulfilled', 'invoice.paid', 'task.created', 'comment.created', 'attachment.created']) okay(activity.some(row => row.action === action));
  okay(!JSON.stringify(activity).includes(invite.token));

  // Reopen the real index/core in a separate process: session, exact replay and
  // opaque attachment bytes must remain accessible from durable storage.
  const entryUrl = pathToFileURL(resolve(import.meta.dir, '../index.ts')).href;
  const restart = Bun.spawnSync([process.execPath, '--eval', `
    const {handleRequest} = await import(${JSON.stringify(entryUrl)});
    const cookie = process.env.CHECK_COOKIE;
    const w = process.env.CHECK_W;
    const request = (path, method='GET', body) => handleRequest(new Request('http://127.0.0.1'+path, {method, headers:{cookie,'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined}));
    const me = await request('/api/auth/me'); if(me.status!==200) throw Error('Persisted session');
    const replay = await request(w+'/orders/'+process.env.CHECK_ORDER+'/fulfill','POST',{idempotencyKey:'retry-key-0001'});
    const data = await replay.json(); if(replay.status!==200||!data.replayed||data.order.totalCents!==4301) throw Error('Persisted replay');
    const summary = await (await request(w+'/summary')).json(); if(summary.revenueCents!==4301) throw Error('Persisted summary');
    const attachment = await request(w+'/attachments/'+process.env.CHECK_ATTACHMENT+'/download');
    const bytes = new Uint8Array(await attachment.arrayBuffer()); if(attachment.status!==200||bytes.length!==5||bytes[4]!==255) throw Error('Persisted file');
    const {db} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../core/index.ts')).href)}); db.close();
  `], { env: { ...process.env, CHECK_COOKIE: cookie, CHECK_W: w, CHECK_ORDER: order.id, CHECK_ATTACHMENT: attachment.id } });
  equal(restart.stderr.toString(), ''); equal(restart.exitCode, 0);
  await call('DELETE', `${w}/projects/${project.id}`, undefined, cookie, 204);
  await call('GET', `${w}/tasks/${task.id}`, undefined, cookie, 404);
  equal((await handleRequest(new Request(downloadUrl, { headers: { cookie } }))).status, 404);
  await call('DELETE', `${w}/members/${outsider.data.user.id}`, undefined, cookie, 204);
  await call('GET', `${w}/customers`, undefined, otherCookie, 404);
  const logout = await call('POST', '/api/auth/logout', undefined, cookie, 204);
  equal(await logout.response.text(), '');
  await call('GET', '/api/auth/me', undefined, cookie, 401);
  console.info(`Backend integration: ${checks} checks passed, including durable restart.`);
} finally {
  db.close();
  Bun.gc(true);
  rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (originalDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDir;
}
