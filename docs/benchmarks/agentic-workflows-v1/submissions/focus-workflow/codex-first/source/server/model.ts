export const kinds = ["succeed", "fail", "fail_once", "block"] as const;
export type Kind = (typeof kinds)[number];
export type Status = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type LegacyJob = {
  id: string; name: string; kind: Kind; status: Status; attempt: number;
  result: string | null; error: string | null; created_at: number; updated_at: number;
};
export type WorkflowRow = {
  id: string; name: string; concurrency: number; status: Status;
  created_at: number; updated_at: number; is_legacy: number;
};
export type NodeRow = LegacyJob & { workflow_id: string; key: string; dependencies: string; max_attempts: number; position: number };
export type Attempt = {
  number: number; status: "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
  pid: number | null; startedAt: number; finishedAt: number | null;
};
export type Definition = {
  name: string; concurrency: number;
  jobs: { key: string; name: string; kind: Kind; dependsOn: string[]; maxAttempts: number }[];
};
export class InputError extends Error {}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120)
    throw new InputError("Names must contain 1–120 characters.");
  return value.trim();
}
export function kind(value: unknown): Kind {
  if (typeof value !== "string" || !kinds.includes(value as Kind)) throw new InputError("Unknown job kind.");
  return value as Kind;
}
export function validate(input: unknown): Definition {
  if (!object(input)) throw new InputError("Expected a workflow object.");
  const workflowName = name(input.name);
  if (!Number.isInteger(input.concurrency) || (input.concurrency as number) < 1 || (input.concurrency as number) > 3)
    throw new InputError("Concurrency must be an integer from 1 to 3.");
  if (!Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 40)
    throw new InputError("A workflow must contain 1–40 jobs.");
  const keys = new Set<string>();
  const jobs = input.jobs.map((job: unknown) => {
    if (!object(job) || typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key))
      throw new InputError("Job keys must start with a letter and contain up to 32 letters, digits, underscores or hyphens.");
    if (keys.has(job.key)) throw new InputError("Job keys must be unique.");
    keys.add(job.key);
    const dependsOn = job.dependsOn === undefined ? [] : job.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(key => typeof key !== "string") || new Set(dependsOn).size !== dependsOn.length)
      throw new InputError("Dependencies must be an array of unique job keys.");
    const maxAttempts = job.maxAttempts === undefined ? 1 : job.maxAttempts;
    if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
      throw new InputError("Maximum attempts must be an integer from 1 to 3.");
    return { key: job.key, name: name(job.name), kind: kind(job.kind), dependsOn: dependsOn as string[], maxAttempts };
  });
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new InputError("Workflow dependencies contain a cycle.");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const predecessor of byKey.get(key)!.dependsOn) {
      if (!keys.has(predecessor)) throw new InputError(`Unknown predecessor: ${predecessor}`);
      visit(predecessor);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of keys) visit(key);
  return { name: workflowName, concurrency: input.concurrency as number, jobs };
}
// JSON object member order is insignificant; array order is deliberately retained.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
