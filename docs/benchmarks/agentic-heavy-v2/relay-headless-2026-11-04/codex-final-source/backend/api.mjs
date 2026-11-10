import { createDomain } from './relay.mjs';
import { RelayInputError } from './validation.mjs';

const MAX_BODY_BYTES = 262144;

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  let authorizationCount = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'authorization') authorizationCount += 1;
  }
  if (authorizationCount !== 1) return null;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [\x21-\x7e]+$/i.test(header)) return null;
  return header.slice(7);
}

async function readBody(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(contentType)) {
    req.resume();
    throw new RelayInputError(415, 'unsupported_media_type', 'A JSON content type is required.');
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    }
  } catch {
    throw new RelayInputError(400, 'invalid_body', 'Unable to read request body.');
  }
  if (tooLarge) throw new RelayInputError(413, 'body_too_large', 'Request body exceeds the byte limit.');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new RelayInputError(400, 'invalid_utf8', 'Request body must contain valid UTF-8.');
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new RelayInputError(400, 'invalid_json', 'Request body must contain valid JSON.');
  }
}

function route(method, path) {
  if (method === 'POST' && path.length === 2 && path[0] === 'v1' && path[1] === 'workspaces') return { operation: 'createWorkspace' };
  if (path[0] !== 'v1' || path[1] !== 'workspaces' || !path[2]) return null;
  const workspaceId = path[2];
  if (path.length === 3 && method === 'GET') return { operation: 'workspace', workspaceId };
  if (path.length === 4) {
    const key = `${method} ${path[3]}`;
    const operation = {
      'GET members': 'members',
      'GET events': 'events',
      'GET imports': 'imports',
      'POST imports': 'stage',
      'POST tokens': 'issueToken',
    }[key];
    if (operation) return { operation, workspaceId };
  }
  if (path.length === 6 && method === 'POST' && path[3] === 'tokens' && path[5] === 'revoke') return { operation: 'revokeToken', workspaceId, capabilityId: path[4] };
  if (path[3] === 'imports' && path[4]) {
    if (path.length === 5 && method === 'GET') return { operation: 'import', workspaceId, importId: path[4] };
    if (path.length === 6 && method === 'POST' && ['approve', 'reject', 'cancel', 'claim', 'commit'].includes(path[5])) return { operation: path[5], workspaceId, importId: path[4] };
  }
  return null;
}

export async function createRelay(options) {
  const domain = await createDomain(options);
  return {
    async handler(req, res) {
      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && parsedUrl.pathname === '/health') {
          req.resume();
          send(res, 200, { ok: true });
          return;
        }
        let path;
        try {
          path = parsedUrl.pathname.slice(1).split('/').map(decodeURIComponent);
        } catch {
          throw new RelayInputError(400, 'invalid_path', 'Malformed request path.');
        }
        const matched = route(req.method, path);
        if (!matched) {
          req.resume();
          throw new RelayInputError(404, 'not_found', 'Endpoint not found.');
        }
        const token = bearer(req);
        if (token === null) throw new RelayInputError(401, 'unauthorized', 'A valid capability is required.');
        await domain.authorize({ ...matched, token });
        const query = {};
        for (const [key, value] of parsedUrl.searchParams) {
          if (matched.operation !== 'events' || !['after', 'limit'].includes(key)) throw new RelayInputError(400, 'invalid_query', 'Unsupported query parameter.');
          if (Object.hasOwn(query, key)) throw new RelayInputError(400, 'invalid_query', 'Repeated query parameter.');
          Object.defineProperty(query, key, { value, enumerable: true, configurable: true });
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        if (req.method !== 'POST') req.resume();
        const response = await domain.execute({ ...matched, body, token, key: req.headers['idempotency-key'], query });
        send(res, response.status, response.body);
      } catch (error) {
        req.resume();
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
        const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_]+$/.test(error.code) ? error.code : 'internal_error';
        const message = status === 500 ? 'The request could not be completed.' : typeof error?.message === 'string' ? error.message : 'The request could not be completed.';
        send(res, status, { error: { code, message } });
      }
    },
    close() {
      return domain.close();
    },
  };
}
