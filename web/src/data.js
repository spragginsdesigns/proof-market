// One data source for the UI. It reads live testnet when a contract is configured and reachable,
// and otherwise falls back to the bundled snapshot, so the app always shows a real finished run.
import { view, loadSnapshot, CONTRACT } from './chain.js';

export async function getMarket() {
  if (CONTRACT) {
    try {
      const [config, jobs, burned] = await Promise.all([
        view('get_config'),
        view('list_jobs', { from_index: 0, limit: 50 }),
        view('total_burned').catch(() => '0'),
      ]);
      return { source: 'live', contract: CONTRACT, config, jobs: jobs || [], burned };
    } catch (e) {
      // fall through to snapshot
    }
  }
  const snap = await loadSnapshot();
  return { source: 'snapshot', contract: snap.contract || CONTRACT || '', config: snap.config, jobs: snap.jobs || [], burned: snap.burned || '0', snapshot: snap };
}

export async function getJob(id, market) {
  if (market?.source === 'live') {
    try {
      return { source: 'live', job: await view('get_job', { job_id: Number(id) }) };
    } catch (e) {
      /* fall through */
    }
  }
  const snap = market?.snapshot || (await loadSnapshot());
  const job = (snap.fullJobs || []).find((j) => Number(j.job_id ?? j.id) === Number(id));
  return { source: 'snapshot', job };
}
