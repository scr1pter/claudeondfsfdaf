import { createHash, createHmac } from 'node:crypto';
import { canonicalJson, hashToken, opaqueId, secretToken } from './data.mjs';
import {
  ApiError, invalid, bearerToken, idempotencyKey, readMutationBody,
  workspaceBody, capabilityBody, emptyBody, rejectionBody, leaseBody,
  commitBody, stageBody, eventQuery,
} from './validation.mjs';

const publicImportFields = ['id', 'workspaceId', 'creator', 'baseVersion', 'state', 'rowCount', 'digest', 'leaseEpoch', 'approvedBy'];
const allRoles = ['owner', 'editor', 'approver', 'worker', 'viewer'];
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const requestHash = (body) => {
  try { return hash(canonicalJson(body)); }
  catch { invalid('Request cannot be represented as canonical JSON.'); }
};
const conflict = (message = 'Operation conflicts with current state.') => { throw new ApiError(409, 'CONFLICT', message); };
const forbidden = () => { throw new ApiError(403, 'FORBIDDEN', 'Capability does not permit this operation.'); };
const unauthorized = () => { throw new ApiError(401, 'UNAUTHORIZED', 'A current capability is required.'); };
const notFound = () => { throw new ApiError(404, 'NOT_FOUND', 'Resource not found.'); };
const ok = (body, status = 200) => ({ status, body });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function publicImport(item) {
  return Object.fromEntries(publicImportFields.map((field) => [field, item[field]]));
}

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, version: workspace.version };
}

function event(workspace, type, subject, importId = null) {
  const cursor = workspace.events.length + 1;
  if (!Number.isSafeInteger(cursor)) conflict('Event cursor capacity exceeded.');
  workspace.events.push({ cursor, type, subject, importId });
}

function requireRole(capability, roles) {
  if (!roles.includes(capability.role)) forbidden();
}

function findImport(workspace, id) {
  const item = workspace.imports.find((entry) => entry.id === id);
  if (!item) notFound();
  return item;
}

function ownerToken(state, workspace) {
  // This stable non-capability key is owned by storage. Only the derived
  // capability hash is stored; the raw capability exists in this response.
  return 'relay_owner_' + createHmac('sha256', state.ownerDerivationKey)
    .update('relay-directory/owner/v1\0', 'utf8')
    .update(JSON.stringify([workspace.id, workspace.creation.nonce]), 'utf8')
    .digest('base64url');
}

function applyRows(workspace, item) {
  const members = new Map(workspace.members.map((member) => [member.externalId, { ...member }]));
  for (const row of item.rows) {
    const existing = members.get(row.externalId);
    if (row.op === 'delete') {
      if (!existing) conflict('Cannot delete an absent member.');
      members.delete(row.externalId);
    } else {
      const revision = existing ? existing.revision + 1 : 1;
      if (!Number.isSafeInteger(revision)) conflict('Member revision capacity exceeded.');
      members.set(row.externalId, { externalId: row.externalId, name: row.name, email: row.email, revision });
    }
  }
  const emails = new Set();
  for (const member of members.values()) {
    if (emails.has(member.email)) conflict('Final member emails must be unique.');
    emails.add(member.email);
  }
  return [...members.values()].sort((a, b) => compare(a.externalId, b.externalId));
}

export function createApi({ store, bootstrapToken }) {
  const bootstrapHash = typeof bootstrapToken === 'string' && bootstrapToken.length ? hashToken(bootstrapToken) : null;

  function identify(state, token) {
    const tokenHash = hashToken(token);
    if (bootstrapHash !== null && tokenHash === bootstrapHash) return { bootstrap: true };
    for (const workspace of state.workspaces) {
      const capability = workspace.capabilities.find((entry) => entry.tokenHash === tokenHash && !entry.revoked);
      if (capability) return { workspace, capability, bootstrap: false };
    }
    unauthorized();
  }

  function requireBootstrap(state, token) {
    if (!identify(state, token).bootstrap) forbidden();
  }

  function authorize(state, token, workspaceId) {
    const identity = identify(state, token);
    if (identity.bootstrap || identity.workspace.id !== workspaceId) forbidden();
    requireRole(identity.capability, allRoles);
    return identity;
  }

  function createWorkspace(state, token, body) {
    requireBootstrap(state, token);
    const fingerprint = requestHash(body);
    const existing = state.workspaces.find((workspace) => workspace.id === body.id);
    if (existing) {
      if (existing.creation.requestHash !== fingerprint) conflict('Workspace id is already in use.');
      return ok({ workspace: { id: existing.id, name: existing.name, version: 0 }, ownerToken: ownerToken(state, existing) });
    }
    const ownerCapabilityId = opaqueId();
    const workspace = {
      id: body.id, name: body.name, version: 0,
      creation: { requestHash: fingerprint, ownerCapabilityId, nonce: secretToken() },
      capabilities: [], members: [], imports: [], stagingReplays: [], events: [],
    };
    const tokenValue = ownerToken(state, workspace);
    workspace.capabilities.push({ id: ownerCapabilityId, subject: 'owner', role: 'owner', tokenHash: hashToken(tokenValue), revoked: false });
    event(workspace, 'workspace.created', 'bootstrap');
    state.workspaces.push(workspace);
    return ok({ workspace: publicWorkspace(workspace), ownerToken: tokenValue }, 201);
  }

  function mutate(state, token, route, body, key, prepared) {
    const { workspace, capability } = authorize(state, token, route.workspaceId);
    const item = route.importId ? findImport(workspace, route.importId) : null;
    const subject = capability.subject;
    switch (route.operation) {
      case 'issue': {
        requireRole(capability, ['owner']);
        const { subject: issuedSubject, role } = prepared;
        const id = opaqueId();
        const issuedToken = secretToken();
        workspace.capabilities.push({ id, subject: issuedSubject, role, tokenHash: hashToken(issuedToken), revoked: false });
        event(workspace, 'capability.issued', subject);
        return ok({ id, subject: issuedSubject, role, token: issuedToken });
      }
      case 'revoke': {
        requireRole(capability, ['owner']);
        const target = workspace.capabilities.find((entry) => entry.id === route.capabilityId);
        if (!target) notFound();
        if (!target.revoked) {
          target.revoked = true;
          event(workspace, 'capability.revoked', subject);
        }
        return ok({ id: target.id, revoked: true });
      }
      case 'stage': {
        requireRole(capability, ['owner', 'editor']);
        const fingerprint = requestHash(body);
        const replay = workspace.stagingReplays.find((entry) => entry.subject === subject && entry.key === key);
        if (replay) {
          if (replay.requestHash !== fingerprint) conflict('Idempotency key was used with a different request.');
          return ok(copy(replay.result));
        }
        const rows = stageBody(body);
        if (body.baseVersion !== workspace.version) conflict('Directory base version is stale.');
        const staged = {
          id: opaqueId(), workspaceId: workspace.id, creator: subject,
          baseVersion: body.baseVersion, state: 'staged', rowCount: rows.length,
          digest: hash(body.csv), leaseEpoch: 0, approvedBy: null,
          rows, rejectionReason: null, lease: null, commitReplay: null,
        };
        const result = { import: publicImport(staged) };
        workspace.imports.push(staged);
        workspace.stagingReplays.push({ subject, key, requestHash: fingerprint, importId: staged.id, result: copy(result) });
        event(workspace, 'import.staged', subject, staged.id);
        return ok(result, 201);
      }
      case 'approve': {
        requireRole(capability, ['owner', 'approver']);
        if (subject === item.creator) forbidden();
        if (item.approvedBy !== null) {
          if (item.approvedBy !== subject) conflict('Import was approved by another subject.');
          return ok({ import: publicImport(item) });
        }
        if (item.state !== 'staged') conflict();
        item.approvedBy = subject;
        item.state = 'approved';
        event(workspace, 'import.approved', subject, item.id);
        return ok({ import: publicImport(item) });
      }
      case 'reject': {
        requireRole(capability, ['owner', 'approver']);
        if (item.state !== 'staged') conflict();
        item.state = 'rejected';
        item.rejectionReason = prepared;
        event(workspace, 'import.rejected', subject, item.id);
        return ok({ import: publicImport(item) });
      }
      case 'cancel': {
        if (capability.role !== 'owner' && !(capability.role === 'editor' && subject === item.creator)) forbidden();
        if (!['staged', 'approved', 'leased'].includes(item.state)) conflict();
        item.state = 'cancelled';
        item.lease = null;
        event(workspace, 'import.cancelled', subject, item.id);
        return ok({ import: publicImport(item) });
      }
      case 'claim': {
        requireRole(capability, ['worker']);
        const now = Date.now();
        if (item.state !== 'approved' && !(item.state === 'leased' && item.lease && item.lease.expiresAt <= now)) conflict('Import is not available for claim.');
        if (!Number.isSafeInteger(item.leaseEpoch + 1)) conflict('Lease epoch capacity exceeded.');
        const leaseToken = secretToken();
        const expiresAt = now + prepared;
        item.leaseEpoch += 1;
        item.state = 'leased';
        item.lease = { capabilityId: capability.id, subject, epoch: item.leaseEpoch, tokenHash: hashToken(leaseToken), expiresAt };
        event(workspace, 'import.claimed', subject, item.id);
        return ok({ import: publicImport(item), leaseToken, expiresAt });
      }
      case 'commit': {
        requireRole(capability, ['worker']);
        const fingerprint = requestHash(body);
        const replay = item.commitReplay;
        if (replay) {
          if (replay.capabilityId !== capability.id || replay.subject !== subject || replay.key !== key || replay.requestHash !== fingerprint) conflict('Commit does not match the original operation.');
          return ok(copy(replay.result));
        }
        const leaseToken = commitBody(body);
        const lease = item.lease;
        if (item.state !== 'leased' || !lease || lease.capabilityId !== capability.id || lease.subject !== subject
          || lease.epoch !== item.leaseEpoch || lease.expiresAt <= Date.now() || lease.tokenHash !== hashToken(leaseToken)) {
          conflict('Lease is not current.');
        }
        if (item.baseVersion !== workspace.version) conflict('Directory base version is stale.');
        const members = applyRows(workspace, item);
        if (!Number.isSafeInteger(workspace.version + 1)) conflict('Directory version capacity exceeded.');
        workspace.members = members;
        workspace.version += 1;
        item.state = 'committed';
        item.lease = null;
        const result = { import: publicImport(item), version: workspace.version, applied: item.rowCount };
        item.commitReplay = { capabilityId: capability.id, subject, key, requestHash: fingerprint, result: copy(result) };
        event(workspace, 'import.committed', subject, item.id);
        return ok(result);
      }
      default: notFound();
    }
  }

  function routeRequest(req) {
    let url;
    let parts;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
      parts = url.pathname.split('/').slice(1).map((part) => {
        const decoded = decodeURIComponent(part);
        if (decoded.includes('/') || decoded.includes('\0')) invalid('Malformed path.');
        return decoded;
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      invalid('Malformed request URL.');
    }
    const method = req.method;
    const route = { url };
    let expectedMethod;
    if (parts.length === 1 && parts[0] === 'health') {
      route.operation = 'health'; expectedMethod = 'GET';
    } else if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'workspaces') {
      route.operation = 'create'; expectedMethod = 'POST';
    } else if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'workspaces' && parts[2]) {
      route.workspaceId = parts[2];
      if (parts.length === 3) { route.operation = 'workspace'; expectedMethod = 'GET'; }
      else if (parts.length === 4 && ['members', 'events'].includes(parts[3])) { route.operation = parts[3]; expectedMethod = 'GET'; }
      else if (parts.length === 4 && parts[3] === 'tokens') { route.operation = 'issue'; expectedMethod = 'POST'; }
      else if (parts.length === 6 && parts[3] === 'tokens' && parts[4] && parts[5] === 'revoke') {
        route.operation = 'revoke'; route.capabilityId = parts[4]; expectedMethod = 'POST';
      } else if (parts.length === 4 && parts[3] === 'imports') {
        if (method === 'GET') { route.operation = 'imports'; expectedMethod = 'GET'; }
        else { route.operation = 'stage'; expectedMethod = 'POST'; }
      } else if (parts.length === 5 && parts[3] === 'imports' && parts[4]) {
        route.operation = 'import'; route.importId = parts[4]; expectedMethod = 'GET';
      } else if (parts.length === 6 && parts[3] === 'imports' && parts[4] && ['approve', 'reject', 'cancel', 'claim', 'commit'].includes(parts[5])) {
        route.operation = parts[5]; route.importId = parts[4]; expectedMethod = 'POST';
      }
    }
    if (!route.operation) notFound();
    if (method !== expectedMethod) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return route;
  }

  async function dispatch(req) {
    const route = routeRequest(req);
    if (route.operation === 'health') return ok({ ok: true });
    const token = bearerToken(req);
    const snapshot = store.snapshot();
    if (route.operation === 'create') requireBootstrap(snapshot, token);
    else {
      const { workspace } = authorize(snapshot, token, route.workspaceId);
      if (route.importId) findImport(workspace, route.importId);
      if (req.method === 'GET') {
        switch (route.operation) {
          case 'workspace': return ok({ workspace: publicWorkspace(workspace) });
          case 'members': return ok({ version: workspace.version, members: copy(workspace.members).sort((a, b) => compare(a.externalId, b.externalId)) });
          case 'imports': return ok({ imports: workspace.imports.map(publicImport).sort((a, b) => compare(a.id, b.id)) });
          case 'import': return ok({ import: publicImport(findImport(workspace, route.importId)) });
          case 'events': {
            const { after, limit } = eventQuery(route.url.searchParams);
            const events = workspace.events.filter((entry) => entry.cursor > after).slice(0, limit);
            return ok({ events: copy(events), nextCursor: events.length ? events.at(-1).cursor : after });
          }
          default: notFound();
        }
      }
    }
    const body = await readMutationBody(req);
    let prepared;
    let key;
    switch (route.operation) {
      case 'create': prepared = workspaceBody(body); break;
      case 'issue': prepared = capabilityBody(body); break;
      case 'stage': key = idempotencyKey(req); break;
      case 'reject': prepared = rejectionBody(body); break;
      case 'claim': prepared = leaseBody(body); break;
      case 'commit': key = idempotencyKey(req); break;
      default: emptyBody(body);
    }
    return store.transact((state) => route.operation === 'create'
      ? createWorkspace(state, token, prepared)
      : mutate(state, token, route, body, key, prepared));
  }

  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
    res.end(json);
  }

  async function handle(req, res) {
    // Also absorb a late aborted-stream error after body listeners are removed.
    req.on('error', () => {});
    try {
      const result = await dispatch(req);
      send(res, result.status, result.body);
    } catch (error) {
      if (!req.complete && !req.destroyed) req.resume();
      const known = error instanceof ApiError;
      try {
        send(res, known ? error.status : 500, {
          error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'The operation could not be completed.' },
        });
      } catch {
        // A disconnected client must not turn a transport failure into an
        // unhandled rejection or interfere with later accepted transactions.
      }
    }
  }

  return { handle };
}
