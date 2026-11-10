import type { Definition } from "./types";

export const kinds = ["succeed", "fail", "fail_once", "block"];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const validName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function validate(input: unknown): Definition {
  if (!object(input) || !validName(input.name) || !integer(input.concurrency, 1, 3) ||
      !Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 40)
    throw new Error("Provide a workflow name, concurrency from 1 to 3, and 1 to 40 jobs.");
  const jobs: Definition["jobs"] = input.jobs.map((job: unknown) => {
    if (!object(job) || typeof job.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(job.key) ||
        !validName(job.name) || typeof job.kind !== "string" || !kinds.includes(job.kind) ||
        (job.maxAttempts !== undefined && !integer(job.maxAttempts, 1, 3)) ||
        (job.dependsOn !== undefined && (!Array.isArray(job.dependsOn) ||
          !job.dependsOn.every((key: unknown) => typeof key === "string"))))
      throw new Error("Each job needs a valid key, name, kind, dependencies, and maxAttempts from 1 to 3.");
    return { key: job.key, name: job.name.trim(), kind: job.kind,
      dependsOn: (job.dependsOn ?? []) as string[], maxAttempts: (job.maxAttempts ?? 1) as number };
  });
  const byKey = new Map(jobs.map(job => [job.key, job]));
  if (byKey.size !== jobs.length) throw new Error("Job keys must be unique.");
  for (const job of jobs) {
    if (new Set(job.dependsOn).size !== job.dependsOn.length) throw new Error("Dependencies must be unique.");
    if (job.dependsOn.some(key => key === job.key || !byKey.has(key)))
      throw new Error("Dependencies must refer to other jobs in this workflow.");
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new Error("Workflow dependencies contain a cycle.");
    if (visited.has(key)) return;
    visiting.add(key); byKey.get(key)!.dependsOn.forEach(visit);
    visiting.delete(key); visited.add(key);
  }
  jobs.forEach(job => visit(job.key));
  return { name: input.name.trim(), concurrency: input.concurrency, jobs };
}

// Object property order is irrelevant; array order and request contents are significant.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
