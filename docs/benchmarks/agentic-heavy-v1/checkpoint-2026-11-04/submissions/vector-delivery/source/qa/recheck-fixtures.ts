// Local QA-fixture preparation only, through the connected public API.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root=join(process.env.DATA_DIR!,'qa-evidence');
const state=JSON.parse(readFileSync(join(root,'browser-state.json'),'utf8'));
const origin='http://127.0.0.1:4123';let cookie='';
async function request(path:string,method='GET',body?:unknown) {
  const response=await fetch(origin+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw new Error(`${response.status}: ${await response.text()}`);
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];
  return response.status===204?null:await response.json();
}
await request('/api/auth/login','POST',{email:'qa-browser-1102@example.invalid',password:'Synthetic-QA-2026!'});
const mode=process.argv[2];
if(mode==='task-progress'){
  const task=(await request(state.w+'/tasks')).tasks.find((t:any)=>t.title==='Prepare launch kit');
  if(!task)throw new Error('QA fixture task missing');
  await request(state.w+'/tasks/'+task.id,'PATCH',{status:'in_progress',priority:'high'});
  console.log('QA fixture reset through API to In progress/High for exact filtered edit recheck.');
}else if(mode==='readonly'||mode==='manager'){
  const member=(await request(state.w+'/members')).members.find((m:any)=>m.email==='qa-ui-member@example.invalid');
  if(!member)throw new Error('QA fixture member missing');
  const result=await request(state.w+'/members/'+member.userId,'PATCH',{role:mode==='readonly'?'read_only':'manager'});
  writeFileSync(join(root,'final-fixture-role.json'),JSON.stringify(result));
  console.log('QA fixture collaborator role: '+result.member.role);
}else throw new Error('Unknown fixture mode');
