// Independent connected HTTP tests. No product imports, no evaluator access.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const base = process.env.QA_URL || 'http://127.0.0.1:4123';
const dir = join(process.env.DATA_DIR!, 'qa-evidence');
mkdirSync(dir, { recursive: true });
let assertions = 0;
const results: string[] = [];
function check(ok: unknown, label: string) { assertions++; if (!ok) throw new Error(label); results.push(label); }
function equal(a: unknown, b: unknown, label: string) { check(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} == ${JSON.stringify(b)}`); }
class Client {
  cookie = ''; workspace = ''; user: any;
  async request(path: string, method = 'GET', data?: any, expected = 200) {
    const response = await fetch(base + path, {method, headers: { ...(this.cookie ? {cookie: this.cookie} : {}), ...(data !== undefined && !(data instanceof FormData) ? {'content-type':'application/json'} : {}) }, body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data)});
    const text = await response.text();
    check(response.status === expected, `${method} ${path}: expected ${expected}, received ${response.status} ${text.slice(0,200)}`);
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    const value = text ? JSON.parse(text) : null;
    if (expected >= 400) check(value?.error?.code && value?.error?.message, 'nonempty JSON error');
    if (expected === 204) equal(text, '', '204 has no body');
    return value;
  }
  w(path: string, method='GET', data?: any, status=200) { return this.request(`/api/w/${this.workspace}${path}`, method, data, status); }
  async signup(name: string, email: string) {
    const response = await this.request('/api/auth/signup','POST',{name,email,password:'Synthetic-QA-2026!'},201);
    this.workspace = response.workspace.id; this.user = response.user;
    return response;
  }
  async upload(entityType: string, entityId: string, filename: string, bytes: Uint8Array, status=201) {
    const form = new FormData(); form.set('entityType',entityType); form.set('entityId',entityId); form.set('file',new File([bytes],filename));
    return this.w('/attachments','POST',form,status);
  }
}
const statePath = join(dir, base.endsWith(':4123') ? 'api-state.json' : 'restart-state.json');
const a = new Client(), b = new Client(), outsider = new Client();
try {
  if (process.argv.includes('--restart')) {
    const saved = JSON.parse(readFileSync(statePath,'utf8'));
    Object.assign(a,saved.a); Object.assign(b,saved.b);
    equal((await a.request('/api/auth/me')).activeWorkspaceId,a.workspace,'session and selected workspace survive restart');
    equal((await a.w('/orders/'+saved.order.id)).order,saved.order,'order survives restart');
    equal((await a.w('/invoices/'+saved.invoice.id)).invoice,saved.invoice,'invoice snapshots survive restart');
    equal(await a.w('/summary'),saved.summary,'analytics survive restart');
    equal((await a.w('/sync')).revision,saved.revision,'revision survives restart');
    const replay=await a.w('/orders/'+saved.order.id+'/fulfill','POST',{idempotencyKey:'qa-retry-key'});
    equal(replay.replayed,true,'idempotency survives restart'); equal(replay.order,saved.order,'persisted identical replay result');
    equal((await a.w('/sync')).revision,saved.revision,'replay does not change revision after restart');
    check((await b.w('/members')).members.some((m:any)=>m.userId===b.user.id),'membership survives restart');
    check((await a.w('/tasks/'+saved.task.id+'/comments')).comments.some((c:any)=>c.body==='QA persisted comment'),'comments survive restart');
    const download=await fetch(base+`/api/w/${a.workspace}/attachments/${saved.attachment.id}/download`,{headers:{cookie:a.cookie}});
    equal(download.status,200,'file survives restart'); equal([...new Uint8Array(await download.arrayBuffer())],saved.bytes,'exact file bytes survive restart');
  } else {
    equal(await a.request('/api/health'),{ok:true},'health');
    await outsider.request('/api/auth/me','GET',undefined,401);
    await a.request('/api/missing','GET',undefined,404);
    await a.request('/api/auth/signup','POST',{name:' ',email:'qa-invalid@example.invalid',password:'Synthetic-QA-2026!'},400);
    await a.request('/api/auth/signup','POST',{name:'Short',email:'qa-short@example.invalid',password:'short'},400);
    const suffix=Date.now();
    await a.signup('QA API '+suffix,`qa-api-${suffix}@example.invalid`);
    check(/^foundry_session=[a-f0-9]{64}$/.test(a.cookie),'random session length');
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:a.user.email.toUpperCase(),password:'Synthetic-QA-2026!'})});
    equal(login.status,200,'case-insensitive login');
    const cookie=login.headers.get('set-cookie')!;
    check(cookie.includes('HttpOnly')&&cookie.includes('SameSite=Lax')&&cookie.includes('Path=/')&&!cookie.includes('Secure'),'local cookie flags');
    const second=new Client(); second.cookie=cookie.split(';')[0];
    await second.request('/api/auth/logout','POST',undefined,204); await second.request('/api/auth/me','GET',undefined,401);
    await a.request('/api/auth/signup','POST',{name:'Duplicate',email:a.user.email.toUpperCase(),password:'Synthetic-QA-2026!'},409);
    await b.signup('QA Collaborator '+suffix,`qa-collab-${suffix}@example.invalid`);
    await outsider.signup('QA Outsider '+suffix,`qa-outsider-${suffix}@example.invalid`);
    const originalB=b.workspace;
    for(const path of ['/customers','/members','/sync','/activity','/summary','/attachments/absent/download']) await outsider.request(`/api/w/${a.workspace}${path}`,'GET',undefined,404);
    const c=(await a.w('/customers','POST',{name:'QA Customer',email:'qa-customer@example.invalid',company:'QA Local'},201)).customer;
    await a.w('/customers','POST',{name:'Duplicate',email:c.email.toUpperCase()},409);
    const foreign=(await b.w('/customers','POST',{name:'Foreign',email:c.email},201)).customer;
    const p=(await a.w('/products','POST',{sku:'qa-a',name:'QA Widget',priceCents:101},201)).product;
    const p2=(await a.w('/products','POST',{sku:'qa-b',name:'QA Cable',priceCents:29},201)).product;
    equal(p.sku,'QA-A','SKU normalized'); equal(p.stock,0,'zero initial stock');
    for(const value of [1.1,'10',-1,100000001,null]) await a.w('/products','POST',{sku:'invalid',name:'Invalid',priceCents:value},400);
    await a.w('/products/'+p.id,'PATCH',{stock:200},400);
    await a.w('/products','POST',{sku:'qa-A',name:'Duplicate',priceCents:1},409);
    await a.w('/stock-movements','POST',{productId:p.id,delta:5,reason:'QA receipt'},201);
    await a.w('/stock-movements','POST',{productId:p2.id,delta:1,reason:'QA receipt'},201);
    for(const delta of [0,0.1,'1']) await a.w('/stock-movements','POST',{productId:p.id,delta,reason:'invalid'},400);
    await a.w('/stock-movements','POST',{productId:p.id,delta:-6,reason:'negative'},409);
    const rev=(await a.w('/sync')).revision;
    await a.w('/orders','POST',{customerId:foreign.id,items:[{productId:p.id,quantity:1}]},404);
    await a.w('/orders','POST',{customerId:c.id,items:[{productId:p.id,quantity:1.2}]},400);
    await a.w('/orders','POST',{customerId:c.id,items:[{productId:p.id,quantity:1},{productId:p.id,quantity:2}]},400);
    equal((await a.w('/sync')).revision,rev,'failed orders do not change revision');
    let order=(await a.w('/orders','POST',{customerId:c.id,items:[{productId:p.id,quantity:2},{productId:p2.id,quantity:2}]},201)).order;
    equal(order.totalCents,260,'exact multiline cents');
    await a.w('/products/'+p.id,'PATCH',{name:'QA Widget renamed',priceCents:999});
    equal((await a.w('/orders/'+order.id)).order.items[0].unitPriceCents,101,'order price snapshot');
    await a.w('/invoices','POST',{orderId:order.id},409);
    const before=await a.w('/sync'); const events=(await a.w('/activity?limit=500')).activity.length;
    await a.w('/orders/'+order.id+'/fulfill','POST',{idempotencyKey:'qa-retry-key'},409);
    equal((await a.w('/products/'+p.id)).product.stock,5,'multiline rollback restores all stock');
    equal(await a.w('/sync'),before,'failed fulfillment no revision'); equal((await a.w('/activity?limit=500')).activity.length,events,'failed fulfillment no activity');
    await a.w('/stock-movements','POST',{productId:p2.id,delta:10,reason:'QA replenish'},201);
    const concurrent=await Promise.all([a.w('/orders/'+order.id+'/fulfill','POST',{idempotencyKey:'qa-retry-key'}),a.w('/orders/'+order.id+'/fulfill','POST',{idempotencyKey:'qa-retry-key'})]);
    equal(concurrent.map(v=>v.replayed).sort(),[false,true],'same-key concurrency applies once'); order=concurrent[0].order;
    equal((await a.w('/products/'+p.id)).product.stock,3,'single decrement');
    equal((await a.w('/stock-movements')).movements.filter((m:any)=>m.orderId===order.id).length,2,'one movement per line');
    await a.w('/orders/'+order.id+'/fulfill','POST',{idempotencyKey:'other-key'},409);
    await a.w('/orders/'+order.id+'/cancel','POST',undefined,409);
    await a.w('/customers/'+c.id,'DELETE',undefined,409); await a.w('/products/'+p.id,'DELETE',undefined,409);
    let invoice=(await a.w('/invoices','POST',{orderId:order.id},201)).invoice;
    equal(invoice.totalCents,260,'invoice exact cents'); equal(invoice.status,'draft','invoice draft'); equal(invoice.paidAt,null,'invoice unpaid timestamp');
    await a.w('/invoices','POST',{orderId:order.id},409); await a.w('/invoices','POST',{orderId:order.id,totalCents:0},400);
    await a.w('/customers/'+c.id,'PATCH',{name:'QA Customer renamed'});
    equal((await a.w('/invoices/'+invoice.id)).invoice.billTo.name,'QA Customer','bill-to immutable');
    await a.w('/invoices/'+invoice.id,'PATCH',{status:'paid'},409);
    await a.w('/invoices/'+invoice.id,'PATCH',{status:'sent'});
    invoice=(await a.w('/invoices/'+invoice.id,'PATCH',{status:'paid'})).invoice;
    check(invoice.paidAt,'paid timestamp'); await a.w('/invoices/'+invoice.id,'PATCH',{status:'void'},409);
    const contenders=[];
    for(let i=0;i<2;i++) contenders.push((await a.w('/orders','POST',{customerId:c.id,items:[{productId:p.id,quantity:2}]},201)).order);
    const race=await Promise.all(contenders.map(async(o,i)=>{const r=await fetch(base+`/api/w/${a.workspace}/orders/${o.id}/fulfill`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'race-key-'+i})});return r.status;}));
    equal(race.sort(),[200,409],'competing fulfillment one success one conflict'); equal((await a.w('/products/'+p.id)).product.stock,1,'nonnegative stock after concurrency');
    const project=(await a.w('/projects','POST',{name:'QA Project',description:'Connected local QA'},201)).project;
    const task=(await a.w('/projects/'+project.id+'/tasks','POST',{title:'QA durable task',description:'Find Needle',status:'in_progress',priority:'high',assigneeId:a.user.id,dueDate:'2028-02-29'},201)).task;
    for(const dueDate of ['2027-02-29','2026-04-31','2026-13-01','bad']) await a.w('/tasks/'+task.id,'PATCH',{title:'MUST NOT COMMIT',dueDate},400);
    equal((await a.w('/tasks/'+task.id)).task.title,task.title,'atomic invalid task patches');
    await a.w('/tasks/'+task.id,'PATCH',{assigneeId:outsider.user.id},404);
    equal((await a.w(`/tasks?q=NEEDLE&status=in_progress&priority=high&assigneeId=${a.user.id}&projectId=${project.id}`)).tasks.length,1,'composed global task filters');
    equal((await a.w(`/projects/${project.id}/tasks?q=NEEDLE&status=done&priority=high`)).tasks.length,0,'composed project task filters');
    await a.w('/tasks/'+task.id+'/comments','POST',{body:'QA persisted comment'},201);
    await a.w('/tasks/'+task.id+'/comments','POST',{body:'x'.repeat(2001)},400);
    const badCsv='name,email,company,notes\r\nValid,new-qa@example.invalid,,\r\nDuplicate,QA-CUSTOMER@example.invalid,,\r\n';
    const customerCount=(await a.w('/customers')).customers.length;
    await a.w('/import/customers','POST',{csv:badCsv},409); equal((await a.w('/customers')).customers.length,customerCount,'CSV duplicate rollback');
    await a.w('/import/customers','POST',{csv:'name,email,company,notes\r\n"Quoted, Person",quoted-qa@example.invalid,"Local ""Co""","Line one\r\nLine two"\r\n=1+1,formula-qa@example.invalid,,\r\n'},201);
    const exported=await fetch(base+`/api/w/${a.workspace}/export.csv?type=customers`,{headers:{cookie:a.cookie}}); const csv=await exported.text();
    check(exported.headers.get('content-type')?.startsWith('text/csv'),'CSV content type'); check(exported.headers.get('content-disposition')?.includes('attachment'),'CSV attachment');
    check(csv.startsWith('id,name,email,company,notes\r\n')&&csv.includes('"Quoted, Person"')&&csv.includes('"Line one\r\nLine two"')&&csv.includes("'=1+1"),'CSV RFC4180 escaping and formula defense');
    check((await a.w('/customers')).customers.some((c:any)=>c.name==='=1+1'),'stored CSV value unmodified');
    for(const type of ['products','orders','invoices','tasks']) {const r=await fetch(base+`/api/w/${a.workspace}/export.csv?type=${type}`,{headers:{cookie:a.cookie}});equal(r.status,200,type+' export');}
    const bytes=new Uint8Array([0,1,2,13,10,255,60,62]);
    const attachment=(await a.upload('task',task.id,'qa-bytes.txt',bytes)).attachment;
    const download=await fetch(base+`/api/w/${a.workspace}/attachments/${attachment.id}/download`,{headers:{cookie:a.cookie}});
    equal(download.status,200,'attachment download'); equal([...new Uint8Array(await download.arrayBuffer())],[...bytes],'attachment exact binary bytes');
    await outsider.request(`/api/w/${a.workspace}/attachments/${attachment.id}/download`,'GET',undefined,404);
    await new Client().request(`/api/w/${a.workspace}/attachments/${attachment.id}/download`,'GET',undefined,401);
    await a.upload('task',task.id,'blocked.html',bytes,415); await a.upload('task',task.id,'large.txt',new Uint8Array(2097153),413); await a.upload('customer',foreign.id,'foreign.txt',bytes,404);
    const deleted=(await a.upload('customer',c.id,'delete.txt',bytes)).attachment;
    await a.w('/attachments/'+deleted.id,'DELETE',undefined,204); await a.w('/attachments/'+deleted.id+'/download','GET',undefined,404);
    const invite=(await a.w('/invites','POST',{email:b.user.email.toUpperCase(),role:'member'},201)).invite;
    check(invite.token.length>=32,'invite entropy length'); check(Date.parse(invite.expiresAt)-Date.now()<=7*86400000,'invite expires within 7 days');
    await outsider.request('/api/invites/accept','POST',{token:invite.token},404);
    await b.request('/api/invites/accept','POST',{token:invite.token}); b.workspace=a.workspace;
    await b.request('/api/invites/accept','POST',{token:invite.token},409);
    check(!(await a.w('/invites')).invites.some((i:any)=>'token'in i),'invite metadata omits tokens');
    await b.w('/products','POST',{sku:'NO',name:'No',priceCents:1},403); await b.w('/invites','POST',{email:'deny@example.invalid',role:'member'},403);
    const own=(await b.w('/tasks/'+task.id+'/comments','POST',{body:'Member own comment'},201)).comment;
    const other=(await a.w('/tasks/'+task.id+'/comments','POST',{body:'Owner comment'},201)).comment;
    await b.w('/comments/'+other.id,'DELETE',undefined,403); await b.w('/comments/'+own.id,'DELETE',undefined,204);
    await a.w('/members/'+a.user.id,'PATCH',{role:'member'},409); await a.w('/members/'+a.user.id,'DELETE',undefined,409); await a.w('/members/'+b.user.id,'PATCH',{role:'owner'},400);
    await a.w('/members/'+b.user.id,'PATCH',{role:'read_only'});
    await b.w('/customers','POST',{name:'Denied'},403); await b.w('/projects','POST',{name:'Denied'},403); await b.w('/tasks/'+task.id+'/comments','POST',{body:'Denied'},403); await b.upload('task',task.id,'denied.txt',bytes,403);
    const tenantRevision=(await a.w('/sync')).revision;
    await outsider.w('/customers','POST',{name:'Unrelated tenant'},201); equal((await a.w('/sync')).revision,tenantRevision,'tenant revision isolation');
    await a.w('/members/'+b.user.id,'DELETE',undefined,204); for(const path of ['/customers','/sync','/activity',`/attachments/${attachment.id}/download`]) await b.w(path,'GET',undefined,404);
    // Restore collaborator to test durable membership on restart.
    const reinvite=(await a.w('/invites','POST',{email:b.user.email,role:'manager'},201)).invite;
    await b.request('/api/invites/accept','POST',{token:reinvite.token});
    const summary=await a.w('/summary'); equal(summary.revenueCents,260,'actual paid revenue'); equal(summary.unpaidCents,0,'actual unpaid total'); equal(summary.openTasks,1,'actual open tasks');
    const activity=(await a.w('/activity?limit=500')).activity;
    for(const name of ['customer.created','stock.adjusted','order.fulfilled','invoice.paid','task.created','comment.created','attachment.created']) check(activity.some((v:any)=>v.action===name),'persisted audit '+name);
    check(!JSON.stringify(activity).includes(invite.token),'audit excludes invite token');
    await a.request(`/api/workspaces/${a.workspace}/select`,'POST');
    writeFileSync(statePath,JSON.stringify({a,b,order,invoice,task,attachment,bytes:[...bytes],summary,revision:(await a.w('/sync')).revision,originalB}));
  }
  const reportName=process.argv.includes('--restart')?'restart-results.json':base.endsWith(':4123')?'api-results.json':'isolated-api-results.json';
  writeFileSync(join(dir,reportName),JSON.stringify({base,assertions,passed:true,results},null,2));
  console.log(`PASS ${assertions} independent HTTP assertions on ${base}`);
} catch(error) {
  writeFileSync(join(dir,'api-failure.json'),JSON.stringify({base,assertions,results,error:String(error)},null,2));
  console.error(error); process.exitCode=1;
}
