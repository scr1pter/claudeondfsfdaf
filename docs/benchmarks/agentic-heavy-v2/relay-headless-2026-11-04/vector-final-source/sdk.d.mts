export type Role = 'owner' | 'editor' | 'approver' | 'worker' | 'viewer';
export type ImportState = 'staged' | 'approved' | 'leased' | 'committed' | 'rejected' | 'cancelled';

export interface Workspace {
  id: string;
  name: string;
  version: number;
}

export interface Member {
  externalId: string;
  name: string;
  email: string;
  revision: number;
}

export interface ImportRecord {
  id: string;
  workspaceId: string;
  creator: string;
  baseVersion: number;
  state: ImportState;
  rowCount: number;
  digest: string;
  leaseEpoch: number;
  approvedBy: string | null;
}

export type EventType = 'workspace.created' | 'capability.issued' | 'capability.revoked' |
  'import.staged' | 'import.approved' | 'import.rejected' | 'import.cancelled' |
  'import.claimed' | 'import.committed';

export interface RelayEvent {
  cursor: number;
  type: EventType;
  subject: string;
  importId: string | null;
}

export interface WorkspaceResult { workspace: Workspace }
export interface MembersResult { version: number; members: Member[] }
export interface ImportResult { import: ImportRecord }
export interface ClaimResult extends ImportResult { leaseToken: string; expiresAt: number }
export interface CommitResult extends ImportResult { version: number; applied: number }
export interface EventsResult { events: RelayEvent[]; nextCursor: number }
export interface StageInput { baseVersion: number; csv: string }
export interface EventsOptions { after?: number; limit?: number }
export interface ClientOptions { baseUrl: string; token: string }

export class RelayError extends Error {
  constructor(status: number, code: string, message: string);
  /** HTTP response status, or 0 for local validation/transport failures. */
  status: number;
  code: string;
}

export interface RelayClient {
  workspace(id: string): Promise<WorkspaceResult>;
  members(id: string): Promise<MembersResult>;
  stage(id: string, input: StageInput, key: string): Promise<ImportResult>;
  approve(id: string, importId: string): Promise<ImportResult>;
  claim(id: string, importId: string, leaseMs: number): Promise<ClaimResult>;
  commit(id: string, importId: string, leaseToken: string, key: string): Promise<CommitResult>;
  cancel(id: string, importId: string): Promise<ImportResult>;
  events(id: string, options?: EventsOptions): Promise<EventsResult>;
}

export function createClient(options: ClientOptions): RelayClient;
