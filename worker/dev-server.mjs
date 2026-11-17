// Local preview: serves the site from the repo root and forwards /api/* to `wrangler dev` on :8787,
// so pages and API share one origin like production. Usage: node worker/dev-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers };
    for (const k of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']) delete headers[k];
    const upstream = await fetch(`http://127.0.0.1:8787${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    });
    const out = Object.fromEntries(upstream.headers);
    delete out['content-encoding'];
    delete out['content-length'];
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || rel.startsWith('worker')) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(8088, '127.0.0.1', () => console.log('http://127.0.0.1:8088/stock.html'));
