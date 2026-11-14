import { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { Pill, Verdict, Tx, Acct } from './bits.jsx';
import { getJob } from './data.js';
import { fmtNear, toNear, shortHash, shortAcct, loadEvidence } from './chain.js';

function finalFor(job, stepIndex) {
  return job.final_verdicts ? job.final_verdicts[stepIndex] : null;
}

const contradicts = (a, b) => (a || []).some((v, i) => (v === 'Pass' && b?.[i] === 'Fail') || (v === 'Fail' && b?.[i] === 'Pass'));
const stepList = (xs) => xs.map((i) => i + 1).join(', ');

// The recorded run behind one verdict: shown only when the published transcript carries the same
// hash this account signed on chain.
function Observed({ evidence, jobId, account, hash, step }) {
  const t = evidence?.[jobId]?.[account];
  if (!t || t.hash !== hash) return null;
  const cmds = t.steps[step] || [];
  const last = cmds[cmds.length - 1];
  if (!last) return null;
  const lines = last.out.split('\n').filter((l) => l.trim());
  const tap = lines.filter((l) => /^# (pass|fail) /.test(l));
  const shown = tap.length ? tap.join(', ') : lines[lines.length - 1] || '(no output)';
  return (
    <span className="obs" title={`${last.cmd}\n${last.out}`}>
      ran <b>{last.cmd}</b>: exit {last.timed_out ? 'timeout' : last.exit}, <span className={last.exit === 0 ? '' : 'bad'}>{shown.slice(0, 90)}</span>
    </span>
  );
}

// A plain account of how a disputed job was settled, derived from the job's own fields.
function Settled({ job, evidence }) {
  const rounds = (job.rounds || []).filter((r) => r.ruling);
  if (!rounds.length || !job.final_verdicts) return null;
  const reports = job.claims.filter((c) => c.revealed);
  // The demo's note on who was scripted, shown only when the bundled evidence is this job's own.
  const mine = evidence?.[job.id];
  const scripted = mine && reports.some((c) => mine[c.worker]?.hash === c.transcript_hash) ? mine._scripted : null;
  const split = job.steps.map((_, i) => i).filter((i) => new Set(reports.map((c) => c.verdicts?.[i])).size > 1);
  const last = rounds[rounds.length - 1];
  const lines = [];
  if (split.length) lines.push(<>The workers disagreed on step {stepList(split)}: {reports.map((c) => `${shortAcct(c.worker)} said ${split.map((i) => c.verdicts[i]).join(', ')}`).join('; ')}.</>);
  for (const r of rounds) {
    const overruled = r !== last && contradicts(r.ruling, last.ruling);
    lines.push(
      <>
        {r.reason === 'challenge' ? <>{shortAcct(r.challenger)} {r.round === 2 ? 'appealed' : 'disputed the result'}, locking a challenge bond. </> : null}
        Verifier {shortAcct(r.verifier)}, drawn at random, reran the steps and ruled {r.ruling.join(', ')}
        {overruled ? <>. <b className="bad">Round {last.round} overruled it</b></> : null}.
      </>,
    );
  }
  for (const b of job.burns || []) {
    const c = reports.find((x) => x.worker === b.account);
    const wrong = c ? job.steps.map((_, i) => i).filter((i) => contradicts([c.verdicts[i]], [job.final_verdicts[i]])) : [];
    lines.push(
      <b className="bad">
        {shortAcct(b.account)} lost {fmtNear(toNear(b.amount), 2)}, burned:{' '}
        {b.kind === 'overruled' ? 'its ruling was overruled, and it is out of the verifier pool' : b.kind === 'slash' ? `it reported ${wrong.map((i) => c.verdicts[i]).join(', ')} on step ${stepList(wrong)}, and the settled result is ${wrong.map((i) => job.final_verdicts[i]).join(', ')}` : 'it did not show up'}.
      </b>,
    );
  }
  return (
    <div className="panel settled">
      <h3>How this was settled</h3>
      <ol>{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
      {scripted?.length > 0 && <p className="scripted"><b>Scripted for this demo.</b> {scripted.join(' ')}</p>}
    </div>
  );
}

export default function JobPage({ id, market, onBack }) {
  const [job, setJob] = useState(null);
  const [err, setErr] = useState(null);
  const [evidence, setEvidence] = useState(null);
  useEffect(() => {
    let live = true;
    getJob(id, market).then((r) => { if (live) setJob(r.job || null); }).catch((e) => live && setErr(e.message));
    loadEvidence().then((e) => live && setEvidence(e));
    return () => { live = false; };
  }, [id, market]);

  if (err) return <div className="wrap"><div className="empty">Could not load job #{id}: {err}</div></div>;
  if (!job) return <div className="wrap"><div className="loading">Loading job #{id}...</div></div>;

  const reports = job.claims.filter((c) => c.revealed);
  const rounds = job.rounds || [];

  return (
    <div className="wrap">
      <div className="back" onClick={onBack}>&larr; all jobs</div>
      <div className="detail-head">
        <div className="left">
          <Pill phase={job.phase} />
          <h1>{job.title}</h1>
          <div className="repo">
            <a href={job.repo} target="_blank" rel="noreferrer">{job.repo.replace(/^https?:\/\//, '')}</a>
            {job.path ? `/${job.path}` : ''} @ {job.commit.slice(0, 10)}
          </div>
          <div className="kv">
            <span className="k">bounty</span><span className="v">{fmtNear(toNear(job.bounty), 4)}</span>
            <span className="k">per-claim bond</span><span className="v">{fmtNear(toNear(job.bond), 4)}</span>
            <span className="k">poster</span><span className="v"><Acct id={job.poster} /></span>
            <span className="k">workers</span><span className="v">{job.claims.length} / {job.slots}</span>
            {job.final_verdicts && (<><span className="k">final verdicts</span><span className="v">{job.final_verdicts.map((v, i) => <Verdict key={i} v={v} />).reduce((a, b) => [a, ' ', b])}</span></>)}
          </div>
        </div>
        <Seal job={job} />
      </div>

      <Settled job={job} evidence={evidence} />

      <div className="steps">
        {job.steps.map((s, i) => (
          <div className="step" key={i}>
            <div className="sh">
              <span className="n">STEP {i + 1}</span>
              <span className="do">{s.do}</span>
              <div className="spacer" />
              {finalFor(job, i) && <Verdict v={finalFor(job, i)} />}
            </div>
            <div className="sbody">
              <div className="see">expect: <b>{s.see}</b></div>
              <div className="reports">
                {reports.map((c, ci) => (
                  <div className="rep" key={ci}>
                    <span className="who"><Acct id={c.worker} /></span>
                    <Verdict v={c.verdicts?.[i]} />
                    <Observed evidence={evidence} jobId={job.id} account={c.worker} hash={c.transcript_hash} step={i} />
                  </div>
                ))}
                {rounds.filter((r) => r.ruling).map((r, ri) => (
                  <div className="rep" key={`r${ri}`}>
                    <span className="who">verifier r{r.round}</span>
                    <Verdict v={r.ruling[i]} />
                    <Observed evidence={evidence} jobId={job.id} account={r.verifier} hash={r.transcript_hash} step={i} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>Reports and transcripts</h3>
        <div className="txlist">
          {reports.map((c, i) => (
            <div className="txrow" key={i}>
              <span className="lbl"><Acct id={c.worker} /></span>
              <span className="dim">{c.status}</span>
              <div style={{ flex: 1 }} />
              <span className="faint">transcript {shortHash(c.transcript_hash, 8)}</span>
              <span>· earned {fmtNear(toNear(c.earned))}</span>
            </div>
          ))}
          {!reports.length && <div className="faint mono">no reports revealed</div>}
        </div>
      </div>

      {rounds.length > 0 && (
        <div className="panel">
          <h3>Audit</h3>
          <div className="txlist">
            {rounds.map((r, i) => (
              <div className="txrow" key={i}>
                <span className="lbl">round {r.round} · {r.reason}</span>
                <span className="dim">{r.outcome}{r.ruling && contradicts(r.ruling, job.final_verdicts) ? ', overruled' : ''}</span>
                <div style={{ flex: 1 }} />
                {r.verifier && <span className="faint">verifier <Acct id={r.verifier} /></span>}
                {r.ruling && <span>ruled {r.ruling.map((v, k) => <Verdict key={k} v={v} />).reduce((a, b) => [a, ' ', b])}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(job.payouts?.length > 0 || job.burns?.length > 0) && (
        <div className="panel">
          <h3>Settlement</h3>
          <div className="txlist">
            {job.payouts.map((p, i) => (
              <div className="txrow payrow" key={`p${i}`}>
                <span className="lbl"><Acct id={p.account} /></span>
                <span>+{fmtNear(toNear(p.amount), 4)}</span>
                <div style={{ flex: 1 }} />
                <span className="faint">{p.kind}</span>
              </div>
            ))}
            {job.burns.map((b, i) => (
              <div className="txrow burnrow" key={`b${i}`}>
                <span className="lbl"><Acct id={b.account} /></span>
                <span>-{fmtNear(toNear(b.amount), 4)} burned</span>
                <div style={{ flex: 1 }} />
                <span className="faint">{b.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
