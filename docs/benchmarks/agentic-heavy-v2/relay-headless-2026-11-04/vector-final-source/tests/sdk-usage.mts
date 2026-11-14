import { createClient, RelayError } from '../sdk.mjs';
import type { Role, ImportState, Member, ImportRecord, RelayClient } from '../sdk.mjs';

interface VerificationOptions {
  baseUrl: string;
  workspaceId: string;
  editorToken: string;
  approverToken: string;
  workerToken: string;
}

function check(condition: boolean, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

/** Also usable as a strict TypeScript consumer fixture when tsc is available. */
export async function verifyTypedSdk(options: VerificationOptions): Promise<{ ok: true; version: number }> {
  const roles: Role[] = ['owner', 'editor', 'approver', 'worker', 'viewer'];
  const states: ImportState[] = ['staged', 'approved', 'leased', 'committed', 'rejected', 'cancelled'];
  check(roles.length === 5 && states.length === 6, 'Exact exported unions');
  const editor: RelayClient = createClient({ baseUrl: options.baseUrl, token: options.editorToken });
  const approver = createClient({ baseUrl: options.baseUrl, token: options.approverToken });
  const worker = createClient({ baseUrl: options.baseUrl, token: options.workerToken });
  const before = await editor.members(options.workspaceId);
  const stage = await editor.stage(options.workspaceId, {
    baseVersion: before.version,
    csv: 'op,external_id,name,email\nupsert,sdk_member,SDK Synthetic,sdk@example.test\n',
  }, 'typed-stage');
  const imported: ImportRecord = stage.import;
  check(imported.state === 'staged', 'SDK staging');
  await approver.approve(options.workspaceId, imported.id);
  const lease = await worker.claim(options.workspaceId, imported.id, 5000);
  const committed = await worker.commit(options.workspaceId, imported.id, lease.leaseToken, 'typed-commit');
  const replay = await worker.commit(options.workspaceId, imported.id, lease.leaseToken, 'typed-commit');
  check(committed.version === before.version + 1 && replay.version === committed.version, 'SDK durable commit replay');
  const members: Member[] = (await editor.members(options.workspaceId)).members;
  check(members.some(member => member.externalId === 'sdk_member' && member.revision === 1), 'SDK member result');
  const workspaceResult = await editor.workspace(options.workspaceId);
  check(workspaceResult.workspace.version === committed.version, 'SDK workspace version');
  const cancelled = await editor.stage(options.workspaceId, {
    baseVersion: committed.version,
    csv: 'op,external_id,name,email\nupsert,not_applied,Cancelled,cancelled@example.test',
  }, 'typed-cancel');
  check((await editor.cancel(options.workspaceId, cancelled.import.id)).import.state === 'cancelled', 'SDK cancel');
  const events = await editor.events(options.workspaceId, { after: 0, limit: 100 });
  check(events.events.length > 0 && events.nextCursor > 0, 'SDK events');
  const invalid = createClient({ baseUrl: options.baseUrl, token: 'synthetic-invalid-capability' });
  try {
    await invalid.workspace(options.workspaceId);
    throw new Error('SDK should reject unauthorized request');
  } catch (error: unknown) {
    check(error instanceof RelayError && error.status === 401 && typeof error.code === 'string', 'Typed RelayError');
  }
  return { ok: true, version: committed.version };
}
