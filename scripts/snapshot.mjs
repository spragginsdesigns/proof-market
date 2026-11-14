// Export live testnet market state to web/public/data/snapshot.json, so the local demo and the
// offline fallback show the real finished run. Reads list_jobs and get_job over public RPC.
// It also writes web/public/data/evidence.json from the published transcripts in
// docs/evidence/transcripts/: per job and account, the commands each step ran, their exit codes and
// the tail of their output, so the job page can show what was observed next to each verdict, and,
// from the run logs, which parties were scripted to misreport in a demo job.
//   PM_CONTRACT=yourname.testnet node scripts/snapshot.mjs
import { view, CONTRACT } from '../lib/chain.mjs';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = new URL('../web/public/data/snapshot.json', import.meta.url).pathname;
const evidenceOut = new URL('../web/public/data/evidence.json', import.meta.url).pathname;
const transcriptsDir = new URL('../docs/evidence/transcripts/', import.meta.url).pathname;

// The last lines of a command's output, capped so the bundle stays small.
const tail = (text, lines = 8, chars = 600) => String(text || '').trimEnd().split('\n').slice(-lines).join('\n').slice(-chars);
const evidence = {};
for (const f of readdirSync(transcriptsDir).filter((x) => x.endsWith('.json')).sort()) {
  const [, job, account] = f.match(/^job-(\d+)-(.+)\.json$/) || [];
  if (job === undefined) continue;
  const t = JSON.parse(readFileSync(join(transcriptsDir, f), 'utf8'));
  (evidence[job] ||= {})[account] = {
    hash: t.hash,
    steps: t.steps.map((st) => st.commands.map((c) => ({ cmd: c.argv.join(' '), exit: c.exit_code, timed_out: !!c.timed_out, out: tail(`${c.stdout || ''}${c.stderr || ''}`) }))),
  };
}
// Which parties were scripted to misreport, from the run logs, so the job page can say so.
const log = (f) => JSON.parse(readFileSync(new URL(`../docs/evidence/${f}`, import.meta.url), 'utf8'));
const short = (id) => id.split('.')[0];
for (const j of log('e2e-results.json').jobs) {
  if (evidence[j.id] && j.slashed.length) evidence[j.id]._scripted = j.slashed.map((w) => `${short(w)} ran the steps, then signed the opposite of what it found.`);
}
for (const j of log('dispute-results.json').jobs) {
  if (!evidence[j.id]) continue;
  const appeal = j.rounds.find((r) => r.reason === 'challenge');
  evidence[j.id]._scripted = [
    ...j.scripted.map((x) => (/round 1/.test(x.script)
      ? `${short(x.account)}, the verifier drawn for round 1, reran the steps, then ruled Pass on every step.`
      : `${short(x.account)} ran the steps, then signed Pass on every step.`)),
    ...(appeal ? [`The run script filed ${short(appeal.challenger)}'s appeal as soon as that ruling landed.`] : []),
  ];
}
writeFileSync(evidenceOut, JSON.stringify(evidence, null, 1));
console.log(`evidence: ${Object.values(evidence).reduce((n, j) => n + Object.keys(j).filter((k) => !k.startsWith('_')).length, 0)} transcripts over ${Object.keys(evidence).length} jobs -> ${evidenceOut}`);

const [config, jobs, burned] = await Promise.all([
  view('get_config'),
  view('list_jobs', { from_index: 0, limit: 50 }),
  view('total_burned').catch(() => '0'),
]);
const fullJobs = [];
for (const j of jobs) fullJobs.push(await view('get_job', { job_id: j.id }));

const snap = { contract: CONTRACT, captured_at: new Date().toISOString(), config, burned, jobs, fullJobs };
writeFileSync(out, JSON.stringify(snap, null, 2));
console.log(`snapshot: ${jobs.length} jobs, ${fullJobs.length} full, burned ${burned}, -> ${out}`);
