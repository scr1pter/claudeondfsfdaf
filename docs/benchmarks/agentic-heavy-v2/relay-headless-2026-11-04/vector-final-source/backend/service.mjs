import { openStore } from './data.mjs';
import { createApi } from './api.mjs';

/** Recover storage and acquire exclusive ownership before exposing handlers. */
export async function openService({ dataDir, bootstrapToken }) {
  if (typeof bootstrapToken !== 'string' || bootstrapToken.length === 0) {
    throw new Error('A bootstrap capability is required.');
  }
  const store = await openStore(dataDir);
  let api;
  try {
    api = createApi({ store, bootstrapToken });
  } catch (error) {
    await store.close();
    throw error;
  }

  let accepting = true;
  let closing;
  const active = new Set();

  function handle(req, res) {
    if (!accepting) {
      req.on('error', () => {});
      req.resume();
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'SERVICE_CLOSING', message: 'The service is closing.' } }));
      }
      return Promise.resolve();
    }
    const operation = Promise.resolve().then(() => api.handle(req, res));
    active.add(operation);
    // Install both branches rather than discarding a rejecting finally promise.
    operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }

  function close() {
    if (closing) return closing;
    accepting = false;
    closing = (async () => {
      await Promise.allSettled([...active]);
      await store.close();
    })();
    return closing;
  }

  return { handle, close };
}
