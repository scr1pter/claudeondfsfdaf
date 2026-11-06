import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ApiError, allowFields, empty, json, readJson, requiredString, requireRole } from './common';

// Agreed coordinator contract: this file owns persistence and auth; getContext is synchronous.
export type Role = 'owner' | 'manager' | 'member' | 'read_only';
export interface User { id: string; name: string; email: string }
export interface WorkspaceContext { user: User; workspace: { id: string; name: string; role: Role; ownerId: string }; workspaceId: string }
export const DATA_DIR = resolve(process.env.DATA_DIR || '../.foundry-data');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'attachments'), { recursive: true });
export const db = new Database(join(DATA_DIR, 'foundry.sqlite'), { create: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL, active_workspace_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 0, order_seq INTEGER NOT NULL DEFAULT 0,
 invoice_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','manager','member','read_only')),
 created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL COLLATE NOCASE,
 role TEXT NOT NULL CHECK(role IN ('manager','member','read_only')), token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_scope ON records(workspace_id,type);
CREATE TABLE IF NOT EXISTS idempotency (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL, order_id TEXT NOT NULL,
 response_json TEXT NOT NULL, PRIMARY KEY(workspace_id,key)
);
`);

export function now(): string { return new Date().toISOString(); }
export function id(): string { return crypto.randomUUID(); }
export function transaction<T>(fn: () => T): T { return db.transaction(fn).immediate(); }
export function listRecords(type: string, workspaceId: string): any[] {
 return (db.query('SELECT data FROM records WHERE workspace_id=? AND type=? ORDER BY rowid DESC').all(workspaceId, type) as {data:string}[]).map(row => JSON.parse(row.data));
}
export function getRecord(type: string, recordId: string, workspaceId: string): any {
 const row = db.query('SELECT data FROM records WHERE id=? AND type=? AND workspace_id=?').get(recordId, type, workspaceId) as {data:string}|null;
 if (!row) throw new ApiError(404, 'not_found', 'This record was not found in the workspace.');
 return JSON.parse(row.data);
}
export function putRecord(type: string, workspaceId: string, obj: any): void {
 const existing = db.query('SELECT workspace_id,type FROM records WHERE id=?').get(obj.id) as {workspace_id:string,type:string}|null;
 if (existing && (existing.workspace_id !== workspaceId || existing.type !== type)) throw new ApiError(404, 'not_found', 'This record was not found in the workspace.');
 db.query('INSERT INTO records (id,workspace_id,type,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(obj.id, workspaceId, type, JSON.stringify(obj));
}
export function deleteRecord(type: string, recordId: string, workspaceId: string): void {
 db.query('DELETE FROM records WHERE id=? AND type=? AND workspace_id=?').run(recordId,type,workspaceId);
}
export function nextNumber(workspaceId: string, kind: 'order'|'invoice'): string {
 const column = kind === 'order' ? 'order_seq' : 'invoice_seq';
 const row = db.query(`UPDATE workspaces SET ${column}=${column}+1 WHERE id=? RETURNING ${column} AS value`).get(workspaceId) as {value:number}|null;
 if (!row) throw new ApiError(404, 'not_found', 'Workspace not found.');
 return `${kind === 'order' ? 'ORD' : 'INV'}-${String(row.value).padStart(6,'0')}`;
}
export function recordActivity(ctx: WorkspaceContext, action: string, entityType: string, entityId: string): void {
 putRecord('activity',ctx.workspaceId,{id:id(),action,entityType,entityId,actorId:ctx.user.id,actorName:ctx.user.name,createdAt:now()});
 db.query('UPDATE workspaces SET revision=revision+1 WHERE id=?').run(ctx.workspaceId);
}

function cookieValue(req: Request): string|null {
 const match = (req.headers.get('cookie') || '').split(';').map(part=>part.trim()).find(part=>part.startsWith('foundry_session='));
 if (!match) return null;
 const token = match.slice('foundry_session='.length);
 return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function randomToken(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), n=>n.toString(16).padStart(2,'0')).join(''); }
function tokenHash(value: string): string { return new Bun.CryptoHasher('sha256').update(value).digest('hex'); }
function sessionCookie(token: string): string { return `foundry_session=${token}; HttpOnly; SameSite=Lax; Path=/`; }
function startSession(userId: string): string {
 const token = randomToken();
 db.query('INSERT INTO sessions(id,user_id,created_at) VALUES(?,?,?)').run(token,userId,now());
 return token;
}
export function getUser(req: Request): User {
 const token = cookieValue(req);
 const user = token ? db.query('SELECT u.id,u.name,u.email FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=?').get(token) as User|null : null;
 if (!user) throw new ApiError(401,'unauthenticated','Please sign in to continue.');
 return user;
}
export function getContext(req: Request, workspaceId: string): WorkspaceContext {
 const user = getUser(req);
 const row = db.query('SELECT w.id,w.name,w.owner_id AS ownerId,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?').get(workspaceId,user.id) as WorkspaceContext['workspace']|null;
 if (!row) throw new ApiError(404,'not_found','Workspace not found.');
 return {user,workspace:row,workspaceId};
}
function memberships(userId:string): {id:string,name:string,role:Role}[] {
 return db.query('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.rowid').all(userId) as {id:string,name:string,role:Role}[];
}
function emailInput(value: unknown): string {
 const email = requiredString(value,'Email',254).toLowerCase();
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400,'invalid_email','Please enter a valid email address.');
 return email;
}
function inviteRole(value:unknown): Exclude<Role,'owner'> {
 if (value !== 'manager' && value !== 'member' && value !== 'read_only') throw new ApiError(400,'invalid_role','Role must be manager, member, or read_only.');
 return value;
}
function createWorkspace(user:User,name:string): {id:string,name:string,role:Role} {
 const workspaceId = id();
 db.query('INSERT INTO workspaces(id,name,owner_id,created_at) VALUES(?,?,?,?)').run(workspaceId,name,user.id,now());
 db.query('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(workspaceId,user.id,'owner',now());
 const ctx:WorkspaceContext = {user,workspaceId,workspace:{id:workspaceId,name,role:'owner',ownerId:user.id}};
 recordActivity(ctx,'workspace.created','workspace',workspaceId);
 return {id:workspaceId,name,role:'owner'};
}

export async function authRoutes(req:Request,url:URL): Promise<Response|null> {
 const path=url.pathname, method=req.method;
 if(path==='/api/auth/signup' && method==='POST') {
  const body=await readJson(req); allowFields(body,['name','email','password']);
  const name=requiredString(body.name,'Name',200), email=emailInput(body.email);
  if(typeof body.password!=='string' || body.password.length<12 || body.password.length>1024) throw new ApiError(400,'invalid_password','Password must be between 12 and 1024 characters.');
  if(db.query('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email)) throw new ApiError(409,'email_exists','An account with this email already exists.');
  const passwordHash=await Bun.password.hash(body.password,{algorithm:'argon2id'});
  const user:User={id:id(),name,email};
  let result:{workspace:{id:string,name:string,role:Role},token:string};
  try {
   result=transaction(()=>{
    db.query('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id,name,email,passwordHash,now());
    const workspace=createWorkspace(user,`${name} workspace`);
    db.query('UPDATE users SET active_workspace_id=? WHERE id=?').run(workspace.id,user.id);
    return {workspace,token:startSession(user.id)};
   });
  } catch(error) {
   if(String(error).includes('UNIQUE')) throw new ApiError(409,'email_exists','An account with this email already exists.');
   throw error;
  }
  return json({user,workspace:result.workspace},201,{'Set-Cookie':sessionCookie(result.token)});
 }
 if(path==='/api/auth/login' && method==='POST') {
  const body=await readJson(req); allowFields(body,['email','password']);
  const email=emailInput(body.email);
  if(typeof body.password!=='string') throw new ApiError(400,'invalid_input','Password is required.');
  const row=db.query('SELECT id,name,email,password_hash FROM users WHERE email=? COLLATE NOCASE').get(email) as (User & {password_hash:string})|null;
  if(!row || !await Bun.password.verify(body.password,row.password_hash)) throw new ApiError(401,'invalid_credentials','Email or password is incorrect.');
  const user:User={id:row.id,name:row.name,email:row.email};
  return json({user},200,{'Set-Cookie':sessionCookie(startSession(user.id))});
 }
 if(path==='/api/auth/me' && method==='GET') {
  const user=getUser(req), workspaces=memberships(user.id);
  const row=db.query('SELECT active_workspace_id FROM users WHERE id=?').get(user.id) as {active_workspace_id:string|null};
  let activeWorkspaceId=row.active_workspace_id;
  if(!workspaces.some(w=>w.id===activeWorkspaceId)) {
   activeWorkspaceId=workspaces[0]?.id || null;
   db.query('UPDATE users SET active_workspace_id=? WHERE id=?').run(activeWorkspaceId,user.id);
  }
  return json({user,activeWorkspaceId,workspaces});
 }
 if(path==='/api/auth/logout' && method==='POST') {
  getUser(req);
  db.query('DELETE FROM sessions WHERE id=?').run(cookieValue(req));
  return new Response(null,{status:204,headers:{'Set-Cookie':'foundry_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}});
 }
 if(path==='/api/workspaces' && method==='GET') return json({workspaces:memberships(getUser(req).id)});
 if(path==='/api/workspaces' && method==='POST') {
  const user=getUser(req), body=await readJson(req); allowFields(body,['name']);
  const name=requiredString(body.name,'Workspace name',200);
  const workspace=transaction(()=>{
   const result=createWorkspace(user,name);
   db.query('UPDATE users SET active_workspace_id=? WHERE id=?').run(result.id,user.id);
   return result;
  });
  return json({workspace},201);
 }
 const select=path.match(/^\/api\/workspaces\/([^/]+)\/select$/);
 if(select && method==='POST') {
  const ctx=getContext(req,decodeURIComponent(select[1]));
  db.query('UPDATE users SET active_workspace_id=? WHERE id=?').run(ctx.workspaceId,ctx.user.id);
  return json({workspace:{id:ctx.workspaceId,name:ctx.workspace.name,role:ctx.workspace.role}});
 }
 if(path==='/api/invites/accept' && method==='POST') {
  const user=getUser(req), body=await readJson(req); allowFields(body,['token']);
  const token=requiredString(body.token,'Invite token',1024);
  const workspace=transaction(()=>{
   const invite=db.query('SELECT * FROM invites WHERE token_hash=?').get(tokenHash(token)) as {id:string,workspace_id:string,email:string,role:Role,expires_at:string,consumed_at:string|null}|null;
   if(!invite || invite.email.toLowerCase()!==user.email.toLowerCase()) throw new ApiError(404,'not_found','Invite not found for this account.');
   if(invite.consumed_at) throw new ApiError(409,'invite_consumed','This invite has already been used.');
   if(Date.parse(invite.expires_at)<=Date.now()) throw new ApiError(404,'not_found','This invite has expired.');
   const existing=db.query('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(invite.workspace_id,user.id);
   if(existing) throw new ApiError(409,'already_member','You are already a member of this workspace.');
   db.query('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(invite.workspace_id,user.id,invite.role,now());
   db.query('UPDATE invites SET consumed_at=? WHERE id=?').run(now(),invite.id);
   db.query('UPDATE users SET active_workspace_id=? WHERE id=?').run(invite.workspace_id,user.id);
   const ctx=getContext(req,invite.workspace_id);
   recordActivity(ctx,'member.joined','member',user.id);
   return {id:ctx.workspace.id,name:ctx.workspace.name,role:ctx.workspace.role};
  });
  return json({workspace});
 }
 return null;
}

export async function workspaceAuthRoutes(req:Request,_url:URL,ctx:WorkspaceContext,segments:string[]): Promise<Response|null> {
 const [section,target]=segments, method=req.method;
 if(section==='members' && segments.length===1 && method==='GET') {
  const members=db.query('SELECT u.id AS userId,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.rowid').all(ctx.workspaceId);
  return json({members});
 }
 if(section==='members' && segments.length===2 && (method==='PATCH'||method==='DELETE')) {
  requireRole(ctx,['owner']);
  if(target===ctx.workspace.ownerId) throw new ApiError(409,'owner_protected','The original workspace owner cannot be removed or demoted.');
  if(!db.query('SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=?').get(ctx.workspaceId,target)) throw new ApiError(404,'not_found','Member not found.');
  if(method==='DELETE') {
   transaction(()=>{
    db.query('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(ctx.workspaceId,target);
    recordActivity(ctx,'member.removed','member',target);
   });
   return empty();
  }
  const body=await readJson(req); allowFields(body,['role']); const role=inviteRole(body.role);
  transaction(()=>{
   db.query('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(role,ctx.workspaceId,target);
   recordActivity(ctx,'member.updated','member',target);
  });
  const member=db.query('SELECT u.id AS userId,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(ctx.workspaceId,target);
  return json({member});
 }
 if(section==='invites' && segments.length===1 && method==='GET') {
  requireRole(ctx,['owner']);
  const invites=db.query('SELECT id,email,role,expires_at AS expiresAt,consumed_at AS consumedAt,created_at AS createdAt FROM invites WHERE workspace_id=? ORDER BY rowid DESC').all(ctx.workspaceId);
  return json({invites});
 }
 if(section==='invites' && segments.length===1 && method==='POST') {
  requireRole(ctx,['owner']);
  const body=await readJson(req); allowFields(body,['email','role']);
  const email=emailInput(body.email),role=inviteRole(body.role),token=randomToken(),inviteId=id(),expiresAt=new Date(Date.now()+7*24*60*60*1000).toISOString();
  const existing=db.query('SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? COLLATE NOCASE AND m.workspace_id=?').get(email,ctx.workspaceId);
  if(existing) throw new ApiError(409,'already_member','This person is already a workspace member.');
  transaction(()=>{
   db.query('INSERT INTO invites(id,workspace_id,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(inviteId,ctx.workspaceId,email,role,tokenHash(token),expiresAt,now());
   recordActivity(ctx,'invite.created','invite',inviteId);
  });
  return json({invite:{id:inviteId,email,role,token,expiresAt}},201);
 }
 return null;
}
