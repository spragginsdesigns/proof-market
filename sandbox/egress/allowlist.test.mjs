import assert from 'node:assert';
import { test } from 'node:test';
import net from 'node:net';
import { isPublicV4, hostAllowed, ALLOW, server } from './proxy.mjs';
// These ranges are blocked regardless of environment. The host's own public IP is blocked too, via
// HOST_IPS passed to the proxy at runtime; that is proven on the real host by sandbox/escape.test.mjs
// (the probe shows the host's address refused), so it is not asserted here with a hardcoded IP.
test('blocks loopback, private, link-local, CGNAT and reserved addresses', () => {
  for (const ip of ['127.0.0.1','172.17.0.1','10.0.0.5','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','198.18.0.9','192.0.2.1'])
    assert.equal(isPublicV4(ip), false, `should block ${ip}`);
});
test('allows ordinary public addresses', () => {
  for (const ip of ['140.82.121.3','1.1.1.1','8.8.8.8']) assert.equal(isPublicV4(ip), true, `should allow ${ip}`);
});
test('allowlist is by hostname only', () => {
  assert.equal(hostAllowed('github.com'), true);
  assert.equal(hostAllowed('rpc.testnet.near.org'), true);
  assert.equal(hostAllowed('GitHub.com'), true);
  assert.equal(hostAllowed('evil.example.com'), false);
  assert.equal(hostAllowed('140.82.121.3'), false);
  assert.ok(ALLOW.includes('registry.npmjs.org'));
});

test('a client that resets after a refused CONNECT does not stop the proxy', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const refusedThenReset = () => new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n')) { s.resetAndDestroy(); resolve(buf.split('\r\n')[0]); }
    });
    s.on('error', reject);
  });
  try {
    assert.equal(await refusedThenReset(), 'HTTP/1.1 403 Forbidden');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await refusedThenReset(), 'HTTP/1.1 403 Forbidden');
  } finally {
    server.close();
  }
});
