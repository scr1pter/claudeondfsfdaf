import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { openService } from './backend/service.mjs';

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--data', '--port'].includes(name) || options[name] !== undefined || argv[index + 1] === undefined) {
      throw new Error('Invalid startup arguments');
    }
    options[name] = argv[index + 1];
  }
  if (!options['--data'] || !isAbsolute(options['--data'])) throw new Error('An absolute data directory is required');
  const portText = options['--port'] ?? process.env.PORT ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(portText) || Number(portText) > 65535) throw new Error('Invalid port');
  if (typeof process.env.RELAY_BOOTSTRAP_TOKEN !== 'string' || !process.env.RELAY_BOOTSTRAP_TOKEN.length) {
    throw new Error('A bootstrap capability is required');
  }
  return { dataDir: options['--data'], port: Number(portText), bootstrapToken: process.env.RELAY_BOOTSTRAP_TOKEN };
}

let service;
let server;
let stopping;
let accepting = true;
const accepted = new Set();

function shutdown(exitCode = 0) {
  if (stopping) return stopping;
  accepting = false;
  stopping = (async () => {
    // Bun's Node HTTP adapter can suspend an incomplete request body when
    // close() begins. Gate admission immediately, but drain already-admitted
    // handlers AND their responses before asking the listener to close.
    for (const entry of accepted) {
      if (!entry.response.headersSent) entry.response.setHeader('connection', 'close');
    }
    await Promise.all([...accepted].map(entry => entry.done));
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service?.close();
    process.stdin.pause();
    process.exitCode = exitCode;
    process.exit(exitCode);
  })().catch(() => {
    process.stderr.write(JSON.stringify({ error: { code: 'SHUTDOWN_FAILED', message: 'Unable to close the service safely' } }) + '\n');
    process.exit(1);
  });
  return stopping;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  service = await openService(options);
  server = createServer((request, response) => {
    if (!accepting) {
      request.on('error', () => {});
      request.resume();
      response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { code: 'SERVICE_CLOSING', message: 'The service is closing' } }));
      return;
    }
    const entry = { response };
    const finished = new Promise(resolve => {
      // Bun does not always emit a response close after an aborted request.
      // A disconnected transport needs no response flush, but entry.done still
      // separately awaits the handler (and any in-flight durable transaction).
      const socket = request.socket;
      const complete = () => {
        response.removeListener('finish', complete);
        response.removeListener('close', complete);
        request.removeListener('aborted', complete);
        request.removeListener('error', complete);
        socket?.removeListener('close', complete);
        resolve();
      };
      entry.complete = complete;
      response.once('finish', complete);
      response.once('close', complete);
      request.once('aborted', complete);
      request.once('error', complete);
      socket?.once('close', complete);
    });
    // Defense in depth: neither a synchronous throw nor a rejected handler may
    // become an uncaught process exception or reveal request data.
    const operation = Promise.resolve().then(() => service.handle(request, response)).catch(() => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' } }));
    });
    const handled = operation.finally(() => {
      // Every JSON handler synchronously ends its response before resolving.
      // Bun may instead throw from end() after a fully-read client disconnect,
      // without emitting any transport close/abort event. Once the handler has
      // finished (including its durable write), explicitly close that unusable
      // response. Never infer transaction completion from a socket event.
      if (!response.writableEnded) {
        try { response.destroy(); } catch { /* The disconnected transport is already unusable. */ }
        entry.complete();
      }
    });
    entry.done = Promise.all([handled, finished]);
    accepted.add(entry);
    entry.done.then(() => accepted.delete(entry), () => accepted.delete(entry));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return;
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const body = JSON.stringify({ error: { code: 'INVALID_HTTP', message: 'Malformed HTTP request' } });
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  server.on('error', () => { void shutdown(1); });
  process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + '\n');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    let end;
    while ((end = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, end).replace(/\r$/, '');
      input = input.slice(end + 1);
      if (line === 'shutdown') { void shutdown(); return; }
    }
    // Unrecognized stdin is ignored without allowing unbounded buffering.
    if (input.length > 1024) input = '';
  });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
} catch {
  try { await service?.close(); } catch { /* Never emit filesystem paths or secrets. */ }
  process.stderr.write(JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'Unable to start the local service' } }) + '\n');
  process.exitCode = 1;
}
