/* eslint-disable @typescript-eslint/no-require-imports */
const { createServer } = require('node:http');
const next = require('next');

const hostname = '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const app = next({ dev: false, hostname, port, dir: process.cwd() });
const handle = app.getRequestHandler();
let server;
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (server) {
    server.closeIdleConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  await app.close();
  process.exit(0);
}

process.on('message', message => {
  if (message && message.type === 'shutdown') void shutdown();
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

app.prepare().then(() => {
  server = createServer((request, response) => handle(request, response));
  server.listen(port, hostname, () => console.log(`SMOKE_SERVER_READY ${port}`));
}).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
