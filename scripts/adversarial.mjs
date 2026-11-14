// An adversarial pass on live testnet: every attack is attempted as a real transaction and must be
// rejected by the contract. The contract integration tests already assert each panic against the
// real wasm; this repeats the key ones on the deployed contract, with tx hashes, and separately
// shows a worker's function-call-only key cannot call another contract or attach a deposit.
//   PM_CONTRACT=yourname.testnet node scripts/adversarial.mjs
import { account, call, view, near, CONTRACT, EXPLORER, provider } from '../lib/chain.mjs';
import { postJob } from './market.mjs';
import { join } from 'node:path';
import { actions } from 'near-api-js';

const C = CONTRACT;
const fcDir = (process.env.PM_STATE || new URL('../state/', import.meta.url).pathname) + 'fckeys';
const agent = (id) => account(id, fcDir);
const owner = (id) => account(id);
const results = [];
function rec(name, r, expectFail = true) {
  const failed = !r.ok;
  const pass = expectFail ? failed : r.ok;
  const panic = (r.error || '').match(/Smart contract panicked: ([^"]+)/)?.[1] || (r.error || '').slice(0, 90);
  results.push({ name, pass, tx: r.hash, detail: panic });
  console.log(`  [${pass ? 'OK ' : 'XX '}] ${name}: ${failed ? 'rejected' : 'ACCEPTED'}${panic ? ' -> ' + panic : ''}`);
}

// A fresh job to attack (short claim window so "claim after claim_until" is quick).
const PHASES = { slots: 1, bond: 0.02, bounty: 0.05, claim_ms: 6000, run_ms: 60000, reveal_ms: 60000, window_ms: 6000 };
const STEPS = [{ do: 'node add.mjs 2 3', see: 'the output is 5' }];
const GH = 'https://github.com/spragginsdesigns/proof-market';

console.log(`# adversarial pass on ${C}`);
const posted = await postJob(`poster.${C}`, { title: 'adversarial target', repo: GH, commit: '5cd8635', path: 'fixtures/honest', steps: STEPS, ...PHASES });
const jobId = posted.value;
console.log(`  target job #${jobId}: ${EXPLORER}${posted.hash}`);

// 1. claim a nonexistent job
rec('claim a nonexistent job', await call(agent(`w1.${C}`), 'claim', { job_id: 9999 }, { gasTgas: 50 }));
// 2. poster claims its own job
rec('poster claims its own job', await call(owner(`poster.${C}`), 'claim', { job_id: jobId }, { gasTgas: 50 }));
// 3. a verifier that was not drawn calls verify
rec('verify by a verifier that was not drawn', await call(agent(`v2.${C}`), 'verify', { job_id: jobId, verdicts: ['Pass'], transcript_hash: 'a'.repeat(64), transcript_uri: 'x' }, { gasTgas: 60 }));
// 4. reveal without having committed
rec('reveal without a commit', await call(agent(`w2.${C}`), 'reveal', { job_id: jobId, verdicts: ['Pass'], transcript_hash: 'a'.repeat(64), transcript_uri: 'x', salt: 'abcdabcdabcdabcd' }, { gasTgas: 60 }));
// 5. challenge by a stranger (not poster, not a claimant)
rec('challenge by a stranger', await call(agent(`w3.${C}`), 'challenge', { job_id: jobId }, { gasTgas: 60 }));
// 6. finalize before anything is reported
rec('finalize before the job is reported', await call(agent(`w1.${C}`), 'finalize', { job_id: jobId }, { gasTgas: 80 }));
// 7. claim after the claim window (wait it out)
await new Promise((r) => setTimeout(r, 7000));
rec('claim after the claim window closed', await call(agent(`w2.${C}`), 'claim', { job_id: jobId }, { gasTgas: 50 }));
// 8. withdraw more than the free balance
rec('withdraw more than free', await call(agent(`w1.${C}`), 'withdraw', { amount: near(1000).toString() }, { gasTgas: 50 }));

// 9/10. the function-call-only key: it cannot call another contract, nor attach a deposit. Signed
// with ONLY that key over raw JSON-RPC (the near-api wrapper hides the node's access-key error).
import { readFileSync } from 'node:fs';
import { KeyPair, KeyPairSigner } from 'near-api-js';
const w1key = JSON.parse(readFileSync(join(fcDir, `w1.${C}.json`), 'utf8'));
const signer = KeyPairSigner.fromSecretKey(w1key.private_key);
async function rawSigned(receiver, method, args, deposit) {
  const acc = new (await import('near-api-js')).Account(`w1.${C}`, provider, signer);
  try {
    const res = await acc.signAndSendTransaction({ receiverId: receiver, actions: [actions.functionCall(method, args, 30n * 10n ** 12n, BigInt(deposit))], waitUntil: 'EXECUTED_OPTIMISTIC' });
    return { ok: true, hash: res?.transaction?.hash };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
rec('fc key calls another contract (test.near)', await rawSigned('test.testnet', 'anything', {}, 0));
rec('fc key attaches a deposit to the market', await rawSigned(C, 'claim', { job_id: jobId }, near(0.1).toString()));

const passed = results.filter((r) => r.pass).length;
console.log(`\n# ${passed}/${results.length} attacks correctly rejected`);
import { writeFileSync } from 'node:fs';
writeFileSync((process.env.PM_STATE || new URL('../state/', import.meta.url).pathname) + 'adversarial-results.json', JSON.stringify({ contract: C, jobId, results }, null, 2));
if (passed !== results.length) process.exit(1);
