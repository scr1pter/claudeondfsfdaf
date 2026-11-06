import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, rename } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createClient, RelayError } from '../sdk.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.DATA_DIR ?? '');
const relation = relative(source, root);
assert.ok(process.env.DATA_DIR && isAbsolute(process.env.DATA_DIR) && (relation.startsWith('..') || isAbsolute(relation)), 'Use DATA_DIR outside source');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'independent-qa-'));
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const bootstrap = randomBytes(32).toString('hex');
const env = { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap };
const children = new Set();
const findings = [];
let checks = 0;
let base;
let live;
const csv = 'op,external_id,name,email\nupsert,a,Alpha,a@example.test';
const p = '/v1/workspaces/qaspace';
const ok = (condition, label) => { checks++; assert.ok(condition, label); };
const equal = (actual, expected, label) => { checks++; assert.deepEqual(actual, expected, label); };
const find = (id, actual, expected, detail) => {
  checks++;
  if (actual !== expected) findings.push({ id, actual, expected, detail });
};

async function launch(dataDir, expectingReady = true) {
  const child = spawn(runtime, [join(source, 'app.mjs'), '--data', dataDir, '--port', '0'], { env });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const exited = once(child, 'exit').then(([code]) => { children.delete(child); return code; });
  if (!expectingReady) {
    const readiness = new Promise(resolveReady => child.stdout.on('data', () => { if (stdout.includes('"ready":true')) resolveReady('ready'); }));
    const outcome = await Promise.race([exited, readiness, new Promise((_, reject) => setTimeout(() => reject(Error('Startup deadline')), 8000).unref())]);
    if (outcome === 'ready') { child.stdin.write('shutdown\n'); await exited; return { ready: true }; }
    ok(outcome !== 0, 'Unsafe startup is refused'); ok(!stdout.includes('"ready":true'), 'No readiness on failure');
    return { code: outcome, stdout, stderr, ready: false };
  }
  const info = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error('Readiness deadline')), 8000);
    child.stdout.on('data', () => {
      if (!stdout.includes('\n')) return;
      clearTimeout(timer); resolveReady(JSON.parse(stdout.split('\n')[0]));
    });
    exited.then(() => { clearTimeout(timer); reject(Error('Premature exit')); });
  });
  ok(info.ready === true && info.port > 0, 'Valid readiness first line');
  return { child, exited, base: `http://127.0.0.1:${info.port}`, stop: async ({ allowFailure = false } = {}) => {
    child.stdin.write('shutdown\n');
    const exitCode = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('Stop deadline')), 8000).unref())]);
    if (!allowFailure) equal(exitCode, 0);
    ok(!stdout.includes(bootstrap) && !stderr.includes(bootstrap), 'No bootstrap logs');
    return exitCode;
  } };
}

async function api(path, token, body, key, raw = false) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(key ? { 'Idempotency-Key': key } : {}),
  }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
  const value = await response.json();
  return { status: response.status, value };
}

async function approvalReplay(importId, approverToken, otherToken, expectedState, label) {
  const before = (await api(`${p}/imports/${importId}`, approverToken)).value;
  const beforeEvents = (await api(`${p}/events?limit=100`, approverToken)).value;
  const beforeMembers = (await api(`${p}/members`, approverToken)).value;
  equal(before.import.state, expectedState);
  const replay = await api(`${p}/imports/${importId}/approve`, approverToken, {});
  find(`APPROVAL_REPLAY_${label}`, replay.status, 200, 'An existing approval retry by approvedBy succeeds after later transitions');
  if (replay.status === 200) equal(replay.value, before, 'Approval replay returns the current unchanged import');
  equal((await api(`${p}/imports/${importId}`, approverToken)).value, before, 'Approval replay preserves state, approvedBy and epoch');
  equal((await api(`${p}/events?limit=100`, approverToken)).value, beforeEvents, 'Approval replay creates no event');
  equal((await api(`${p}/members`, approverToken)).value, beforeMembers, 'Approval replay changes no directory data');
  equal((await api(`${p}/imports/${importId}/approve`, otherToken, {})).status, 409, 'Different approver retry conflicts');
}

try {
  const mainData = join(directory, 'main');
  live = await launch(mainData); base = live.base;
  equal((await api('/health')).value, { ok: true });
  const created = await api('/v1/workspaces', bootstrap, { id: 'qaspace', name: 'QA synthetic' });
  equal(created.status, 201);
  const owner = created.value.ownerToken;
  const tokens = {};
  for (const role of ['editor', 'approver', 'worker', 'viewer']) {
    const issued = await api(`${p}/tokens`, owner, { subject: role, role }); equal(issued.status, 200); tokens[role] = issued.value;
  }
  const sameEditor = (await api(`${p}/tokens`, owner, { subject: 'editor', role: 'editor' })).value;
  const sameWorker = (await api(`${p}/tokens`, owner, { subject: 'worker', role: 'worker' })).value;
  const stage = await api(`${p}/imports`, tokens.editor.token, { baseVersion: 0, csv }, 'qa_stage'); equal(stage.status, 201);
  const iid = stage.value.import.id;
  equal((await api(`${p}/imports`, sameEditor.token, { csv, baseVersion: 0 }, 'qa_stage')).status, 200, 'Same-subject staging namespace');
  find('STAGE_REPLAY_CHANGED_INVALID_CSV', (await api(`${p}/imports`, tokens.editor.token, { baseVersion: 0, csv: 'malformed' }, 'qa_stage')).status, 409, 'Reused staging key with changed valid-JSON body but invalid CSV must conflict');
  find('STAGE_REPLAY_CHANGED_INVALID_BASE', (await api(`${p}/imports`, tokens.editor.token, { baseVersion: -1, csv }, 'qa_stage')).status, 409, 'Reused staging key with changed invalid baseVersion must conflict');
  for (const [label, body] of [['NULL', null], ['ARRAY', []], ['SCALAR', true]]) {
    find(`STAGE_REPLAY_CHANGED_${label}`, (await api(`${p}/imports`, tokens.editor.token, body, 'qa_stage')).status, 409, 'Every changed parsed JSON body conflicts under a used staging key');
    equal((await api(`${p}/imports`, tokens.editor.token, body, `new_stage_${label}`)).status, 400, 'Unused staging keys retain shape validation');
  }
  equal((await api(`${p}/imports`, tokens.editor.token, { baseVersion: -1, csv }, 'new_invalid_stage')).status, 400);
  const approval = await api(`${p}/imports/${iid}/approve`, tokens.approver.token, {}); equal(approval.status, 200);
  await approvalReplay(iid, tokens.approver.token, owner, 'approved', 'APPROVED');
  const lease = await api(`${p}/imports/${iid}/claim`, tokens.worker.token, { leaseMs: 5000 }); equal(lease.status, 200);
  await approvalReplay(iid, tokens.approver.token, owner, 'leased', 'LEASED');
  const done = await api(`${p}/imports/${iid}/commit`, tokens.worker.token, { leaseToken: lease.value.leaseToken }, 'qa_commit'); equal(done.status, 200);
  await approvalReplay(iid, tokens.approver.token, owner, 'committed', 'COMMITTED');
  find('COMMIT_REPLAY_CHANGED_INVALID_BODY', (await api(`${p}/imports/${iid}/commit`, tokens.worker.token, { leaseToken: '' }, 'qa_commit')).status, 409, 'Reused commit key with changed empty token must conflict');
  for (const [label, body] of [['NULL', null], ['ARRAY', []], ['SCALAR', false]]) {
    find(`COMMIT_REPLAY_CHANGED_${label}`, (await api(`${p}/imports/${iid}/commit`, tokens.worker.token, body, 'qa_commit')).status, 409, 'Every changed parsed JSON body conflicts under a used commit key');
    equal((await api(`${p}/imports/${iid}/commit`, tokens.worker.token, body, `new_commit_${label}`)).status, 400, 'Unused commit keys retain shape validation');
  }
  equal((await api(`${p}/imports/${iid}/commit`, tokens.worker.token, { leaseToken: '' }, 'new_invalid_commit')).status, 400);
  equal((await api(`${p}/imports/${iid}/commit`, sameWorker.token, { leaseToken: lease.value.leaseToken }, 'qa_commit')).status, 409);
  equal((await api(`${p}/imports/${iid}/commit`, tokens.worker.token, { leaseToken: lease.value.leaseToken }, 'qa_commit_new')).status, 409);
  const current = (await api(`${p}/members`, owner)).value;
  equal(current.version, 1); equal(current.members[0].revision, 1);
  for (const role of ['owner','editor','approver','worker','viewer']) {
    const token = role === 'owner' ? owner : tokens[role].token;
    for (const suffix of ['', '/members', '/imports', `/imports/${iid}`, '/events']) equal((await api(p + suffix, token)).status, 200);
    for (const [suffix,body] of [['/tokens',{subject:'bad',role:'worker'}], [`/tokens/${sameWorker.id}/revoke`,{}]]) {
      if (role !== 'owner') equal((await api(p + suffix, token, body)).status, 403);
    }
    if (!['owner','editor'].includes(role)) equal((await api(`${p}/imports`, token, {baseVersion:1,csv}, 'role_matrix')).status,403);
  }
  const eventsBefore = (await api(`${p}/events`, owner)).value;
  for (const payload of [null, [], true, {}, {baseVersion:1}, {baseVersion:'1',csv}]) equal((await api(`${p}/imports`, tokens.editor.token, payload, 'bad_shape')).status, 400);
  for (const raw of ['{', 'null', '[]']) equal((await api(`${p}/imports`, tokens.editor.token, raw, 'bad_json', true)).status, 400);
  for (const bad of [undefined, 'unknown']) {
    equal((await api(`${p}/imports`, bad, '{', 'bad_auth', true)).status, 401);
    find('AUTH_INVALID_QUERY', (await api(`${p}/events?after=oops`, bad)).status, 401, 'Invalid/missing authentication should remain 401 with malformed query');
  }
  equal((await api(`${p}/events`, owner)).value, eventsBefore, 'Rejected operations append no event');
  const fifty = Array.from({length:500}, (_,i) => `upsert,x${i},Name,x${i}@example.test`).join('\n');
  const maxRows = await api(`${p}/imports`, tokens.editor.token, {baseVersion:1,csv:'op,external_id,name,email\n'+fifty}, 'max_rows'); equal(maxRows.status,201); equal(maxRows.value.import.rowCount,500);
  equal((await api(`${p}/imports/${maxRows.value.import.id}/cancel`, sameEditor.token, {})).status,200);
  const unicode = await api(`${p}/imports`, tokens.editor.token, {baseVersion:1,csv:'op,external_id,name,email\nupsert,unicode,  Café Synthetic  ,UNICODE@EXAMPLE.TEST'}, 'unicode'); equal(unicode.status,201);
  equal((await api(`${p}/imports/${unicode.value.import.id}/approve`, owner, {})).status,200);
  const unicodeLease = await api(`${p}/imports/${unicode.value.import.id}/claim`, tokens.worker.token, {leaseMs:100}); equal(unicodeLease.status,200);
  await new Promise(r=>setTimeout(r,150));
  equal((await api(`${p}/imports/${unicode.value.import.id}/commit`, tokens.worker.token, {leaseToken:unicodeLease.value.leaseToken},'expired')).status,409);
  const retryLease = await api(`${p}/imports/${unicode.value.import.id}/claim`, sameWorker.token, {leaseMs:5000}); equal(retryLease.value.import.leaseEpoch,2);
  equal((await api(`${p}/imports/${unicode.value.import.id}/commit`, tokens.worker.token, {leaseToken:unicodeLease.value.leaseToken},'fenced')).status,409);
  const unicodeDone=await api(`${p}/imports/${unicode.value.import.id}/commit`, sameWorker.token, {leaseToken:retryLease.value.leaseToken},'unicode_done'); equal(unicodeDone.status,200);
  const sdk = createClient({baseUrl:base,token:tokens.viewer.token});
  equal((await sdk.members('qaspace')).members.find(m=>m.externalId==='unicode').name,'Café Synthetic');
  try {await sdk.stage('qaspace',{baseVersion:2,csv},'viewer'); assert.fail('Expected role denial');} catch(error) {ok(error instanceof RelayError && error.status===403 && typeof error.code==='string','SDK RelayError shape');}
  const cancelledApproved = await api(`${p}/imports`, tokens.editor.token, {baseVersion:2,csv}, 'cancelled_approved'); equal(cancelledApproved.status,201);
  equal((await api(`${p}/imports/${cancelledApproved.value.import.id}/approve`, tokens.approver.token, {})).status,200);
  const cancelLease=await api(`${p}/imports/${cancelledApproved.value.import.id}/claim`,sameWorker.token,{leaseMs:5000}); equal(cancelLease.status,200);
  equal((await api(`${p}/imports/${cancelledApproved.value.import.id}/cancel`,sameEditor.token,{})).status,200);
  await approvalReplay(cancelledApproved.value.import.id,tokens.approver.token,owner,'cancelled','CANCELLED');
  equal((await api(`${p}/imports/${cancelledApproved.value.import.id}/commit`,sameWorker.token,{leaseToken:cancelLease.value.leaseToken},'cancelled_lease')).status,409);
  const neverApproved = await api(`${p}/imports`,tokens.editor.token,{baseVersion:2,csv},'never_approved'); equal(neverApproved.status,201);
  equal((await api(`${p}/imports/${neverApproved.value.import.id}/cancel`,sameEditor.token,{})).status,200);
  equal((await api(`${p}/imports/${neverApproved.value.import.id}/approve`,tokens.approver.token,{})).status,409);
  const rejected = await api(`${p}/imports`,tokens.editor.token,{baseVersion:2,csv},'rejected_never_approved'); equal(rejected.status,201);
  equal((await api(`${p}/imports/${rejected.value.import.id}/reject`,owner,{reason:'Synthetic QA rejection'})).status,200);
  equal((await api(`${p}/imports/${rejected.value.import.id}/approve`,tokens.approver.token,{})).status,409);
  const leasedRestart=await api(`${p}/imports`,tokens.editor.token,{baseVersion:2,csv},'lease_across_restart'); equal(leasedRestart.status,201);
  equal((await api(`${p}/imports/${leasedRestart.value.import.id}/approve`,tokens.approver.token,{})).status,200);
  const persistedLease=await api(`${p}/imports/${leasedRestart.value.import.id}/claim`,sameWorker.token,{leaseMs:5000}); equal(persistedLease.status,200);
  await approvalReplay(leasedRestart.value.import.id,tokens.approver.token,owner,'leased','LEASED_BEFORE_RESTART');
  const beforeRestart=(await api(`${p}/events?limit=100`,owner)).value;
  await live.stop(); live=undefined;
  live=await launch(mainData);base=live.base;
  equal((await api(`${p}/events?limit=100`,owner)).value,beforeRestart);
  await approvalReplay(iid,tokens.approver.token,owner,'committed','COMMITTED_AFTER_RESTART');
  await approvalReplay(cancelledApproved.value.import.id,tokens.approver.token,owner,'cancelled','CANCELLED_AFTER_RESTART');
  await approvalReplay(leasedRestart.value.import.id,tokens.approver.token,owner,'leased','LEASED_AFTER_RESTART');
  equal((await api(`${p}/imports/${leasedRestart.value.import.id}/claim`,sameWorker.token,{leaseMs:5000})).status,409,'Approval retry does not clear a live lease');
  const preservedCommit=await api(`${p}/imports/${leasedRestart.value.import.id}/commit`,sameWorker.token,{leaseToken:persistedLease.value.leaseToken},'preserved_lease_commit'); equal(preservedCommit.status,200,'Lease token remains valid across approval retry and restart');
  equal(preservedCommit.value.version,3);
  equal((await api(`${p}/imports/${iid}/commit`,tokens.worker.token,{leaseToken:lease.value.leaseToken},'qa_commit')).value,done.value);
  await api(`${p}/tokens/${tokens.worker.id}/revoke`,owner,{});
  equal((await api(`${p}/imports/${iid}/commit`,tokens.worker.token,{leaseToken:lease.value.leaseToken},'qa_commit')).status,401);
  await live.stop();live=undefined;

  // A synthetic unrelated directory must survive even when linked at the lock path.
  const aliasData=join(directory,'lock-alias');const unrelated=join(directory,'unrelated-synthetic');
  await mkdir(aliasData);await mkdir(unrelated);
  const ownerPath=join(unrelated,'owner.json');
  await writeFile(ownerPath,JSON.stringify({pid:2147483647,nonce:'synthetic-unrelated-owner'}));
  let aliasSupported=true;
  try {await symlink(unrelated,join(aliasData,'.relay-owner'),process.platform==='win32'?'junction':'dir');} catch {aliasSupported=false;}
  if(aliasSupported){
    const aliasStart=await launch(aliasData,false);
    find('LOCK_SYMLINK_ADMITTED',aliasStart.ready,false,'Startup should refuse a lock path alias rather than operate outside the supplied data directory');
    let preserved=true;try{await lstat(ownerPath);}catch{preserved=false;}
    find('LOCK_SYMLINK_UNRELATED_DELETE',preserved,true,'Startup traversed linked .relay-owner and deleted an unrelated owner.json outside the requested data directory');
  }
  const metadataData=join(directory,'metadata-alias');await mkdir(metadataData);await mkdir(join(metadataData,'.relay-owner'));
  const metadataTarget=join(directory,'unrelated-metadata.json');const metadataText=JSON.stringify({pid:2147483647,nonce:'synthetic-unrelated-metadata'});
  await writeFile(metadataTarget,metadataText);
  let metadataAliasSupported=true;
  try{await symlink(metadataTarget,join(metadataData,'.relay-owner','owner.json'),'file');}catch{metadataAliasSupported=false;}
  if(metadataAliasSupported){
    const metadataStart=await launch(metadataData,false);
    find('METADATA_SYMLINK_ADMITTED',metadataStart.ready,false,'Startup must refuse aliased lock metadata');
    equal(await readFile(metadataTarget,'utf8'),metadataText,'Startup preserves aliased metadata target');
    let metadataPreserved=true;try{await lstat(join(metadataData,'.relay-owner','owner.json'));}catch{metadataPreserved=false;}
    find('METADATA_SYMLINK_REMOVED',metadataPreserved,true,'Startup must retain unknown aliased metadata rather than unlink it');
  }

  const releaseData=join(directory,'release-directory-alias');live=await launch(releaseData);
  const releaseLock=join(releaseData,'.relay-owner');
  const releaseText=await readFile(join(releaseLock,'owner.json'),'utf8');
  const movedReleaseLock=join(releaseData,'saved-owned-lock');await rename(releaseLock,movedReleaseLock);
  const releaseTarget=join(directory,'unrelated-release-directory');await mkdir(releaseTarget);await writeFile(join(releaseTarget,'owner.json'),releaseText);
  let releaseAliasSupported=true;
  try{await symlink(releaseTarget,releaseLock,process.platform==='win32'?'junction':'dir');}catch{releaseAliasSupported=false;}
  await live.stop({allowFailure:true});live=undefined;
  if(releaseAliasSupported){
    let releasePreserved;try{releasePreserved=await readFile(join(releaseTarget,'owner.json'),'utf8');}catch{releasePreserved=null;}
    find('RELEASE_DIRECTORY_ALIAS_TARGET_DELETED',releasePreserved,releaseText,'Release must preserve a replaced lock alias target even with the original pid and nonce');
    equal(await readFile(join(movedReleaseLock,'owner.json'),'utf8'),releaseText,'Release preserves ownership metadata moved by another actor');
    let releaseAliasPreserved=true;try{await lstat(releaseLock);}catch{releaseAliasPreserved=false;}
    find('RELEASE_DIRECTORY_ALIAS_REMOVED',releaseAliasPreserved,true,'Release must preserve an unknown replacement lock path');
  }

  let releaseMetadataAliasSupported=metadataAliasSupported;
  if(releaseMetadataAliasSupported){
    const releaseMetadataData=join(directory,'release-metadata-alias');live=await launch(releaseMetadataData);
    const releaseMetadataPath=join(releaseMetadataData,'.relay-owner','owner.json');
    const ownedMetadataText=await readFile(releaseMetadataPath,'utf8');
    await rename(releaseMetadataPath,join(releaseMetadataData,'saved-owned-metadata.json'));
    const releaseMetadataTarget=join(directory,'unrelated-release-metadata.json');await writeFile(releaseMetadataTarget,ownedMetadataText);
    try{await symlink(releaseMetadataTarget,releaseMetadataPath,'file');}catch{releaseMetadataAliasSupported=false;}
    await live.stop({allowFailure:true});live=undefined;
    if(releaseMetadataAliasSupported){
      equal(await readFile(releaseMetadataTarget,'utf8'),ownedMetadataText,'Release preserves aliased metadata target');
      let releaseMetadataPreserved=true;try{await lstat(releaseMetadataPath);}catch{releaseMetadataPreserved=false;}
      find('RELEASE_METADATA_ALIAS_REMOVED',releaseMetadataPreserved,true,'Release must retain aliased ownership metadata and its directory');
    }
  }
  console.log(JSON.stringify({ok:findings.length===0,checks,findings,runtime:runtime.includes('bun')?'bun':'node',directory,aliasSupported,metadataAliasSupported,releaseAliasSupported,releaseMetadataAliasSupported}));
  if(findings.length) process.exitCode=1;
} finally {for(const child of children)child.kill('SIGKILL');}
