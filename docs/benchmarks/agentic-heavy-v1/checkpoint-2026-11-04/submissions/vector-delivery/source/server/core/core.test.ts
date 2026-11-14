import { afterAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This authored focused suite uses only synthetic accounts and a fresh directory
// beneath the external runtime root. It never touches the normal app database.
const originalDir = process.env.DATA_DIR;
const isolatedDir = join(resolve(originalDir || '../.foundry-data'), `core-check-${randomBytes(8).toString('hex')}`);
process.env.DATA_DIR = isolatedDir;
const core = await import('./index');

afterAll(() => {
  core.db.close();
  Bun.gc(true);
  rmSync(isolatedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (originalDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDir;
});

type Result = { response: Response; data: Record<string, any> };
async function call(method: string, path: string, value?: unknown, cookie?: string): Promise<Result> {
  const headers = new Headers();
  if (value !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  const request = new Request(`http://127.0.0.1${path}`, {
    method, headers, body: value === undefined ? undefined : JSON.stringify(value),
  });
  let response: Response;
  try {
    response = await core.handleIdentity(request, new URL(request.url)) ?? core.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  } catch (error) {
    if (!(error instanceof core.HttpError)) throw error;
    response = core.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  const data = response.status === 204 ? {} : await response.json() as Record<string, any>;
  return { response, data };
}

function session(response: Response): string {
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Lax');
  expect(setCookie).toContain('Path=/');
  expect(setCookie).not.toContain('Secure');
  expect(setCookie.split(';')[0].split('=')[1].length).toBeGreaterThanOrEqual(32);
  return setCookie.split(';')[0];
}

function authRequest(cookie: string): Request {
  return new Request('http://127.0.0.1/', { headers: { Cookie: cookie } });
}

const password = 'Synthetic-Passphrase-2026';

test('identity, invitations, transaction rollback, storage and process-restart durability', async () => {
  for (const value of [null, [], 1, 'text']) {
    expect((await call('POST', '/api/auth/signup', value)).response.status).toBe(400);
  }
  await expect(core.body(new Request('http://127.0.0.1', { method: 'POST', body: '{broken' }))).rejects.toMatchObject({ status: 400 });
  expect((await call('GET', '/api/auth/me')).response.status).toBe(401);
  expect((await call('POST', '/api/auth/signup', { name: ' ', email: 'bad', password })).response.status).toBe(400);
  expect((await call('POST', '/api/auth/signup', { name: 'Synthetic', email: 'short@example.invalid', password: 'short' })).response.status).toBe(400);

  const signup = await call('POST', '/api/auth/signup', { name: 'Ada Synthetic', email: 'Ada@EXAMPLE.invalid', password });
  expect(signup.response.status).toBe(201);
  const ownerCookie = session(signup.response);
  const ownerId = signup.data.user.id as string;
  const workspaceId = signup.data.workspace.id as string;
  expect(signup.data.workspace.name).toBe('Ada Synthetic workspace');
  expect(signup.data.user.email).toBe('ada@example.invalid');
  expect(signup.data.user.password_hash).toBeUndefined();
  const hash = core.db.query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?').get(ownerId)!.password_hash;
  expect(hash.startsWith('$argon2id$')).toBe(true);
  expect(await Bun.password.verify(password, hash)).toBe(true);
  expect((await call('POST', '/api/auth/signup', { name: 'Duplicate', email: 'ADA@example.invalid', password })).response.status).toBe(409);
  expect((await call('POST', '/api/auth/login', { email: 'ada@example.invalid', password: 'wrong-password' })).response.status).toBe(401);
  const login = await call('POST', '/api/auth/login', { email: 'ADA@EXAMPLE.INVALID', password });
  expect(login.response.status).toBe(200);
  const loginCookie = session(login.response);
  expect(loginCookie).not.toBe(ownerCookie);
  expect((await call('POST', '/api/auth/logout', undefined, loginCookie)).response.status).toBe(204);
  expect((await call('GET', '/api/auth/me', undefined, loginCookie)).response.status).toBe(401);
  expect((await call('GET', '/api/auth/me', undefined, ownerCookie)).data.activeWorkspaceId).toBe(workspaceId);

  const secondWorkspace = await call('POST', '/api/workspaces', { name: 'Synthetic second workspace', userId: 'foreign' }, ownerCookie);
  expect(secondWorkspace.response.status).toBe(201);
  const secondId = secondWorkspace.data.workspace.id as string;
  expect((await call('GET', '/api/workspaces', undefined, ownerCookie)).data.workspaces.length).toBe(2);
  expect((await call('GET', '/api/auth/me', undefined, ownerCookie)).data.activeWorkspaceId).toBe(secondId);
  expect((await call('POST', `/api/workspaces/${workspaceId}/select`, undefined, ownerCookie)).response.status).toBe(200);

  const invitee = await call('POST', '/api/auth/signup', { name: 'Bea Synthetic', email: 'Bea@example.invalid', password });
  const inviteeCookie = session(invitee.response);
  const inviteeId = invitee.data.user.id as string;
  const inviteeOwnId = invitee.data.workspace.id as string;
  const otherHash = core.db.query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?').get(inviteeId)!.password_hash;
  expect(otherHash).not.toBe(hash); // Same password, independently random Argon2 salt.
  expect((await call('GET', `/api/w/${workspaceId}/members`, undefined, inviteeCookie)).response.status).toBe(404);
  expect((await call('POST', `/api/workspaces/${workspaceId}/select`, undefined, inviteeCookie)).response.status).toBe(404);
  expect((await call('POST', `/api/w/${workspaceId}/invites`, { email: 'bea@example.invalid', role: 'owner' }, ownerCookie)).response.status).toBe(400);
  const beforeInvite = core.getRevision(workspaceId);
  const invitation = await call('POST', `/api/w/${workspaceId}/invites`, { email: 'BEA@example.invalid', role: 'member' }, ownerCookie);
  expect(invitation.response.status).toBe(201);
  const invite = invitation.data.invite;
  expect(invite.token.length).toBeGreaterThanOrEqual(32);
  expect(Date.parse(invite.expiresAt) - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  expect(core.getRevision(workspaceId)).toBe(beforeInvite + 1);
  const inviteMetadata = await call('GET', `/api/w/${workspaceId}/invites`, undefined, ownerCookie);
  expect(JSON.stringify(inviteMetadata.data)).not.toContain(invite.token);
  expect(inviteMetadata.data.invites[0].token).toBeUndefined();
  expect((await call('POST', '/api/invites/accept', { token: invite.token }, ownerCookie)).response.status).toBe(404);
  expect(core.getRevision(workspaceId)).toBe(beforeInvite + 1);
  const acceptances = await Promise.all([
    call('POST', '/api/invites/accept', { token: invite.token }, inviteeCookie),
    call('POST', '/api/invites/accept', { token: invite.token }, inviteeCookie),
  ]);
  expect(acceptances.map(result => result.response.status).sort()).toEqual([200, 409]);
  expect(core.getRevision(workspaceId)).toBe(beforeInvite + 2);
  expect((await call('GET', '/api/auth/me', undefined, inviteeCookie)).data.activeWorkspaceId).toBe(workspaceId);
  expect((await call('GET', '/api/auth/me', undefined, ownerCookie)).data.activeWorkspaceId).toBe(workspaceId);
  expect(core.members(workspaceId).find(member => member.userId === inviteeId)?.role).toBe('member');
  expect((await call('GET', `/api/w/${workspaceId}/invites`, undefined, inviteeCookie)).response.status).toBe(403);
  expect((await call('PATCH', `/api/w/${workspaceId}/members/${ownerId}`, { role: 'manager' }, inviteeCookie)).response.status).toBe(403);
  expect((await call('PATCH', `/api/w/${workspaceId}/members/${ownerId}`, { role: 'manager' }, ownerCookie)).response.status).toBe(409);
  expect((await call('DELETE', `/api/w/${workspaceId}/members/${ownerId}`, undefined, ownerCookie)).response.status).toBe(409);
  expect((await call('PATCH', `/api/w/${workspaceId}/members/${inviteeId}`, { role: 'owner' }, ownerCookie)).response.status).toBe(400);
  expect((await call('PATCH', `/api/w/${workspaceId}/members/missing`, { role: 'member' }, ownerCookie)).response.status).toBe(404);
  for (const role of ['manager', 'read_only', 'member'] as const) {
    expect((await call('PATCH', `/api/w/${workspaceId}/members/${inviteeId}`, { role }, ownerCookie)).response.status).toBe(200);
    expect(core.workspaceContext(authRequest(inviteeCookie), workspaceId).role).toBe(role);
  }
  expect(() => core.requireRole(core.workspaceContext(authRequest(inviteeCookie), workspaceId), ['owner'])).toThrow(core.HttpError);

  // Expiry is exercised by moving only this synthetic invite into the past.
  const expiredUser = await call('POST', '/api/auth/signup', { name: 'Cy Synthetic', email: 'cy@example.invalid', password });
  const expiredCookie = session(expiredUser.response);
  const expiring = await call('POST', `/api/w/${workspaceId}/invites`, { email: 'cy@example.invalid', role: 'read_only' }, ownerCookie);
  core.db.query('UPDATE invites SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiring.data.invite.id);
  const expiryRevision = core.getRevision(workspaceId);
  expect((await call('POST', '/api/invites/accept', { token: expiring.data.invite.token }, expiredCookie)).response.status).toBe(404);
  expect(core.getRevision(workspaceId)).toBe(expiryRevision);
  expect((await call('GET', `/api/w/${workspaceId}/members`, undefined, expiredCookie)).response.status).toBe(404);

  const ctx = core.workspaceContext(authRequest(ownerCookie), workspaceId);
  const revision = core.getRevision(workspaceId);
  const activityCount = core.listActivity(workspaceId, 500).length;
  const entityId = core.id();
  expect(() => core.transaction(() => {
    core.saveEntity(workspaceId, 'customer', { id: entityId, name: 'Rolled back' });
    core.activity(ctx, 'customer.created', 'customer', entityId);
    expect(core.nextNumber(workspaceId, 'ORD')).toBe('ORD-000001');
    core.saveFulfillment(workspaceId, 'rollback-key', 'order-rollback', { id: 'order-rollback' });
    throw new Error('Synthetic rollback');
  })).toThrow('Synthetic rollback');
  expect(core.getEntity(workspaceId, 'customer', entityId)).toBeNull();
  expect(core.getRevision(workspaceId)).toBe(revision);
  expect(core.listActivity(workspaceId, 500).length).toBe(activityCount);
  expect(core.getFulfillment(workspaceId, 'rollback-key')).toBeNull();

  core.transaction(() => {
    core.saveEntity(workspaceId, 'customer', { id: entityId, name: 'Durable Synthetic Customer' });
    expect(core.nextNumber(workspaceId, 'ORD')).toBe('ORD-000001');
    expect(core.nextNumber(workspaceId, 'INV')).toBe('INV-000001');
    core.saveFulfillment(workspaceId, 'durable-key', 'synthetic-order', { id: 'synthetic-order', totalCents: 12345 });
    core.activity(ctx, 'customer.created', 'customer', entityId);
  });
  expect(core.getRevision(workspaceId)).toBe(revision + 1);
  expect(core.listActivity(workspaceId, 500).length).toBe(activityCount + 1);
  expect(core.listActivity(workspaceId, 1)[0]).toMatchObject({ action: 'customer.created', actorId: ownerId, actorName: 'Ada Synthetic' });
  expect(core.listEntities(workspaceId, 'customer')).toHaveLength(1);
  expect(core.listEntities(secondId, 'customer')).toHaveLength(0);
  expect(core.getEntity(secondId, 'customer', entityId)).toBeNull();
  expect(core.getFulfillment(secondId, 'durable-key')).toBeNull();
  expect(() => core.saveFulfillment(workspaceId, 'durable-key', 'different-order', {})).toThrow(core.HttpError);
  expect(core.getFulfillment(workspaceId, 'durable-key')).toEqual({ orderId: 'synthetic-order', order: { id: 'synthetic-order', totalCents: 12345 } });
  expect(core.getRevision(secondId)).toBe(1);

  // A failed inner savepoint may be caught without discarding valid outer work.
  core.transaction(() => {
    try {
      core.transaction(() => {
        core.saveEntity(workspaceId, 'temporary', { id: 'inner' });
        throw new Error('Savepoint rollback');
      });
    } catch { /* Deliberately recover from the inner savepoint. */ }
    core.saveEntity(workspaceId, 'temporary', { id: 'outer' });
  });
  expect(core.getEntity(workspaceId, 'temporary', 'inner')).toBeNull();
  expect(core.getEntity(workspaceId, 'temporary', 'outer')).toEqual({ id: 'outer' });
  core.deleteEntity(workspaceId, 'temporary', 'outer');
  expect(core.getEntity(workspaceId, 'temporary', 'outer')).toBeNull();

  // Independent SQLite connections contend for the same immediate write lock.
  // Their counter allocations and saved rows must remain unique and complete.
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'index.ts')).href;
  const contenders = ['a', 'b'].map(batch => Bun.spawn([process.execPath, '--eval', `
    const c = await import(${JSON.stringify(moduleUrl)});
    for (let i = 0; i < 5; i++) c.transaction(() => {
      const number = c.nextNumber(process.env.CORE_CHECK_WORKSPACE, 'INV');
      Bun.sleepSync(10);
      c.saveEntity(process.env.CORE_CHECK_WORKSPACE, 'counter_probe', {id: '${batch}-' + i, number});
    });
    c.db.close();
  `], {
    env: { ...process.env, CORE_CHECK_WORKSPACE: workspaceId }, stdout: 'pipe', stderr: 'pipe',
  }));
  for (const contender of contenders) {
    expect(await contender.exited).toBe(0);
    expect(await new Response(contender.stderr).text()).toBe('');
  }
  const numbered = core.listEntities<{ id: string; number: string }>(workspaceId, 'counter_probe');
  expect(numbered.length).toBe(10);
  expect(new Set(numbered.map(row => row.number)).size).toBe(10);
  expect(numbered.map(row => row.number).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `INV-${String(i + 2).padStart(6, '0')}`));

  const fileId = core.id();
  const path = core.attachmentPath(fileId);
  expect(dirname(path)).toBe(core.dataDir);
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  writeFileSync(path, bytes);
  expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  for (const invalid of ['../outside', '..\\outside', 'C:\\outside', 'file.txt', '', `${fileId}/x`]) {
    expect(() => core.attachmentPath(invalid)).toThrow(core.HttpError);
    expect(() => core.removeOwnedFile(invalid)).toThrow(core.HttpError);
  }

  // New Bun processes reopen the actual database and use the persisted sessions.
  const child = Bun.spawnSync([process.execPath, '--eval', `
    const c = await import(${JSON.stringify(moduleUrl)});
    const r = new Request('http://127.0.0.1/api/auth/me', {headers:{cookie:process.env.CORE_CHECK_COOKIE}});
    const response = await c.handleIdentity(r, new URL(r.url));
    const me = await response.json();
    if (response.status !== 200 || me.activeWorkspaceId !== process.env.CORE_CHECK_WORKSPACE) throw Error('Session/selection durability');
    if (c.members(process.env.CORE_CHECK_WORKSPACE).length !== 2) throw Error('Membership durability');
    if (c.listEntities(process.env.CORE_CHECK_WORKSPACE, 'customer').length !== 1) throw Error('Entity durability');
    if (!c.getFulfillment(process.env.CORE_CHECK_WORKSPACE, 'durable-key')) throw Error('Idempotency durability');
    if (c.nextNumber(process.env.CORE_CHECK_WORKSPACE, 'ORD') !== 'ORD-000002') throw Error('Counter durability');
    if (c.getRevision(process.env.CORE_CHECK_WORKSPACE) !== Number(process.env.CORE_CHECK_REVISION)) throw Error('Revision durability');
    const bytes = await Bun.file(c.attachmentPath(process.env.CORE_CHECK_FILE)).bytes();
    if (bytes.length !== 5 || bytes[4] !== 255) throw Error('Attachment durability');
    c.db.close();
  `], {
    env: {
      ...process.env, CORE_CHECK_COOKIE: ownerCookie, CORE_CHECK_WORKSPACE: workspaceId,
      CORE_CHECK_REVISION: String(core.getRevision(workspaceId)), CORE_CHECK_FILE: fileId,
    },
  });
  expect(child.stderr.toString()).toBe('');
  expect(child.exitCode).toBe(0);
  core.removeOwnedFile(fileId);
  core.removeOwnedFile(fileId);
  expect(existsSync(path)).toBe(false);

  const beforeRemoval = core.getRevision(workspaceId);
  expect((await call('DELETE', `/api/w/${workspaceId}/members/${inviteeId}`, undefined, ownerCookie)).response.status).toBe(204);
  expect(core.getRevision(workspaceId)).toBe(beforeRemoval + 1);
  expect((await call('GET', `/api/w/${workspaceId}/members`, undefined, inviteeCookie)).response.status).toBe(404);
  expect((await call('GET', '/api/auth/me', undefined, inviteeCookie)).data.activeWorkspaceId).toBe(inviteeOwnId);
  expect((await call('GET', '/api/auth/me', undefined, ownerCookie)).data.activeWorkspaceId).toBe(workspaceId);
  expect(JSON.stringify(core.listActivity(workspaceId, 500))).not.toContain(invite.token);
  expect(JSON.stringify(core.listActivity(workspaceId, 500))).not.toContain(password);
  expect(JSON.stringify(core.listActivity(workspaceId, 500))).not.toContain(ownerCookie.split('=')[1]);

  // An expired persisted session is rejected, not silently renewed.
  const expiringLogin = await call('POST', '/api/auth/login', { email: 'ada@example.invalid', password });
  const expiringCookie = session(expiringLogin.response);
  core.db.query('UPDATE sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiringCookie.split('=')[1]);
  expect((await call('GET', '/api/auth/me', undefined, expiringCookie)).response.status).toBe(401);
}, 30000);
