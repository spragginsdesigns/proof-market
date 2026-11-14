// A one-command simulation with no AI and no chain. It plays many two-worker jobs and applies the
// contract's settlement rule, re-implemented here in JavaScript. One worker reports the truth in
// every job. The other lies in a share of its jobs and reports the truth in the rest, and the two
// accounts are counted separately. Its assumptions are printed with the result: the verifier is
// honest, every disagreement is audited, and a lie flips every step. It does not model two workers
// who agree on a lie. The contract tests check the same rule on the real wasm.
//
//   node scripts/sim.mjs [jobs] [lieProb]

const JOBS = Number(process.argv[2] || 2000);
const LIE_PROB = Number(process.argv[3] || 0.5);
const BOUNTY = 1.0;        // per job
const BOND = 0.2;          // per claim
const FEE_BPS = 1000;      // 10% verifier fee when audited
const SLOTS = 2;

// A step's truth is Pass or Fail. The honest worker reports the truth; a liar flips it.
function randomSteps(n) {
  return Array.from({ length: n }, () => (Math.random() < 0.7 ? 'Pass' : 'Fail'));
}
function contradicts(a, b) {
  return a.some((v, i) => (v === 'Pass' && b[i] === 'Fail') || (v === 'Fail' && b[i] === 'Pass'));
}

// Settle one job the way the contract does, for the case of SLOTS workers and, if they disagree, one
// honest verifier whose ruling is the truth. Returns per-account deltas (earnings minus bonds minus
// burns) and the amount burned.
function settleJob(truth, reports, audited) {
  const n = truth.length;
  const final = audited ? truth.slice() : (() => {
    // unanimous per step, else Unverifiable
    return truth.map((_, i) => {
      const set = new Set(reports.map((r) => r.verdicts[i]));
      return set.size === 1 ? [...set][0] : 'Unverifiable';
    });
  })();
  const deltas = {};
  const add = (k, v) => { deltas[k] = (deltas[k] || 0) + v; };
  let burned = 0;
  let feePaid = 0;
  if (audited) { feePaid = (BOUNTY * FEE_BPS) / 10000; add('verifier', feePaid); }
  const nonSlashed = [];
  for (const r of reports) {
    if (contradicts(r.verdicts, final)) { burned += BOND; add(r.id, -BOND); /* bond burned */ } else { nonSlashed.push(r); /* bond returned, net 0 from bond */ }
  }
  const pool = BOUNTY - feePaid;
  for (let i = 0; i < n; i++) {
    const share = i === n - 1 ? pool - Math.floor((pool / n) * (n - 1) * 1e9) / 1e9 : Math.floor((pool / n) * 1e9) / 1e9;
    const matchers = nonSlashed.filter((r) => r.verdicts[i] === final[i]);
    if (matchers.length) for (const r of matchers) add(r.id, share / matchers.length);
    // steps with no matcher: the share returns to the poster (not modeled as profit)
  }
  return { deltas, burned, final };
}

const net = { steady: 0, mixedHonest: 0, mixedLying: 0 };
let burnedTotal = 0;
let lies = 0;
let liesCaught = 0;

for (let k = 0; k < JOBS; k++) {
  const truth = randomSteps(1 + Math.floor(Math.random() * 3));
  const steady = { id: 'steady', verdicts: truth.slice() };
  const lying = Math.random() < LIE_PROB;
  const mixed = { id: 'mixed', verdicts: lying ? truth.map((v) => (v === 'Pass' ? 'Fail' : 'Pass')) : truth.slice() };
  if (lying) lies++;
  const audited = lying; // a disagreement always triggers an audit
  const { deltas, burned } = settleJob(truth, [steady, mixed], audited);
  burnedTotal += burned;
  net.steady += deltas.steady || 0;
  if (lying) { net.mixedLying += deltas.mixed || 0; if ((deltas.mixed || 0) <= -BOND + 1e-9) liesCaught++; }
  else net.mixedHonest += deltas.mixed || 0;
}
const mixedNet = net.mixedHonest + net.mixedLying;
// The share of lying jobs at which the second worker's honest earnings no longer cover its burned
// bonds: an honest job pays it half the bounty, a lie costs the bond.
const breakEven = (BOUNTY / SLOTS) / (BOUNTY / SLOTS + BOND);

console.log(`Proof Market simulation: ${JOBS} jobs, two workers each; the second worker lies in a share ${LIE_PROB} of its jobs\n`);
console.log(`  always-honest worker net:  ${net.steady.toFixed(2)} NEAR`);
console.log(`  sometimes-lying worker net: ${mixedNet.toFixed(2)} NEAR  (its honest jobs ${net.mixedHonest.toFixed(2)}, its lying jobs ${net.mixedLying.toFixed(2)})`);
console.log(`  lies: ${lies}, caught and slashed: ${liesCaught}  (each cost its ${BOND.toFixed(2)} NEAR bond and earned nothing)`);
console.log(`  bonds burned:              ${burnedTotal.toFixed(2)} NEAR  (slashed funds, nobody can withdraw them)`);
console.log(`\n  assumes: an honest verifier, every disagreement audited, a lie flips every step; two workers who agree on a lie are not modeled.`);
console.log(`  result: under these assumptions every lie is caught and costs its bond, and the worker that lies ends with less than the one that does not.`);
console.log(`  not shown: that lying loses money overall. With the bond at ${(BOND / BOUNTY * 100).toFixed(0)}% of the bounty, a worker stays above zero unless it lies in more than about ${(breakEven * 100).toFixed(0)}% of its jobs.`);
if (net.mixedLying >= 0 || liesCaught !== lies || (lies > 0 && mixedNet >= net.steady)) { console.error('\nUNEXPECTED: a lie went unpunished, or lying did not earn less than honesty'); process.exit(1); }
