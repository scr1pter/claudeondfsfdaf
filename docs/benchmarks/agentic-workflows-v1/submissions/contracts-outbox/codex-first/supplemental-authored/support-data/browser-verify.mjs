import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const log = join(process.env.DATA_DIR, 'browser-verification.jsonl');
writeFileSync(log, '');
let snapshot;
function run(action) {
  const output = execFileSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, '--endpoint', process.env.BROWSER_DRIVER_ENDPOINT, JSON.stringify(action)], {encoding:'utf8'});
  const result = JSON.parse(output);
  appendFileSync(log, JSON.stringify({action,result})+'\n');
  assert.equal(result.ok, true, result.error);
  snapshot = result.snapshot;
  return result;
}
function click(name) {
  const target = snapshot.controls.find(control => control.name === name);
  assert.ok(target, 'Missing control: '+name);
  run({action:'click',ref:target.ref});
}
function type(text) {
  const target = snapshot.controls.find(control => control.name === 'Reply');
  run({action:'type',ref:target.ref,text});
}
function until(predicate) {
  const deadline = Date.now()+10000;
  do { run({action:'observe'}); if(predicate(snapshot)) return; } while(Date.now()<deadline);
  throw new Error('Browser condition timed out: '+snapshot.text);
}
run({action:'open',url:'http://127.0.0.1:'+process.env.PORT});
until(s=>s.headings.includes('Replacement cable'));
type('   \n   ');
click('Save draft');
until(s=>s.text.includes('Reply must contain 1–2000 Unicode characters and cannot be blank'));
assert.equal(snapshot.controls.find(c=>c.name==='Reply').value,'   \n   ');
type('  Synthetic reply with spaces\nand a second line.  ');
click('Save draft');
until(s=>s.text.includes('Synthetic reply with spaces'));
const drafts=snapshot.controls.filter(c=>c.name.startsWith('Edit '));
const id=drafts.at(-1).name.slice(5);
click('Edit '+id);
until(s=>s.controls.find(c=>c.name==='Reply').value.includes('Synthetic reply with spaces'));
type('Edited synthetic browser reply');
click('Save draft');
until(s=>s.text.includes('Edited synthetic browser reply') && s.controls.find(c=>c.name==='Reply').value==='');
click('Queue '+id);
until(s=>s.text.includes('Status: queued'));
click('Details '+id);
until(s=>s.text.includes('Provider key'));
assert.ok(snapshot.text.includes('Attempt count\n0'));
click('Process queue');
until(s=>s.text.includes('Status: delivered'));
assert.ok(snapshot.text.includes('Provider receipt'));
click('Invoice copy');
until(s=>s.headings.includes('Invoice copy'));
type('Synthetic cancellation before transmission');
click('Save draft');
until(s=>s.text.includes('Synthetic cancellation before transmission'));
const cancelId=snapshot.controls.find(c=>c.name.startsWith('Queue ')).name.slice(6);
click('Queue '+cancelId);
until(s=>s.text.includes('Status: queued'));
click('Cancel '+cancelId);
until(s=>s.text.includes('Status: cancelled'));
assert.ok(snapshot.text.includes('Cancellation confirmed'));
run({action:'viewport',width:390,height:844});
click('Details '+cancelId);
until(s=>s.text.includes('Provider key'));
click('Refresh');
until(s=>s.text.includes('Status: cancelled') && s.text.includes('Provider key'));
run({action:'screenshot',path:join(process.env.DATA_DIR,'browser-mobile.png')});
run({action:'console'});
console.log(JSON.stringify({ok:true,deliveredMessage:id,cancelledMessage:cancelId,viewport:390,log},null,2));
