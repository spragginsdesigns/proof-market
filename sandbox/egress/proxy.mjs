// Egress proxy for job containers. Jobs sit on an internal Docker network with no route out and no
// address for the host; this proxy is their only way to the internet. It forwards only to
// allowlisted hostnames, resolves them itself (IPv4 only), refuses any address that is not public
// or that belongs to the host, and connects to the exact address it checked (no DNS rebinding).
// Every decision is one JSON line on stdout.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

const PORT = Number(process.env.PORT || 3128);
const HOST_IPS = new Set((process.env.HOST_IPS || '').split(',').map((s) => s.trim()).filter(Boolean));

// Hostnames a README step legitimately needs: source hosts, package registries, toolchains, NEAR RPC.
export const ALLOW = [
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org', 'registry.yarnpkg.com',
  'crates.io', 'index.crates.io', 'static.crates.io', 'static.rust-lang.org',
  's3-us-west-1.amazonaws.com',
  'rpc.testnet.near.org', 'archival-rpc.testnet.near.org', 'test.rpc.fastnear.com',
  'rpc.mainnet.near.org', 'free.rpc.fastnear.com',
  'pypi.org', 'files.pythonhosted.org',
];
const ALLOWED_PORTS = new Set([443, 80]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0]);

export function isPublicV4(ip) {
  if (!net.isIPv4(ip)) return false;
  if (HOST_IPS.has(ip)) return false;
  const n = ipv4ToInt(ip);
  return !BLOCKED_V4.some(([base, mask]) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

export function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || net.isIP(h)) return false; // never IP literals
  return ALLOW.includes(h);
}

async function resolvePublic(host) {
  const addrs = await dns.resolve4(host);
  const ok = addrs.filter(isPublicV4);
  if (!ok.length) throw new Error(`no public address for ${host}`);
  return ok[0];
}

function log(entry) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

async function decide(host, port) {
  if (!ALLOWED_PORTS.has(port)) return { ok: false, why: `port ${port} not allowed` };
  if (!hostAllowed(host)) return { ok: false, why: 'host not on allowlist' };
  try {
    return { ok: true, ip: await resolvePublic(host) };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

export const server = http.createServer(async (req, res) => {
  // Plain HTTP through the proxy: absolute-form request URL.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('absolute URL required\n');
    return;
  }
  const port = Number(url.port || 80);
  const d = await decide(url.hostname, port);
  log({ kind: 'http', host: url.hostname, port, allowed: d.ok, why: d.why, from: req.socket.remoteAddress });
  if (!d.ok) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`proof-market egress: ${d.why}\n`);
    return;
  }
  const headers = { ...req.headers, host: url.host };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const up = http.request(
    { host: d.ip, port, method: req.method, path: url.pathname + url.search, headers, servername: url.hostname },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', (e) => res.writeHead(502).end(`upstream error: ${e.message}\n`));
  req.pipe(up);
});

// HTTPS: CONNECT host:443, then a raw tunnel to the checked address.
server.on('connect', async (req, client, head) => {
  // The client can reset at any moment: while the address is checked, or right after a 403. Its
  // socket error must never go unhandled, or it stops the proxy for every later request of the job.
  client.on('error', () => client.destroy());
  const [host, portStr] = String(req.url).split(':');
  const port = Number(portStr || 443);
  const d = await decide(host, port);
  log({ kind: 'connect', host, port, allowed: d.ok, why: d.why, from: client.remoteAddress });
  if (!d.ok) {
    client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nproof-market egress: ${d.why}\r\n`);
    return;
  }
  const up = net.connect(port, d.ip, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  const close = () => {
    up.destroy();
    client.destroy();
  };
  up.on('error', close);
  client.on('error', close);
  up.setTimeout(10 * 60 * 1000, close);
});

import { pathToFileURL } from 'node:url';
// Start the server only when run directly, never when imported (unit tests import the pure helpers).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '0.0.0.0', () => log({ kind: 'listening', port: PORT, allow: ALLOW.length, host_ips: HOST_IPS.size }));
}
