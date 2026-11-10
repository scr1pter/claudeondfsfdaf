import { TextDecoder } from 'node:util';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function invalid(message = 'Malformed request.') {
  throw new ApiError(400, 'INVALID_INPUT', message);
}

export function objectBody(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('A JSON object is required.');
  return value;
}

export function emptyBody(body) {
  if (Object.keys(body).length !== 0) invalid('An empty JSON object is required.');
}

export function singleHeader(req, name) {
  let count = 0;
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count += 1;
  }
  const value = req.headers[name];
  return count > 1 || Array.isArray(value) ? undefined : value;
}

export function bearerToken(req) {
  const header = singleHeader(req, 'authorization');
  const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) throw new ApiError(401, 'UNAUTHORIZED', 'A current capability is required.');
  return match[1];
}

export function idempotencyKey(req) {
  const key = singleHeader(req, 'idempotency-key');
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) invalid('A valid Idempotency-Key is required.');
  return key;
}

export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`Invalid ${label}.`);
  return value;
}

function trimmed(value, max, label) {
  if (typeof value !== 'string') invalid(`Invalid ${label}.`);
  const normalized = value.trim();
  if (!normalized || [...normalized].length > max) invalid(`Invalid ${label}.`);
  return normalized;
}

export function workspaceBody(body) {
  if (typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{2,23}$/.test(body.id)) invalid('Invalid workspace id.');
  return { ...body, id: body.id, name: trimmed(body.name, 80, 'workspace name') };
}

export function capabilityBody(body) {
  if (typeof body.subject !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(body.subject)) invalid('Invalid subject.');
  if (!['editor', 'approver', 'worker', 'viewer'].includes(body.role)) invalid('Invalid role.');
  return { subject: body.subject, role: body.role };
}

export function rejectionBody(body) {
  return trimmed(body.reason, 160, 'rejection reason');
}

export function leaseBody(body) {
  return integer(body.leaseMs, 100, 5000, 'lease duration');
}

export function commitBody(body) {
  if (typeof body.leaseToken !== 'string' || !body.leaseToken) invalid('Invalid lease token.');
  return body.leaseToken;
}

export function eventQuery(searchParams) {
  const read = (name, fallback, min, max) => {
    const values = searchParams.getAll(name);
    if (values.length === 0) return fallback;
    if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) invalid(`Invalid ${name}.`);
    return integer(Number(values[0]), min, max, name);
  };
  return {
    after: read('after', 0, 0, Number.MAX_SAFE_INTEGER),
    limit: read('limit', 50, 1, 100),
  };
}

export async function readMutationBody(req) {
  const contentType = singleHeader(req, 'content-type');
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;[^\r\n]*)?\s*$/i.test(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  }
  const maxBytes = 262144;
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
    };
    const fail = (error) => {
      cleanup();
      chunks.length = 0;
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) return fail(new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.'));
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new ApiError(400, 'INVALID_INPUT', 'Incomplete request body.'));
    const onError = () => fail(new ApiError(400, 'INVALID_INPUT', 'Unable to read request body.'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    if (req.aborted || req.destroyed) onAborted();
  });
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return objectBody(JSON.parse(text));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid('Body must be valid UTF-8 JSON.');
  }
}

// A field parser, not split(','): closing quotes must be followed by a
// delimiter, and only LF/CRLF may delimit records. A final delimiter creates
// no extra record, whereas a second final line ending creates an empty row.
export function parseCsv(csv) {
  if (typeof csv !== 'string') invalid('CSV must be a string.');
  if (Buffer.byteLength(csv, 'utf8') > 65536) throw new ApiError(413, 'CSV_TOO_LARGE', 'CSV is too large.');
  const text = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;
  const records = [];
  let record = [];
  let field = '';
  let mode = 'start';
  let endedRecord = false;
  const finishField = () => {
    record.push(field);
    field = '';
    mode = 'start';
  };
  const finishRecord = () => {
    finishField();
    records.push(record);
    record = [];
    endedRecord = true;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (mode === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else mode = 'closed';
      } else field += char;
      endedRecord = false;
      continue;
    }
    if (char === ',') { finishField(); endedRecord = false; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (text[i + 1] !== '\n') invalid('Malformed CSV line ending.');
        i += 1;
      }
      finishRecord();
      continue;
    }
    if (mode === 'closed') invalid('Malformed CSV quoting.');
    if (char === '"') {
      if (mode !== 'start') invalid('Malformed CSV quoting.');
      mode = 'quoted';
    } else {
      field += char;
      mode = 'plain';
    }
    endedRecord = false;
  }
  if (mode === 'quoted') invalid('Unterminated CSV quote.');
  if (!endedRecord) finishRecord();
  const header = records.shift();
  if (!header || header.length !== 4 || header.some((value, index) => value !== ['op', 'external_id', 'name', 'email'][index])) {
    invalid('Invalid CSV header.');
  }
  if (records.length < 1 || records.length > 500) invalid('CSV must contain 1 to 500 data rows.');
  const seen = new Set();
  return records.map((columns) => {
    if (columns.length !== 4) invalid('Each CSV row must contain four columns.');
    const [op, externalId, rawName, rawEmail] = columns;
    if (op !== 'upsert' && op !== 'delete') invalid('Invalid CSV operation.');
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(externalId) || seen.has(externalId)) invalid('Invalid or duplicate external id.');
    seen.add(externalId);
    if (op === 'delete') {
      if (rawName !== '' || rawEmail !== '') invalid('Delete fields must be empty.');
      return { op, externalId, name: '', email: '' };
    }
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(rawName)) invalid('Unsafe member name.');
    const name = trimmed(rawName, 80, 'member name');
    const at = rawEmail.indexOf('@');
    const domain = rawEmail.slice(at + 1);
    if ([...rawEmail].length > 120 || /[\s\u0000-\u001F\u007F-\u009F]/u.test(rawEmail)
      || at < 1 || rawEmail.lastIndexOf('@') !== at || !domain.includes('.') || domain.split('.').some((part) => !part)) {
      invalid('Invalid member email.');
    }
    return { op, externalId, name, email: rawEmail.toLowerCase() };
  });
}

export function stageBody(body) {
  integer(body.baseVersion, 0, Number.MAX_SAFE_INTEGER, 'base version');
  return parseCsv(body.csv);
}
