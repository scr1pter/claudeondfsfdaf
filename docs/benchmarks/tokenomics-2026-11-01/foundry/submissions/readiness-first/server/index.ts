import { createApp } from './app';

const app = createApp(process.env.DATA_DIR || '.foundry-data');
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), maxRequestBodySize: 4 * 1024 * 1024, fetch: app.fetch });
console.log(`Foundry listening on http://127.0.0.1:${server.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(true); app.close(); process.exit(0); });
