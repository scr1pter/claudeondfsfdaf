// Assert the actual authorized-client artifacts, not parent completion claims.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir=join(process.env.DATA_DIR,'qa-evidence');let assertions=0;const checks=[];
function check(value,label){assertions++;if(!value)throw new Error(label);checks.push(label);}
function evidence(name){const data=JSON.parse(readFileSync(join(dir,name+'.json'),'utf8'));check(data.ok,name+' authorized action succeeded');return data.snapshot;}
function focused(snapshot){return snapshot.controls.find(c=>c.ref===snapshot.focus.focusedRef)?.name;}
for(const [artifact,name] of [['final-r2-sku-exact','SKU'],['final-r2-quantity-exact','Quantity change'],['final-r2-invite-token-exact','Invite token'],['final-r2-signup-labels','Password'],['final-r2-customer-loaded','Attachment']]){
  const snapshot=evidence(artifact);check(snapshot.controls.filter(c=>c.name===name).length===1,'one exact hinted field '+name);
}
evidence('final-r2-overview-exact');
for(const [artifact,name] of [['final-r3-customer-exact','Open customer UI Avery revised'],['final-r3-order-exact','Open order ORD-000001'],['final-r3-invoice-exact','Open invoice INV-000001'],['final-r3-task-exact','Open task Prepare launch kit'],['final-readonly-customer','Open customer UI Avery revised'],['final-readonly-order','Open order ORD-000001'],['final-readonly-invoice','Open invoice INV-000001'],['final-readonly-task','Open task Prepare launch kit']]){
  const snapshot=evidence(artifact);check(snapshot.controls.filter(c=>c.role==='button'&&c.name===name).length===1,'one canonical '+artifact);
}
// Successful exact project action independently requires a unique role/name target.
evidence('final-r3-project-exact');evidence('final-readonly-project');
const settled=evidence('final-r4-settled');check(focused(settled)==='Search tasks','filtered edit settled focus Search tasks');check(!settled.controls.some(c=>c.name==='Edit task Prepare launch kit'),'edited task removed from retained filter');
check(focused(evidence('final-r4-tab-continuation'))==='Status filter','keyboard continues to Status filter');
check(focused(evidence('final-r4-nested-escape'))==='Delete attachment qa-ui-note.txt','nested Escape restores outer trigger');
check(focused(evidence('final-r4-outer-escape'))==='Open customer UI Avery revised','outer Escape restores canonical record trigger');
const readonly=evidence('final-readonly-task-loaded');check(!readonly.controls.some(c=>['New task','Add comment','Upload attachment','Edit task Prepare launch kit','Delete task Prepare launch kit'].includes(c.name)),'read-only mutation controls hidden');
check(readonly.text.includes('Prepare launch kit\nDone'),'saved task remains Done on independent client');
for(const file of ['api-results','edge-results','final-revocation-results']){const result=JSON.parse(readFileSync(join(dir,file+'.json'),'utf8'));check(result.passed,file+' passed');}
writeFileSync(join(dir,'final-browser-assertions.json'),JSON.stringify({passed:true,assertions,checks},null,2));
console.log(`PASS ${assertions} final browser/evidence assertions`);
