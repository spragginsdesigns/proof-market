import { EXPLORER_TX, EXPLORER_ACCOUNT, shortHash, shortAcct } from './chain.js';

export function Pill({ phase }) {
  const p = String(phase || 'open').toLowerCase();
  const label = { finalized: 'finalized', auditing: 'auditing', open: 'open', committing: 'committing', revealing: 'revealing', reported: 'reported', expired: 'expired' }[p] || p;
  return <span className={`pill ${p}`}>{label}</span>;
}

export function Verdict({ v }) {
  return <span className={`vt ${v}`}>{v}</span>;
}

export function Tx({ hash, children }) {
  if (!hash) return <span className="faint">pending</span>;
  return <a href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noreferrer">{children || shortHash(hash)}</a>;
}

export function Acct({ id }) {
  if (!id) return null;
  return <a href={`${EXPLORER_ACCOUNT}${id}`} target="_blank" rel="noreferrer" title={id}>{shortAcct(id)}</a>;
}

export function Stat({ k, children, cls = '' }) {
  return (
    <div className={`stat ${cls}`}>
      <div className="k">{k}</div>
      <div className="v">{children}</div>
    </div>
  );
}
