export type Role = 'owner' | 'editor' | 'approver' | 'worker' | 'viewer';
export type ImportState = 'staged' | 'approved' | 'leased' | 'committed' | 'rejected' | 'cancelled';
export interface Member {externalId: string; name: string; email: string; revision: number}
export interface ImportRecord {id: string; workspaceId: string; creator: string; baseVersion: number; state: ImportState; rowCount: number; digest: string; leaseEpoch: number; approvedBy: string | null}
export interface Workspace {id: string; name: string; version: number}
export interface AuditEvent {cursor: number; type: string; subject: string; importId: string | null}
export class RelayError extends Error {status: number; code: string; constructor(status: number, code: string, message: string)}
export function createClient(options: {baseUrl: string; token: string}): {
  workspace(id: string): Promise<{workspace: Workspace}>;
  members(id: string): Promise<{version: number; members: Member[]}>;
  stage(id: string, body: {baseVersion: number; csv: string}, key: string): Promise<{import: ImportRecord}>;
  approve(id: string, importId: string): Promise<{import: ImportRecord}>;
  claim(id: string, importId: string, leaseMs: number): Promise<{import: ImportRecord; leaseToken: string; expiresAt: number}>;
  commit(id: string, importId: string, leaseToken: string, key: string): Promise<{import: ImportRecord; version: number; applied: number}>;
  cancel(id: string, importId: string): Promise<{import: ImportRecord}>;
  events(id: string, options?: {after?: number; limit?: number}): Promise<{events: AuditEvent[]; nextCursor: number}>;
};
