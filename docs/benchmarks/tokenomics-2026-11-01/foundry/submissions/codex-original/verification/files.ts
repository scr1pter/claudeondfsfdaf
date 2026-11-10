import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const s = JSON.parse(readFileSync(join(process.env.DATA_DIR!, 'verification-state.json'), 'utf8'));
const base = `http://127.0.0.1:${process.env.PORT}/api/w/${s.w}`;
let checks = 0;
for (const size of [3 * 1024 * 1024 + 1, 8 * 1024 * 1024]) {
  const form = new FormData(); form.set('entityType', 'task'); form.set('entityId', s.taskId); form.set('file', new File([new Uint8Array(size)], 'oversized.txt'));
  const r = await fetch(base + '/attachments', { method: 'POST', headers: { cookie: s.cookie }, body: form }); assert.equal(r.status, 413); const e = await r.json() as any; assert.ok(e.error?.code && e.error?.message); checks += 2;
}
for (const filename of ['../escape.txt', 'bad.txt\r\nInjected: true']) {
  const boundary = 'FoundryOwnedBoundary';
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\ntask\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${s.taskId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\nexact raw bytes\r\n--${boundary}--\r\n`;
  const r = await fetch(base + '/attachments', { method: 'POST', headers: { cookie: s.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: payload });
  if (filename.includes('\r')) { assert.equal(r.status, 400); checks++; }
  else if (r.status === 201) { const a = (await r.json() as any).attachment; assert.equal(a.fileName, basename(a.fileName)); assert.equal(a.fileName.includes('..'), false); const downloaded = await fetch(`${base}/attachments/${a.id}/download`, { headers: { cookie: s.cookie } }); assert.equal(await downloaded.text(), 'exact raw bytes'); assert.equal((await fetch(`${base}/attachments/${a.id}`, { method: 'DELETE', headers: { cookie: s.cookie } })).status, 204); checks += 4; }
  else { assert.equal(r.status, 400); checks++; }
}
console.log(`Additional upload verification passed: ${checks} checks. Oversized bodies return JSON 413; traversal and CR/LF injection rejected or safely normalized.`);
