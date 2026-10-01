#!/usr/bin/env node
// Test-only mock for the self-heal path in `createSession` (opencode-server-runner.ts):
// a real v2.0.20 server whose detection probe (`GET /api/session`) answers
// `200 text/html` — exactly the SPA catch-all shape §2.4 of the v2 spec
// documents — so `detectOpencodeDialect` picks `v1`. The runner then posts
// the v1 session path and gets the real server's actual answer for that
// route: `405`. `createSession` must read that 405 as proof of v2 and retry
// under the v2 dialect rather than failing the run.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const SESSION_ID = 'ses_v1misdetect_1';
let sse = null;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};

const server = createServer((req, res) => {
  const url = req.url ?? '';

  if (req.method === 'GET' && url.startsWith('/api/session')) {
    // The SPA catch-all: a real v2 server answers every unmatched GET this
    // way, which is exactly what makes the detection probe ambiguous.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html>');
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ id: 'evt_connected', type: 'server.connected', data: {} });
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      // The real server's answer for the v1 route: gone, not a 404.
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    if (req.method === 'POST' && url.startsWith('/api/session') && !url.includes('/prompt')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: SESSION_ID } }));
      return;
    }
    if (req.method === 'POST' && url.includes('/prompt')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_v1misdetect_1' } }));
      setTimeout(() => {
        send({ id: 'evt_idle', type: 'session.idle', data: { sessionID: SESSION_ID } });
      }, 20);
      return;
    }
    if (req.method === 'POST' && url.includes('/interrupt')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":{}}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
});

server.listen(port, hostname, () => {
  console.log(`server listening on http://${hostname}:${server.address().port}`);
});
