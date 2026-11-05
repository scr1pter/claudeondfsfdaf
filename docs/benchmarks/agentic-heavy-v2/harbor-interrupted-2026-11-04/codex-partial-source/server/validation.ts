export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, message: string, code = status === 400 ? 'invalid_input' : status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'conflict'): never {
  throw new ApiError(status, code, message);
}
export async function body(req: Request): Promise<Record<string, any>> {
  let value: unknown;
  try { value = await req.json(); } catch { return fail(400, 'The request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'The request body must be a JSON object.');
  return value as Record<string, any>;
}
export function string(value: unknown, label: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim())) fail(400, `${label} must be ${required ? 'a nonempty' : 'a'} string.`);
  return value;
}
export function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(400, `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
export function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(400, `${label} must be one of: ${values.join(', ')}.`);
  return value as T;
}
export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(400, `${label} must be true or false.`);
  return value;
}
export type Step = {key:string;name:string;kind:'check'|'build'|'deploy';dependsOn:string[];durationMs:number;failureMode:'never'|'once'|'always'};
export function steps(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) fail(400, 'A plan requires between 1 and 12 steps.');
  const result: Step[] = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, `Step ${index + 1} must be an object.`);
    const key = string(raw.key, `Step ${index + 1} key`);
    if (!/^[a-z0-9-]{1,32}$/.test(key)) fail(400, 'Step keys require 1–32 lowercase letters, digits or hyphens.');
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d: unknown) => typeof d !== 'string') || new Set(raw.dependsOn).size !== raw.dependsOn.length) fail(400, `Dependencies for ${key} must be distinct step keys.`);
    return {key, name:string(raw.name, `Step ${key} name`), kind:enumeration(raw.kind, ['check','build','deploy'], 'Step kind'), dependsOn:[...raw.dependsOn], durationMs:integer(raw.durationMs, 'Step duration',100,5000), failureMode:enumeration(raw.failureMode,['never','once','always'],'Step failure mode')};
  });
  const keys = new Set(result.map(s => s.key));
  if (keys.size !== result.length) fail(400, 'Step keys must be unique.');
  const byKey = new Map(result.map(s => [s.key,s]));
  for (const s of result) for (const dep of s.dependsOn) {
    if (!keys.has(dep)) fail(400, `Unknown dependency ${dep}.`);
    if (dep === s.key) fail(400, `Step ${s.key} cannot depend on itself.`);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) fail(400, 'Step dependencies contain a cycle.');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)!.dependsOn) visit(dep);
    visiting.delete(key); visited.add(key);
  }
  for (const key of keys) visit(key);
  return result;
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
