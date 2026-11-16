// A local stand-in for the make.fun trial env, for development only (not part of the
// graded surface): it accepts the entry's POST /register, records the entry's base
// URL, answers GET /done with {"done": false} until the file named by STUB_DONE_FILE
// exists, and prints the registered base URL so the kit's conformance runner
// (sdk/run.ts --url <base> --token <token>) can be pointed at the running entry.
//
//   MAKEFUN_SHOP_TOKEN=test-token STUB_DONE_FILE=/tmp/gcc-done \
//     node --experimental-strip-types tools/stub-env.ts &
//   MAKEFUN_ENV_URL=http://127.0.0.1:18080 MAKEFUN_SHOP_TOKEN=test-token \
//     node --experimental-strip-types main.ts &

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';

const doneFile = process.env.STUB_DONE_FILE ?? '/tmp/gcc-done';
const port = Number(process.env.STUB_ENV_PORT ?? '18080');

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub');
  if (req.method === 'POST' && url.pathname === '/register') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { port?: number };
        process.stdout.write(`[stub-env] entry registered: http://127.0.0.1:${parsed.port}\n`);
      } catch {
        process.stdout.write('[stub-env] register with unparseable body\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/done') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ done: existsSync(doneFile) }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"message":"Not Found"}');
});

server.listen(port, () => {
  process.stdout.write(`[stub-env] listening on ${port}; done file: ${doneFile}\n`);
});
