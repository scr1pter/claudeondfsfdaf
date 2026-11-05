import { createHash, createHmac, randomBytes } from 'node:crypto';
import { openStore, authenticate, createCapability, createSecret, hashSecret } from './storage.mjs';
import { validateCommand } from './validation.mjs';

const reads = new Set(['workspace', 'members', 'import', 'imports', 'events']);
const sortId = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const validKey = key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(key);

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function fingerprint(body) {
  return createHash('sha256').update(canonical(body), 'utf8').digest('hex');
}

function workspaceView(workspace) {
  return { id: workspace.id, name: workspace.name, version: workspace.version };
}

function importView(record) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    creator: record.creator,
    baseVersion: record.baseVersion,
    state: record.state,
    rowCount: record.rowCount,
    digest: record.digest,
    leaseEpoch: record.leaseEpoch,
    approvedBy: record.approvedBy,
  };
}

function event(workspace, type, subject, importId = null) {
  workspace.events.push({ cursor: workspace.events.length + 1, type, subject, importId });
}

function requireRole(capability, allowed) {
  if (!allowed.includes(capability.role)) fail(403, 'forbidden', 'The capability does not permit this operation.');
}

function existingImport(workspace, importId) {
  const record = workspace.imports.find(item => item.id === importId);
  if (!record) fail(404, 'not_found', 'Import not found.');
  return record;
}

function conflict(message = 'The operation conflicts with the current state.') {
  fail(409, 'conflict', message);
}

export async function createDomain({ dataDir, bootstrapToken }) {
  if (typeof bootstrapToken !== 'string' || !bootstrapToken) throw new Error('A bootstrap capability is required.');
  const bootstrapHash = hashSecret(bootstrapToken);
  const store = await openStore({ dataDir });
  const ownerSecret = (capabilityId, workspaceId) => createHmac('sha256', bootstrapToken)
    .update(`relay-owner:${capabilityId}:${workspaceId}`).digest('base64url');

  function context(state, command) {
    // Authentication is repeated at the serialized write boundary, including replays.
    if (typeof command.token === 'string' && hashSecret(command.token) === bootstrapHash) {
      fail(403, 'forbidden', 'The bootstrap capability does not permit workspace operations.');
    }
    const capability = authenticate(state, command.token, command.workspaceId);
    const workspace = state.workspaces.find(item => item.id === command.workspaceId);
    if (!workspace) fail(404, 'not_found', 'Workspace not found.');
    return { capability, workspace };
  }

  function authorizeBootstrap(state, token) {
    if (typeof token === 'string' && hashSecret(token) === bootstrapHash) return;
    authenticate(state, token);
    fail(403, 'forbidden', 'The capability does not permit workspace creation.');
  }

  function createWorkspace(state, raw) {
    authorizeBootstrap(state, raw.token);
    // A used valid key identifies the original request before validating new
    // fields. Any different parsed JSON body is a conflict, including null.
    if (validKey(raw.key)) {
      const replay = state.workspaceKeys.find(item => item.key === raw.key);
      if (replay) {
        if (replay.bodyDigest !== fingerprint(raw.body)) conflict('The idempotency key has already been used.');
        const workspace = state.workspaces.find(item => item.id === replay.workspaceId);
        const owner = state.capabilities.find(item => item.id === replay.capabilityId);
        const token = ownerSecret(replay.capabilityId, replay.workspaceId);
        if (!workspace || !owner || owner.revoked || hashSecret(token) !== owner.tokenHash) {
          conflict('The original workspace creation cannot be replayed.');
        }
        return { changed: false, result: { status: 200, body: { workspace: replay.workspace, ownerToken: token } } };
      }
    }
    const command = validateCommand(raw);
    const digest = fingerprint(command.body);
    if (state.workspaces.some(item => item.id === command.body.id)) conflict('The workspace ID already exists.');
    const workspace = {
      id: command.body.id, name: command.body.name.trim(), version: 0,
      members: [], imports: [], events: [], stageKeys: [], commitKeys: [],
    };
    const owner = createCapability({ workspaceId: workspace.id, subject: 'owner', role: 'owner' });
    const ownerToken = ownerSecret(owner.record.id, workspace.id);
    owner.record.tokenHash = hashSecret(ownerToken);
    state.capabilities.push(owner.record);
    state.workspaces.push(workspace);
    event(workspace, 'workspace.created', 'owner');
    const view = workspaceView(workspace);
    if (command.key !== undefined) {
      state.workspaceKeys.push({ key: command.key, bodyDigest: digest, workspaceId: workspace.id, capabilityId: owner.record.id, workspace: view });
    }
    return { changed: true, result: { status: 201, body: { workspace: view, ownerToken } } };
  }

  function read(state, raw) {
    const { capability, workspace } = context(state, raw);
    requireRole(capability, ['owner', 'editor', 'approver', 'worker', 'viewer']);
    const command = validateCommand(raw);
    let body;
    switch (command.operation) {
      case 'workspace': body = { workspace: workspaceView(workspace) }; break;
      case 'members': body = { version: workspace.version, members: [...workspace.members].sort((a, b) => sortId(a.externalId, b.externalId)) }; break;
      case 'import': body = { import: importView(existingImport(workspace, command.importId)) }; break;
      case 'imports': body = { imports: [...workspace.imports].sort((a, b) => sortId(a.id, b.id)).map(importView) }; break;
      case 'events': {
        const events = workspace.events.filter(item => item.cursor > command.query.after).slice(0, command.query.limit);
        body = { events, nextCursor: events.length ? events[events.length - 1].cursor : command.query.after };
        break;
      }
      default: fail(404, 'not_found', 'Endpoint not found.');
    }
    return { status: 200, body };
  }

  function mutate(state, raw) {
    if (raw.operation === 'createWorkspace') return createWorkspace(state, raw);
    const { capability, workspace } = context(state, raw);
    const roles = {
      issueToken: ['owner'], revokeToken: ['owner'], stage: ['owner', 'editor'],
      approve: ['owner', 'approver'], reject: ['owner', 'approver'],
      cancel: ['owner', 'editor'], claim: ['worker'], commit: ['worker'],
    };
    if (!Object.hasOwn(roles, raw.operation)) fail(404, 'not_found', 'Endpoint not found.');
    requireRole(capability, roles[raw.operation]);
    if (validKey(raw.key) && raw.operation === 'stage') {
      const replay = workspace.stageKeys.find(item => item.subject === capability.subject && item.key === raw.key);
      if (replay) {
        if (replay.bodyDigest !== fingerprint(raw.body)) conflict('The idempotency key has already been used.');
        return { changed: false, result: { status: 200, body: replay.result } };
      }
    }
    if (validKey(raw.key) && raw.operation === 'commit') {
      const replay = workspace.commitKeys.find(item => item.capabilityId === capability.id && item.key === raw.key);
      if (replay) {
        // Authentication for an absent import in this workspace remains 404.
        const record = existingImport(workspace, raw.importId);
        if (replay.bodyDigest !== fingerprint(raw.body) || replay.importId !== record.id) {
          conflict('The idempotency key has already been used.');
        }
        return { changed: false, result: { status: 200, body: replay.result } };
      }
    }
    const command = validateCommand(raw);
    const { operation, body } = command;
    let response;
    let type;
    let importId = null;
    let status = 200;

    if (operation === 'issueToken') {
      const issued = createCapability({ workspaceId: workspace.id, subject: body.subject, role: body.role });
      state.capabilities.push(issued.record);
      response = { id: issued.record.id, subject: issued.record.subject, role: issued.record.role, token: issued.token };
      type = 'capability.issued';
    } else if (operation === 'revokeToken') {
      const target = state.capabilities.find(item => item.id === command.capabilityId && item.workspaceId === workspace.id);
      if (!target) fail(404, 'not_found', 'Capability not found.');
      response = { id: target.id, revoked: true };
      if (target.revoked) return { changed: false, result: { status, body: response } };
      target.revoked = true;
      type = 'capability.revoked';
    } else if (operation === 'stage') {
      const bodyDigest = fingerprint(body);
      if (body.baseVersion !== workspace.version) conflict('The directory version has changed.');
      const record = {
        id: `imp_${randomBytes(18).toString('base64url')}`, workspaceId: workspace.id,
        creator: capability.subject, baseVersion: body.baseVersion, state: 'staged',
        rowCount: command.rows.length, digest: createHash('sha256').update(body.csv, 'utf8').digest('hex'),
        leaseEpoch: 0, approvedBy: null, rows: command.rows, lease: null,
      };
      workspace.imports.push(record);
      response = { import: importView(record) };
      workspace.stageKeys.push({ subject: capability.subject, key: command.key, bodyDigest, result: response });
      type = 'import.staged';
      importId = record.id;
      status = 201;
    } else {
      const record = existingImport(workspace, command.importId);
      importId = record.id;
      switch (operation) {
        case 'approve':
          if (record.approvedBy === capability.subject) {
            return { changed: false, result: { status, body: { import: importView(record) } } };
          }
          if (record.state !== 'staged') conflict();
          if (record.creator === capability.subject) fail(403, 'separation_required', 'The creator cannot approve this import.');
          record.approvedBy = capability.subject;
          record.state = 'approved';
          type = 'import.approved';
          response = { import: importView(record) };
          break;
        case 'reject':
          if (record.state !== 'staged') conflict();
          record.state = 'rejected';
          record.reason = body.reason.trim();
          type = 'import.rejected';
          response = { import: importView(record) };
          break;
        case 'cancel':
          if (capability.role !== 'owner' && record.creator !== capability.subject) {
            fail(403, 'forbidden', 'Only the owner or creator may cancel this import.');
          }
          if (!['staged', 'approved', 'leased'].includes(record.state)) conflict();
          record.state = 'cancelled';
          record.lease = null;
          type = 'import.cancelled';
          response = { import: importView(record) };
          break;
        case 'claim': {
          const now = Date.now();
          if (record.state !== 'approved' && !(record.state === 'leased' && record.lease && record.lease.expiresAt <= now)) conflict();
          const leaseToken = createSecret();
          const expiresAt = now + body.leaseMs;
          record.leaseEpoch += 1;
          record.state = 'leased';
          record.lease = { tokenHash: hashSecret(leaseToken), subject: capability.subject, capabilityId: capability.id, epoch: record.leaseEpoch, expiresAt };
          type = 'import.claimed';
          response = { import: importView(record), leaseToken, expiresAt };
          break;
        }
        case 'commit': {
          const bodyDigest = fingerprint(body);
          const lease = record.lease;
          if (record.state !== 'leased' || !lease || lease.subject !== capability.subject
            || lease.capabilityId !== capability.id || lease.epoch !== record.leaseEpoch
            || lease.expiresAt <= Date.now() || lease.tokenHash !== hashSecret(body.leaseToken)) {
            conflict('The worker lease is invalid or expired.');
          }
          if (record.baseVersion !== workspace.version) conflict('The directory version has changed.');
          const members = new Map(workspace.members.map(item => [item.externalId, item]));
          for (const row of record.rows) {
            const previous = members.get(row.externalId);
            if (row.op === 'delete') {
              if (!previous) conflict('A deleted member does not exist.');
              members.delete(row.externalId);
            } else {
              members.set(row.externalId, { externalId: row.externalId, name: row.name, email: row.email, revision: previous ? previous.revision + 1 : 1 });
            }
          }
          const emails = new Set();
          for (const member of members.values()) {
            if (emails.has(member.email)) conflict('Final member emails must be unique.');
            emails.add(member.email);
          }
          workspace.members = [...members.values()];
          workspace.version += 1;
          record.state = 'committed';
          record.lease = null;
          response = { import: importView(record), version: workspace.version, applied: record.rowCount };
          workspace.commitKeys.push({ capabilityId: capability.id, key: command.key, importId: record.id, bodyDigest, result: response });
          type = 'import.committed';
          break;
        }
        default: fail(404, 'not_found', 'Endpoint not found.');
      }
    }
    event(workspace, type, capability.subject, importId);
    return { changed: true, result: { status, body: response } };
  }

  return {
    authorize(command) {
      return store.read(state => {
        if (command.operation === 'createWorkspace') {
          authorizeBootstrap(state, command.token);
        } else context(state, command);
      });
    },
    execute(command) {
      return reads.has(command.operation)
        ? Promise.resolve(store.read(state => read(state, command)))
        : store.transact(state => mutate(state, command));
    },
    close() { return store.close(); },
  };
}
