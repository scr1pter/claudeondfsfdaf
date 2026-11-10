import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { parseCsv, exportCsv } from './csv';

const dataDir = resolve(process.env.DATA_DIR || '.foundry-data');
mkdirSync(join(dataDir, 'attachments'), { recursive: true });
const db = new Database(join(dataDir, 'foundry.sqlite'), { create: true });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,active_workspace_id TEXT);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE,role TEXT NOT NULL,token TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_scope ON records(workspace_id,type);
CREATE TABLE IF NOT EXISTS idempotency(workspace_id TEXT NOT NULL,key TEXT NOT NULL,order_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(workspace_id,key));
CREATE TABLE IF NOT EXISTS counters(workspace_id TEXT NOT NULL,type TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(workspace_id,type));`);

type Obj = Record<string, any>;
class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
function fail(status: number, message: string, code = ({400:'invalid_input',401:'unauthenticated',403:'forbidden',404:'not_found',409:'conflict',413:'too_large',415:'unsupported_file'} as Obj)[status] || 'request_error'): never { throw new HttpError(status, code, message); }
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const one = (sql: string, ...args: any[]): any => db.query(sql).get(...args);
const all = (sql: string, ...args: any[]): any[] => db.query(sql).all(...args);
const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
function list(w: string, type: string): Obj[] { return all('SELECT data FROM records WHERE workspace_id=? AND type=? ORDER BY rowid', w, type).map(x => JSON.parse(x.data)); }
function get(w: string, type: string, id: string): Obj { const r = one('SELECT data FROM records WHERE workspace_id=? AND type=? AND id=?', w, type, id); if (!r) fail(404, `${type} not found`); return JSON.parse(r.data); }
function put(w: string, type: string, value: Obj) { run('INSERT INTO records(id,workspace_id,type,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', value.id,w,type,JSON.stringify(value)); return value; }
function remove(w: string, type: string, id: string) { run('DELETE FROM records WHERE workspace_id=? AND type=? AND id=?',w,type,id); }
function text(v: unknown, name: string, required = false, max = 10000): string { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(400, `${name} must be ${required ? 'a nonempty' : 'a'} string (maximum ${max} characters)`); return v as string; }
function integer(v: unknown, name: string, min: number, max: number): number { if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(400, `${name} must be an integer from ${min} to ${max}`); return v as number; }
function choice(v: unknown, name: string, choices: string[]): string { if (typeof v !== 'string' || !choices.includes(v)) fail(400, `Invalid ${name}`); return v as string; }
function fields(b: Obj, allowed: string[]) { for (const k of Object.keys(b)) if (!allowed.includes(k) && !['workspaceId','userId'].includes(k)) fail(400, `Field ${k} cannot be changed`); }
function email(v: unknown, required = false): string { const s = text(v, 'Email', required, 320).trim(); if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'Enter a valid email'); return s; }
function unique(w: string, type: string, field: string, value: string, except?: string) { if (value && list(w,type).some(r => r.id !== except && r[field].toLowerCase() === value.toLowerCase())) fail(409, `${field === 'sku' ? 'SKU' : 'Email'} already exists`); }
function publicUser(u: Obj) { return { id:u.id,name:u.name,email:u.email }; }
function workspaces(u: string) { return all('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.rowid',u); }
function workspace(w: string, u: string) { const r = one('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON w.id=m.workspace_id WHERE w.id=? AND m.user_id=?',w,u); if (!r) fail(404,'Workspace not found'); return r; }
function createWorkspace(name: string,u: string) { const id=uid(); run('INSERT INTO workspaces(id,name,owner_id) VALUES(?,?,?)',id,name,u); run('INSERT INTO memberships VALUES(?,?,?)',id,u,'owner'); run('UPDATE users SET active_workspace_id=? WHERE id=?',id,u); return {id,name,role:'owner'}; }
function activity(w: string,u: Obj,action: string,type: string,id: string) { put(w,'activity',{id:uid(),action,entityType:type,entityId:id,actorId:u.id,actorName:u.name,createdAt:now()}); run('UPDATE workspaces SET revision=revision+1 WHERE id=?',w); }
function number(w: string, type: string, prefix: string) { run('INSERT INTO counters VALUES(?,?,1) ON CONFLICT(workspace_id,type) DO UPDATE SET value=value+1',w,type); return `${prefix}-${String(one('SELECT value FROM counters WHERE workspace_id=? AND type=?',w,type).value).padStart(6,'0')}`; }
const json = (body: any, status = 200, headers?: HeadersInit) => Response.json(body,{status,headers});
const empty = () => new Response(null,{status:204});
function deleteAttachments(w: string,type: string,id: string) { for (const a of list(w,'attachment').filter(a=>a.entityType===type && a.entityId===id)) { remove(w,'attachment',a.id); const path=join(dataDir,'attachments',a.id); if(existsSync(path)) unlinkSync(path); } }
function own(role: string,u: Obj,record: Obj) { if (!['owner','manager'].includes(role) && record.createdBy !== u.id && record.author?.id !== u.id) fail(403,'Only the author or a manager can delete this item'); }
function taskValues(w: string,b: Obj,previous?: Obj) {
  fields(b,['title','description','status','priority','assigneeId','dueDate']);
  const t: Obj = previous ? {...previous} : {description:'',status:'todo',priority:'medium',assigneeId:null,dueDate:null};
  if ('title' in b || !previous) t.title=text(b.title,'Title',true,300);
  if ('description' in b) t.description=text(b.description,'Description');
  if ('status' in b) t.status=choice(b.status,'status',['todo','in_progress','done']);
  if ('priority' in b) t.priority=choice(b.priority,'priority',['low','medium','high']);
  if ('assigneeId' in b) { if (b.assigneeId!==null) { text(b.assigneeId,'Assignee',true); if(!one('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',w,b.assigneeId)) fail(404,'Assignee is not a workspace member'); } t.assigneeId=b.assigneeId; }
  if ('dueDate' in b) { if(b.dueDate!==null && (typeof b.dueDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || Number.isNaN(Date.parse(b.dueDate)) || new Date(b.dueDate).toISOString().slice(0,10)!==b.dueDate)) fail(400,'Due date must be a valid YYYY-MM-DD'); t.dueDate=b.dueDate; }
  return t;
}
function orderValues(w: string,b: Obj,previous?: Obj) {
  fields(b,['customerId','items']);
  const customerId='customerId' in b ? text(b.customerId,'Customer',true) : previous?.customerId;
  get(w,'customer',customerId);
  let items=previous?.items;
  if ('items' in b || !previous) {
    if(!Array.isArray(b.items) || b.items.length<1 || b.items.length>50) fail(400,'Orders require 1 to 50 distinct products');
    const seen=new Set();
    items=b.items.map((item: Obj)=>{ if(!item || typeof item!=='object') fail(400,'Invalid line'); fields(item,['productId','quantity']); const p=get(w,'product',text(item.productId,'Product',true)); if(seen.has(p.id)) fail(400,'Products must be distinct'); seen.add(p.id); const quantity=integer(item.quantity,'Quantity',1,10000); return {productId:p.id,sku:p.sku,name:p.name,unitPriceCents:p.priceCents,quantity,lineTotalCents:p.priceCents*quantity}; });
  } else if(previous && ('customerId' in b)) { items=previous.items.map((i: Obj)=>{const p=get(w,'product',i.productId); return {...i,sku:p.sku,name:p.name,unitPriceCents:p.priceCents,lineTotalCents:p.priceCents*i.quantity};}); }
  return {customerId,items,totalCents:items.reduce((sum: number,i: Obj)=>sum+i.lineTotalCents,0)};
}

async function handle(req: Request): Promise<Response> {
  const url=new URL(req.url), p=decodeURIComponent(url.pathname).split('/').filter(Boolean), method=req.method;
  if(p[0]!=='api') {
    const root=resolve('dist'), file=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(file.startsWith(root + '\\') || file.startsWith(root + '/')) { if(existsSync(file) && !file.endsWith('/') && extname(file)) return new Response(Bun.file(file)); }
    return existsSync(join(root,'index.html')) ? new Response(Bun.file(join(root,'index.html'))) : new Response('Build the frontend with bun run build.',{status:503});
  }
  if(url.pathname==='/api/health' && method==='GET') return json({ok:true});
  let body: Obj = {};
  const multipart=req.headers.get('content-type')?.includes('multipart/form-data');
  if(['POST','PATCH'].includes(method) && !multipart) { try { const raw=await req.text(); if(raw.length>1500000) fail(413,'Request is too large'); body=raw ? JSON.parse(raw) : {}; if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Expected a JSON object'); } catch(e) { if(e instanceof HttpError) throw e; fail(400,'Malformed JSON'); } }
  const sid=req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('foundry_session='))?.slice(16);
  let user=sid ? one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=?',sid) : null;
  if(p[1]==='auth') {
    if(p.length!==3) fail(404,'API route not found');
    if(p[2]==='signup' && method==='POST') {
      fields(body,['name','email','password']); const name=text(body.name,'Name',true,200).trim(), em=email(body.email,true).toLowerCase(), password=text(body.password,'Password',true,1000); if(password.length<12) fail(400,'Password must contain at least 12 characters');
      const hash=await Bun.password.hash(password,{algorithm:'argon2id'});
      return db.transaction(()=>{ if(one('SELECT id FROM users WHERE email=?',em)) fail(409,'Email already registered'); const id=uid(),session=token(); run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)',id,name,em,hash); const w=createWorkspace(`${name} workspace`,id); run('INSERT INTO sessions VALUES(?,?,?)',session,id,now()); return json({user:{id,name,email:em},workspace:w},201,{'Set-Cookie':`foundry_session=${session}; HttpOnly; SameSite=Lax; Path=/`}); })();
    }
    if(p[2]==='login' && method==='POST') { const em=email(body.email,true),pass=text(body.password,'Password',true,1000),u=one('SELECT * FROM users WHERE email=?',em); if(!u || !await Bun.password.verify(pass,u.password_hash)) fail(401,'Email or password is incorrect'); const session=token(); run('INSERT INTO sessions VALUES(?,?,?)',session,u.id,now()); return json({user:publicUser(u)},200,{'Set-Cookie':`foundry_session=${session}; HttpOnly; SameSite=Lax; Path=/`}); }
    if(!user) fail(401,'Please sign in');
    if(p[2]==='me' && method==='GET') return json({user:publicUser(user),activeWorkspaceId:user.active_workspace_id,workspaces:workspaces(user.id)});
    if(p[2]==='logout' && method==='POST') { run('DELETE FROM sessions WHERE id=?',sid); return new Response(null,{status:204,headers:{'Set-Cookie':'foundry_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/'}}); }
    fail(404,'API route not found');
  }
  if(!user) fail(401,'Please sign in');
  const u: Obj=user;
  if(p[1]==='workspaces') {
    if(p.length===2 && method==='GET') return json({workspaces:workspaces(u.id)});
    if(p.length===2 && method==='POST') return db.transaction(()=>json({workspace:createWorkspace(text(body.name,'Workspace name',true,200).trim(),u.id)},201))();
    if(p.length===4 && p[3]==='select' && method==='POST') { const w=workspace(p[2]!,u.id); run('UPDATE users SET active_workspace_id=? WHERE id=?',w.id,u.id); return json({workspace:w}); }
  }
  if(p[1]==='invites' && p[2]==='accept' && p.length===3 && method==='POST') return db.transaction(()=>{ const inv=one('SELECT * FROM invites WHERE token=?',text(body.token,'Invite token',true,200)); if(!inv || inv.email.toLowerCase()!==u.email.toLowerCase()) fail(404,'Invite not found'); if(inv.consumed) fail(409,'Invite has already been used'); if(inv.expires_at<now()) fail(404,'Invite has expired'); if(one('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?',inv.workspace_id,u.id)) fail(409,'Already a workspace member'); run('INSERT INTO memberships VALUES(?,?,?)',inv.workspace_id,u.id,inv.role); run('UPDATE invites SET consumed=1 WHERE id=?',inv.id); activity(inv.workspace_id,u,'member.joined','member',u.id); return json({workspace:workspace(inv.workspace_id,u.id)}); })();
  if(p[1]!=='w' || !p[2]) fail(404,'API route not found');
  const w=p[2], ws=workspace(w,u.id), role=ws.role, resource=p[3], id=p[4], action=p[5], q=url.searchParams;
  const endpoint=p.slice(3).join('/');
  const routes: [string,RegExp][]=[
    ['GET POST',/^(customers|products|projects|orders|invoices|invites|stock-movements|attachments)$/],
    ['GET PATCH DELETE',/^(customers|products|projects|orders|tasks)\/[^/]+$/],
    ['GET PATCH',/^invoices\/[^/]+$/],['GET POST',/^projects\/[^/]+\/tasks$/],
    ['GET POST',/^tasks\/[^/]+\/comments$/],['GET',/^(tasks|members|activity|sync|summary|export\.csv)$/],
    ['PATCH DELETE',/^members\/[^/]+$/],['DELETE',/^(comments|attachments)\/[^/]+$/],
    ['GET',/^attachments\/[^/]+\/download$/],['POST',/^orders\/[^/]+\/(fulfill|cancel)$/],
    ['POST',/^import\/customers$/]
  ];
  if(!routes.some(([methods,pattern])=>methods.split(' ').includes(method) && pattern.test(endpoint))) fail(404,'API route not found');
  const read=method==='GET';
  const manager=['owner','manager'].includes(role);
  if(!read) {
    if(['members','invites'].includes(resource!) && role!=='owner') fail(403,'Only the owner can manage the team');
    if(['products','stock-movements','orders','invoices'].includes(resource!) && !manager) fail(403,'A manager role is required');
    if(role==='read_only') fail(403,'This workspace is read only');
  }
  let upload: {file:File;bytes:Uint8Array;entityType:string;entityId:string} | undefined;
  if(resource==='attachments' && method==='POST' && !id) {
    if(!multipart) fail(400,'A multipart file is required');
    if(Number(req.headers.get('content-length')||0)>2200000) fail(413,'Files must be at most 2 MiB');
    let form: FormData; try { form=await req.formData(); } catch { fail(400,'Invalid multipart data'); }
    const file=form.get('file'); if(!(file instanceof File)) fail(400,'Choose a file');
    if(file.size>2*1024*1024) fail(413,'Files must be at most 2 MiB');
    if(/[\r\n\\/]/.test(file.name) || file.name==='.' || file.name==='..') fail(400,'Unsafe filename');
    if(!['.txt','.md','.csv','.pdf','.png','.jpg','.jpeg'].includes(extname(file.name).toLowerCase())) fail(415,'Allowed files: TXT, MD, CSV, PDF, PNG and JPG');
    const entityType=choice(form.get('entityType'),'entity type',['customer','order','task']),entityId=text(form.get('entityId'),'Entity',true);
    upload={file,bytes:new Uint8Array(await file.arrayBuffer()),entityType,entityId};
  }
  // All business reads and writes below are synchronous; a mutation is one SQLite transaction.
  return db.transaction(()=>{
    const currentAccess=workspace(w,u.id);
    if(!read && currentAccess.role!==role) fail(403,'Your role has changed. Please try again');
    if(resource==='sync' && read) return json({revision:one('SELECT revision FROM workspaces WHERE id=?',w).revision});
    if(resource==='members') {
      if(!id && read) return json({members:all('SELECT u.id AS userId,u.name,u.email,m.role FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.rowid',w)});
      if(id && ['PATCH','DELETE'].includes(method)) { const target=one('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?',w,id); if(!target) fail(404,'Member not found'); if(one('SELECT owner_id FROM workspaces WHERE id=?',w).owner_id===id) fail(409,'The original owner cannot be removed or demoted'); if(method==='PATCH') { const r=choice(body.role,'role',['manager','member','read_only']); run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?',r,w,id); activity(w,u,'member.updated','member',id); return json({member:{...one('SELECT id AS userId,name,email FROM users WHERE id=?',id),role:r}}); } run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?',w,id); activity(w,u,'member.removed','member',id); return empty(); }
    }
    if(resource==='invites' && !id) {
      if(role!=='owner') fail(403,'Only the owner can manage invites');
      if(read) return json({invites:all('SELECT id,email,role,expires_at AS expiresAt,consumed FROM invites WHERE workspace_id=?',w)});
      if(method==='POST') { const em=email(body.email,true).toLowerCase(),r=choice(body.role,'role',['manager','member','read_only']),inv={id:uid(),email:em,role:r,token:token(),expiresAt:new Date(Date.now()+7*86400000).toISOString()}; run('INSERT INTO invites(id,workspace_id,email,role,token,expires_at) VALUES(?,?,?,?,?,?)',inv.id,w,em,r,inv.token,inv.expiresAt); activity(w,u,'invite.created','invite',inv.id); return json({invite:inv},201); }
    }
    if(resource==='activity' && read) { const limit=q.has('limit') ? Number(q.get('limit')) : 50; integer(limit,'Limit',1,500); return json({activity:list(w,'activity').reverse().slice(0,limit)}); }
    if(resource==='summary' && read) {
      const customers=list(w,'customer'),products=list(w,'product'),orders=list(w,'order'),invoices=list(w,'invoice'),tasks=list(w,'task');
      return json({customers:customers.length,products:products.length,lowStockProducts:products.filter(p=>p.stock<=5).length,openOrders:orders.filter(o=>o.status==='draft').length,fulfilledOrders:orders.filter(o=>o.status==='fulfilled').length,revenueCents:invoices.filter(i=>i.status==='paid').reduce((s,i)=>s+i.totalCents,0),unpaidCents:invoices.filter(i=>['draft','sent'].includes(i.status)).reduce((s,i)=>s+i.totalCents,0),openTasks:tasks.filter(t=>t.status!=='done').length,completedTasks:tasks.filter(t=>t.status==='done').length});
    }
    if(resource==='export.csv' && read) {
      const types: Obj={customers:['customer','id,name,email,company,notes'],products:['product','id,sku,name,description,priceCents,stock'],orders:['order','id,number,customerId,status,totalCents'],invoices:['invoice','id,number,orderId,status,totalCents'],tasks:['task','id,projectId,title,description,status,priority,assigneeId,dueDate']}; const config=types[q.get('type')||'']; if(!config) fail(400,'Invalid export type'); return new Response(exportCsv(config[1].split(','),list(w,config[0])),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${q.get('type')}.csv"`}});
    }
    if(resource==='import' && id==='customers' && method==='POST') {
      const csv=text(body.csv,'CSV',true,1048576); if(new TextEncoder().encode(csv).length>1048576) fail(400,'CSV exceeds 1 MB'); let rows: string[][]; try {rows=parseCsv(csv);} catch {fail(400,'Invalid CSV quoting');} const header=rows.shift(); if(header?.length!==4 || header.some((cell,i)=>cell!==['name','email','company','notes'][i])) fail(400,'Expected header name,email,company,notes'); if(rows.length>200) fail(400,'Import at most 200 rows'); const seen=new Set<string>();
      const records=rows.map(row=>{if(row.length!==4) fail(400,'Each row needs four fields'); const name=text(row[0],'Name',true,300),em=email(row[1]); unique(w,'customer','email',em); if(em && seen.has(em.toLowerCase())) fail(409,'Duplicate email in CSV'); if(em) seen.add(em.toLowerCase()); return {id:uid(),name,email:em,company:text(row[2],'Company'),notes:text(row[3],'Notes'),createdAt:now(),updatedAt:now()};});
      records.forEach(c=>{put(w,'customer',c); activity(w,u,'customer.created','customer',c.id);}); return json({imported:records.length},201);
    }
    if(resource==='customers' || resource==='products' || resource==='projects') {
      const type=({customers:'customer',products:'product',projects:'project'} as Obj)[resource];
      if(read && !action) { if(id) return json({[type]:get(w,type,id)}); const search=(q.get('q')||'').toLowerCase(); return json({[resource]:list(w,type).filter(r=>!search || (type==='customer' ? [r.name,r.email,r.company] : type==='product' ? [r.name,r.sku,r.description] : [r.name,r.description]).some(s=>s.toLowerCase().includes(search)))}); }
      // Nested project task routes are handled below.
      if(resource==='projects' && action==='tasks') { /* continue */ }
      else if(method==='POST' && !id || method==='PATCH' && id) {
        const previous=id ? get(w,type,id) : undefined,b=body; let value: Obj=previous ? {...previous} : {id:uid(),createdAt:now()};
        if(type==='customer') { fields(b,['name','email','company','notes']); if('name' in b || !id) value.name=text(b.name,'Name',true,300); for(const k of ['email','company','notes']) if(k in b || !id) value[k]=k==='email' ? email(b[k]??'') : text(b[k]??'',k); unique(w,type,'email',value.email,id); }
        if(type==='product') { fields(b,['sku','name','description','priceCents']); if('sku' in b || !id) value.sku=text(b.sku,'SKU',true,100).trim().toUpperCase(); if('name' in b || !id) value.name=text(b.name,'Product name',true,300); if('description' in b || !id) value.description=text(b.description??'','Description'); if('priceCents' in b || !id) value.priceCents=integer(b.priceCents,'Price cents',0,100000000); if(!id) value.stock=0; unique(w,type,'sku',value.sku,id); }
        if(type==='project') { fields(b,['name','description']); if('name' in b || !id) value.name=text(b.name,'Project name',true,300); if('description' in b || !id) value.description=text(b.description??'','Description'); }
        value.updatedAt=now(); put(w,type,value); activity(w,u,`${type}.${id?'updated':'created'}`,type,value.id); return json({[type]:value},id?200:201);
      } else if(method==='DELETE' && id) {
        get(w,type,id);
        if(type==='customer' && [...list(w,'order'),...list(w,'invoice')].some(r=>r.customerId===id)) fail(409,'Customer is referenced by an order or invoice');
        if(type==='product' && (list(w,'movement').some(r=>r.productId===id) || list(w,'order').some(o=>o.items.some((i: Obj)=>i.productId===id)))) fail(409,'Product has stock history or order lines');
        if(type==='project') for(const task of list(w,'task').filter(t=>t.projectId===id)) { for(const c of list(w,'comment').filter(c=>c.taskId===task.id)) remove(w,'comment',c.id); deleteAttachments(w,'task',task.id); remove(w,'task',task.id); }
        deleteAttachments(w,type,id); remove(w,type,id); activity(w,u,`${type}.deleted`,type,id); return empty();
      }
    }
    if(resource==='stock-movements' && !id) {
      if(read) { if(q.has('productId')) get(w,'product',q.get('productId')!); return json({movements:list(w,'movement').filter(m=>!q.has('productId') || m.productId===q.get('productId')).reverse()}); }
      if(method==='POST') { fields(body,['productId','delta','reason']); const product=get(w,'product',text(body.productId,'Product',true)),delta=integer(body.delta,'Delta',-1000000000,1000000000),reason=text(body.reason,'Reason',true,2000); if(delta===0) fail(400,'Delta must be nonzero'); if(product.stock+delta<0 || product.stock+delta>1000000000) fail(409,'Stock must remain between 0 and 1,000,000,000'); product.stock+=delta; product.updatedAt=now(); const movement={id:uid(),productId:product.id,delta,reason,kind:'adjustment',orderId:null,createdBy:u.id,createdAt:now()}; put(w,'product',product); put(w,'movement',movement); activity(w,u,'stock.adjusted','product',product.id); return json({movement,product},201); }
    }
    if(resource==='orders') {
      if(read) { if(id) return json({order:get(w,'order',id)}); const status=q.get('status'); if(status) choice(status,'status',['draft','fulfilled','cancelled']); return json({orders:list(w,'order').filter(o=>!status || o.status===status)}); }
      if(method==='POST' && !id) { const values=orderValues(w,body),order={id:uid(),number:number(w,'order','ORD'),...values,status:'draft',createdAt:now(),updatedAt:now(),fulfilledAt:null}; put(w,'order',order); activity(w,u,'order.created','order',order.id); return json({order},201); }
      if(id) {
        const order=get(w,'order',id);
        if(method==='POST' && action==='fulfill') {
          fields(body,['idempotencyKey']); const key=text(body.idempotencyKey,'Idempotency key',true,100); if(key.length<8) fail(400,'Idempotency key must have 8 to 100 characters'); const cached=one('SELECT * FROM idempotency WHERE workspace_id=? AND key=?',w,key); if(cached) { if(cached.order_id!==id) fail(409,'Key was used for a different order'); return json({order:JSON.parse(cached.result),replayed:true}); }
          if(order.status!=='draft') fail(409,'Only a draft order can be fulfilled');
          const products=order.items.map((i: Obj)=>{const p=get(w,'product',i.productId); if(p.stock<i.quantity) fail(409,`Insufficient stock for ${p.sku}`); return p;});
          for(let i=0;i<products.length;i++) { const product=products[i],line=order.items[i]; product.stock-=line.quantity; product.updatedAt=now(); put(w,'product',product); put(w,'movement',{id:uid(),productId:product.id,delta:-line.quantity,reason:`Fulfilled ${order.number}`,kind:'fulfillment',orderId:id,createdBy:u.id,createdAt:now()}); }
          order.status='fulfilled'; order.fulfilledAt=now(); order.updatedAt=now(); put(w,'order',order); run('INSERT INTO idempotency VALUES(?,?,?,?)',w,key,id,JSON.stringify(order)); activity(w,u,'order.fulfilled','order',id); return json({order,replayed:false});
        }
        if(method==='POST' && action==='cancel') { if(order.status!=='draft') fail(409,'Only draft orders can be cancelled'); order.status='cancelled'; order.updatedAt=now(); put(w,'order',order); activity(w,u,'order.cancelled','order',id); return json({order}); }
        if(method==='PATCH' && !action) { if(order.status!=='draft') fail(409,'Only draft orders can be edited'); Object.assign(order,orderValues(w,body,order),{updatedAt:now()}); put(w,'order',order); activity(w,u,'order.updated','order',id); return json({order}); }
        if(method==='DELETE' && !action) { if(order.status!=='draft') fail(409,'Only draft orders can be deleted'); deleteAttachments(w,'order',id); remove(w,'order',id); activity(w,u,'order.deleted','order',id); return empty(); }
      }
    }
    if(resource==='invoices') {
      if(read) { if(id) return json({invoice:get(w,'invoice',id)}); const status=q.get('status'); if(status) choice(status,'status',['draft','sent','paid','void']); return json({invoices:list(w,'invoice').filter(i=>!status || i.status===status)}); }
      if(method==='POST' && !id) { fields(body,['orderId']); const order=get(w,'order',text(body.orderId,'Order',true)); if(order.status!=='fulfilled') fail(409,'Fulfill the order before invoicing'); if(list(w,'invoice').some(i=>i.orderId===order.id)) fail(409,'An invoice already exists for this order'); const c=get(w,'customer',order.customerId),invoice={id:uid(),number:number(w,'invoice','INV'),orderId:order.id,customerId:c.id,billTo:{name:c.name,email:c.email,company:c.company},status:'draft',currency:'USD',items:order.items,subtotalCents:order.totalCents,totalCents:order.totalCents,createdAt:now(),paidAt:null}; put(w,'invoice',invoice); activity(w,u,'invoice.created','invoice',invoice.id); return json({invoice},201); }
      if(method==='PATCH' && id) { fields(body,['status']); const invoice=get(w,'invoice',id),status=choice(body.status,'status',['sent','paid','void']); if(!(invoice.status==='draft' && ['sent','void'].includes(status) || invoice.status==='sent' && ['paid','void'].includes(status))) fail(409,'That invoice status transition is not allowed'); invoice.status=status; if(status==='paid') invoice.paidAt=now(); put(w,'invoice',invoice); activity(w,u,`invoice.${status}`,'invoice',id); return json({invoice}); }
    }
    if(resource==='tasks' || resource==='projects' && action==='tasks') {
      const projectId=resource==='projects' ? id : q.get('projectId'); if(projectId) get(w,'project',projectId);
      if(resource==='tasks' && id && action==='comments') {
        get(w,'task',id);
        if(read) return json({comments:list(w,'comment').filter(c=>c.taskId===id)});
        if(method==='POST') { fields(body,['body']); const comment={id:uid(),taskId:id,body:text(body.body,'Comment',true,2000),author:{id:u.id,name:u.name},createdAt:now()}; put(w,'comment',comment); activity(w,u,'comment.created','comment',comment.id); return json({comment},201); }
      }
      if(read) {
        if(resource==='tasks' && id) return json({task:get(w,'task',id)});
        const search=(q.get('q')||'').toLowerCase(),status=q.get('status'),priority=q.get('priority'),assignee=q.get('assigneeId'); if(status) choice(status,'status',['todo','in_progress','done']); if(priority) choice(priority,'priority',['low','medium','high']);
        return json({tasks:list(w,'task').filter(t=>(!projectId || t.projectId===projectId) && (!search || [t.title,t.description].some((s:string)=>s.toLowerCase().includes(search))) && (!status || t.status===status) && (!priority || t.priority===priority) && (!assignee || t.assigneeId===assignee))});
      }
      if(method==='POST' && resource==='projects' && projectId) { const values=taskValues(w,body),task={...values,id:uid(),projectId,createdAt:now(),updatedAt:now()}; put(w,'task',task); activity(w,u,'task.created','task',task.id); return json({task},201); }
      if(resource==='tasks' && id && !action && method==='PATCH') { const task=taskValues(w,body,get(w,'task',id)); task.updatedAt=now(); put(w,'task',task); activity(w,u,'task.updated','task',id); return json({task}); }
      if(resource==='tasks' && id && !action && method==='DELETE') { get(w,'task',id); for(const c of list(w,'comment').filter(c=>c.taskId===id)) remove(w,'comment',c.id); deleteAttachments(w,'task',id); remove(w,'task',id); activity(w,u,'task.deleted','task',id); return empty(); }
    }
    if(resource==='comments' && id && method==='DELETE') { const comment=get(w,'comment',id); own(role,u,comment); remove(w,'comment',id); activity(w,u,'comment.deleted','comment',id); return empty(); }
    if(resource==='attachments') {
      if(!id && read) { const type=choice(q.get('entityType'),'entity type',['customer','order','task']),entityId=text(q.get('entityId'),'Entity',true); get(w,type,entityId); return json({attachments:list(w,'attachment').filter(a=>a.entityType===type && a.entityId===entityId)}); }
      if(!id && method==='POST' && upload) { const {file,bytes,entityType,entityId}=upload; get(w,entityType,entityId); const aid=uid(); const mime: Obj={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}; const attachment={id:aid,entityType,entityId,fileName:file.name,size:file.size,mimeType:mime[extname(file.name).toLowerCase()],createdBy:u.id,createdAt:now()}; writeFileSync(join(dataDir,'attachments',aid),bytes); put(w,'attachment',attachment); activity(w,u,'attachment.created','attachment',aid); return json({attachment},201); }
      if(id && read && action==='download') { const a=get(w,'attachment',id); const bytes=readFileSync(join(dataDir,'attachments',id)); return new Response(bytes,{headers:{'Content-Type':a.mimeType,'Content-Disposition':`attachment; filename="${a.fileName.replaceAll('"','_').replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,'X-Content-Type-Options':'nosniff'}}); }
      if(id && method==='DELETE') { const a=get(w,'attachment',id); own(role,u,a); remove(w,'attachment',id); const file=join(dataDir,'attachments',id); if(existsSync(file)) unlinkSync(file); activity(w,u,'attachment.deleted','attachment',id); return empty(); }
    }
    fail(404,'API route not found');
  })();
}

const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT||3000),maxRequestBodySize:4*1024*1024,
  async fetch(req) { try { const response=await handle(req); response.headers.set('X-Content-Type-Options','nosniff'); response.headers.set('Cache-Control','no-store'); response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"); return response; } catch(e) { if(e instanceof HttpError) return json({error:{code:e.code,message:e.message}},e.status); console.error('Request failed:',e instanceof Error ? e.message : 'Unknown error'); return json({error:{code:'internal_error',message:'An unexpected error occurred'}},500); } }
});
console.log(`Foundry listening on http://127.0.0.1:${server.port}`);
