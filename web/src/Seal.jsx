// The hero object: a stamped seal on a finished job. Green VERIFIED when the final verdicts are all
// Pass, red FAILED when any step is Fail, amber OPEN while the case is still being decided.
export default function Seal({ job }) {
  const phase = String(job?.phase || '').toLowerCase();
  const fv = job?.final_verdicts || null;
  let kind = 'open';
  let big = 'OPEN';
  let sub = phase || 'in progress';
  if (phase === 'finalized' && fv) {
    const anyFail = fv.includes('Fail');
    kind = anyFail ? 'fail' : 'pass';
    big = anyFail ? 'FAILED' : 'VERIFIED';
    sub = `job #${job.job_id ?? job.id}`;
  } else if (phase === 'expired') {
    kind = 'open';
    big = 'EXPIRED';
    sub = 'no report';
  }
  return (
    <div className="seal-wrap">
      <div className={`seal ${kind}`}>
        <div className="ring" />
        <div>
          <div className="big">{big}</div>
          <div className="sub">{sub}</div>
        </div>
      </div>
    </div>
  );
}
