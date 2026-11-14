import { Pill } from './bits.jsx';
import { fmtNear, toNear } from './chain.js';

function verdictSummary(fv, slashed) {
  if (!fv) return null;
  const pass = fv.filter((v) => v === 'Pass').length;
  const fail = fv.filter((v) => v === 'Fail').length;
  return (
    <span className="mono" style={{ fontSize: 12 }}>
      <b style={{ color: 'var(--pass)' }}>{pass}P</b>{' '}
      {fail > 0 && <b style={{ color: 'var(--fail)' }}>{fail}F</b>}{' '}
      {slashed > 0 && <b style={{ color: 'var(--fail)' }}>· {slashed} slashed</b>}
    </span>
  );
}

export default function Board({ jobs, onOpen }) {
  if (!jobs.length) return <div className="empty">No jobs posted yet.</div>;
  return (
    <div className="board">
      {jobs.map((j) => (
        <div className="card" key={j.id} onClick={() => onOpen(j.id)}>
          <div className="row1">
            <span className="jid">JOB #{j.id}</span>
            <div style={{ flex: 1 }} />
            <Pill phase={j.phase} />
          </div>
          <h3>{j.title}</h3>
          <div className="repo">{j.repo.replace(/^https?:\/\//, '')}{j.path ? `/${j.path}` : ''} @ {j.commit.slice(0, 7)}</div>
          <div className="meta">
            <span><b>{fmtNear(toNear(j.bounty))}</b> bounty</span>
            <span><b>{j.claims_count}</b>/{j.slots} workers</span>
            <span><b>{j.steps_count}</b> steps</span>
            {verdictSummary(j.final_verdicts, j.slashed_count)}
          </div>
        </div>
      ))}
    </div>
  );
}
