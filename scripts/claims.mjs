// Check the claims the README makes, one line per claim: PASS, FAIL, or SKIP when the claim could
// not be checked here: a prerequisite is missing, or no public RPC answered a live read (the line
// says which). FAIL means the claim is false. Exits 1 if any claim fails. It adds no test logic of its own: it runs
// the repo's existing tests and simulation, and reads the bundled snapshot and the recorded testnet
// run in docs/evidence/. The README's "Check the claims" table lists the same ids.
//
//   npm run claims             no key, no network after npm install (uses cargo and Docker if present)
//   npm run claims -- --live   also reads pmarket.testnet over public JSON-RPC (network, no key)
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVE = process.argv.includes('--live');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));
const YOCTO = 10n ** 24n;
const nearStr = (y) => (Number((BigInt(y) * 10000n) / YOCTO) / 10000).toFixed(2);

const results = [];
function report(status, id, claim, detail, secs) {
  results.push(status);
  const t = secs === undefined ? '' : ` (${secs.toFixed(1)} s)`;
  console.log(`${status.padEnd(4)}  ${id.padEnd(20)}  ${claim}${detail ? `: ${detail}` : ''}${t}`);
}
async function check(id, claim, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const secs = (performance.now() - t0) / 1000;
    if (r?.skip) report('SKIP', id, claim, r.skip);
    else if (r?.ok) report('PASS', id, claim, r.detail, secs);
    else report('FAIL', id, claim, r?.detail || 'check failed', secs);
  } catch (e) {
    const msg = String(e?.message || e).split('\n')[0];
    // A live read that no public RPC answered was not checked; it is not a false claim.
    if (id.startsWith('live-') && RPC_DOWN.test(msg)) report('SKIP', id, claim, `no public RPC answered (${msg.slice(0, 80)}); run it again`);
    else report('FAIL', id, claim, msg);
  }
}
const RPC_DOWN = /Exceeded \d+ providers|429|rate limit|fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|502|503/i;
function run(cmd, args, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.error ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, missing: r.error?.code === 'ENOENT' };
}
// node --test prints "# pass N" and "# fail N"; the claim holds when the expected count passed.
function nodeTests(files, expected, env) {
  const r = run(process.execPath, ['--test', ...files], { env });
  const pass = Number(r.out.match(/^# pass (\d+)/m)?.[1] ?? -1);
  const fail = Number(r.out.match(/^# fail (\d+)/m)?.[1] ?? -1);
  return { ok: r.code === 0 && fail === 0 && pass === expected, detail: `${pass} of ${expected} tests pass${fail > 0 ? `, ${fail} fail` : ''}` };
}
// cargo prints "test result: ok. N passed; M failed" per test target.
function cargoTests(args, expected) {
  const r = run('cargo', ['test', ...args], { cwd: join(ROOT, 'contract') });
  const m = [...r.out.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)].find((x) => Number(x[2]) + Number(x[3]) > 0);
  const pass = Number(m?.[2] ?? 0);
  const fail = Number(m?.[3] ?? 0);
  if (!m) return { ok: false, detail: `no test result (cargo exit ${r.code}): ${r.out.trim().split('\n').slice(-2).join(' ')}` };
  return { ok: r.code === 0 && fail === 0 && pass === expected, detail: `${pass} of ${expected} tests pass${fail ? `, ${fail} fail` : ''}` };
}

const snapshot = readJson('web/public/data/snapshot.json');
const e2e = readJson('docs/evidence/e2e-results.json');
const self = readJson('docs/evidence/self-check-results.json');
const dispute = readJson('docs/evidence/dispute-results.json');
const jobTrees = readJson('docs/evidence/job-trees.json');
const runLog = [...e2e.txs, ...self.txs, ...dispute.txs];
const TRUTH = 'Pass,Fail,Pass'; // what fixtures/misleading really does: step 2 of its README is false
const transcripts = readdirSync(join(ROOT, 'docs/evidence/transcripts')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ key: f.replace(/\.json$/, ''), t: readJson(`docs/evidence/transcripts/${f}`) }));
// "job-<id>-<account>" -> the transcript hash a job records for that worker or verifier
const hashesOf = (jobs) => Object.fromEntries(jobs.flatMap((j) => [
  ...j.claims.map((c) => [`job-${j.id}-${c.worker}`, c.transcript_hash]),
  ...j.rounds.filter((r) => r.verifier).map((r) => [`job-${j.id}-${r.verifier}`, r.transcript_hash]),
]));
const TX_LINK = /\[(post|challenge|verify|finalize)\]\(https:\/\/testnet\.nearblocks\.io\/txns\/(\w+)\)/g;
const adversarial = readJson('docs/evidence/adversarial-results.json');
const jobById = (id) => snapshot.fullJobs.find((j) => j.id === id);
const C = snapshot.contract;
const head = run('git', ['rev-parse', '--short', 'HEAD']).out.trim();
console.log(`Proof Market claims check, commit ${head || 'unknown'}, ${LIVE ? 'offline checks plus live testnet reads' : 'offline (add --live to also read testnet)'}\n`);

// ---- keyless, offline ----

await check('sim', 'Simulation: under its stated assumptions every lie is caught and costs its bond, and a worker that lies ends with less than one that never does', () => {
  const r = run(process.execPath, ['scripts/sim.mjs', '2000', '0.5']);
  const steady = Number(r.out.match(/always-honest worker net:\s*(-?[\d.]+)/)?.[1]);
  const [, mixed, , lying] = r.out.match(/sometimes-lying worker net:\s*(-?[\d.]+) NEAR\s+\(its honest jobs (-?[\d.]+), its lying jobs (-?[\d.]+)\)/) || [];
  const [, lies, caught] = r.out.match(/lies: (\d+), caught and slashed: (\d+)/) || [];
  const ok = r.code === 0 && Number(lies) > 0 && lies === caught && Number(lying) < 0 && steady > Number(mixed);
  return { ok, detail: `always honest ${steady}, lying half the time ${mixed} (lying jobs alone ${lying}), ${caught} of ${lies} lies slashed` };
});

await check('report-hash', 'Commit-reveal: a worker commits SHA-256 of the documented report preimage', () =>
  nodeTests(['agents/report.test.mjs', 'agents/worker.test.mjs'], 8));

await check('egress', 'Sandbox egress: loopback, private, link-local and CGNAT addresses are refused, only listed hostnames pass, a reset client does not stop the proxy', () =>
  nodeTests(['sandbox/egress/allowlist.test.mjs'], 4, { HOST_IPS: '127.0.0.1' }));

await check('demo-jobs', 'Demo snapshot: job #0 PASS, job #1 FAIL, job #2 w3 slashed after verifier v1 ruled Pass', () => {
  const s = (id) => jobById(id);
  const claims = (j) => Object.fromEntries(j.claims.map((c) => [c.worker.split('.')[0], `${c.status}:${c.verdicts.join(',')}`]));
  const j0 = claims(s(0)), j1 = claims(s(1)), j2 = claims(s(2));
  const r2 = s(2).rounds[0];
  const ok = s(0).final_verdicts.join() === 'Pass,Pass' && j0.w1 === 'paid:Pass,Pass' && j0.w2 === 'paid:Pass,Pass'
    && s(1).final_verdicts.join() === 'Fail,Fail' && j1.w1 === 'paid:Fail,Fail' && j1.w2 === 'paid:Fail,Fail'
    && s(2).final_verdicts.join() === 'Pass,Pass' && j2.w1 === 'paid:Pass,Pass' && j2.w3 === 'slashed:Fail,Fail'
    && r2?.verifier === `v1.${C}` && r2?.ruling.join() === 'Pass,Pass';
  return { ok, detail: `#2 verifier ${r2?.verifier}, w1 ${j2.w1}, w3 ${j2.w3}` };
});

await check('slash-pays-no-one', 'Job #2 settlement: w1 +0.09 bounty, v1 +0.01 fee, w3 -0.02 burned; payouts = bounty + w1 bond, so the burn pays no one', () => {
  const j = jobById(2);
  const sum = (xs) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);
  const get = (acct, kind) => j.payouts.find((p) => p.account === `${acct}.${C}` && p.kind === kind)?.amount;
  const paid = sum(j.payouts);
  const expectedPaid = BigInt(j.bounty) + BigInt(j.bond); // the one honest claimant's bond comes back
  const ok = nearStr(get('w1', 'bounty')) === '0.09' && nearStr(get('v1', 'fee')) === '0.01'
    && j.burns.length === 1 && j.burns[0].account === `w3.${C}` && nearStr(j.burns[0].amount) === '0.02'
    && paid === expectedPaid;
  return { ok, detail: `paid ${nearStr(paid)} = bounty ${nearStr(j.bounty)} + bond ${nearStr(j.bond)}; burned ${nearStr(j.burns[0]?.amount ?? 0)}` };
});

await check('misleading-fixture', 'fixtures/misleading: its README step 2 is false and steps 1 and 3 are true, for anyone who runs them', () => {
  const cwd = join(ROOT, 'fixtures/misleading');
  const s1 = run(process.execPath, ['cli.mjs', '1h30m'], { cwd });
  const s2 = run(process.execPath, ['cli.mjs', '2d'], { cwd });
  const s3 = run(process.execPath, ['--test'], { cwd });
  const pass = Number(s3.out.match(/^# pass (\d+)/m)?.[1] ?? -1);
  const fail = Number(s3.out.match(/^# fail (\d+)/m)?.[1] ?? -1);
  const ok = s1.code === 0 && s1.out.trim() === '5400' && s2.code === 1 && !s2.out.includes('172800') && s3.code === 0 && pass === 5 && fail === 0;
  return { ok, detail: `step 1 prints ${s1.out.trim()}; step 2 exits ${s2.code} with ${s2.out.trim()}; step 3 # pass ${pass}, # fail ${fail}` };
});

await check('dispute-jobs', 'Job #5: w3 approved a false README step and was slashed. Job #6: the verifier that sided with it was overruled on appeal and slashed too', () => {
  const [caught, appeal] = ['caught', 'appeal'].map((k) => dispute.jobs.find((j) => j.key === k));
  const j5 = jobById(caught.id), j6 = jobById(appeal.id);
  const claim = (j, w) => j.claims.find((c) => c.worker === `${w}.${C}`);
  const burned = (j, account, kind, amount) => j.burns.some((b) => b.account === account && b.kind === kind && nearStr(b.amount) === amount);
  const got = (j, account, kind) => j.payouts.some((p) => p.account === account && p.kind === kind);
  const [a, b] = j6.rounds;
  const ok5 = j5.path === 'fixtures/misleading' && j5.final_verdicts.join() === TRUTH
    && claim(j5, 'w3').verdicts.join() === 'Pass,Pass,Pass' && claim(j5, 'w3').status === 'slashed'
    && claim(j5, 'w1').verdicts.join() === TRUTH && claim(j5, 'w1').status === 'paid'
    && j5.rounds.length === 1 && j5.rounds[0].reason === 'disagreement' && j5.rounds[0].ruling.join() === TRUTH
    && j5.burns.length === 1 && burned(j5, `w3.${C}`, 'slash', '0.02') && got(j5, `w1.${C}`, 'bounty');
  const ok6 = j6.path === 'fixtures/misleading' && j6.final_verdicts.join() === TRUTH
    && claim(j6, 'w3').status === 'slashed' && claim(j6, 'w2').verdicts.join() === TRUTH && claim(j6, 'w2').status === 'paid'
    && j6.rounds.length === 2 && a.ruling.join() === 'Pass,Pass,Pass' && b.reason === 'challenge' && b.challenger === `w2.${C}`
    && b.ruling.join() === TRUTH && b.verifier !== a.verifier
    && j6.burns.length === 2 && burned(j6, `w3.${C}`, 'slash', '0.02') && burned(j6, a.verifier, 'overruled', '0.05')
    && got(j6, b.verifier, 'fee') && !got(j6, a.verifier, 'fee') && got(j6, `w2.${C}`, 'challenge_return') && got(j6, `w2.${C}`, 'bounty');
  const sameAsLog = [caught, appeal].every((r) => JSON.stringify(jobById(r.id).burns) === JSON.stringify(r.burns) && JSON.stringify(jobById(r.id).payouts) === JSON.stringify(r.payouts));
  return { ok: ok5 && ok6 && sameAsLog && nearStr(snapshot.burned) === '0.11', detail: `#5 verifier ${j5.rounds[0].verifier.split('.')[0]} ruled ${j5.rounds[0].ruling.join()}, w3 -0.02; #6 round 1 ${a.verifier.split('.')[0]} ruled ${a.ruling.join()}, w2 appealed, round 2 ${b.verifier.split('.')[0]} ruled ${b.ruling.join()}, w3 -0.02, ${a.verifier.split('.')[0]} -0.05; contract total burned ${nearStr(snapshot.burned)}` };
});

await check('job-trees', 'The fixture directory each job ran is unchanged at this commit (same git tree id as at the job\'s commit)', () => {
  const moved = [];
  for (const t of jobTrees) {
    const r = run('git', ['rev-parse', `HEAD:${t.path}`]);
    if (r.missing || r.code !== 0) return { skip: 'needs a git clone of this repo (git rev-parse HEAD:<path>)' };
    if (r.out.trim() !== t.tree) moved.push(`#${t.job} ${t.path}`);
  }
  return { ok: moved.length === 0, detail: moved.length ? `changed since the job ran: ${moved.join(', ')}` : `${jobTrees.length} of ${jobTrees.length} jobs: ${[...new Set(jobTrees.map((t) => t.path))].join(', ')} (docs/evidence/job-trees.json)` };
});

await check('readme-txs', 'Every testnet transaction the README links is in a recorded run log as the action the README names', () => {
  const links = [...read('README.md').matchAll(TX_LINK)];
  const bad = links.filter(([, kind, hash]) => !runLog.some((t) => t.tx === hash && t.kind === kind));
  return { ok: links.length === 19 && bad.length === 0, detail: `${links.length - bad.length} of ${links.length} links match the run logs in docs/evidence/${bad.length ? `; not found: ${bad.map((b) => b[2]).join(', ')}` : ''}` };
});

await check('self-check', 'Job #4: two bonded workers and a drawn verifier reproduced this repo\'s own README steps and all ruled Pass', () => {
  const j = self.jobs[0];
  const steps = j?.final_verdicts?.length;
  const verify = self.txs.find((t) => t.kind === 'verify');
  const ok = j?.outcome === 'PASS' && steps === 3 && j.final_verdicts.every((v) => v === 'Pass')
    && j.paid.length === 2 && j.slashed.length === 0 && j.burns.length === 0 && Boolean(verify);
  return { ok, detail: `job #${j?.id} at commit ${String(j?.commit).slice(0, 7)}: ${j?.outcome}, ${steps} steps Pass, ${j?.paid.length} workers paid, verifier ${verify?.actor} (docs/evidence/self-check-results.json)` };
});

await check('transcripts', 'Each published transcript hashes to its recorded hash, which is the hash its account signed in the snapshot', async () => {
  const { transcriptHash } = await import('../sandbox/run.mjs');
  const snap = hashesOf(snapshot.fullJobs);
  const bad = transcripts.filter(({ key, t }) => transcriptHash(t) !== t.hash || (key in snap && snap[key] !== t.hash));
  const vsSnap = transcripts.filter(({ key }) => key in snap).length;
  return { ok: transcripts.length === 17 && vsSnap === 17 && bad.length === 0, detail: `${transcripts.length - bad.length} of ${transcripts.length} recompute with transcriptHash in sandbox/run.mjs; ${vsSnap} also match the snapshot${bad.length ? `; not matching: ${bad.map((b) => b.key).join(', ')}` : ''} (docs/evidence/transcripts/)` };
});

await check('attacks-recorded', 'Testnet sweep: none of 10 attacks succeeded; 8 failed as transactions with a contract panic (5 by the check they name, 3 by an earlier one), 2 left no transaction', () => {
  // The panic each attack is named for. An attack that failed with a different panic was stopped
  // by an earlier check (its target job was never claimed or reported).
  const NAMED = {
    'claim a nonexistent job': 'no such job',
    'poster claims its own job': 'poster cannot claim its own job',
    'verify by a verifier that was not drawn': 'not the drawn verifier',
    'reveal without a commit': 'no commit to reveal',
    'challenge by a stranger': 'only the poster or a claimant',
    'finalize before the job is reported': 'job not reported yet',
    'claim after the claim window closed': 'claim phase closed',
    'withdraw more than free': 'withdraw: only free balance can be withdrawn',
  };
  const r = adversarial.results;
  const withTx = r.filter((x) => x.pass && x.tx && x.detail);
  const named = withTx.filter((x) => x.detail.startsWith(NAMED[x.name] ?? '\u0000'));
  const noTx = r.filter((x) => x.pass && !x.tx && /^fc key/.test(x.name));
  const ok = r.length === 10 && r.every((x) => x.pass) && withTx.length === 8 && named.length === 5 && noTx.length === 2;
  return { ok, detail: `${withTx.length} with tx hash and panic text (${named.length} by the named check, ${withTx.length - named.length} by an earlier one), ${noTx.length} function-call-key attacks with no tx (docs/evidence/adversarial-results.json)` };
});

await check('model-cost', 'The three-job testnet run cost about $0.002 in model calls', () => {
  const u = e2e.model_usage;
  return { ok: u.usd > 0 && u.usd < 0.003, detail: `${u.calls} calls, ${u.input_tokens + u.output_tokens} tokens, $${u.usd} (docs/evidence/e2e-results.json)` };
});

await check('dispute-cost', 'The two dispute jobs cost under $0.01 in model calls and under 0.01 NEAR in network fees, against 0.2 NEAR of bounties', () => {
  const u = dispute.model_usage;
  const fees = dispute.jobs.map((j) => j.network_fee);
  const yocto = fees.reduce((a, f) => a + BigInt(f.yocto), 0n);
  const txs = fees.reduce((a, f) => a + f.transactions, 0);
  const ok = u.usd > 0 && u.usd < 0.01 && yocto > 0n && yocto < 10n ** 22n && txs === dispute.txs.length;
  return { ok, detail: `${u.calls} model calls $${u.usd}; ${txs} transactions burnt ${(Number(yocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR in fees (docs/evidence/dispute-results.json)` };
});

// ---- keyless, need a toolchain (SKIP when it is missing) ----

const rust = run('cargo', ['--version'], { cwd: join(ROOT, 'contract') });
const rustc = rust.code === 0 ? run('rustc', ['--version'], { cwd: join(ROOT, 'contract') }).out.trim() : '';
const rustMinor = Number(rustc.match(/^rustc 1\.(\d+)/)?.[1] ?? 0);
const cargoNear = rust.code === 0 ? run('cargo', ['near', '--version'], { cwd: join(ROOT, 'contract') }) : rust;
const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
const glibcOld = glibc && Number(glibc.split('.')[0]) <= 2 && Number(glibc.split('.')[1]) < 38;
const noRust = rust.code !== 0 || rustMinor < 95
  ? `needs Rust 1.95 (${rust.code !== 0 ? 'cargo not found' : `found ${rustc.split(' ')[1]}`}; rustup installs the version contract/rust-toolchain.toml pins), see AGENTS.md`
  : null;

if (rust.code === 0) console.log('      (contract tests: about 3 minutes on a fresh clone, mostly compiling)');
await check('contract-unit', 'Contract unit tests (settlement, verifier draw, bounty split, preimage)', () =>
  noRust ? { skip: noRust } : cargoTests(['--lib'], 18));

await check('contract-attacks', 'near-sandbox tests on the real wasm: every happy path and every attack in "How to break this"', () => {
  if (noRust) return { skip: noRust };
  if (cargoNear.code !== 0) return { skip: 'needs the cargo-near CLI (the wasm build), see AGENTS.md' };
  if (glibcOld) return { skip: `the near-sandbox binary needs glibc 2.38+ (this system has ${glibc}); Ubuntu 24.04 works, see AGENTS.md` };
  return cargoTests(['--test', 'integration'], 10);
});

const image = process.env.PM_RUNNER_IMAGE || 'proof-market-runner:1';
await check('sandbox-escape', 'A hostile repo in the job sandbox reads and reaches nothing on the host', () => {
  const d = run('docker', ['image', 'inspect', image]);
  if (d.missing) return { skip: 'needs Docker, see AGENTS.md' };
  if (d.code !== 0) return { skip: `needs the runner image: docker build -t ${image} sandbox/runner (about 2 minutes), see AGENTS.md` };
  return nodeTests(['sandbox/escape.test.mjs'], 1, { PM_SANDBOX_IT: '1' });
});

// ---- live testnet reads (network, no key) ----

if (LIVE) {
  // The RPC client prints a stack trace each time it retries or fails over to another public
  // endpoint. Those are not results: keep the output to one line per claim.
  console.error = () => {};
  console.warn = () => {};
  const { view, provider } = await import('../lib/chain.mjs');
  // Public endpoints rate-limit bursts: wait longer each time, about a minute in all, before giving up.
  const retry = async (fn) => {
    for (let k = 0; ; k++) {
      try { return await fn(); } catch (e) { if (k >= 7) throw e; await new Promise((r) => setTimeout(r, 2000 * (k + 1))); }
    }
  };
  const txStatus = (txHash, accountId) => retry(() => provider.viewTransactionStatus({ txHash, accountId, waitUntil: 'NONE' }));
  const pick = (j) => JSON.stringify({ s: j.status, f: j.final_verdicts, c: j.claims.map((c) => [c.worker, c.status, c.verdicts]), r: j.rounds.map((r) => [r.verifier, r.ruling]), p: j.payouts, b: j.burns });

  await check('live-config', `${C} runs with audit_bps 0: only disagreements are audited on this deployment`, async () => {
    const cfg = await view('get_config');
    return { ok: cfg.audit_bps === 0 && JSON.stringify(cfg) === JSON.stringify(snapshot.config), detail: `audit_bps ${cfg.audit_bps}, registration bond ${nearStr(cfg.min_worker_bond)} NEAR, fee ${cfg.audit_fee_bps / 100}%` };
  });

  await check('live-jobs', 'Jobs #0, #1, #2, #4, #5 and #6 on chain match the demo snapshot (verdicts, claims, verifiers, payouts, burns)', async () => {
    const diff = [];
    for (const id of [0, 1, 2, 4, 5, 6]) if (pick(await view('get_job', { job_id: id })) !== pick(jobById(id))) diff.push(id);
    return { ok: diff.length === 0, detail: diff.length ? `differs: #${diff.join(', #')}` : 'all six match' };
  });

  await check('live-burned', 'The contract has burned 0.11 NEAR in total', async () => {
    const b = await view('total_burned');
    return { ok: nearStr(b) === '0.11', detail: `total_burned ${nearStr(b)} NEAR` };
  });

  await check('live-records', 'Each account carries its record on chain: w3 was slashed three times, and the overruled verifier is out of the pool', async () => {
    const out = dispute.jobs.find((j) => j.key === 'appeal').rounds[0].verifier;
    const [w3, v, pool] = await Promise.all([view('get_account', { account_id: `w3.${C}` }), view('get_account', { account_id: out }), view('list_verifiers')]);
    const inPool = pool.map((x) => x.account_id);
    const ok = w3.stats.slashes === 3 && nearStr(w3.stats.burned) === '0.06' && v.stats.overruled === 1 && nearStr(v.stats.burned) === '0.05'
      && v.role !== 'verifier' && !inPool.includes(out);
    return { ok, detail: `w3 slashes ${w3.stats.slashes}, burned ${nearStr(w3.stats.burned)} NEAR; ${out.split('.')[0]} overruled ${v.stats.overruled}, burned ${nearStr(v.stats.burned)} NEAR, role ${v.role}; pool ${inPool.map((x) => x.split('.')[0]).join(', ')}` };
  });

  await check('live-readme-txs', 'The 19 README transactions succeeded on chain with the signer and method the run logs record', async () => {
    const method = { post: 'post_job', challenge: 'challenge', verify: 'verify', finalize: 'finalize' };
    const links = [...read('README.md').matchAll(TX_LINK)];
    const bad = [];
    for (const [, kind, hash] of links) {
      const signer = runLog.find((t) => t.tx === hash)?.actor || `poster.${C}`;
      const r = await txStatus(hash, signer);
      const fc = r.transaction.actions[0]?.FunctionCall;
      if (!('SuccessValue' in r.status) || r.transaction.signer_id !== signer || fc?.method_name !== method[kind]) bad.push(hash);
    }
    return { ok: links.length === 19 && bad.length === 0, detail: `${links.length - bad.length} of ${links.length} succeeded as recorded${bad.length ? `; failed: ${bad.join(', ')}` : ''}` };
  });

  await check('live-self-check', 'Job #4 on chain: this repo at the recorded commit, Finalized with every step Pass, both workers paid, the dispute ruled Pass by the drawn verifier', async () => {
    const want = self.jobs[0];
    const j = await view('get_job', { job_id: want.id });
    const r1 = j.rounds[0];
    const ok = j.status === 'Finalized' && j.commit === want.commit && j.path === ''
      && j.final_verdicts.length === 3 && j.final_verdicts.every((v) => v === 'Pass')
      && j.claims.length === 2 && j.claims.every((c) => c.status === 'paid') && j.burns.length === 0
      && r1?.reason === 'challenge' && r1?.ruling?.every((v) => v === 'Pass') && JSON.stringify(j.payouts) === JSON.stringify(want.payouts);
    return { ok, detail: `#${j.id} ${j.status}, commit ${j.commit.slice(0, 7)}, verifier ${r1?.verifier} ruled ${r1?.ruling?.join(',')}, ${j.claims.filter((c) => c.status === 'paid').length} paid, ${j.burns.length} burns` };
  });

  await check('live-transcripts', 'The 17 published transcripts carry the transcript hashes on chain for jobs #0, #1, #2, #4, #5 and #6', async () => {
    const chain = {};
    for (const id of [0, 1, 2, 4, 5, 6]) Object.assign(chain, hashesOf([await view('get_job', { job_id: id })]));
    const bad = transcripts.filter(({ key, t }) => chain[key] !== t.hash);
    return { ok: transcripts.length === 17 && bad.length === 0, detail: `${transcripts.length - bad.length} of ${transcripts.length} match the chain${bad.length ? `; not matching: ${bad.map((b) => b.key).join(', ')}` : ''}` };
  });

  await check('live-attacks', 'The 8 recorded attack transactions failed on chain with the recorded contract panic', async () => {
    // Who signed each attack, as scripts/adversarial.mjs sends them.
    const signer = { 'claim a nonexistent job': 'w1', 'poster claims its own job': 'poster', 'verify by a verifier that was not drawn': 'v2', 'reveal without a commit': 'w2', 'challenge by a stranger': 'w3', 'finalize before the job is reported': 'w1', 'claim after the claim window closed': 'w2', 'withdraw more than free': 'w1' };
    const bad = [];
    let n = 0;
    for (const a of adversarial.results.filter((x) => x.tx)) {
      n++;
      const r = await txStatus(a.tx, `${signer[a.name]}.${C}`);
      const panic = a.detail.split(' (')[0];
      if (!('Failure' in r.status) || !JSON.stringify(r.status).includes(panic)) bad.push(a.name);
    }
    return { ok: n === 8 && bad.length === 0, detail: `${n - bad.length} of ${n} failed with the recorded panic${bad.length ? `; not as recorded: ${bad.join('; ')}` : ''}` };
  });

  await check('live-agent-keys', 'Each worker and verifier has a function-call key limited to the market and its 12 agent methods, plus the operator\'s full-access key', async () => {
    const methods = JSON.parse(read('scripts/provision.mjs').match(/export const AGENT_METHODS = (\[[^\]]+\])/)[1].replace(/'/g, '"')).sort().join();
    const bad = [];
    for (const a of ['w1', 'w2', 'w3', 'v1', 'v2', 'v3']) {
      const { keys } = await retry(() => provider.viewAccessKeyList({ accountId: `${a}.${C}`, finalityQuery: { finality: 'final' } }));
      const fc = keys.filter((k) => k.access_key.permission?.FunctionCall);
      const full = keys.filter((k) => k.access_key.permission === 'FullAccess');
      const good = fc.length === 1 && fc[0].access_key.permission.FunctionCall.receiver_id === C
        && [...fc[0].access_key.permission.FunctionCall.method_names].sort().join() === methods && full.length === 1;
      if (!good) bad.push(a);
    }
    return { ok: bad.length === 0, detail: bad.length ? `unexpected keys on ${bad.join(', ')}` : '6 of 6 accounts: 1 function-call key (12 methods), 1 full-access key' };
  });
}

const n = (s) => results.filter((x) => x === s).length;
console.log(`\n${results.length} claims: ${n('PASS')} PASS, ${n('FAIL')} FAIL, ${n('SKIP')} SKIP (not checked here; the line says why)`);
process.exit(n('FAIL') ? 1 : 0);
