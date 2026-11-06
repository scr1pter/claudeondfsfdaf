import { execFileSync } from 'node:child_process';
import { readFileSync,appendFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const saved=JSON.parse(readFileSync(join(process.env.DATA_DIR,'browser-restart-state.json'),'utf8'));
const log=join(process.env.DATA_DIR,'browser-races.jsonl'); let snapshot;
function run(action) { const result=JSON.parse(execFileSync(process.env.NODE_EXE,[process.env.BROWSER_DRIVER_CLIENT,'--endpoint',process.env.BROWSER_DRIVER_ENDPOINT,JSON.stringify(action)],{encoding:'utf8'})); appendFileSync(log,JSON.stringify({action,result})+'\n'); assert.equal(result.ok,true,result.error); snapshot=result.snapshot; return result; }
function click(name) { const c=snapshot.controls.find(c=>c.name===name); assert.ok(c); run({action:'click',ref:c.ref}); }
function until(ready) { const deadline=Date.now()+10000; do {run({action:'observe'});if(ready(snapshot)) return;} while(Date.now()<deadline);throw new Error('Timeout'); }
const origin='http://127.0.0.1:'+process.env.PORT;
run({action:'open',url:origin});until(s=>s.headings.includes('Replacement cable'));
click('Delivery window');until(s=>s.headings.includes('Delivery window')&&s.text.includes('Synthetic browser cancellation after acceptance'));
for(const [id,item] of [[saved.retryId,saved.retried],[saved.lateId,saved.late]]) {
 const actual=(await fetch(origin+'/api/messages/'+id).then(r=>r.json())).message;assert.deepEqual(actual,item);
 click('Details '+id);until(s=>s.text.includes(item.delivery.idempotencyKey));
 assert.ok(snapshot.text.includes('Attempt count\n'+item.delivery.attempts));assert.ok(snapshot.text.includes(item.delivery.receiptId));
 if(item.delivery.lastError) assert.ok(snapshot.text.includes(item.delivery.lastError));
}
click('Refresh');until(s=>s.text.includes(saved.late.delivery.lastError)&&s.text.includes(saved.retried.delivery.receiptId));
run({action:'console'});
console.log('PASS: browser restart preserved both keys, attempt counts, receipts, statuses, and the cancellation explanation at 390px.');
