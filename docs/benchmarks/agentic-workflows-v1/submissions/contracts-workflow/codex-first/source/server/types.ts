export type Status = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type LegacyJob = {
  id: string; name: string; kind: string; status: Status; attempt: number;
  result: string | null; error: string | null; created_at: number; updated_at: number;
};
export type WorkflowRow = {
  id: string; name: string; concurrency: number; status: string;
  created_at: number; updated_at: number; legacy: number;
};
export type Node = LegacyJob & { workflow_id: string; key: string; depends_on: string; max_attempts: number };
export type Definition = {
  name: string; concurrency: number;
  jobs: { key: string; name: string; kind: string; dependsOn: string[]; maxAttempts: number }[];
};
