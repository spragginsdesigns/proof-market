// Deploy the built wasm to the contract account and initialize it with a config. Idempotent-ish:
// deploy replaces the code; `new` only runs once (a second init panics, which we report and ignore).
//   PM_CONTRACT=yourname.testnet node scripts/deploy.mjs
import { account, call, view, near, CONTRACT, EXPLORER } from '../lib/chain.mjs';
import { readFileSync } from 'node:fs';
import { actions } from 'near-api-js';

const WASM = process.env.PM_WASM || new URL('../contract/target/near/proof_market.wasm', import.meta.url).pathname;

// Small testnet-friendly config. Phases are short so a demo runs in minutes; bonds are small.
export const CONFIG = {
  min_worker_bond: near(0.05).toString(),
  verifier_bond: near(0.05).toString(),
  challenge_bond: near(0.05).toString(),
  audit_bps: 0,          // unanimous jobs are not randomly audited in the live demo (deterministic outcomes)
  audit_fee_bps: 1000,   // 10% of the bounty to the round-1 verifier
  max_steps: 12,
  max_slots: 5,
  min_phase_ms: 5000,
  max_phase_ms: 86400000,
};

const root = account(CONTRACT);
const code = readFileSync(WASM);
console.log(`deploying ${code.length} bytes to ${CONTRACT}`);

// Deploy the code.
const dep = await root.signAndSendTransaction({
  receiverId: CONTRACT,
  actions: [actions.deployContract(new Uint8Array(code))],
  waitUntil: 'EXECUTED_OPTIMISTIC',
}).catch((e) => ({ error: String(e?.message || e) }));
console.log('deploy:', dep?.transaction?.hash ? `${EXPLORER}${dep.transaction.hash}` : dep?.error);

// Initialize (only the first time).
try {
  const cfg = await view('get_config');
  console.log('already initialized; config on chain:', JSON.stringify(cfg));
} catch {
  const init = await call(root, 'new', { config: CONFIG }, { gasTgas: 60 });
  console.log('init new():', init.ok ? `${EXPLORER}${init.hash}` : `FAILED: ${init.error}`);
  if (!init.ok) process.exit(1);
}
const cfg = await view('get_config');
console.log('config:', JSON.stringify(cfg, null, 2));
