import { createServer } from 'node:http'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.DATA_DIR
const path = join(dir, 'ledger.json')
const lockPath = join(dir, 'ledger.lock')
mkdirSync(dir, {recursive:true})
try {
  const fd = openSync(lockPath, 'wx')
  writeFileSync(fd, String(process.pid)); fsyncSync(fd); closeSync(fd)
} catch(error) {
  if(error.code!=='EEXIST') throw error
  const pid = Number(readFileSync(lockPath, 'utf8'))
  let live = true
  try {process.kill(pid,0)} catch(error) {if(error.code==='ESRCH')live=false;else throw error}
  if(live || !Number.isSafeInteger(pid) || pid<1) throw Error('another data owner is live or ambiguous')
  unlinkSync(lockPath)
  const fd = openSync(lockPath, 'wx')
  writeFileSync(fd,String(process.pid)); fsyncSync(fd); closeSync(fd)
}
const hash = value => createHash('sha256').update(value).digest('hex')
function canon(value) {
  if(Array.isArray(value))return '['+value.map(canon).join(',')+']'
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canon(value[k])).join(',')+'}'
  return JSON.stringify(value)
}
const text = v=>typeof v==='string'&&v.trim().length>0&&v.length<=200
const uint = v=>Number.isSafeInteger(v)&&v>=0
const positive = v=>uint(v)&&v>0
const object = v=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const planValid = p=>object(p)&&uint(p.baseCents)&&uint(p.includedUnits)&&uint(p.unitCents)
function dateValid(v){
  if(typeof v!=='string')return false
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(v)
  if(!m||!Number.isFinite(Date.parse(v)))return false
  const y=+m[1], mo=+m[2], d=+m[3], end=new Date(0)
  end.setUTCFullYear(y,mo,0)
  return mo>=1&&mo<=12&&d>=1&&d<=end.getUTCDate()&&+m[4]<24&&+m[5]<60&&+m[6]<60
}
function validLegacy(v){
  if(!object(v)||v.version!==1||!Array.isArray(v.accounts)||!Array.isArray(v.usage))return false
  const ids=new Set(),events=new Set()
  for(const a of v.accounts){
    if(!object(a)||!text(a.id)||!text(a.workspaceId)||!text(a.name)||!planValid(a.plan)||ids.has(a.id))return false
    ids.add(a.id)
  }
  for(const u of v.usage){
    const a=v.accounts.find(a=>a.id===u.accountId&&a.workspaceId===u.workspaceId)
    if(!object(u)||!text(u.id)||!text(u.eventId)||!positive(u.units)||!dateValid(u.occurredAt)||!a||events.has(u.id))return false
    events.add(u.id)
  }
  return true
}
let data
function persist(){
  const envelope={version:2,payload:data,checksum:hash(canon(data))}
  const temporary=path+'.'+randomUUID()+'.tmp'
  const fd=openSync(temporary,'wx')
  try {writeFileSync(fd,JSON.stringify(envelope));fsyncSync(fd)}finally{closeSync(fd)}
  renameSync(temporary,path)
}
if(existsSync(path)){
  const bytes=readFileSync(path), value=JSON.parse(bytes)
  if(value.version===1){
    if(!validLegacy(value))throw Error('invalid legacy data')
    const backup=join(dir,'ledger.v1.backup.json')
    if(existsSync(backup)){if(!readFileSync(backup).equals(bytes))throw Error('conflicting migration backup')}
    else {const fd=openSync(backup,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}}
    data={accounts:value.accounts,usage:value.usage,invoices:[],credits:[],keys:[],idempotency:[]}
    persist()
  }else if(value.version===2){
    if(!object(value.payload)||value.checksum!==hash(canon(value.payload)))throw Error('corrupt data checksum')
    data=value.payload
    if(!['accounts','usage','invoices','credits','keys','idempotency'].every(x=>Array.isArray(data[x])))throw Error('invalid v2 shape')
    if(!validLegacy({version:1,accounts:data.accounts,usage:data.usage}))throw Error('invalid durable accounts or usage')
  }else throw Error('unknown storage version')
}else {data={accounts:[],usage:[],invoices:[],credits:[],keys:[],idempotency:[]};persist()}

function fail(status,code,message){const e=Error(message);e.status=status;e.code=code;throw e}
function requireRole(p,roles){if(!roles.includes(p.role))fail(403,'forbidden','Role is not authorized for this operation')}
const defaults=new Map([
  ['owner-acme',{workspaceId:'acme',role:'owner'}],['billing-acme',{workspaceId:'acme',role:'billing'}],
  ['reader-acme',{workspaceId:'acme',role:'reader'}],['owner-beta',{workspaceId:'beta',role:'owner'}]
])
function auth(raw){
  const token=typeof raw==='string'&&raw.startsWith('Bearer ')?raw.slice(7):''
  const tokenHash=hash(token)
  if(defaults.has(token))return {...defaults.get(token),actorId:tokenHash}
  const key=data.keys.find(x=>x.tokenHash===tokenHash&&!x.revoked)
  if(!key)fail(401,'unauthorized','A current valid API key is required')
  return {...key,actorId:tokenHash}
}
function allowed(p,a){return a.workspaceId===p.workspaceId&&(!p.accountIds||p.accountIds.includes(a.id))}
function account(p,id){const a=data.accounts.find(a=>a.id===id&&allowed(p,a));if(!a)fail(404,'not_found','Account not found');return a}
function invoice(p,id){const i=data.invoices.find(i=>i.id===id&&i.workspaceId===p.workspaceId);if(!i)fail(404,'not_found','Invoice not found');account(p,i.accountId);return i}
function periodBounds(v){
  if(typeof v!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(v))fail(400,'invalid_period','A valid UTC month is required')
  const start=new Date(v+'-01T00:00:00.000Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1)
  return [+start,+end]
}
function usageRows(a,period){
  let rows=data.usage.filter(u=>u.accountId===a.id&&u.workspaceId===a.workspaceId)
  if(period!==undefined&&period!==null){const [a,b]=periodBounds(period);rows=rows.filter(u=>Date.parse(u.occurredAt)>=a&&Date.parse(u.occurredAt)<b)}
  return rows
}
function quote(a,period){
  periodBounds(period)
  const totalUnits=usageRows(a,period).reduce((n,u)=>n+u.units,0),overageUnits=Math.max(0,totalUnits-a.plan.includedUnits)
  const totalCents=a.plan.baseCents+overageUnits*a.plan.unitCents
  if(!uint(totalUnits)||!uint(totalCents))fail(400,'unsafe_arithmetic','Requested values exceed safe integer arithmetic')
  return {accountId:a.id,period,totalUnits,...a.plan,overageUnits,totalCents}
}
function invoiceView(i){const creditedCents=data.credits.filter(c=>c.invoiceId===i.id).reduce((n,c)=>n+c.amountCents,0);return {...i,creditedCents,balanceCents:i.totalCents-creditedCents}}
function transaction(fn){const before=structuredClone(data);try{const result=fn();persist();return result}catch(error){data=before;throw error}}
function idem(p,scope,body,fn){
  if(!text(body.requestId))fail(400,'invalid_request','A request ID is required')
  const key=p.workspaceId+':'+p.actorId+':'+scope+':'+body.requestId
  const signature=hash(canon(body)),prior=data.idempotency.find(x=>x.key===key)
  if(prior){if(prior.signature!==signature)fail(409,'idempotency_conflict','Request ID already has a different payload');return [200,prior.result]}
  return transaction(()=>{const result=fn();data.idempotency.push({key,signature,result});return [201,result]})
}
async function body(req){
  const chunks=[];let bytes=0
  for await(const part of req){bytes+=part.length;if(bytes>65536)fail(413,'body_too_large','Request body is too large');chunks.push(Buffer.from(part))}
  const value=Buffer.concat(chunks).toString('utf8')
  let result;try{result=JSON.parse(value||'{}')}catch{fail(400,'invalid_json','A JSON object is required')}
  if(!object(result))fail(400,'invalid_json','A JSON object is required')
  return result
}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,version:2})
    let p=auth(req.headers.authorization)
    const b=['POST','PUT','PATCH'].includes(req.method)?await body(req):undefined
    // Reauthorization after body arrival fences revocation during an admitted request.
    if(b!==undefined)p=auth(req.headers.authorization)
    if(route[0]!=='api')fail(404,'not_found','Route not found')
    if(route[1]==='accounts'&&route.length===2){
      if(req.method==='GET')return send(res,200,data.accounts.filter(a=>allowed(p,a)))
      if(req.method==='POST'){
        requireRole(p,['owner']);if(!text(b.name)||!planValid(b.plan))fail(400,'invalid_account','A valid account name and plan are required')
        const a=transaction(()=>{const a={id:randomUUID(),workspaceId:p.workspaceId,name:b.name,plan:b.plan};data.accounts.push(a);return a})
        return send(res,201,a)
      }
    }
    if(route[1]==='accounts'&&route.length>=3){
      const a=account(p,route[2])
      if(route.length===3&&req.method==='GET')return send(res,200,a)
      if(route[3]==='usage'&&route.length===4){
        if(req.method==='GET')return send(res,200,usageRows(a,url.searchParams.get('period')))
        if(req.method==='POST'){
          requireRole(p,['owner','billing'])
          if(!text(b.eventId)||!positive(b.units)||!dateValid(b.occurredAt))fail(400,'invalid_usage','A valid event, units and timezone timestamp are required')
          const old=data.usage.find(x=>x.accountId===a.id&&x.eventId===b.eventId)
          if(old){if(old.units!==b.units||old.occurredAt!==b.occurredAt)fail(409,'event_conflict','Event ID already has different values');return send(res,200,old)}
          const u=transaction(()=>{const u={id:randomUUID(),workspaceId:a.workspaceId,accountId:a.id,eventId:b.eventId,units:b.units,occurredAt:b.occurredAt};data.usage.push(u);return u})
          return send(res,201,u)
        }
      }
      if(route[3]==='quote'&&route.length===4&&req.method==='GET')return send(res,200,quote(a,url.searchParams.get('period')))
      if(route[3]==='invoices'&&route.length===4&&req.method==='POST'){
        requireRole(p,['owner','billing']);periodBounds(b.period)
        const [status,value]=idem(p,'invoice:'+a.id,b,()=>{
          if(data.invoices.some(i=>i.accountId===a.id&&i.period===b.period))fail(409,'invoice_exists','The account period was already issued')
          const q=quote(a,b.period),i={id:randomUUID(),workspaceId:a.workspaceId,...q,status:'issued',lines:[
            {kind:'base',quantity:1,unitCents:q.baseCents,amountCents:q.baseCents},
            {kind:'overage',quantity:q.overageUnits,unitCents:q.unitCents,amountCents:q.overageUnits*q.unitCents}]}
          data.invoices.push(i);return invoiceView(i)
        });return send(res,status,value)
      }
    }
    if(route[1]==='invoices'&&route.length>=3){
      const i=invoice(p,route[2])
      if(route.length===3&&req.method==='GET')return send(res,200,invoiceView(i))
      if(route[3]==='credits'&&route.length===4){
        if(req.method==='GET')return send(res,200,data.credits.filter(c=>c.invoiceId===i.id))
        if(req.method==='POST'){
          requireRole(p,['owner','billing']);if(!positive(b.amountCents)||!text(b.reason))fail(400,'invalid_credit','A positive credit amount and reason are required')
          const normalized={...b,reason:b.reason.trim()}
          const [status,value]=idem(p,'credit:'+i.id,normalized,()=>{
            if(b.amountCents>invoiceView(i).balanceCents)fail(409,'credit_limit','Credit would exceed the issued total')
            const c={id:randomUUID(),workspaceId:i.workspaceId,invoiceId:i.id,amountCents:b.amountCents,reason:normalized.reason};data.credits.push(c);return c
          });return send(res,status,value)
        }
      }
    }
    if(route[1]==='access-keys'){
      requireRole(p,['owner'])
      if(route.length===2&&req.method==='POST'){
        if(!['billing','reader'].includes(b.role))fail(400,'invalid_role','A billing or reader role is required')
        if(b.accountIds!==undefined&&(!Array.isArray(b.accountIds)||!b.accountIds.length||new Set(b.accountIds).size!==b.accountIds.length
          ||b.accountIds.some(id=>!data.accounts.some(a=>a.id===id&&a.workspaceId===p.workspaceId))))fail(400,'invalid_scope','Scope must identify distinct existing accounts')
        const raw=randomBytes(32).toString('base64url'),id=randomUUID()
        transaction(()=>data.keys.push({id,tokenHash:hash(raw),workspaceId:p.workspaceId,role:b.role,
          ...(b.accountIds?{accountIds:b.accountIds}:{}),revoked:false}))
        return send(res,201,{id,apiKey:raw,role:b.role,...(b.accountIds?{accountIds:b.accountIds}:{})})
      }
      if(route.length===4&&route[3]==='revoke'&&req.method==='POST'){
        const key=data.keys.find(k=>k.id===route[2]&&k.workspaceId===p.workspaceId)
        if(!key)fail(404,'not_found','Key not found')
        transaction(()=>{key.revoked=true});return send(res,200,{revoked:true})
      }
    }
    fail(404,'not_found','Route not found')
  }catch(error){send(res,error.status||500,{error:{code:error.code||'internal_error',message:error.status?error.message:'Internal operation failed'}})}
})
server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('LedgerDesk ready'))
function stop(){server.close(()=>{try{if(readFileSync(lockPath,'utf8')===String(process.pid))unlinkSync(lockPath)}catch{}process.exit(0)})}
process.on('SIGTERM',stop);process.on('SIGINT',stop)
