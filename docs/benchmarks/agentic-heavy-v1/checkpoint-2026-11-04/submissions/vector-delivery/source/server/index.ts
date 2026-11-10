import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { HttpError, handleIdentity, json } from './core/index.ts';
import { handleBusiness } from './routes/index.ts';

const distDirectory = resolve(import.meta.dir, '../dist');

function isWithin(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

async function frontend(request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: { code: 'not_found', message: 'Route not found.' } }, 404);
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new HttpError(400, 'invalid_path', 'Invalid URL encoding.'); }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    throw new HttpError(400, 'invalid_path', 'Invalid frontend path.');
  }
  const candidate = resolve(distDirectory, `.${pathname}`);
  if (!isWithin(distDirectory, candidate)) {
    throw new HttpError(404, 'not_found', 'File not found.');
  }
  let path = candidate;
  let file = Bun.file(path);
  if (!(await file.exists()) || pathname.endsWith('/')) {
    path = resolve(distDirectory, 'index.html');
    file = Bun.file(path);
  }
  if (!(await file.exists())) {
    return json({ error: { code: 'frontend_not_built', message: 'Build the frontend before starting Foundry.' } }, 404);
  }
  // Refuse a symlink escaping dist, even if an asset happened to be present there.
  if (!isWithin(realpathSync(distDirectory), realpathSync(path))) {
    throw new HttpError(404, 'not_found', 'File not found.');
  }
  return new Response(request.method === 'HEAD' ? null : file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Cache-Control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The sole HTTP integration point, also importable by focused API tests. */
export async function handleRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return await handleIdentity(request, url)
        ?? await handleBusiness(request, url)
        ?? json({ error: { code: 'not_found', message: 'API route not found.' } }, 404);
    }
    return await frontend(request, url);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    // Do not leak database details, request bodies, credentials, or tokens.
    console.error('Foundry request failed unexpectedly.');
    return json({ error: { code: 'internal_error', message: 'The request could not be completed.' } }, 500);
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    maxRequestBodySize: 8 * 1048576,
    fetch: handleRequest,
  });
  console.info(`Foundry listening on http://127.0.0.1:${server.port}`);
}
