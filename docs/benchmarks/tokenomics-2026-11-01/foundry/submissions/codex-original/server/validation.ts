import { fail } from './db';
export function object(value: any): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.'); return value; }
export function keys(b: Record<string, any>, allowed: string[]) { for (const k of Object.keys(b)) if (!allowed.includes(k)) fail(400, `Field “${k}” cannot be set here.`); }
export function str(value: any, label: string, required = false, max = 10000): string { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label} must be ${required ? 'a nonempty' : 'a'} string (maximum ${max} characters).`); return value; }
export function email(value: any, required = false) { const e = str(value, 'Email', required, 254).trim().toLowerCase(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.'); return e; }
export function integer(value: any, label: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(400, `${label} must be an integer from ${min} to ${max}.`); return value; }
export function choice(value: any, choices: string[], label: string): string { if (typeof value !== 'string' || !choices.includes(value)) fail(400, `${label} must be one of: ${choices.join(', ')}.`); return value; }
export function date(value: any) { if (value === null) return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, 'Due date must be a valid YYYY-MM-DD date.'); return value; }
export function parseCsv(input: any): string[][] {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 1048576) fail(400, 'CSV must be text, up to 1 MB.');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
    else if (c === '"') { if (field || closed) fail(400, 'Invalid CSV quoting.'); quoted = true; }
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; rows.push(row); row = []; }
    } else { if (closed) fail(400, 'Unexpected text after a quoted CSV field.'); field += c; }
  }
  if (quoted) fail(400, 'Unclosed CSV quote.');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}
export function csvCell(value: any): string { let s = value == null ? '' : String(value); if (typeof value === 'string' && (/^[\s]*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
