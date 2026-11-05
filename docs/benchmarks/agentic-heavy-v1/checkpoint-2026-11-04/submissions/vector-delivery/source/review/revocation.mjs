// Focused independent HTTP review: stalled request bodies must not retain revoked rights.
// No product imports; only synthetic local records. Run with NODE_EXE.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const origin = `http://127.0.0.1:${process.env.PORT || 4123}`;
const dir = join(process.env.DATA_DIR, 'review-evidence');
mkdirSync(dir, {recursive: true});
const suffix = Date.now();
async function request(cookie, path, method = 'GET', data) {
  const response = await fetch(origin + path, {method, headers: {cookie, 'content-type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const text = await response.text();
  return {status: response.status, value: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0]};
}
async function signup(kind) {
  const result = await request('', '/api/auth/signup', 'POST', {name: `Judge ${kind} ${suffix}`, email: `judge-${kind}-${suffix}@example.invalid`, password: 'Synthetic-Judge-2026!'});
  if (result.status !== 201) throw new Error(`Signup failed: ${result.status}`);
  return {...result.value, cookie: result.cookie};
}
const owner = await signup('owner');
const w = `/api/w/${owner.workspace.id}`;
const results = [];
async function member(role, n) {
  const account = await signup(`writer-${n}`);
  const invite = await request(owner.cookie, w + '/invites', 'POST', {email: account.user.email, role});
  if (invite.status !== 201) throw new Error('Invite failed');
  const accepted = await request(account.cookie, '/api/invites/accept', 'POST', {token: invite.value.invite.token});
  if (accepted.status !== 200) throw new Error('Join failed');
  return account;
}
// Send headers and an incomplete body, ensuring auth can run before the body resolves.
async function stalled(cookie, path, payload, contentType = 'application/json') {
  let send;
  const bytes = Buffer.from(payload);
  const done = new Promise((resolve, reject) => {
    const req = http.request(origin + path, {method: 'POST', headers: {cookie, 'content-type': contentType, 'content-length': bytes.length}}, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.on('end', () => resolve({status: response.statusCode, value: text ? JSON.parse(text) : null}));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Stalled review request timed out')));
    req.on('error', reject);
    req.flushHeaders(); req.write(bytes.subarray(0, Math.min(20, bytes.length - 1)));
    send = () => req.end(bytes.subarray(Math.min(20, bytes.length - 1)));
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  return {finish: async () => {send(); return done;}};
}
for (const [n, role, change, resource, expected] of [
  [1, 'manager', 'member', 'products', 403],
  [2, 'member', 'read_only', 'customers', 403],
  [3, 'member', 'remove', 'customers', 404],
  [4, 'member', 'logout', 'customers', 401],
]) {
  const account = await member(role, n);
  const name = `Must not commit ${change} ${suffix}`;
  const payload = resource === 'products' ? {sku: 'REVOKED', name, priceCents: 100} : {name};
  const pending = await stalled(account.cookie, w + '/' + resource, JSON.stringify(payload));
  const changed = change === 'logout'
    ? await request(account.cookie, '/api/auth/logout', 'POST')
    : await request(owner.cookie, w + '/members/' + account.user.id, change === 'remove' ? 'DELETE' : 'PATCH', change === 'remove' ? undefined : {role: change});
  if (![200, 204].includes(changed.status)) throw new Error(`Rights change failed ${changed.status}`);
  const before = await request(owner.cookie, w + '/sync');
  const response = await pending.finish();
  const after = await request(owner.cookie, w + '/sync');
  const listed = await request(owner.cookie, w + '/' + resource);
  const committed = listed.value[resource].some(row => row.name === name);
  results.push({case: `${role} -> ${change}: stalled ${resource} create`, expected, actual: response.status, committed, revisionDelta: after.value.revision - before.value.revision, passed: response.status === expected && !committed && after.value.revision === before.value.revision});
}
const account = await member('member', 5);
const customer = await request(owner.cookie, w + '/customers', 'POST', {name: 'Judge attachment parent'});
const boundary = `judge-boundary-${suffix}`;
const payload = `--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\ncustomer\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${customer.value.customer.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="judge-revoked.txt"\r\nContent-Type: text/plain\r\n\r\nsynthetic local attachment\r\n--${boundary}--\r\n`;
const pending = await stalled(account.cookie, w + '/attachments', payload, `multipart/form-data; boundary=${boundary}`);
const removed = await request(owner.cookie, w + '/members/' + account.user.id, 'DELETE');
if (removed.status !== 204) throw new Error('Removal failed');
const before = await request(owner.cookie, w + '/sync');
const response = await pending.finish();
const after = await request(owner.cookie, w + '/sync');
const files = await request(owner.cookie, w + '/attachments?entityType=customer&entityId=' + customer.value.customer.id);
results.push({case: 'member -> removed: stalled multipart attachment', expected: 404, actual: response.status, committed: files.value.attachments.length > 0, revisionDelta: after.value.revision - before.value.revision, passed: response.status === 404 && files.value.attachments.length === 0 && before.value.revision === after.value.revision});
const evidence = {origin, at: new Date().toISOString(), workspaceId: owner.workspace.id, results, passed: results.every(row => row.passed)};
writeFileSync(join(dir, 'revocation-results.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
