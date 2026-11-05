export class RelayError extends Error {
  constructor(status, code, message) { super(message); this.name = 'RelayError'; this.status = status; this.code = code; }
}
export function createClient({baseUrl, token}) {
  async function request(method, workspace, tail = '', body, key) {
    const response = await fetch(baseUrl.replace(/\/$/, '') + '/v1/workspaces/' + encodeURIComponent(workspace) + tail,
      {method, headers: {Authorization: 'Bearer ' + token, ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(key === undefined ? {} : {'Idempotency-Key': key})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const value = await response.json();
    if (!response.ok) throw new RelayError(response.status, value.error?.code || 'HTTP_ERROR', value.error?.message || 'Request failed');
    return value;
  }
  const route = id => '/imports/' + encodeURIComponent(id);
  return {
    workspace: id => request('GET', id), members: id => request('GET', id, '/members'),
    stage: (id, body, key) => request('POST', id, '/imports', body, key),
    approve: (id, importId) => request('POST', id, route(importId) + '/approve', {}),
    claim: (id, importId, leaseMs) => request('POST', id, route(importId) + '/claim', {leaseMs}),
    commit: (id, importId, leaseToken, key) => request('POST', id, route(importId) + '/commit', {leaseToken}, key),
    cancel: (id, importId) => request('POST', id, route(importId) + '/cancel', {}),
    events: (id, options = {}) => request('GET', id, '/events?' + new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])))
  };
}
