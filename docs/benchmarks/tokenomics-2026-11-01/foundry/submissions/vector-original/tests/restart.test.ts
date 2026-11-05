import { test,expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
test('sessions, memberships, snapshots, files, revision and idempotency survive a full server restart',async()=>{
  const s=JSON.parse(readFileSync(join(resolve(process.env.DATA_DIR||'.foundry-data'),'verification','api-state.json'),'utf8'));
  const base=`http://127.0.0.1:${process.env.PORT||3000}/api`,W=`/w/${s.workspaceId}`;
  async function api(path:string,method='GET',body?:any,cookie=s.a.cookie){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});expect(r.status).toBe(200);return r.headers.get('content-type')?.includes('json')?r.json():r.text();}
  expect((await api('/auth/me')).user.id).toBe(s.a.user.id);
  expect((await api(W+'/summary'))).toEqual(s.summary);
  expect((await api(W+'/sync')).revision).toBe(s.revision);
  expect((await api(W+`/orders/${s.orderId}/fulfill`,'POST',{idempotencyKey:s.key}))).toEqual({order:s.fulfilled,replayed:true});
  expect((await api(W+'/sync')).revision).toBe(s.revision);
  expect((await api(W+'/invoices/'+s.invoiceId)).invoice.status).toBe('paid');
  expect((await api(W+'/tasks/'+s.taskId)).task.title).toBe('Ship the sample');
  expect((await api(W+`/attachments/${s.attachmentId}/download`))).toBe('Exact file bytes\r\nwith unicode: café');
  expect((await api('/auth/me','GET',undefined,s.r.cookie)).workspaces.some((w:any)=>w.id===s.workspaceId&&w.role==='read_only')).toBe(true);
});
