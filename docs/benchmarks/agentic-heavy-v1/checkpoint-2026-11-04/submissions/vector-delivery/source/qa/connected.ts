import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=join(process.env.DATA_DIR!,'qa-evidence'); mkdirSync(dir,{recursive:true});
const url='http://127.0.0.1:4123';
let cookie='';
async function request(path:string,method='GET',data?:unknown) {
  const r=await fetch(url+path,{method,headers:{cookie,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  if(!r.ok)throw new Error(`${r.status} ${path} ${await r.text()}`);
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];
  return r.status===204?null:await r.json();
}
function browser(action:unknown) {
  const r=spawnSync(process.env.NODE_EXE!,[process.env.BROWSER_DRIVER_CLIENT!,'--endpoint',process.env.BROWSER_DRIVER_ENDPOINT!],{input:JSON.stringify(action),encoding:'utf8',timeout:25000});
  if(r.error)throw r.error;const out=JSON.parse(r.stdout); if(!out.ok)throw new Error(r.stdout);return out;
}
await request('/api/auth/login','POST',{email:'qa-browser-1102@example.invalid',password:'Synthetic-QA-2026!'});
const me=await request('/api/auth/me'); const w='/api/w/'+me.workspaces.find((w:any)=>w.name==='QA Browser workspace').id;
const mode=process.argv[2];
if(mode==='setup'){
  const customer=(await request(w+'/customers')).customers.find((c:any)=>c.name==='UI Avery');
  const kit=(await request(w+'/products')).products.find((p:any)=>p.sku==='UI-KIT');
  const cable=(await request(w+'/products','POST',{sku:'ui-cable',name:'Studio cable',priceCents:66})).product;
  await request(w+'/stock-movements','POST',{productId:cable.id,delta:10,reason:'QA API receipt'});
  writeFileSync(join(dir,'browser-state.json'),JSON.stringify({w,customer,kit,cable,user:me.user}));
  console.log(JSON.stringify({w,customer,kit,cable,user:me.user}));
} else if(mode==='live-customer') {
  const start=Date.now(); const name='Live QA '+start;
  const customer=(await request(w+'/customers','POST',{name,email:`live-${start}@example.invalid`})).customer;
  let observation:any; let elapsed=0;
  do { observation=browser({action:'observe'});elapsed=Date.now()-start;if(observation.snapshot.text.includes(name))break; await Bun.sleep(100); } while(elapsed<3500);
  const passed=observation.snapshot.text.includes(name)&&elapsed<=3000;
  writeFileSync(join(dir,'live-customer.json'),JSON.stringify({passed,elapsed,customer,observation},null,2));
  console.log(JSON.stringify({passed,elapsed,name})); if(!passed)process.exitCode=1;
} else if(mode==='role-readonly' || mode==='role-member' || mode==='revoke') {
  const state=JSON.parse(readFileSync(join(dir,'browser-state.json'),'utf8'));
  // The browser is signed into the invitee while this independent HTTP client is owner.
  const members=(await request(w+'/members')).members;
  const invitee=members.find((m:any)=>m.email==='qa-ui-member@example.invalid');
  if(!invitee)throw new Error('UI invitee missing');
  const start=Date.now();
  await request(w+'/members/'+invitee.userId,mode==='revoke'?'DELETE':'PATCH',mode==='revoke'?undefined:{role:mode==='role-readonly'?'read_only':'member'});
  let observation:any;let elapsed=0;let passed=false;
  do {
    observation=browser({action:'observe'});elapsed=Date.now()-start;
    const controls=observation.snapshot.controls;
    const create=controls.some((c:any)=>c.name==='New customer');
    passed=mode==='revoke'?!observation.snapshot.controls.find((c:any)=>c.name==='Workspace')?.options?.some((o:any)=>o.label==='QA Browser workspace'):mode==='role-readonly'?!create:create;
    if(passed)break;await Bun.sleep(100);
  }while(elapsed<3500);
  passed=passed&&elapsed<=3000;
  writeFileSync(join(dir,mode+'.json'),JSON.stringify({passed,elapsed,observation},null,2));
  console.log(JSON.stringify({mode,passed,elapsed}));if(!passed)process.exitCode=1;
} else if(mode==='attachment-and-check') {
  const state=JSON.parse(readFileSync(join(dir,'browser-state.json'),'utf8'));
  const orders=(await request(w+'/orders')).orders;
  const invoices=(await request(w+'/invoices')).invoices;
  const summary=await request(w+'/summary');
  const form=new FormData();form.set('entityType','customer');form.set('entityId',state.customer.id);form.set('file',new File(['QA local original bytes\r\n'],'qa-ui-note.txt'));
  const r=await fetch(url+w+'/attachments',{method:'POST',headers:{cookie},body:form});if(r.status!==201)throw new Error(await r.text());
  const attachment=await r.json();
  const results={orders,invoices,summary,attachment};
  writeFileSync(join(dir,'ui-api-results.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify(results));
} else if(mode==='member-account') {
  const r=await request('/api/auth/signup','POST',{name:'QA UI Member',email:'qa-ui-member@example.invalid',password:'Synthetic-QA-2026!'});
  console.log(JSON.stringify({user:r.user,workspace:r.workspace}));
} else if(mode==='restore-member') {
  const invite=(await request(w+'/invites','POST',{email:'qa-ui-member@example.invalid',role:'member'})).invite;
  await request('/api/auth/login','POST',{email:'qa-ui-member@example.invalid',password:'Synthetic-QA-2026!'});
  await request('/api/invites/accept','POST',{token:invite.token});console.log('Restored synthetic member for owner UI role checks.');
} else if(mode==='snapshot-edits') {
  const state=JSON.parse(readFileSync(join(dir,'browser-state.json'),'utf8'));
  await request(w+'/customers/'+state.customer.id,'PATCH',{name:'UI Avery revised',company:'Revised studio'});
  await request(w+'/products/'+state.kit.id,'PATCH',{name:'Fieldwork kit revised',priceCents:5000});
  console.log('Changed live customer/catalog after invoice creation; issued snapshots must remain UI Avery/Cedar Studio/Fieldwork kit/$12.34.');
} else throw new Error('Unknown mode');
