// Functional sandbox tests: the honest and broken fixtures run their README commands and produce the
// expected output, the transcript hash is deterministic, and a real GitHub clone works through the
// egress proxy. Opt-in (needs Docker + network): PM_SANDBOX_IT=1 node --test fixtures.test.mjs
import assert from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runJob, transcriptHash } from './run.mjs';
import { buildBareRepos, headCommit, startOrigin } from './origin.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const skip = process.env.PM_SANDBOX_IT === '1' ? false : 'set PM_SANDBOX_IT=1';

async function runFixture(name, tag) {
  const root = await buildBareRepos({ [name]: join(fixtures, name) });
  const commit = await headCommit(root, name);
  let origin;
  const job = {
    repo: `http://pm-origin-${tag}:8080/${name}.git`,
    commit,
    path: '',
    steps: [
      { do: 'node add.mjs 2 3', see: '5' },
      { do: 'node add.mjs 10 32', see: '42' },
    ],
  };
  const plan = { steps: [{ run: [['node', 'add.mjs', '2', '3']] }, { run: [['node', 'add.mjs', '10', '32']] }] };
  const transcript = await runJob(job, plan, {
    tag,
    noProxyHosts: [`pm-origin-${tag}`],
    beforeRun: async (net) => { origin = await startOrigin(net, tag, root); },
    afterRun: async () => { if (origin) await origin.cleanup(); },
  });
  return transcript;
}

test('honest fixture: both steps produce the stated output', { skip }, async () => {
  const t = await runFixture('honest', randomUUID().slice(0, 8));
  assert.equal(t.clone.exit_code, 0);
  assert.equal(t.steps[0].commands[0].stdout.trim(), '5');
  assert.equal(t.steps[1].commands[0].stdout.trim(), '42');
  // The hash is a deterministic function of the canonical transcript content.
  assert.match(t.hash, /^[0-9a-f]{64}$/);
  assert.equal(t.hash, transcriptHash(t), 'transcript hash must be reproducible from its content');
});

test('broken fixture: step 2 does not produce the stated output', { skip }, async () => {
  const t = await runFixture('broken', randomUUID().slice(0, 8));
  assert.equal(t.clone.exit_code, 0);
  // broken/add.mjs prints a+b+1, so step 1 prints 6 (not the stated 5) and step 2 prints 43 (not 42)
  assert.equal(t.steps[0].commands[0].stdout.trim(), '6');
  assert.equal(t.steps[1].commands[0].stdout.trim(), '43');
});

test('a real GitHub repo clones through the egress proxy', { skip }, async () => {
  const tag = randomUUID().slice(0, 8);
  // A small, stable public NEAR example. Pin a commit so the test is reproducible.
  const job = {
    repo: 'https://github.com/near-examples/hello-near-examples',
    commit: 'main',
    path: 'frontend',
    steps: [{ do: 'ls package.json', see: 'package.json' }],
  };
  const plan = { steps: [{ run: [['bash', '-c', 'ls package.json && head -1 package.json']] }] };
  const transcript = await runJob(job, plan, { tag });
  assert.equal(transcript.clone.exit_code, 0, `github clone should work through the proxy: ${JSON.stringify(transcript.clone).slice(0, 400)}`);
  assert.match(transcript.steps[0].commands[0].stdout, /package\.json/);
});
