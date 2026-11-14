import { store, id, now, audit, auditEvents, jobLogs } from './db';
import { createRun, cancelRun, retryRun, wakeWorkers } from './worker';
import { ApiError, fail, body, string, integer, boolean, enumeration, steps, canonical } from './validation';

const releaseStatuses = ['draft','awaiting_approval','ready','running','succeeded','failed','cancelled','rolled_back'] as const;
const jobStatuses = ['queued','running','succeeded','failed','blocked','cancelled'] as const;
const incidentStatuses = ['open','mitigated','resolved'] as const;
const severities = ['sev1','sev2','sev3'] as const;
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, {status,headers});
const empty = () => new Response(null, {status:204});
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value,key);
const required = (table:string, entityId:string, projectId?:string):any => {
  const value = store.get(table, entityId);
  if (!value || (projectId && value.projectId !== projectId)) fail(404, 'The requested resource was not found.');
  return value;
};
const scoped = (table:string, projectId:string):any[] => store.all(table).filter((r:any) => r.projectId === projectId);
const matches = (q:string|null, ...values:unknown[]) => !q || values.some(v => typeof v === 'string' && v.toLowerCase().includes(q.toLowerCase()));
const publicJob = (j:any) => { const {durationMs,failureMode,projectId,actorId,...value} = j; return value; };
const publicArtifact = (a:any) => { const {content,...value} = a; return value; };
function tokenFrom(req:Request):string|null {
  const match = (req.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('harbor_session='));
  return match ? match.slice('harbor_session='.length) : null;
}
function actorFrom(req:Request):any {
  const token = tokenFrom(req), session = token && store.get('sessions',token);
  const actor = session && store.get('actors',session.actorId);
  if (!actor) fail(401, 'Select a local actor to continue.');
  return actor;
}
function writer(actor:any) { if (actor.role === 'viewer') fail(403, 'Viewer actors have read-only access.'); }
function admin(actor:any) { if (actor.role !== 'admin') fail(403, 'This action requires an administrator.'); }
function expected(value:unknown, current:number, label:string) {
  integer(value,label);
  if (value !== current) fail(409, `${label} is stale. Refresh the record and try again.`);
}
function slug(value:unknown):string {
  const result = string(value,'Project slug');
  if (!/^[a-z0-9-]{2,40}$/.test(result)) fail(400,'Project slug requires 2–40 lowercase letters, digits or hyphens.');
  return result;
}
function queryEnum(url:URL, key:string, values:readonly string[]) {
  const value = url.searchParams.get(key);
  return value ? enumeration(value,values,key) : '';
}
function timeline(incident:any, actorId:string, type:string, message:string) {
  store.put('timeline',{id:id(),incidentId:incident.id,type,actorId,message,createdAt:now()});
}
function known(path:string):boolean {
  return /^\/api\/(health|actors|session|dashboard|audit|projects|jobs)$/.test(path)
    || /^\/api\/projects\/[^/]+(?:\/(export|environments|runbooks|releases|incidents)(?:\/[^/]+(?:\/(submit|approve|run|cancel|retry|rollback|jobs|artifacts|notes|timeline))?)?)?$/.test(path)
    || /^\/api\/jobs\/[^/]+(?:\/logs)?$/.test(path)
    || /^\/api\/artifacts\/[^/]+\/content$/.test(path);
}

export async function handleApi(req:Request):Promise<Response|null> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (path !== '/api' && !path.startsWith('/api/')) return null;
  try {
    if (!known(path)) fail(404, 'API route not found.');
    if (path === '/api/health' && method === 'GET') return json({ok:true});
    if (path === '/api/actors' && method === 'GET') return json({actors:store.all('actors')});
    if (path === '/api/session') {
      if (method === 'POST') {
        const input = await body(req), actorId = string(input.actorId,'Actor ID');
        const actor = store.get('actors',actorId);
        if (!actor) fail(400,'Unknown local actor.');
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
        store.put('sessions',{id:token,actorId:actor.id,createdAt:now()});
        return json({actor},200,{'Set-Cookie':`harbor_session=${token}; HttpOnly; SameSite=Lax; Path=/`});
      }
      if (method === 'GET') return json({actor:actorFrom(req)});
      if (method === 'DELETE') {
        const token = tokenFrom(req); if (token) store.remove('sessions',token);
        return new Response(null,{status:204,headers:{'Set-Cookie':'harbor_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/'}});
      }
      fail(404,'API route not found.');
    }
    const actor = actorFrom(req);
    if (method !== 'GET') writer(actor);
    const input = ['POST','PATCH'].includes(method) ? await body(req) : {};
    let wake = false;
    const response = store.transaction(():Response => {
      if (path === '/api/dashboard' && method === 'GET') {
        const environments = store.all('environments'), releases = store.all('releases'), jobs = store.all('jobs'), incidents = store.all('incidents');
        return json({counts:{projects:store.all('projects').length,environments:environments.length,activeReleases:environments.filter((r:any)=>r.activeReleaseId !== null).length,runningJobs:jobs.filter((r:any)=>r.status==='running').length,openIncidents:incidents.filter((r:any)=>r.status==='open'||r.status==='mitigated').length,failedReleases:releases.filter((r:any)=>r.status==='failed').length},recentEvents:auditEvents().slice(-20)});
      }
      if (path === '/api/audit' && method === 'GET') {
        const afterString = url.searchParams.get('after');
        let after = 0;
        if (afterString !== null && afterString !== '') {
          if (!/^\d+$/.test(afterString) || !Number.isSafeInteger(Number(afterString))) fail(400,'Audit after cursor must be a nonnegative integer.');
          after = Number(afterString);
        }
        const projectId = url.searchParams.get('projectId'), type = url.searchParams.get('type');
        return json({events:auditEvents().filter((e:any)=>e.sequence>after&&(!projectId||e.projectId===projectId)&&(!type||e.type===type))});
      }
      if (path === '/api/jobs' && method === 'GET') {
        const status = queryEnum(url,'status',jobStatuses), projectId = url.searchParams.get('projectId');
        return json({jobs:store.all('jobs').filter((j:any)=>(!status||j.status===status)&&(!projectId||required('releases',j.releaseId).projectId===projectId)).map(publicJob)});
      }
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/logs)?$/);
      if (jobMatch && method === 'GET') {
        const job = required('jobs',jobMatch[1]);
        return jobMatch[2] ? json({logs:jobLogs(job.id)}) : json({job:publicJob(job)});
      }
      const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)\/content$/);
      if (artifactMatch && method === 'GET') {
        const artifact = required('artifacts',artifactMatch[1]);
        return new Response(artifact.content,{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${artifact.name}"`}});
      }
      if (path === '/api/projects') {
        if (method === 'GET') return json({projects:store.all('projects').filter((p:any)=>matches(url.searchParams.get('q'),p.name,p.slug,p.description))});
        if (method === 'POST') {
          const name = string(input.name,'Project name'), valueSlug = slug(input.slug), description = own(input,'description') ? string(input.description,'Project description',false) : '';
          if (store.all('projects').some((p:any)=>p.slug===valueSlug)) fail(409,'This project slug already exists.');
          const time = now(), project = {id:id(),name,slug:valueSlug,description,createdAt:time,updatedAt:time};
          store.put('projects',project); audit(project.id,actor.id,'project.created',project.id,{name,slug:valueSlug});
          return json({project},201);
        }
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(environments|runbooks|releases|incidents|export)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/);
      if (!projectMatch) fail(404,'API route not found.');
      const [,projectId,collection,entityId,action] = projectMatch;
      let project = required('projects',projectId);
      if (!collection) {
        if (method === 'GET') return json({project});
        if (method === 'PATCH') {
          const updates:any = {};
          if (own(input,'name')) updates.name = string(input.name,'Project name');
          if (own(input,'slug')) {
            updates.slug = slug(input.slug);
            if (store.all('projects').some((p:any)=>p.id!==project.id&&p.slug===updates.slug)) fail(409,'This project slug already exists.');
          }
          if (own(input,'description')) updates.description = string(input.description,'Project description',false);
          project = {...project,...updates,updatedAt:now()}; store.put('projects',project); audit(project.id,actor.id,'project.updated',project.id,updates);
          return json({project});
        }
        if (method === 'DELETE') {
          if (['environments','runbooks','releases','incidents'].some(table=>scoped(table,projectId).length>0)) fail(409,'This project still has referenced resources.');
          store.remove('projects',projectId); audit(projectId,actor.id,'project.deleted',projectId,{name:project.name}); return empty();
        }
      }
      if (collection === 'export' && !entityId && method === 'GET') return json({project,environments:scoped('environments',projectId),runbooks:scoped('runbooks',projectId),releases:scoped('releases',projectId),incidents:scoped('incidents',projectId)},200,{'Content-Disposition':`attachment; filename="${project.slug}-export.json"`});
      if (collection === 'environments') {
        if (!entityId) {
          if (method === 'GET') return json({environments:scoped('environments',projectId)});
          if (method === 'POST') {
            const name = string(input.name,'Environment name'), protectedValue = own(input,'protected') ? boolean(input.protected,'Protected environment') : false;
            if (scoped('environments',projectId).some((e:any)=>e.name.toLowerCase()===name.toLowerCase())) fail(409,'An environment with this name already exists.');
            const time = now(), environment = {id:id(),projectId,name,protected:protectedValue,activeReleaseId:null,createdAt:time,updatedAt:time};
            store.put('environments',environment); audit(projectId,actor.id,'environment.created',environment.id,{name,protected:protectedValue}); return json({environment},201);
          }
        } else if (!action) {
          let environment = required('environments',entityId,projectId);
          if (method === 'GET') return json({environment});
          if (method === 'PATCH') {
            const updates:any = {};
            if (own(input,'name')) {
              updates.name = string(input.name,'Environment name');
              if (scoped('environments',projectId).some((e:any)=>e.id!==entityId&&e.name.toLowerCase()===updates.name.toLowerCase())) fail(409,'An environment with this name already exists.');
            }
            if (own(input,'protected')) updates.protected = boolean(input.protected,'Protected environment');
            environment = {...environment,...updates,updatedAt:now()}; store.put('environments',environment); audit(projectId,actor.id,'environment.updated',entityId,updates); return json({environment});
          }
          if (method === 'DELETE') {
            if (scoped('releases',projectId).some((r:any)=>r.environmentId===entityId) || scoped('incidents',projectId).some((r:any)=>r.environmentId===entityId)) fail(409,'This environment still has referenced resources.');
            store.remove('environments',entityId); audit(projectId,actor.id,'environment.deleted',entityId,{name:environment.name}); return empty();
          }
        }
      }
      if (collection === 'runbooks') {
        if (!entityId) {
          if (method === 'GET') return json({runbooks:scoped('runbooks',projectId)});
          if (method === 'POST') {
            const name = string(input.name,'Runbook name'), description = own(input,'description') ? string(input.description,'Runbook description',false) : '', plan = steps(input.steps), time = now();
            const runbook = {id:id(),projectId,name,description,version:1,steps:plan,createdAt:time,updatedAt:time};
            store.put('runbooks',runbook); audit(projectId,actor.id,'runbook.created',runbook.id,{name,version:1}); return json({runbook},201);
          }
        } else if (!action) {
          let runbook = required('runbooks',entityId,projectId);
          if (method === 'GET') return json({runbook});
          if (method === 'PATCH') {
            expected(input.expectedVersion,runbook.version,'Runbook version');
            const updates:any = {};
            if (own(input,'name')) updates.name = string(input.name,'Runbook name');
            if (own(input,'description')) updates.description = string(input.description,'Runbook description',false);
            if (own(input,'steps')) updates.steps = steps(input.steps);
            runbook = {...runbook,...updates,version:runbook.version+1,updatedAt:now()};
            store.put('runbooks',runbook); audit(projectId,actor.id,'runbook.updated',entityId,{...updates,version:runbook.version}); return json({runbook});
          }
          if (method === 'DELETE') { store.remove('runbooks',entityId); audit(projectId,actor.id,'runbook.deleted',entityId,{name:runbook.name}); return empty(); }
        }
      }
      if (collection === 'releases') {
        if (!entityId) {
          if (method === 'GET') {
            const status = queryEnum(url,'status',releaseStatuses), environmentId = url.searchParams.get('environmentId');
            return json({releases:scoped('releases',projectId).filter((r:any)=>(!status||r.status===status)&&(!environmentId||r.environmentId===environmentId)&&matches(url.searchParams.get('q'),r.title,r.versionLabel,r.notes))});
          }
          if (method === 'POST') {
            const environment = required('environments',string(input.environmentId,'Environment ID'),projectId), title = string(input.title,'Release title'), versionLabel = string(input.versionLabel,'Version label'), notes = own(input,'notes') ? string(input.notes,'Release notes',false) : '';
            if (own(input,'runbookId') === own(input,'steps')) fail(400,'Specify exactly one runbookId or steps.');
            let runbookId = null, runbookVersion = null, plan;
            if (own(input,'runbookId')) { const runbook = required('runbooks',string(input.runbookId,'Runbook ID'),projectId); runbookId = runbook.id; runbookVersion = runbook.version; plan = structuredClone(runbook.steps); }
            else plan = steps(input.steps);
            if (scoped('releases',projectId).some((r:any)=>r.environmentId===environment.id&&r.versionLabel===versionLabel)) fail(409,'This version label already exists in the environment.');
            const time = now(), release = {id:id(),projectId,environmentId:environment.id,title,versionLabel,notes,authorId:actor.id,status:'draft',revision:1,runbookId,runbookVersion,steps:plan,approvals:[],createdAt:time,updatedAt:time,submittedAt:null,startedAt:null,finishedAt:null,previousReleaseId:null};
            store.put('releases',release); audit(projectId,actor.id,'release.created',release.id,{title,versionLabel}); return json({release},201);
          }
        } else {
          let release = required('releases',entityId,projectId);
          if (!action) {
            if (method === 'GET') return json({release});
            if (method === 'PATCH') {
              expected(input.expectedRevision,release.revision,'Release revision');
              if (release.status !== 'draft') fail(409,'Only draft releases can be edited.');
              const updates:any = {};
              if (own(input,'title')) updates.title = string(input.title,'Release title');
              if (own(input,'versionLabel')) {
                updates.versionLabel = string(input.versionLabel,'Version label');
                if (scoped('releases',projectId).some((r:any)=>r.id!==entityId&&r.environmentId===release.environmentId&&r.versionLabel===updates.versionLabel)) fail(409,'This version label already exists in the environment.');
              }
              if (own(input,'notes')) updates.notes = string(input.notes,'Release notes',false);
              if (own(input,'steps')) { updates.steps = steps(input.steps); updates.runbookId = null; updates.runbookVersion = null; }
              release = {...release,...updates,revision:release.revision+1,updatedAt:now()}; store.put('releases',release); audit(projectId,actor.id,'release.updated',entityId,{...updates,revision:release.revision}); return json({release});
            }
          }
          if (action === 'jobs' && method === 'GET') return json({jobs:store.all('jobs').filter((j:any)=>j.releaseId===entityId).map(publicJob)});
          if (action === 'artifacts' && method === 'GET') return json({artifacts:store.all('artifacts').filter((a:any)=>a.releaseId===entityId).map(publicArtifact)});
          if (method === 'POST') {
            if (action === 'submit') {
              expected(input.expectedRevision,release.revision,'Release revision');
              if (release.status !== 'draft') fail(409,'Only draft releases can be submitted.');
              const environment = required('environments',release.environmentId,projectId), time = now();
              release = {...release,status:environment.protected?'awaiting_approval':'ready',revision:release.revision+1,submittedAt:time,updatedAt:time};
              store.put('releases',release); audit(projectId,actor.id,'release.submitted',entityId,{status:release.status,revision:release.revision}); return json({release});
            }
            if (action === 'approve') {
              admin(actor); expected(input.expectedRevision,release.revision,'Release revision');
              const decision = enumeration(input.decision,['approve','reject'],'Approval decision'), comment = string(input.comment,'Approval comment');
              if (release.status !== 'awaiting_approval') fail(409,'This release is not awaiting approval.');
              if (release.authorId === actor.id) fail(409,'Release authors cannot approve or reject their own submissions.');
              const time = now(), revision = release.revision+1, approval = {actorId:actor.id,decision,comment,createdAt:time,revision};
              release = {...release,status:decision==='approve'?'ready':'draft',revision,approvals:[...release.approvals,approval],updatedAt:time};
              store.put('releases',release); audit(projectId,actor.id,decision==='approve'?'release.approved':'release.rejected',entityId,approval); return json({release});
            }
            if (action === 'run') {
              const key = req.headers.get('Idempotency-Key');
              if (!key || !/^[\x20-\x7e]{1,100}$/.test(key)) fail(400,'A printable Idempotency-Key of 1–100 characters is required.');
              const receiptId = `${actor.id}:${key}`, signature = canonical(input), receipt = store.get('receipts',receiptId);
              if (receipt) {
                if (receipt.path !== path || receipt.body !== signature) fail(409,'This idempotency key was used for another request.');
                return json(receipt.response);
              }
              if (Object.keys(input).length) fail(400,'Run accepts an empty JSON object.');
              if (release.status !== 'ready') fail(409,'Only ready releases can run.');
              const result = createRun(release,actor.id), publicResult = {release:result.release,jobs:result.jobs.map(publicJob)};
              store.put('receipts',{id:receiptId,actorId:actor.id,key,path,body:signature,response:publicResult,createdAt:now()}); wake = true; return json(publicResult);
            }
            if (action === 'cancel') {
              const reason = string(input.reason,'Action reason');
              if (release.status !== 'running') fail(409,'Only running releases can be cancelled.');
              release = cancelRun(release,reason,actor.id); wake = true;
              return json({release});
            }
            if (action === 'retry') {
              if (release.status !== 'failed') fail(409,'Only failed releases can be retried.');
              if (Object.keys(input).length) fail(400,'Retry accepts an empty JSON object.');
              release = retryRun(release,actor.id); wake = true; return json({release});
            }
            if (action === 'rollback') {
              admin(actor); const reason = string(input.reason,'Action reason'), environment = required('environments',release.environmentId,projectId);
              const previous = release.previousReleaseId && store.get('releases',release.previousReleaseId);
              if (release.status !== 'succeeded' || environment.activeReleaseId !== entityId || !previous || previous.status !== 'succeeded' || previous.environmentId !== release.environmentId || previous.projectId !== projectId) fail(409,'Rollback requires the active successful release and a previous successful release.');
              const time = now(); release = {...release,status:'rolled_back',updatedAt:time};
              store.put('releases',release); store.put('environments',{...environment,activeReleaseId:previous.id,updatedAt:time}); audit(projectId,actor.id,'release.rolled_back',entityId,{reason,previousReleaseId:previous.id}); return json({release});
            }
          }
        }
      }
      if (collection === 'incidents') {
        if (!entityId) {
          if (method === 'GET') {
            const status = queryEnum(url,'status',incidentStatuses), severity = queryEnum(url,'severity',severities);
            return json({incidents:scoped('incidents',projectId).filter((i:any)=>(!status||i.status===status)&&(!severity||i.severity===severity)&&matches(url.searchParams.get('q'),i.title,i.summary,i.resolution))});
          }
          if (method === 'POST') {
            const environment = required('environments',string(input.environmentId,'Environment ID'),projectId), title = string(input.title,'Incident title'), severity = enumeration(input.severity,severities,'Severity'), summary = own(input,'summary') ? string(input.summary,'Incident summary',false) : '';
            let releaseId = null;
            if (own(input,'releaseId') && input.releaseId !== null) {
              const release = required('releases',string(input.releaseId,'Related release ID'),projectId);
              if (release.environmentId !== environment.id) fail(404,'The related release does not belong to this environment.'); releaseId = release.id;
            }
            const time = now(), incident = {id:id(),projectId,environmentId:environment.id,releaseId,title,severity,status:'open',summary,resolution:'',version:1,createdBy:actor.id,createdAt:time,updatedAt:time,resolvedAt:null};
            store.put('incidents',incident); timeline(incident,actor.id,'incident.created',`Incident opened: ${title}`); audit(projectId,actor.id,'incident.created',incident.id,{title,severity,environmentId:environment.id,releaseId}); return json({incident},201);
          }
        } else {
          let incident = required('incidents',entityId,projectId);
          if (!action) {
            if (method === 'GET') return json({incident});
            if (method === 'PATCH') {
              expected(input.expectedVersion,incident.version,'Incident version');
              const updates:any = {};
              if (own(input,'title')) updates.title = string(input.title,'Incident title');
              if (own(input,'severity')) updates.severity = enumeration(input.severity,severities,'Severity');
              if (own(input,'summary')) updates.summary = string(input.summary,'Incident summary',false);
              if (own(input,'resolution')) updates.resolution = string(input.resolution,'Resolution',false);
              if (own(input,'status')) {
                updates.status = enumeration(input.status,incidentStatuses,'Incident status');
                if (updates.status !== incident.status) {
                  const allowed:Record<string,string[]> = {open:['mitigated','resolved'],mitigated:['open','resolved'],resolved:['open']};
                  if (!allowed[incident.status].includes(updates.status)) fail(409,'This incident status transition is not allowed.');
                  if (updates.status === 'resolved') { updates.resolution = string(input.resolution,'Resolution'); updates.resolvedAt = now(); }
                  if (updates.status === 'open') updates.resolvedAt = null;
                }
              }
              const previousStatus = incident.status;
              incident = {...incident,...updates,version:incident.version+1,updatedAt:now()}; store.put('incidents',incident);
              audit(projectId,actor.id,incident.status!==previousStatus?'incident.status_changed':'incident.updated',entityId,{...updates,previousStatus,version:incident.version});
              if (incident.status !== previousStatus) timeline(incident,actor.id,'incident.status_changed',`Status changed from ${previousStatus} to ${incident.status}${incident.status==='resolved'?`: ${incident.resolution}`:''}`);
              return json({incident});
            }
          }
          if (action === 'notes') {
            if (method === 'GET') return json({notes:store.all('notes').filter((n:any)=>n.incidentId===entityId)});
            if (method === 'POST') {
              const text = string(input.body,'Incident note'); if (text.length>4000) fail(400,'Incident notes may contain at most 4000 characters.');
              const note = {id:id(),incidentId:entityId,actorId:actor.id,body:text,createdAt:now()}; store.put('notes',note); timeline(incident,actor.id,'incident.note',text); audit(projectId,actor.id,'incident.note_added',entityId,{noteId:note.id,body:text}); return json({note},201);
            }
          }
          if (action === 'timeline' && method === 'GET') return json({events:store.all('timeline').filter((e:any)=>e.incidentId===entityId).map(({incidentId,...event}:any)=>event)});
        }
      }
      return fail(404,'API route not found.');
    });
    if (wake) wakeWorkers();
    return response;
  } catch (error) {
    if (error instanceof ApiError) return json({error:{code:error.code,message:error.message}},error.status);
    console.error('Harbor API error',error);
    return json({error:{code:'internal_error',message:'The local operation could not be completed.'}},500);
  }
}
