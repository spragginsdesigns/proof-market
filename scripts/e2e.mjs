// Drive the three demo jobs end to end on NEAR testnet: honest -> PASS, broken -> FAIL, and a liar
// who is caught by a verifier and slashed. Workers reproduce in the real sandbox and sign with their
// function-call-only keys. Every tx hash is recorded to state/e2e-results.json for the UI snapshot,
// the README and the video.
//
// With --self it posts one job instead: this repo's own keyless README steps (npm install, the
// simulation, npm test) at the current commit, reproduced by two workers. The poster then disputes
// the result on purpose, so a randomly drawn verifier reruns it too; if the verifier agrees with the
// workers, the poster's challenge bond goes to that verifier. Recorded to
// state/self-check-results.json.
//
// With --dispute it posts two jobs on fixtures/misleading, a project whose README has one false
// step. In the first a worker rubber-stamps the README, another reports the failing step, and the
// drawn verifier's rerun settles it. In the second the drawn verifier sides with the rubber stamp,
// the honest worker appeals, and a second verifier overrules the first. Recorded to
// state/dispute-results.json, with the network fee of every transaction.
//
//   PM_CONTRACT=yourname.testnet PM_MODEL_API_KEY=... node scripts/e2e.mjs [--self | --dispute]
import { makeRepoMirrorOrigin } from '../sandbox/origin.mjs';
import { agent, fund, registerWorker, registerVerifier, postJob, claimAndCommit, revealReport, verifyJob, advance, finalize, getJob, sleep } from './market.mjs';
import { view, near, toNear, call, account, provider, CONTRACT, EXPLORER } from '../lib/chain.mjs';
import { usageSummary } from '../agents/model.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.PM_STATE || new URL('../state/', import.meta.url).pathname;
const ledger = JSON.parse(readFileSync(join(stateDir, 'accounts.json'), 'utf8'));
const GH = process.env.PM_REPO_URL || 'https://github.com/spragginsdesigns/proof-market';
const MODEL = process.env.PM_MODEL || 'gpt-5-nano';
const C = CONTRACT;
const W = (n) => `w${n}.${C}`;
const V = (n) => `v${n}.${C}`;
const POSTER = `poster.${C}`;

const STEPS = [
  { do: 'node add.mjs 2 3', see: 'the output is 5' },
  { do: 'node add.mjs 10 32', see: 'the output is 42' },
];
const PHASES = { slots: 2, bond: 0.02, bounty: 0.1, claim_ms: 40000, run_ms: 180000, reveal_ms: 90000, window_ms: 12000 };
const SELF = process.argv.includes('--self');
// This repo's own README steps that need no key and no toolchain beyond Node.
const SELF_STEPS = [
  { do: 'npm install', see: 'npm finishes without an error and reports the packages it added' },
  { do: 'node scripts/sim.mjs', see: 'every lie is caught and slashed, and the sometimes-lying worker net is lower than the always-honest worker net' },
  { do: 'npm test', see: 'the test summary shows # pass 12 and # fail 0' },
];
const SELF_PHASES = { ...PHASES, run_ms: 600000, reveal_ms: 180000, window_ms: 60000 }; // room for npm install and the dispute
const DISPUTE = process.argv.includes('--dispute');
// fixtures/misleading/README.md, "Try it". Step 2 is false: the parser has no day unit.
const MISLEADING_STEPS = [
  { do: 'node cli.mjs 1h30m', see: 'the output is 5400' },
  { do: 'node cli.mjs 2d', see: 'the output is 172800' },
  { do: 'node --test', see: 'the test summary shows # pass 5 and # fail 0' },
];
const APPEAL_PHASES = { ...PHASES, window_ms: 90000 }; // room for the honest worker to appeal

const log = (s) => console.log(s);
const results = { contract: C, repo: GH, started_at: new Date().toISOString(), jobs: [], txs: [] };
const onEvent = (e) => { if (e.tx) results.txs.push({ kind: e.kind, actor: e.actor || e.worker || e.verifier, tx: e.tx, ...(CURRENT?.jobId !== undefined ? { job: CURRENT.jobId } : {}) }); if (['claim', 'commit', 'reveal', 'verify', 'planned', 'ran', 'judged'].includes(e.kind)) log(`   . ${e.kind} ${e.actor || e.worker || e.verifier || ''} ${e.verdicts ? JSON.stringify(e.verdicts) : ''}${e.lie || e.collude ? ' (SCRIPTED LIE)' : ''}${e.tx ? ' ' + e.tx : ''}${e.error ? ' ERR ' + e.error.slice(0, 80) : ''}`); };

async function ensureRegistered() {
  log('# funding and registering agents');
  for (const n of [1, 2, 3]) {
    const w = W(n);
    const acc = await view('get_account', { account_id: w });
    if (acc.role !== 'worker') {
      await fund(C, w, 0.4);
      const r = await registerWorker(w, `worker-${n}`, MODEL);
      log(`  register ${w}: ${r.ok ? r.hash : 'ERR ' + r.error}`);
    } else log(`  ${w} already a worker`);
  }
  for (const n of [1, 2, 3]) {
    const v = V(n);
    const acc = await view('get_account', { account_id: v });
    if (acc.role !== 'verifier') {
      await fund(C, v, 0.2);
      const r = await registerVerifier(v, `verifier-${n}`, 'gpt-5-mini');
      log(`  register ${v}: ${r.ok ? r.hash : 'ERR ' + r.error}`);
    } else log(`  ${v} already a verifier`);
  }
  // poster needs free for the bounties
  await fund(C, POSTER, 0.4);
}

async function settle(jobId, { expectAudit, collude = false, appealBy = null }) {
  // Wait for the reveal phase to close into Reported / Auditing, then handle an audit, then finalize.
  for (let i = 0; i < 40; i++) {
    const j = await getJob(jobId);
    if (j.phase === 'Auditing') {
      const round = j.rounds[j.rounds.length - 1];
      if (round && round.verifier && round.outcome === 'pending') {
        log(`  audit round ${round.round} (${round.reason}); drawn verifier ${round.verifier}`);
        const vjob = { jobId, repo: GH, path: CURRENT.path, steps: CURRENT.steps, commit: CURRENT.commit, cloneUrl: `${ORIGIN.base}/repo.git` };
        // In the appeal scenario the round-1 verifier is scripted to side with the rubber stamp.
        const scripted = collude && round.round === 1;
        const vr = await verifyJob(round.verifier, vjob, { model: 'gpt-5-mini', origin: ORIGIN, collude: scripted, onEvent });
        log(`  verifier ruled: ${vr.ruled.ok ? vr.ruled.hash : 'ERR ' + vr.ruled.error}`);
        if (scripted && vr.ruled.ok && appealBy) {
          // The honest worker appeals with its own function-call key; this opens round 2.
          const ap = await call(agent(appealBy), 'challenge', { job_id: jobId }, { gasTgas: 80 });
          log(`  appeal by ${appealBy}: ${ap.ok ? ap.hash : 'ERR ' + ap.error}`);
          if (ap.hash) results.txs.push({ kind: 'challenge', actor: appealBy, tx: ap.hash, job: jobId });
        }
      } else if (round && (await view('get_job', { job_id: jobId })).advance_due) {
        await advance(POSTER, jobId);
      } else {
        await sleep(3000);
      }
      continue;
    }
    if (j.finalize_ready) break;
    if (j.advance_due) { await advance(POSTER, jobId); continue; }
    await sleep(3000);
  }
  const fin = await finalize(POSTER, jobId);
  log(`  finalize: ${fin.ok ? fin.hash : 'ERR ' + fin.error}`);
  if (fin.hash) results.txs.push({ kind: 'finalize', tx: fin.hash, job: jobId });
  return getJob(jobId);
}

let CURRENT = null;
let ORIGIN = null;

async function runJobScenario({ key, title, fixture, path, workers, expect, expectAudit, steps = STEPS, phases = PHASES, dispute = false, collude = false, appealBy = null }) {
  log(`\n# JOB "${key}" (${expect})`);
  CURRENT = { fixture, path, steps, commit: ORIGIN.headCommit() };
  const job = { title, repo: GH, commit: CURRENT.commit, path, steps, fixture, cloneUrl: `${ORIGIN.base}/repo.git`, ...phases };
  const posted = await postJob(POSTER, job);
  if (!posted.ok) { log(`  post FAILED: ${posted.error}`); return; }
  const jobId = posted.value;
  CURRENT.jobId = jobId;
  log(`  posted job #${jobId}: ${EXPLORER}${posted.hash}`);
  results.txs.push({ kind: 'post', tx: posted.hash, job: jobId });
  const jobForWorker = { ...job, jobId };

  // Phase 1: every worker claims, reproduces and commits (in parallel).
  const committed = await Promise.all(workers.map((w) => claimAndCommit(w.id, jobForWorker, { model: MODEL, origin: ORIGIN, lie: w.lie, onEvent })));
  // Phase 2: once every claimant has committed, reveal (reveal is rejected before that).
  for (const c of committed.filter((c) => c.ok)) await revealReport(c.workerId, jobId, c.report, c.verdicts, { onEvent });
  if (dispute) {
    const ch = await call(account(POSTER), 'challenge', { job_id: jobId }, { gasTgas: 80 });
    log(`  poster dispute: ${ch.ok ? ch.hash : 'ERR ' + ch.error}`);
    if (ch.hash) results.txs.push({ kind: 'challenge', actor: POSTER, tx: ch.hash, job: jobId });
  }

  const final = await settle(jobId, { expectAudit, collude, appealBy });
  const fv = final.final_verdicts;
  const slashed = final.claims.filter((c) => c.status === 'slashed');
  const paid = final.claims.filter((c) => c.status === 'paid');
  const outcome = final.phase === 'Finalized' ? (slashed.length ? 'SLASHED' : fv && fv.includes('Fail') ? 'FAIL' : 'PASS') : final.phase;
  log(`  => phase=${final.phase} verdicts=${JSON.stringify(fv)} slashed=${slashed.length} paid=${paid.length}  OUTCOME=${outcome} (expected ${expect})`);
  const row = {
    key, id: jobId, title, path, commit: CURRENT.commit, expect, outcome,
    final_verdicts: fv, slashed: slashed.map((c) => c.worker), paid: paid.map((c) => c.worker),
    burns: final.burns, payouts: final.payouts,
    match: outcome === expect,
  };
  if (DISPUTE) {
    // What each party reported, who was scripted to lie, and what the transactions cost in fees.
    row.reports = final.claims.map((c) => ({ worker: c.worker, verdicts: c.verdicts, status: c.status }));
    row.rounds = final.rounds.map((r) => ({ round: r.round, reason: r.reason, verifier: r.verifier, ruling: r.ruling, challenger: r.challenger }));
    row.scripted = [
      ...workers.filter((w) => w.lie).map((w) => ({ account: w.id, script: 'reports Pass on every step' })),
      ...(collude ? [{ account: final.rounds[0]?.verifier, script: 'rules Pass on every step in round 1' }] : []),
    ];
    row.network_fee = await networkFee(results.txs.filter((t) => t.job === jobId));
    const want = fv?.join() === 'Pass,Fail,Pass' && row.burns.length === (collude ? 2 : 1) && final.rounds.length === (collude ? 2 : 1);
    row.match = row.match && want;
  }
  results.jobs.push(row);
}

// Sum the NEAR burnt as network fees by a job's transactions (the transaction and every receipt).
async function networkFee(txs) {
  let yocto = 0n;
  for (const t of txs) {
    for (let k = 0; ; k++) {
      try {
        const r = await provider.viewTransactionStatus({ txHash: t.tx, accountId: t.actor || POSTER, waitUntil: 'FINAL' });
        yocto += BigInt(r.transaction_outcome.outcome.tokens_burnt);
        for (const o of r.receipts_outcome) yocto += BigInt(o.outcome.tokens_burnt);
        break;
      } catch (e) {
        if (k >= 5) throw e;
        await sleep(1500 * (k + 1));
      }
    }
  }
  return { transactions: txs.length, yocto: yocto.toString(), near: Number(yocto / 10n ** 18n) / 1e6 };
}

async function main() {
  await ensureRegistered();
  // Serve a bare mirror of this repo (same commits as the public remote), so the demo clone and a
  // public clone at the same commit are identical. The job's path points into fixtures/.
  const repoDir = new URL('..', import.meta.url).pathname;
  ORIGIN = await makeRepoMirrorOrigin(repoDir);
  log(`# fixture origin mirrors this repo at commit ${ORIGIN.headCommit().slice(0, 10)}`);
  try {
    if (SELF) {
      await runJobScenario({ key: 'self', title: 'Reproduce this repo\'s own README (no key)', fixture: null, path: '', workers: [{ id: W(1) }, { id: W(2) }], expect: 'PASS', steps: SELF_STEPS, phases: SELF_PHASES, dispute: true });
      return;
    }
    if (DISPUTE) {
      const misleading = { fixture: 'misleading', path: 'fixtures/misleading', steps: MISLEADING_STEPS, expect: 'SLASHED', expectAudit: true };
      await runJobScenario({ ...misleading, key: 'caught', title: 'Reproduce the tinydur README (a false approval)', workers: [{ id: W(1) }, { id: W(3), lie: 'approve' }] });
      await runJobScenario({ ...misleading, key: 'appeal', title: 'Reproduce the tinydur README (the verifier sides with it)', workers: [{ id: W(2) }, { id: W(3), lie: 'approve' }], phases: APPEAL_PHASES, collude: true, appealBy: W(2) });
      return;
    }
    await runJobScenario({ key: 'honest', title: 'Reproduce the adder README (honest)', fixture: 'honest', path: 'fixtures/honest', workers: [{ id: W(1) }, { id: W(2) }], expect: 'PASS' });
    await runJobScenario({ key: 'broken', title: 'Reproduce the adder README (a broken step)', fixture: 'broken', path: 'fixtures/broken', workers: [{ id: W(1) }, { id: W(2) }], expect: 'FAIL' });
    await runJobScenario({ key: 'slashed', title: 'Reproduce the adder README (a worker lies)', fixture: 'honest', path: 'fixtures/honest', workers: [{ id: W(1) }, { id: W(3), lie: true }], expect: 'SLASHED', expectAudit: true });
  } finally {
    await ORIGIN.cleanup();
    if (SELF) await writeResults('self-check-results.json');
    if (DISPUTE) await writeResults('dispute-results.json');
  }
  await writeResults('e2e-results.json');
}

async function writeResults(file) {
  results.finished_at = new Date().toISOString();
  results.model_usage = usageSummary();
  results.burned_total = await view('total_burned');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), JSON.stringify(results, null, 2));
  log(`\n# RESULTS`);
  for (const j of results.jobs) log(`  job #${j.id} ${j.key}: ${j.outcome} (expected ${j.expect}) ${j.match ? 'OK' : 'MISMATCH'}`);
  log(`  model usage: ${JSON.stringify(results.model_usage)}`);
  log(`  total burned: ${toNear(results.burned_total)} NEAR`);
  log(`  written to ${join(stateDir, file)}`);
  if (!results.jobs.every((j) => j.match)) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
