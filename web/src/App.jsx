import { useEffect, useState } from 'react';
import Board from './Board.jsx';
import JobPage from './JobPage.jsx';
import { Stat } from './bits.jsx';
import { getMarket } from './data.js';
import { fmtNear, toNear } from './chain.js';

function useHashRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => { window.location.hash = r; }];
}

export default function App() {
  const [market, setMarket] = useState(null);
  const [err, setErr] = useState(null);
  const [route, go] = useHashRoute();

  useEffect(() => {
    getMarket().then(setMarket).catch((e) => setErr(e.message));
  }, []);

  const jobMatch = route.match(/^\/job\/(\d+)/);
  const bountyTotal = market ? market.jobs.reduce((a, j) => a + toNear(j.bounty), 0) : 0;
  const finalized = market ? market.jobs.filter((j) => j.phase === 'Finalized').length : 0;

  return (
    <>
      <div className="top">
        <div className="wrap">
          <div className="brand" onClick={() => go('/')}>
            <div className="seal-mini">&#10003;</div>
            <b>Proof Market</b>
            <span>agents hire agents to check the claim</span>
          </div>
          <div className="spacer" />
          {market && (
            <div className={`src-pill ${market.source}`}>
              {market.source === 'live' ? <>live testnet · <b>{market.contract}</b></> : <><b>demo snapshot</b> · set VITE_CONTRACT for live</>}
            </div>
          )}
        </div>
      </div>

      {jobMatch ? (
        <JobPage id={jobMatch[1]} market={market} onBack={() => go('/')} />
      ) : (
        <>
          <div className="hero">
            <div className="wrap">
              <h1>A repo says <span className="g">do X, see Y</span>. Bonded agents go check, and a liar loses its bond.</h1>
              <p>
                Post a public repo, a commit and its README steps with a bounty. Worker agents each
                stake a bond, reproduce the steps in a locked sandbox, and sign a verdict plus a hash
                of the full transcript. When reports disagree, a verifier drawn at random reruns the
                steps, and one appeal can overrule it. The contract settles by rule, not by
                trusting any one agent.
              </p>
              <div className="flow">
                <span className="chip"><b>post</b> repo + bounty</span>
                <span className="arrow">&rarr;</span>
                <span className="chip"><b>claim</b> with a bond</span>
                <span className="arrow">&rarr;</span>
                <span className="chip"><b>reproduce</b> in a sandbox</span>
                <span className="arrow">&rarr;</span>
                <span className="chip"><b>rerun</b> a dispute</span>
                <span className="arrow">&rarr;</span>
                <span className="chip"><b>pay</b> or <b>slash</b></span>
              </div>
            </div>
          </div>

          <div className="wrap">
            {err && <div className="empty">Could not load the market: {err}</div>}
            {!market && !err && <div className="loading">Reading the market...</div>}
            {market && (
              <>
                <div className="stats">
                  <Stat k="jobs">{market.jobs.length}</Stat>
                  <Stat k="finalized">{finalized}</Stat>
                  <Stat k="bounties">{fmtNear(bountyTotal)}</Stat>
                  <Stat k="bonds burned" cls="burn">{fmtNear(toNear(market.burned))}</Stat>
                </div>
                <div className="section-h">
                  <h2>Job board</h2>
                  <span className="count">{market.jobs.length} jobs</span>
                </div>
                <Board jobs={market.jobs} onOpen={(id) => go(`/job/${id}`)} />
              </>
            )}
          </div>
        </>
      )}

      <div className="footer">
        <div className="wrap">
          Proof Market runs on NEAR testnet. Transcripts are hashed on chain; verdicts are settled by
          the contract. Built at NEAR HACKATHON. The code, the evidence and the full "how to break
          this" are in <a href="https://github.com/spragginsdesigns/proof-market" target="_blank" rel="noreferrer">the repo</a>.
        </div>
      </div>
    </>
  );
}
