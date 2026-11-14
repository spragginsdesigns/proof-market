// Serve the built web app locally with no keys. By default it serves the bundled snapshot (replay
// mode), so a visitor sees a real finished run offline. Set VITE_CONTRACT at build time to read live
// testnet instead. Run `npm run build` first.
//   node scripts/demo.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = Number(process.argv[2] || process.env.PM_DEMO_PORT || 4155);
const DIST = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const full = normalize(join(DIST, p));
    if (!full.startsWith(DIST)) { res.writeHead(403).end('no'); return; }
    let body;
    try {
      body = await readFile(full);
    } catch {
      body = await readFile(join(DIST, 'index.html')); // SPA fallback
    }
    res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
});
try {
  await stat(join(DIST, 'index.html'));
} catch {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Pass another: node scripts/demo.mjs ${PORT + 5}` : `Could not start the demo server: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Proof Market demo on http://127.0.0.1:${PORT} (snapshot mode; build with VITE_CONTRACT for live testnet)`));
