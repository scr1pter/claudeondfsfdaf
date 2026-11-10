import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
const dir=join(process.env.DATA_DIR!,'qa-evidence');
const state=JSON.parse(readFileSync(join(dir,'api-state.json'),'utf8'));
const base='http://127.0.0.1:4123',w='/api/w/'+state.a.workspace,cookie=state.a.cookie;
let assertions=0;const checks:string[]=[];
function check(v:unknown,label:string){assertions++;if(!v)throw new Error(label);checks.push(label);}
async function req(path:string,method='GET',data?:unknown,status=200){const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const text=await r.text();check(r.status===status,`${method} ${path} => ${r.status}, expected ${status}: ${text.slice(0,150)}`);return text?JSON.parse(text):null;}
const stable=async()=>({revision:(await req(w+'/sync')).revision,activity:(await req(w+'/activity?limit=500')).activity.length});
async function rawUpload(filename:string,statuses:number[]){
  const boundary='qa-boundary-1102';
  const raw=`--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\ntask\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${state.task.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\nqa raw file\r\n--${boundary}--\r\n`;
  const r=await fetch(base+w+'/attachments',{method:'POST',headers:{cookie,'content-type':`multipart/form-data; boundary=${boundary}`},body:raw});
  const value=await r.json();check(statuses.includes(r.status),`raw filename ${JSON.stringify(filename)} status ${r.status}`);
  if(r.status===201){check(value.attachment.fileName==='safe.txt','parser normalizes traversal to safe basename');check(existsSync(join(process.env.DATA_DIR!,value.attachment.id+'.blob')),'opaque file exists only under DATA_DIR');await req(w+'/attachments/'+value.attachment.id,'DELETE',undefined,204);}
}
try {
  let before=await stable();
  await rawUpload('safe\r\nInjected: true.txt',[400]);
  await rawUpload('../safe.txt',[400,201]);await rawUpload('..\\safe.txt',[400,201]);
  check(!existsSync(join(process.env.DATA_DIR!,'safe.txt')),'client filename never used as storage path');
  const malformed=await fetch(base+w+'/customers',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"name":'});check(malformed.status===400,'malformed JSON rejected');
  for(const data of [null,[],true,'name'])await req(w+'/customers','POST',data,400);
  for(const q of ['limit=0','limit=501','limit=1.5','limit=-1'])await req(w+'/activity?'+q,'GET',undefined,400);
  for(const route of ['/orders?status=unknown','/invoices?status=unknown','/tasks?priority=urgent','/export.csv?type=unknown'])await req(w+route,'GET',undefined,400);
  const movement=(await req(w+'/stock-movements')).movements[0];
  for(const method of ['PATCH','DELETE'])await req(w+'/stock-movements/'+movement.id,method,method==='PATCH'?{delta:100}:undefined,404);
  before=await stable();
  const bads=['name,email,company,notes\n"unterminated,a@example.invalid,,','name,email,company,notes\n"quoted"tail,a@example.invalid,,','name,email,company,notes\nToo,few,columns','name,email,company,notes\nBad,bademail,,'];
  for(const csv of bads)await req(w+'/import/customers','POST',{csv},400);
  const rows=Array.from({length:201},(_,i)=>`QA Edge ${i},edge-${i}@example.invalid,,`);
  await req(w+'/import/customers','POST',{csv:'name,email,company,notes\n'+rows.join('\n')},400);
  await req(w+'/import/customers','POST',{csv:'name,email,company,notes\nBig,big@example.invalid,,"'+'é'.repeat(530000)+'"'},400);
  check(JSON.stringify(await stable())===JSON.stringify(before),'malformed CSV writes leave no revision/activity');
  const imported=await req(w+'/import/customers','POST',{csv:'name,email,company,notes\n'+rows.slice(0,200).join('\n')},201);check(imported.imported===200,'200-row CSV boundary');
  const listed=(await req(w+'/customers?q=QA%20Edge')).customers;check(listed.length===200,'all small-test rows visible');
  const formulas=[' =2+2','+SUM(1,1)','-2+2','@SUM(1,1)','\tHello','\rHello'];
  for(let i=0;i<formulas.length;i++)await req(w+'/customers','POST',{name:'Formula '+i,notes:formulas[i]},201);
  const exported=await fetch(base+w+'/export.csv?type=customers',{headers:{cookie}});const csv=await exported.text();
  for(const value of formulas)check(csv.includes("'"+value.replaceAll('"','""')),'formula defense '+JSON.stringify(value));
  const p=(await req(w+'/products','POST',{sku:'qa-upper-bound',name:'QA upper bound',priceCents:100000000},201)).product;
  await req(w+'/stock-movements','POST',{productId:p.id,delta:1000000000,reason:'Boundary receipt'},201);
  before=await stable();await req(w+'/stock-movements','POST',{productId:p.id,delta:1,reason:'Overflow'},409);
  check((await req(w+'/products/'+p.id)).product.stock===1000000000,'stock max remains exact');check(JSON.stringify(await stable())===JSON.stringify(before),'overflow has no activity/revision');
  const db=new Database(join(process.env.DATA_DIR!,'foundry.sqlite'),{readonly:true});
  const user=db.query('SELECT email,password_hash FROM users WHERE id=?').get(state.a.user.id) as any;
  check(user.email===state.a.user.email&&user.password_hash.startsWith('$argon2id$'),'persisted users email/password_hash genuine Argon2id');
  check(await Bun.password.verify('Synthetic-QA-2026!',user.password_hash),'real salted password verifies');
  const user2=db.query('SELECT password_hash FROM users WHERE id=?').get(state.b.user.id) as any;
  check(user2.password_hash!==user.password_hash,'same password independently salted');
  const path=join(process.env.DATA_DIR!,state.attachment.id+'.blob');check(existsSync(path),'durable attachment stored by opaque ID');
  const stored=readFileSync(path);check([...stored].join(',')===state.bytes.join(','),'owned file exact original bytes');db.close();
  const project=(await req(w+'/projects','POST',{name:'QA cascade'},201)).project;
  const task=(await req(w+'/projects/'+project.id+'/tasks','POST',{title:'QA cascade task'},201)).task;
  await req(w+'/tasks/'+task.id+'/comments','POST',{body:'Delete with project'},201);
  const form=new FormData();form.set('entityType','task');form.set('entityId',task.id);form.set('file',new File(['cascade'],'qa-cascade.txt'));
  const upload=await fetch(base+w+'/attachments',{method:'POST',headers:{cookie},body:form});check(upload.status===201,'cascade attachment creation');const attachment=(await upload.json()).attachment;
  await req(w+'/projects/'+project.id,'DELETE',undefined,204);await req(w+'/tasks/'+task.id,'GET',undefined,404);await req(w+'/tasks/'+task.id+'/comments','GET',undefined,404);await req(w+'/attachments/'+attachment.id+'/download','GET',undefined,404);
  check(!existsSync(join(process.env.DATA_DIR!,attachment.id+'.blob')),'project cascade removes physical file');
  writeFileSync(join(dir,'edge-results.json'),JSON.stringify({assertions,passed:true,checks},null,2));console.log(`PASS ${assertions} acceptance-edge assertions`);
}catch(error){writeFileSync(join(dir,'edge-failure.json'),JSON.stringify({assertions,checks,error:String(error)},null,2));throw error;}
