/** A service error, or a local client failure (status 0). */
export class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

const states = new Set(['staged', 'approved', 'leased', 'committed', 'rejected', 'cancelled']);
const eventTypes = new Set(['workspace.created', 'capability.issued', 'capability.revoked',
  'import.staged', 'import.approved', 'import.rejected', 'import.cancelled',
  'import.claimed', 'import.committed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const nullableString = value => value === null || string(value);
const workspace = value => object(value) && string(value.id) && string(value.name) && integer(value.version);
const member = value => object(value) && string(value.externalId) && string(value.name) &&
  string(value.email) && integer(value.revision, 1);
const record = value => object(value) && string(value.id) && string(value.workspaceId) &&
  string(value.creator) && integer(value.baseVersion) && states.has(value.state) &&
  integer(value.rowCount, 1, 500) && string(value.digest) && /^[a-f0-9]{64}$/.test(value.digest) &&
  integer(value.leaseEpoch) && nullableString(value.approvedBy);
const event = value => object(value) && integer(value.cursor, 1) && eventTypes.has(value.type) &&
  string(value.subject) && nullableString(value.importId);
const hasImport = value => object(value) && record(value.import);

function invalid() {
  throw new RelayError(0, 'INVALID_ARGUMENT', 'Invalid client argument.');
}

function segment(value) {
  if (!string(value) || !value || value === '.' || value === '..') invalid();
  try {
    // Encode literal identifiers, never treating a slash, query or fragment as routing syntax.
    return encodeURIComponent(value).replace(/[!'()*]/g,
      character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    invalid();
  }
}

function keyHeader(key) {
  if (!string(key) || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) invalid();
  return { 'Idempotency-Key': key };
}

/** Create an HTTP client. No state is stored independently of the service. */
export function createClient(options) {
  let baseUrl;
  let token;
  try {
    if (!object(options) || !string(options.baseUrl) || options.baseUrl !== options.baseUrl.trim() ||
      !string(options.token) || !options.token || /\s|[\u0000-\u001f\u007f]/u.test(options.token)) {
      throw new Error();
    }
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    baseUrl = url.href.replace(/\/+$/, '');
    token = options.token;
  } catch {
    throw new RelayError(0, 'INVALID_CONFIG', 'A valid base URL and capability are required.');
  }

  async function request(path, validate, body, extraHeaders = {}) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extraHeaders };
    let serialized;
    if (body !== undefined) {
      serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > 262144) invalid();
      headers['Content-Type'] = 'application/json';
    }
    let response;
    let text;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers, body: serialized,
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      });
      text = await response.text();
    } catch {
      throw new RelayError(0, 'TRANSPORT_ERROR', 'Unable to complete the service request.');
    }
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new RelayError(response.status, 'INVALID_RESPONSE', 'The service returned an invalid response.');
    }
    if (!response.ok) {
      if (object(result) && object(result.error) && string(result.error.code) && string(result.error.message)) {
        throw new RelayError(response.status, result.error.code, result.error.message);
      }
      throw new RelayError(response.status, 'INVALID_RESPONSE', 'The service returned an invalid response.');
    }
    if (!validate(result)) {
      throw new RelayError(response.status, 'INVALID_RESPONSE', 'The service returned an invalid response.');
    }
    return result;
  }

  const root = id => `/v1/workspaces/${segment(id)}`;
  const importPath = (id, importId) => `${root(id)}/imports/${segment(importId)}`;
  return {
    async workspace(id) {
      return request(root(id), value => object(value) && workspace(value.workspace));
    },
    async members(id) {
      return request(`${root(id)}/members`, value => object(value) && integer(value.version) &&
        Array.isArray(value.members) && value.members.every(member));
    },
    async stage(id, input, key) {
      if (!object(input) || !integer(input.baseVersion) || !string(input.csv) ||
        new TextEncoder().encode(input.csv).byteLength > 65536) invalid();
      return request(`${root(id)}/imports`, hasImport,
        { baseVersion: input.baseVersion, csv: input.csv }, keyHeader(key));
    },
    async approve(id, importId) {
      return request(`${importPath(id, importId)}/approve`, hasImport, {});
    },
    async claim(id, importId, leaseMs) {
      if (!integer(leaseMs, 100, 5000)) invalid();
      return request(`${importPath(id, importId)}/claim`, value => hasImport(value) &&
        string(value.leaseToken) && value.leaseToken.length > 0 && integer(value.expiresAt, 1), { leaseMs });
    },
    async commit(id, importId, leaseToken, key) {
      if (!string(leaseToken) || !leaseToken) invalid();
      return request(`${importPath(id, importId)}/commit`, value => hasImport(value) &&
        integer(value.version) && integer(value.applied, 1, 500), { leaseToken }, keyHeader(key));
    },
    async cancel(id, importId) {
      return request(`${importPath(id, importId)}/cancel`, hasImport, {});
    },
    async events(id, options = {}) {
      if (!object(options) || (options.after !== undefined && !integer(options.after)) ||
        (options.limit !== undefined && !integer(options.limit, 1, 100))) invalid();
      const query = new URLSearchParams();
      if (options.after !== undefined) query.set('after', String(options.after));
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      return request(`${root(id)}/events${query.size ? `?${query}` : ''}`, value => object(value) &&
        Array.isArray(value.events) && value.events.every(event) && integer(value.nextCursor));
    },
  };
}
