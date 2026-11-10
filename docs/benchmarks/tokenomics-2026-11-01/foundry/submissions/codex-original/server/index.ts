import { one, all, run, uid, now, tx, fail, ApiError, event, type Row } from './db';
import { object, keys, str, email } from './validation';
import { business, json } from './business';
import { randomBytes } from 'node:crypto';
import { resolve, extname } from 'node:path';

function publicUser(u: Row) { return { id: u.id, name: u.name, email: u.email }; }
function memberships(userId: string) { return all('SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.rowid', userId); }
function createWorkspace(name: string, userId: string) {
  const workspace = { id: uid(), name, role: 'owner' };
  run('INSERT INTO workspaces(id,name,owner_id) VALUES(?,?,?)', workspace.id, name, userId);
  run('INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)', workspace.id, userId, 'owner');
  run('UPDATE users SET active_workspace_id=? WHERE id=?', workspace.id, userId); return workspace;
}
function session(userId: string) { const token = randomBytes(32).toString('hex'); run('INSERT INTO sessions(id,user_id,created_at) VALUES(?,?,?)', token, userId, now()); return `foundry_session=${token}; HttpOnly; SameSite=Lax; Path=/`; }
const dist = resolve('dist');
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), maxRequestBodySize: 64 * 1024 * 1024, async fetch(req) {
  try {
    const url = new URL(req.url), path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (path[0] !== 'api') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Not found', { status: 404 });
      const candidate = resolve(dist, '.' + url.pathname); const file = Bun.file(candidate);
      if (candidate.startsWith(dist + (process.platform === 'win32' ? '\\' : '/')) && extname(candidate) && await file.exists()) return new Response(file);
      if (url.pathname.startsWith('/assets/')) return new Response('Not found', { status: 404 });
      return new Response(Bun.file(resolve(dist, 'index.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json({ ok: true });
    let b: Row = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const text = await req.text(); try { b = text ? object(JSON.parse(text)) : {}; } catch (e) { if (e instanceof ApiError) throw e; fail(400, 'Malformed JSON body.'); }
    }
    const token = req.headers.get('cookie')?.match(/(?:^|;\s*)foundry_session=([^;]+)/)?.[1];
    const user = token ? one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=?', token) : null;
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      keys(b, ['name', 'email', 'password']); const name = str(b.name, 'Name', true, 100), e = email(b.email, true); const password = b.password;
      if (typeof password !== 'string' || password.length < 12 || password.length > 1024) fail(400, 'Password must have 12 to 1024 characters.');
      const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
      return tx(() => { if (one('SELECT id FROM users WHERE email=?', e)) fail(409, 'This email is already registered.'); const u = { id: uid(), name, email: e }; run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)', u.id, name, e, hash); const workspace = createWorkspace(`${name} workspace`, u.id); const cookie = session(u.id); return Response.json({ user: u, workspace }, { status: 201, headers: { 'Set-Cookie': cookie } }); });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      keys(b, ['email', 'password']); const e = email(b.email, true); if (typeof b.password !== 'string') fail(401, 'Invalid email or password.', 'unauthenticated');
      const u = one('SELECT * FROM users WHERE email=?', e); if (!u || !await Bun.password.verify(b.password, u.password_hash)) fail(401, 'Invalid email or password.', 'unauthenticated');
      return Response.json({ user: publicUser(u) }, { headers: { 'Set-Cookie': session(u.id) } });
    }
    if (!user) fail(401, 'Sign in to continue.', 'unauthenticated');
    if (url.pathname === '/api/auth/me' && req.method === 'GET') { const workspaces = memberships(user.id); return json({ user: publicUser(user), activeWorkspaceId: workspaces.some(w => w.id === user.active_workspace_id) ? user.active_workspace_id : workspaces[0]?.id ?? null, workspaces }); }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { run('DELETE FROM sessions WHERE id=?', token!); return new Response(null, { status: 204, headers: { 'Set-Cookie': 'foundry_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' } }); }
    if (url.pathname === '/api/workspaces') {
      if (req.method === 'GET') return json({ workspaces: memberships(user.id) });
      if (req.method === 'POST') { keys(b, ['name']); const name = str(b.name, 'Workspace name', true, 150); return tx(() => json({ workspace: createWorkspace(name, user.id) }, 201)); }
    }
    if (path[1] === 'workspaces' && path.length === 4 && path[3] === 'select' && req.method === 'POST') {
      const workspace = memberships(user.id).find(w => w.id === path[2]); if (!workspace) fail(404, 'Workspace not found.'); run('UPDATE users SET active_workspace_id=? WHERE id=?', workspace.id, user.id); return json({ workspace });
    }
    if (url.pathname === '/api/invites/accept' && req.method === 'POST') {
      keys(b, ['token']); const inviteToken = str(b.token, 'Invite token', true);
      return tx(() => { const i = one('SELECT * FROM invites WHERE token=? AND email=?', inviteToken, user.email); if (!i) fail(404, 'Invite not found for your email.'); if (i.consumed) fail(409, 'This invite has already been used.'); if (Date.parse(i.expires_at) <= Date.now()) fail(404, 'Invite expired.');
        const existing = one('SELECT role FROM members WHERE workspace_id=? AND user_id=?', i.workspace_id, user.id);
        if (!existing) run('INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)', i.workspace_id, user.id, i.role);
        run('UPDATE invites SET consumed=1 WHERE id=?', i.id); run('UPDATE users SET active_workspace_id=? WHERE id=?', i.workspace_id, user.id); event(i.workspace_id, user, 'member.joined', 'member', user.id);
        return json({ workspace: { id: i.workspace_id, name: one('SELECT name FROM workspaces WHERE id=?', i.workspace_id)!.name, role: existing?.role ?? i.role } }); });
    }
    if (path[1] === 'w' && path[2]) {
      const m = one('SELECT role FROM members WHERE workspace_id=? AND user_id=?', path[2], user.id); if (!m) fail(404, 'Workspace not found.');
      return await business(req, { w: path[2], user, role: m.role }, path.slice(3), url.searchParams, b);
    }
    fail(404, 'API route not found.');
  } catch (e) {
    if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
    if (e instanceof URIError || (e instanceof TypeError && /form|multipart|body/i.test(e.message))) return json({ error: { code: 'invalid_input', message: 'Malformed request.' } }, 400);
    console.error('Request failed:', e instanceof Error ? e.message : 'Unknown error');
    return json({ error: { code: 'internal_error', message: 'The request could not be completed.' } }, 500);
  }
} });
console.log(`Foundry listening at http://127.0.0.1:${server.port}`);
const shutdown = () => { server.stop(true); process.exit(0); }; process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
