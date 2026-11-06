/** An HTTP error returned by the Relay service. */
export class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

/** Create a client connected to an existing Relay service. */
export function createClient({ baseUrl, token } = {}) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RelayError(0, 'CLIENT_CONFIG', 'A valid service base URL is required.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RelayError(0, 'CLIENT_CONFIG', 'The service base URL must use HTTP or HTTPS without credentials, query or fragment.');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new RelayError(0, 'CLIENT_CONFIG', 'A service capability is required.');
  }
  const base = parsed.href.replace(/\/+$/u, '');
  const segment = (value) => encodeURIComponent(value);
  const workspacePath = (id) => `/v1/workspaces/${segment(id)}`;
  const importPath = (id, importId) => `${workspacePath(id)}/imports/${segment(importId)}`;

  async function request(path, method = 'GET', body, key) {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
      });
    } catch {
      throw new RelayError(0, 'NETWORK_ERROR', 'Unable to complete the service request.');
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new RelayError(response.status, 'INVALID_RESPONSE', 'The service returned an invalid JSON response.');
    }
    if (!response.ok) {
      const error = value && typeof value === 'object' ? value.error : undefined;
      throw new RelayError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
        typeof error?.message === 'string' ? error.message : 'The service rejected the request.',
      );
    }
    return value;
  }

  return Object.freeze({
    workspace: (id) => request(workspacePath(id)),
    members: (id) => request(`${workspacePath(id)}/members`),
    stage: (id, body, key) => request(`${workspacePath(id)}/imports`, 'POST', body, key),
    approve: (id, importId) => request(`${importPath(id, importId)}/approve`, 'POST', {}),
    claim: (id, importId, leaseMs) => request(`${importPath(id, importId)}/claim`, 'POST', { leaseMs }),
    commit: (id, importId, leaseToken, key) => request(`${importPath(id, importId)}/commit`, 'POST', { leaseToken }, key),
    cancel: (id, importId) => request(`${importPath(id, importId)}/cancel`, 'POST', {}),
    events: (id, options = {}) => {
      const query = new URLSearchParams();
      if (options.after !== undefined) query.set('after', String(options.after));
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size ? `?${query}` : '';
      return request(`${workspacePath(id)}/events${suffix}`);
    },
  });
}
