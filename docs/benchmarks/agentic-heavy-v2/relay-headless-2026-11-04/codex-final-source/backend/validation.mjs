const workspacePattern = /^[a-z][a-z0-9-]{2,23}$/;
const subjectPattern = /^[a-zA-Z0-9_-]{1,32}$/;
const keyPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;

export class RelayInputError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RelayInputError';
    this.status = status;
    this.code = code;
  }
}

function invalid(message = 'Malformed input.') {
  throw new RelayInputError(400, 'invalid_input', message);
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('A JSON object is required.');
}

function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`Invalid ${field}.`);
}

function trimmed(value, max, field, rejectControls = true) {
  if (typeof value !== 'string') invalid(`Invalid ${field}.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || (rejectControls && controls.test(normalized))) invalid(`Invalid ${field}.`);
  return normalized;
}

function emptyBody(body) {
  object(body);
  if (Object.keys(body).length !== 0) invalid('An empty JSON object is required.');
}

function queryInteger(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalid(`Invalid ${field}.`);
  const parsed = Number(value);
  integer(parsed, min, max, field);
  return parsed;
}

// Parse RFC-style quoted fields without accepting quotes inside bare fields,
// characters after closing quotes, bare CRs, or multiple trailing blank rows.
export function parseCsv(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 65536) invalid('Invalid CSV size.');
  const input = csv.startsWith('\ufeff') ? csv.slice(1) : csv;
  const records = [];
  let record = [];
  let field = '';
  let state = 'start';
  let lastWasEnd = false;

  function pushField() {
    record.push(field);
    field = '';
    state = 'start';
  }
  function pushRecord() {
    pushField();
    records.push(record);
    record = [];
    if (records.length > 501) invalid('CSV must contain between 1 and 500 data rows.');
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else state = 'closed';
      } else {
        field += char;
      }
      lastWasEnd = false;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r') {
        if (input[index + 1] !== '\n') invalid('CSV contains an invalid line ending.');
        index += 1;
      }
      pushRecord();
      lastWasEnd = true;
      continue;
    }
    if (char === ',') {
      pushField();
      lastWasEnd = false;
      continue;
    }
    if (state === 'closed') invalid('CSV has characters after a quoted field.');
    if (char === '"') {
      if (state !== 'start') invalid('CSV contains malformed quoting.');
      state = 'quoted';
    } else {
      state = 'bare';
      field += char;
    }
    lastWasEnd = false;
  }
  if (state === 'quoted') invalid('CSV contains an unclosed quoted field.');
  if (!lastWasEnd || field !== '' || record.length !== 0) pushRecord();
  if (records.length < 2 || records.length > 501) invalid('CSV must contain between 1 and 500 data rows.');
  if (records[0].length !== 4 || records[0].some((value, index) => value !== ['op', 'external_id', 'name', 'email'][index])) invalid('Invalid CSV header.');

  const seen = new Set();
  return records.slice(1).map(columns => {
    if (columns.length !== 4) invalid('CSV rows must contain exactly four columns.');
    const [op, externalId, rawName, rawEmail] = columns;
    if (!subjectPattern.test(externalId) || seen.has(externalId)) invalid('Invalid or repeated external ID.');
    seen.add(externalId);
    if (op === 'delete') {
      if (rawName !== '' || rawEmail !== '') invalid('Delete rows require empty name and email.');
      return { op, externalId, name: '', email: '' };
    }
    if (op !== 'upsert') invalid('Unsupported CSV operation.');
    const name = trimmed(rawName, 80, 'member name');
    if (controls.test(rawName)) invalid('Invalid member name.');
    if (typeof rawEmail !== 'string' || rawEmail.length > 120 || /\s/u.test(rawEmail) || controls.test(rawEmail)) invalid('Invalid email.');
    const pieces = rawEmail.split('@');
    if (pieces.length !== 2 || !pieces[0] || !/^[^.]+(?:\.[^.]+)+$/.test(pieces[1])) invalid('Invalid email.');
    return { op, externalId, name, email: rawEmail.toLowerCase() };
  });
}

export function validateCommand(command) {
  const { operation, body, key } = command;
  const result = { ...command };
  if (operation === 'events') {
    const query = command.query ?? {};
    result.query = {
      after: queryInteger(query.after, 0, 0, Number.MAX_SAFE_INTEGER, 'after'),
      limit: queryInteger(query.limit, 50, 1, 100, 'limit'),
    };
    return result;
  }
  if (['workspace', 'members', 'import', 'imports'].includes(operation)) return result;
  object(body);
  switch (operation) {
    case 'createWorkspace':
      if (typeof body.id !== 'string' || !workspacePattern.test(body.id)) invalid('Invalid workspace ID.');
      trimmed(body.name, 80, 'workspace name', false);
      if (key !== undefined && (typeof key !== 'string' || !keyPattern.test(key))) invalid('Invalid idempotency key.');
      break;
    case 'issueToken':
      if (typeof body.subject !== 'string' || !subjectPattern.test(body.subject)) invalid('Invalid subject.');
      if (!['editor', 'approver', 'worker', 'viewer'].includes(body.role)) invalid('Invalid role.');
      break;
    case 'stage':
      integer(body.baseVersion, 0, Number.MAX_SAFE_INTEGER, 'base version');
      if (typeof key !== 'string' || !keyPattern.test(key)) invalid('Invalid idempotency key.');
      result.rows = parseCsv(body.csv);
      break;
    case 'commit':
      if (typeof body.leaseToken !== 'string' || body.leaseToken.length === 0 || body.leaseToken.length > 4096) invalid('Invalid lease token.');
      if (typeof key !== 'string' || !keyPattern.test(key)) invalid('Invalid idempotency key.');
      break;
    case 'claim':
      integer(body.leaseMs, 100, 5000, 'lease duration');
      break;
    case 'reject':
      trimmed(body.reason, 160, 'rejection reason', false);
      break;
    case 'approve':
    case 'cancel':
    case 'revokeToken':
      emptyBody(body);
      break;
    default:
      throw new RelayInputError(404, 'not_found', 'Endpoint not found.');
  }
  return result;
}
