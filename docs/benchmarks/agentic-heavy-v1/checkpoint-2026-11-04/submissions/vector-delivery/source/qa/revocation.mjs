// Independent stalled-body HTTP regression. No product or judge test imports.
import http from 'node:http';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const origin = `http://127.0.0.1:${process.env.PORT || 4123}`;
const directory = join(process.env.DATA_DIR, 'qa-evidence');
mkdirSync(directory, { recursive: true });
const results = [];
let assertions = 0;
function check(value, label) { assertions++; if (!value) throw new Error(label); }
class Client {
  cookie = '';
  async request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    check(response.status === expected, `${method} ${path} expected ${expected}, got ${response.status}: ${text}`);
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
}
function stalled(path, cookie, bytes, contentType) {
  let complete;
  const response = new Promise((resolve, reject) => {
    const request = http.request(origin + path, {method:'POST',headers:{cookie,'content-type':contentType,'content-length':bytes.length}}, incoming => {
      const parts=[];incoming.on('data',part=>parts.push(part));incoming.on('end',()=>resolve({status:incoming.statusCode,body:Buffer.concat(parts).toString()}));
    });
    request.on('error',reject); request.setTimeout(10000,()=>request.destroy(new Error('QA stalled request timed out')));
    request.flushHeaders();
    const split=Math.max(1,Math.floor(bytes.length/2));request.write(bytes.subarray(0,split));
    complete=()=>request.end(bytes.subarray(split));
  });
  return {response,complete:()=>complete()};
}
const blobs=()=>new Set(readdirSync(process.env.DATA_DIR).filter(name=>/^[a-f0-9]{32}\.blob$/.test(name)));
try {
  const stamp=Date.now();const owner=new Client();
  const created=await owner.request('/api/auth/signup','POST',{name:`QA Final R1 ${stamp}`,email:`qa-final-r1-${stamp}@example.invalid`,password:'Synthetic-QA-2026!'},201);
  const w='/api/w/'+created.workspace.id;
  const customer=(await owner.request(w+'/customers','POST',{name:'QA attachment parent'},201)).customer;
  const cases=[['manager-demoted','manager',403],['member-readonly','member',403],['member-removed','member',404],['session-revoked','member',401],['attachment-member-removed','member',404]];
  for (const [name,role,expected] of cases) {
    const writer=new Client();const email=`qa-final-${name}-${stamp}@example.invalid`;
    const account=await writer.request('/api/auth/signup','POST',{name:`QA ${name}`,email,password:'Synthetic-QA-2026!'},201);
    const invite=(await owner.request(w+'/invites','POST',{email,role},201)).invite;
    await writer.request('/api/invites/accept','POST',{token:invite.token});
    const upload=name.startsWith('attachment');const product=name==='manager-demoted';
    const entityName='Stalled '+name+' '+stamp;
    const boundary='qa-final-stalled-boundary';
    const json=product?{sku:'QA-STALLED-'+stamp,name:entityName,priceCents:111}:{name:entityName};
    const bytes=Buffer.from(upload?`--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\ncustomer\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${customer.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa-stalled.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic attachment held until membership removal\r\n--${boundary}--\r\n`:JSON.stringify(json));
    const filesBefore=blobs();const start=Date.now();
    const pending=stalled(w+(upload?'/attachments':product?'/products':'/customers'),writer.cookie,bytes,upload?`multipart/form-data; boundary=${boundary}`:'application/json');
    await new Promise(resolve=>setTimeout(resolve,650));
    if(name==='session-revoked')await writer.request('/api/auth/logout','POST',undefined,204);
    else if(name.endsWith('removed'))await owner.request(w+'/members/'+account.user.id,'DELETE',undefined,204);
    else await owner.request(w+'/members/'+account.user.id,'PATCH',{role:product?'member':'read_only'});
    const revisionBefore=(await owner.request(w+'/sync')).revision;
    const activityBefore=(await owner.request(w+'/activity?limit=500')).activity.length;
    const revokedAt=Date.now();pending.complete();const response=await pending.response;
    const revisionAfter=(await owner.request(w+'/sync')).revision;
    const activityAfter=(await owner.request(w+'/activity?limit=500')).activity.length;
    const records=upload?(await owner.request(w+`/attachments?entityType=customer&entityId=${customer.id}`)).attachments:product?(await owner.request(w+'/products')).products:(await owner.request(w+'/customers')).customers;
    const committed=upload?records.some(record=>record.fileName==='qa-stalled.txt'):records.some(record=>record.name===entityName);
    const newBlobs=[...blobs()].filter(name=>!filesBefore.has(name));
    const result={name,expected,status:response.status,error:JSON.parse(response.body),committed,revisionDelta:revisionAfter-revisionBefore,activityDelta:activityAfter-activityBefore,newBlobs,heldBeforeRevocationMs:revokedAt-start};results.push(result);
    check(response.status===expected,name+' correct denial');check(!committed,name+' no business/metadata commit');check(result.revisionDelta===0,name+' no revision');check(result.activityDelta===0,name+' no activity');check(newBlobs.length===0,name+' no orphan blob');
  }
  writeFileSync(join(directory,'final-revocation-results.json'),JSON.stringify({origin,assertions,passed:true,workspaceId:created.workspace.id,results},null,2));
  console.log(JSON.stringify({passed:true,assertions,cases:results.map(({name,status,revisionDelta,activityDelta,newBlobs})=>({name,status,revisionDelta,activityDelta,newBlobs}))}));
} catch(error) {
  writeFileSync(join(directory,'final-revocation-results.json'),JSON.stringify({origin,assertions,passed:false,results,error:String(error)},null,2));console.error(error);process.exitCode=1;
}
