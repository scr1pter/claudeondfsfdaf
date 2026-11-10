import { createClient, RelayError } from '../sdk.mjs';
import type { Role, ImportState, Member, ImportRecord, RelayClient, ClientOptions } from '../sdk.mjs';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type RolesAreExact = Expect<Equal<Role, 'owner' | 'editor' | 'approver' | 'worker' | 'viewer'>>;
export type StatesAreExact = Expect<Equal<ImportState, 'staged' | 'approved' | 'leased' | 'committed' | 'rejected' | 'cancelled'>>;

export async function exerciseSDK(options: {
  baseUrl: string; owner: string; approver: string; worker: string; workspace: string;
}): Promise<{ version: number; member: Member; record: ImportRecord; events: number }> {
  const config: ClientOptions = { baseUrl: options.baseUrl, token: options.owner };
  const owner: RelayClient = createClient(config);
  const approver = createClient({ baseUrl: options.baseUrl, token: options.approver });
  const worker = createClient({ baseUrl: options.baseUrl, token: options.worker });
  const status = await owner.workspace(options.workspace);
  const staged = await owner.stage(options.workspace, {
    baseVersion: status.workspace.version,
    csv: 'op,external_id,name,email\nupsert,sdk_person,SDK Synthetic,sdk@example.test',
  }, 'typed_sdk_stage');
  const approved = await approver.approve(options.workspace, staged.import.id);
  if (approved.import.state !== 'approved') throw new Error('SDK approval failed');
  const claimed = await worker.claim(options.workspace, staged.import.id, 5000);
  const committed = await worker.commit(options.workspace, staged.import.id, claimed.leaseToken, 'typed_sdk_commit');
  const replay = await worker.commit(options.workspace, staged.import.id, claimed.leaseToken, 'typed_sdk_commit');
  if (replay.version !== committed.version) throw new Error('SDK replay changed version');
  const members = await owner.members(options.workspace);
  const cancelled = await owner.stage(options.workspace, { baseVersion: committed.version, csv: 'op,external_id,name,email\ndelete,sdk_person,,' }, 'typed_sdk_cancel');
  await owner.cancel(options.workspace, cancelled.import.id);
  const events = await owner.events(options.workspace, { after: 0, limit: 100 });
  try { await owner.workspace('absent-sdk-workspace'); } catch (error: unknown) {
    if (!(error instanceof RelayError) || typeof error.status !== 'number' || typeof error.code !== 'string') throw error;
  }
  return { version: members.version, member: members.members[0], record: committed.import, events: events.events.length };
}

function rejectedCalls(client: RelayClient): void {
  // These compile-time checks ensure the public API rejects invalid argument shapes.
  // @ts-expect-error baseVersion is numeric
  void client.stage('alpha', { baseVersion: '0', csv: '' }, 'key');
  // @ts-expect-error leaseMs is required and numeric
  void client.claim('alpha', 'import');
  // @ts-expect-error commit key is required
  void client.commit('alpha', 'import', 'secret');
  // @ts-expect-error cursor is numeric
  void client.events('alpha', { after: '1' });
  // @ts-expect-error this method is not part of the public SDK
  void client.unknown();
}
void rejectedCalls;
