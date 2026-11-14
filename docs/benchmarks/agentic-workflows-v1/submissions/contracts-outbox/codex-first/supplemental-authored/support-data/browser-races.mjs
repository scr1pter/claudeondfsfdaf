import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const log=join(process.env.DATA_DIR,'browser-races.jsonl');
writeFileSync(log,'');
let snapshot;
function run(action) {
 const output=execFileSync(process.env.NODE_EXE,[process.env.BROWSER_DRIVER_CLIENT,'--endpoint',process.env.BROWSER_DRIVER_ENDPOINT,JSON.stringify(action)],{encoding:'utf8'});
 const result=JSON.parse(output); appendFileSync(log,JSON.stringify({action,result})+'\n'); assert.equal(result.ok,true,result.error); snapshot=result.snapshot; return result;
}
function click(name) { const c=snapshot.controls.find(c=>c.name===name); assert.ok(c,'Missing '+name); run({action:'click',ref:c.ref}); }
function type(text) { run({action:'type',ref:snapshot.controls.find(c=>c.name==='Reply').ref,text}); }
function until(ready) { const deadline=Date.now()+10000; do { run({action:'observe'}); if(ready(snapshot)) return; } while(Date.now()<deadline); throw new Error('Browser timeout: '+snapshot.text); }
const origin='http://127.0.0.1:'+process.env.PORT;
const health=await fetch(origin+'/api/health').then(r=>r.json());
async function control(path,body) { const r=await fetch(health.providerOrigin+'/control/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); assert.ok(r.ok); return r.json(); }
async function get(id) { return (await fetch(origin+'/api/messages/'+id).then(r=>r.json())).message; }
async function held(id) { const deadline=Date.now()+10000; do { const state=await control('state'); if(state.held.some(h=>h.messageId===id)) return; await new Promise(r=>setTimeout(r,15)); } while(Date.now()<deadline); throw new Error('Provider did not hold'); }
async function create(body) { type(body); click('Save draft'); until(s=>s.text.includes(body)&&s.controls.find(c=>c.name==='Reply').value===''); return snapshot.controls.filter(c=>c.name.startsWith('Queue ')).at(-1).name.slice(6); }
run({action:'open',url:origin}); until(s=>s.headings.includes('Replacement cable'));
click('Delivery window'); until(s=>s.headings.includes('Delivery window'));
const retryId=await create('Synthetic browser retry verification');
await control('plan',{messageId:retryId,mode:'fail_once'});
click('Queue '+retryId); until(s=>s.text.includes('Status: queued'));
click('Process queue'); until(s=>s.text.includes('Status: retryable'));
const failed=await get(retryId); assert.equal(failed.delivery.attempts,1);
click('Details '+retryId); until(s=>s.text.includes('Attempt count\n1'));
assert.ok(snapshot.text.includes(failed.delivery.lastError));
click('Retry '+retryId); until(s=>s.text.includes('Status: queued'));
click('Process queue'); until(s=>s.text.includes('Status: delivered')&&!s.controls.find(c=>c.name==='Process queue').disabled);
const retried=await get(retryId); assert.equal(retried.delivery.attempts,2); assert.ok(snapshot.text.includes(retried.delivery.receiptId));
const lateId=await create('Synthetic browser cancellation after acceptance');
await control('plan',{messageId:lateId,mode:'after_accept'});
click('Queue '+lateId); until(s=>s.controls.some(c=>c.name==='Cancel '+lateId)&&!s.controls.some(c=>c.name==='Queue '+lateId));
click('Process queue'); await held(lateId);
click('Refresh'); until(s=>s.text.includes('Status: sending'));
click('Cancel '+lateId); until(s=>s.text.includes('Cancellation was too late. Delivery is confirmed.'));
const late=await get(lateId); assert.equal(late.status,'delivered'); assert.equal(late.delivery.cancelRequested,true); assert.ok(late.delivery.lastError);
await control('release',{messageId:lateId,response:'lost'});
until(s=>!s.controls.find(c=>c.name==='Process queue').disabled);
click('Details '+lateId); until(s=>s.text.includes(late.delivery.lastError));
assert.ok(snapshot.text.includes(late.delivery.receiptId));
click('Refresh'); until(s=>s.text.includes(late.delivery.lastError));
run({action:'console'});
writeFileSync(join(process.env.DATA_DIR,'browser-restart-state.json'),JSON.stringify({retryId,retried,lateId,late}));
console.log(JSON.stringify({ok:true,retryId,lateId,errorVerbatim:late.delivery.lastError,viewport:390},null,2));
