import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const state = JSON.parse(readFileSync(join(process.env.DATA_DIR!, 'verification-state.json'), 'utf8'));
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api`;
let checks = 0;
async function call(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch(base + path, { method, headers: { cookie: state.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(r.status, status, `${method} ${path}`); checks++; return r.status === 204 ? null : r.json();
}
const w = `/w/${state.w}`;
assert.equal((await call('/auth/me')).activeWorkspaceId, state.w); checks++;
assert.deepEqual(await call(w + '/summary'), state.summary); checks++;
assert.equal((await call(w + '/sync')).revision, state.revision); checks++;
assert.equal((await call(w + `/invoices/${state.invoiceId}`)).invoice.status, 'paid'); checks++;
assert.equal((await call(w + `/tasks/${state.taskId}`)).task.title, 'Prepare launch'); checks++;
assert.ok((await call(w + '/members')).members.some((x: any) => x.role === 'read_only')); checks++;
const activity = await call(w + '/activity'); const productBefore = await call(w + '/products');
const replay = await call(w + `/orders/${state.orderId}/fulfill`, 'POST', { idempotencyKey: state.key }); assert.equal(replay.replayed, true); checks++;
assert.deepEqual(await call(w + '/products'), productBefore); assert.deepEqual(await call(w + '/activity'), activity); checks += 2;
const file = await fetch(base + w + `/attachments/${state.attachmentId}/download`, { headers: { cookie: state.cookie } }); assert.equal(file.status, 200); assert.equal(await file.text(), '# Durable local file'); checks += 2;
assert.ok(existsSync(join(process.env.DATA_DIR!, 'attachments', state.attachmentId))); checks++;
// Verify strict input preservation and entity cascade behavior after the restart.
const project = (await call(w + '/projects', 'POST', { name: 'Cascade verification' }, 201)).project;
const task = (await call(w + `/projects/${project.id}/tasks`, 'POST', { title: 'Cascade task' }, 201)).task;
await call(w + `/tasks/${task.id}/comments`, 'POST', { body: 'Owned comment' }, 201);
const form = new FormData(); form.set('file', new File(['cascade bytes'], 'cascade.txt')); form.set('entityType', 'task'); form.set('entityId', task.id);
const upload = await fetch(base + w + '/attachments', { method: 'POST', headers: { cookie: state.cookie }, body: form }); assert.equal(upload.status, 201); const attachment = (await upload.json() as any).attachment; checks++;
await call(w + `/projects/${project.id}`, 'DELETE', undefined, 204);
await call(w + `/tasks/${task.id}`, 'GET', undefined, 404); await call(w + `/attachments/${attachment.id}/download`, 'GET', undefined, 404); assert.equal(existsSync(join(process.env.DATA_DIR!, 'attachments', attachment.id)), false); checks++;
const customer = (await call(w + '/customers', 'POST', { name: 'Preserved whitespace', notes: '\t=SUM(1,2)\nnext line' }, 201)).customer;
assert.equal(customer.notes, '\t=SUM(1,2)\nnext line'); checks++;
await call(w + `/customers/${customer.id}`, 'PATCH', { notes: null }, 400);
await call(w + '/import/customers', 'POST', { csv: '"name,email,company,notes"\nAda,ada-odd@example.invalid,,' }, 400);
const exported = await fetch(base + w + '/export.csv?type=customers', { headers: { cookie: state.cookie } }); assert.ok((await exported.text()).includes('"\'\t=SUM(1,2)\nnext line"')); checks++;
await call(w + `/customers/${customer.id}`, 'DELETE', undefined, 204);
console.log(`Restart and edge verification passed: ${checks} checks. Sessions, selection, data, memberships, analytics, idempotency and files survived process restart; cascade cleanup and whitespace-safe CSV checked.`);
