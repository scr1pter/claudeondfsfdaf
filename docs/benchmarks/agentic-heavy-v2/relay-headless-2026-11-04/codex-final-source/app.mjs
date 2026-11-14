import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { createRelay } from './backend/api.mjs';

function options(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--data', '--port'].includes(name) || values.has(name) || args[i + 1] === undefined) {
      throw new Error('Usage: <runtime> app.mjs --data ABSOLUTE_DIRECTORY --port NUMBER');
    }
    values.set(name, args[i + 1]);
  }
  const dataDir = values.get('--data') ?? process.env.DATA_DIR;
  const portText = values.get('--port') ?? process.env.PORT ?? '0';
  if (!dataDir || !isAbsolute(dataDir)) throw new Error('An absolute data directory is required');
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error('Port must be an integer from 0 to 65535');
  const bootstrapToken = process.env.RELAY_BOOTSTRAP_TOKEN;
  if (!bootstrapToken) throw new Error('RELAY_BOOTSTRAP_TOKEN is required');
  return { dataDir, port: Number(portText), bootstrapToken };
}

async function main() {
  const { port, ...config } = options(process.argv.slice(2));
  const relay = await createRelay(config);
  const server = createServer((request, response) => {
    Promise.resolve().then(() => relay.handler(request, response)).catch(() => {
      if (response.headersSent) return response.destroy();
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }));
    });
  });
  let closing;
  let input;
  const shutdown = () => {
    closing ??= (async () => {
      input?.close();
      try {
        try {
          await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections?.();
          });
        } finally {
          await relay.close();
        }
      } finally {
        process.stdin.pause();
        // Windows anonymous stdin pipes can remain referenced after pause().
        process.stdin.destroy();
        process.stdin.unref?.();
      }
    })().catch(() => {
      process.stderr.write(JSON.stringify({ error: { code: 'SHUTDOWN_FAILED', message: 'Could not finish shutdown' } }) + '\n');
      process.exitCode = 1;
    });
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await relay.close();
    throw error;
  }
  server.on('error', () => void shutdown());
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => { if (line === 'shutdown') void shutdown(); });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + '\n');
}

main().catch(error => {
  const known = /^Usage:|^An absolute data directory|^Port must|^RELAY_BOOTSTRAP_TOKEN/.test(error?.message ?? '');
  process.stderr.write(JSON.stringify({ error: {
    code: 'STARTUP_FAILED', message: known ? error.message : 'Unable to start Relay Directory; check data integrity and exclusive ownership',
  } }) + '\n');
  process.exitCode = 1;
});
