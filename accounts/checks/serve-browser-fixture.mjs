// Opt-in, loopback-only, no-cache native browser test. Serves only this allowlist.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const files = new Map([
  ['/accounts/tests/browser-fixture.html', ['../tests/browser-fixture.html', 'text/html; charset=utf-8']],
  ['/accounts/tests/browser-fixture.mjs', ['../tests/browser-fixture.mjs', 'text/javascript; charset=utf-8']],
  ['/accounts/browser-storage.mjs', ['../browser-storage.mjs', 'text/javascript; charset=utf-8']],
  ['/accounts/browser-storage-records.mjs', ['../browser-storage-records.mjs', 'text/javascript; charset=utf-8']],
  ['/accounts/browser-state.mjs', ['../browser-state.mjs', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const entry = files.get(path);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'none'; frame-ancestors 'none'" };
  if (!entry || request.method !== 'GET') { response.writeHead(404, headers); response.end(); return; }
  try {
    const bytes = await readFile(new URL(entry[0], import.meta.url));
    response.writeHead(200, { ...headers, 'Content-Type': entry[1] }); response.end(bytes);
  } catch { response.writeHead(503, headers); response.end(); }
});
server.on('error', (error) => {
  console.error(`Fixture server unavailable: ${error.code ?? 'UNKNOWN'}`);
  process.exitCode = 1;
});
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/accounts/tests/browser-fixture.html?run=${randomUUID()}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
