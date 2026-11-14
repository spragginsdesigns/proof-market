// Testnet helpers that drive the Proof Market contract: fund and register agents, post a job, and
// run one worker or verifier through the sandbox and onto the chain. The worker and verifier agents
// sign with their FUNCTION-CALL ONLY keys (loaded from state/fckeys); the poster and the operator
// use their full-access keys. Nothing here prints a key.
import { account, call, view, near, toNear, CONTRACT, EXPLORER } from '../lib/chain.mjs';
import { workJob } from '../agents/worker.mjs';
import { buildReport } from '../agents/report.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const stateDir = process.env.PM_STATE || new URL('../state/', import.meta.url).pathname;
const fcDir = join(stateDir, 'fckeys');

// An account acting with its function-call-only agent key.
export function agent(id) {
  return account(id, fcDir);
}
// An account acting with its full-access key (operator, poster).
export function owner(id) {
  return account(id);
}

export async function fund(operatorId, accountId, amountNear) {
  const r = await call(owner(operatorId), 'deposit', { account_id: accountId }, { deposit: near(amountNear), gasTgas: 30 });
  return r;
}

export async function registerWorker(id, label, model) {
  return call(agent(id), 'register_worker', { label, model }, { gasTgas: 40 });
}
export async function registerVerifier(id, label, model) {
  return call(agent(id), 'register_verifier', { label, model }, { gasTgas: 40 });
}

export async function postJob(posterId, job) {
  const args = {
    title: job.title, repo: job.repo, commit: job.commit, path: job.path || '',
    steps: job.steps.map((s) => ({ do: s.do, see: s.see })),
    slots: job.slots, bond: near(job.bond).toString(), bounty: near(job.bounty).toString(),
    claim_ms: job.claim_ms, run_ms: job.run_ms, reveal_ms: job.reveal_ms, window_ms: job.window_ms,
  };
  const r = await call(owner(posterId), 'post_job', args, { deposit: near(job.bounty), gasTgas: 60 });
  return r;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reproduce a job in the sandbox through the shared fixture origin (or a public repo if no origin).
async function reproduce(actorId, job, { model, origin, onEvent }) {
  const tag = randomUUID().slice(0, 8);
  // The actual fetch source: the job's explicit cloneUrl (a local mirror for the pre-public demo),
  // else the canonical public repo. Either way job.repo + job.commit are what the hash records.
  const cloneUrl = job.cloneUrl || job.repo;
  let jobNet;
  return workJob(job, {
    contractId: CONTRACT, workerId: actorId, model, tag, cloneUrl,
    transcriptsDir: join(stateDir, 'transcripts'),
    noProxyHosts: origin ? [origin.host] : [],
    beforeRun: origin ? async (net) => { jobNet = net; await origin.attach(net); } : null,
    afterRun: origin ? async () => { if (jobNet) await origin.detach(jobNet); } : null,
    onEvent: (e) => onEvent({ ...e, actor: actorId }),
  });
}

// A scripted dishonest report, for the demo jobs. `true` flips every verdict (Pass<->Fail);
// 'approve' reports Pass on every step, the rubber stamp of an agent that wants the bounty without
// reading its own run.
export function scriptedVerdicts(verdicts, lie) {
  if (lie === 'approve') return verdicts.map(() => 'Pass');
  return verdicts.map((v) => (v === 'Pass' ? 'Fail' : v === 'Fail' ? 'Pass' : v));
}

// Phase 1 for a worker: claim, reproduce in the sandbox, judge, and commit the report hash on chain.
// `lie` changes the REPORTED verdicts (see scriptedVerdicts); the transcript it ran is still honest,
// so the verifier catches the mismatch. Returns the report so the caller can reveal it after every
// worker has committed (reveal is rejected until all claimants have committed).
export async function claimAndCommit(workerId, job, { model, origin, lie = false, onEvent = () => {} }) {
  const jobId = job.jobId;
  const claimed = await call(agent(workerId), 'claim', { job_id: jobId }, { gasTgas: 60 });
  onEvent({ kind: 'claim', worker: workerId, ok: claimed.ok, tx: claimed.hash, error: claimed.error });
  if (!claimed.ok) return { ok: false, claimed, error: claimed.error };

  const r = await reproduce(workerId, job, { model, origin, onEvent });
  let verdicts = r.report.verdicts;
  if (lie) verdicts = scriptedVerdicts(verdicts, lie);
  const report = lie
    ? buildReport({ contractId: CONTRACT, jobId, workerId, verdicts, transcriptHash: r.transcript.hash, transcriptUri: r.report.transcriptUri })
    : r.report;

  const committed = await call(agent(workerId), 'commit', { job_id: jobId, hash: report.hash }, { gasTgas: 60 });
  onEvent({ kind: 'commit', worker: workerId, ok: committed.ok, tx: committed.hash, hash: report.hash, verdicts, lie });
  return { ok: committed.ok, workerId, report, verdicts, transcript: r.transcript, usd: r.usd, error: committed.error };
}

// Phase 2: reveal a committed report (call only after every claimant has committed).
export async function revealReport(workerId, jobId, report, verdicts, { onEvent = () => {} } = {}) {
  const revealed = await call(agent(workerId), 'reveal', {
    job_id: jobId, verdicts, transcript_hash: report.transcriptHash, transcript_uri: report.transcriptUri, salt: report.salt,
  }, { gasTgas: 80 });
  onEvent({ kind: 'reveal', worker: workerId, ok: revealed.ok, tx: revealed.hash, verdicts, error: revealed.error });
  return revealed;
}

// The verifier rerun: reproduce the job honestly and submit a ruling as the drawn verifier.
// `collude` scripts a dishonest verifier for the appeal demo: it reruns the job, then rules Pass on
// every step to side with a rubber-stamping worker. Its transcript is still the honest rerun.
export async function verifyJob(verifierId, job, { model, origin, collude = false, onEvent = () => {} }) {
  const jobId = job.jobId;
  const r = await reproduce(verifierId, job, { model, origin, onEvent });
  const verdicts = collude ? scriptedVerdicts(r.report.verdicts, 'approve') : r.report.verdicts;
  const ruled = await call(agent(verifierId), 'verify', {
    job_id: jobId, verdicts, transcript_hash: r.transcript.hash, transcript_uri: r.report.transcriptUri,
  }, { gasTgas: 80 });
  onEvent({ kind: 'verify', verifier: verifierId, ok: ruled.ok, tx: ruled.hash, verdicts, collude, error: ruled.error });
  return { ruled, verdicts, usd: r.usd };
}

export async function advance(byId, jobId) {
  return call(owner(byId), 'advance', { job_id: jobId }, { gasTgas: 80 });
}
export async function finalize(byId, jobId) {
  return call(owner(byId), 'finalize', { job_id: jobId }, { gasTgas: 120 });
}
export async function getJob(jobId) {
  return view('get_job', { job_id: jobId });
}
