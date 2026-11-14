// The sandbox security proof: run the hostile escape fixture through the real container path and
// assert nothing from the host is readable or reachable. This is the test that matters most on a
// production host. It needs Docker and the proof-market-runner image; it is slow, so it is opt-in:
//   PM_SANDBOX_IT=1 node --test escape.test.mjs
import assert from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runJob } from './run.mjs';
import { buildBareRepos, headCommit, startOrigin } from './origin.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const RUN_IT = process.env.PM_SANDBOX_IT === '1';

test('the escape fixture reads nothing from the host', { skip: RUN_IT ? false : 'set PM_SANDBOX_IT=1' }, async () => {
  const tag = randomUUID().slice(0, 8);
  const root = await buildBareRepos({ escape: join(fixtures, 'escape') });
  const commit = await headCommit(root, 'escape');
  let origin;
  const job = {
    repo: `http://pm-origin-${tag}:8080/escape.git`,
    commit,
    path: '',
    steps: [{ do: 'bash probe.sh', see: 'every line BLOCKED' }],
  };
  const plan = { steps: [{ run: [['bash', 'probe.sh']] }] };
  const transcript = await runJob(job, plan, {
    tag,
    noProxyHosts: [`pm-origin-${tag}`],
    beforeRun: async (net) => { origin = await startOrigin(net, tag, root); },
    afterRun: async () => { if (origin) await origin.cleanup(); },
  });
  try {
    assert.equal(transcript.clone.exit_code, 0, `clone should succeed: ${JSON.stringify(transcript.clone).slice(0, 300)}`);
    const out = transcript.steps[0].commands[0].stdout;
    // Print it so the proof is visible in the test log.
    console.log('--- escape probe output ---\n' + out + '\n---------------------------');
    const lines = out.split('\n').filter((l) => l.includes(':'));
    const exposed = lines.filter((l) => /EXPOSED/.test(l));
    assert.deepEqual(exposed, [], `host exposure detected:\n${exposed.join('\n')}`);
    // Positive checks: the probe really ran and the hardening is visible.
    assert.match(out, /WHOAMI: 10001:10001/, 'job must run as the non-root user');
    assert.match(out, /ROOT-WRITABLE: BLOCKED/, 'root fs must be read-only');
    assert.match(out, /READ .*\.near-credentials: BLOCKED/, 'host NEAR creds must be unreadable');
    assert.match(out, /ENV secrets: BLOCKED/, 'no host secrets in the job environment');
    assert.match(out, /CONNECT 1\.1\.1\.1:443 \(direct\): BLOCKED/, 'no direct internet, only the proxy');
    assert.match(out, /PROXY example\.com: BLOCKED/, 'the proxy must refuse a non-allowlisted host');
    assert.match(out, /CONNECT 172\.17\.0\.1:6379: BLOCKED/, 'the host redis must be unreachable');
  } finally {
    if (origin) await origin.cleanup().catch(() => {});
  }
});
