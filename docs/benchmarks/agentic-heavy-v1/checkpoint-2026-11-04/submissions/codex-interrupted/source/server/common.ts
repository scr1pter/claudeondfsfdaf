export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function empty(): Response { return new Response(null, { status: 204 }); }

export async function readJson(request: Request): Promise<Record<string, any>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new ApiError(400, 'invalid_json', 'A valid JSON object is required.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_json', 'A JSON object is required.');
  return value as Record<string, any>;
}

export function requiredString(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'invalid_input', `${label} is required and must be at most ${max} characters.`);
  return value.trim();
}

export function optionalString(value: unknown, label: string, max = 10000): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, 'invalid_input', `${label} must be a string of at most ${max} characters.`);
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'invalid_input', `${label} must be an integer between ${min} and ${max}.`);
  return value;
}

export function allowFields(body: Record<string, unknown>, allowed: string[]): void {
  for (const field of Object.keys(body)) if (!allowed.includes(field)) throw new ApiError(400, 'invalid_field', `Field ${field} cannot be set here.`);
}

export function requireRole(ctx: {workspace:{role:string}}, roles: string[]): void {
  if (!roles.includes(ctx.workspace.role)) throw new ApiError(403, 'forbidden', 'Your workspace role cannot perform this action.');
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += c;
    } else if (c === '"') {
      if (value || closed) throw new ApiError(400, 'invalid_csv', 'Unexpected quote in CSV field.');
      quoted = true;
    } else if (c === ',') { row.push(value); value = ''; closed = false; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = ''; closed = false;
    } else {
      if (closed) throw new ApiError(400, 'invalid_csv', 'Unexpected text after a quoted CSV field.');
      value += c;
    }
  }
  if (quoted) throw new ApiError(400, 'invalid_csv', 'A quoted CSV field is not closed.');
  if (row.length || value || closed) { row.push(value); rows.push(row); }
  return rows;
}

export function csvResponse(rows: unknown[][], filename: string): Response {
  const escape = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && (/^[\t\r]/.test(text) || /^[\s]*[=+\-@]/.test(text))) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  return new Response(rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n', {
    headers: {'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`, 'Cache-Control':'no-store'}
  });
}
