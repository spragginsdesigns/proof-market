// Provision the Proof Market on NEAR testnet: create the contract account (from the faucet), create
// the poster, worker and verifier sub-accounts, and give every worker and verifier a FUNCTION-CALL
// ONLY access key limited to the market contract and its safe methods. The agents sign with that
// key, never a full-access key, so a stolen agent key can do nothing but act in this one market.
//
//   PM_CONTRACT=yourname.testnet node scripts/provision.mjs --faucet
//
// Keys: full-access keys go to the legacy keychain (~/.near-credentials/testnet). The function-call
// agent keys go to state/fckeys/ (git-ignored). Nothing is printed.
import { account, accountExists, hasKey, saveKey, keyFile, near, toNear, view, CONTRACT, EXPLORER, KeyPair } from '../lib/chain.mjs';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const WORKERS = Number(args.workers || 3);
const VERIFIERS = Number(args.verifiers || 3);
const FAUCET = process.env.NEAR_FAUCET || 'https://helper.nearprotocol.com/account';

// The only methods an agent key may call: all non-payable (a function-call key cannot attach a
// deposit anyway). post_job, deposit and withdraw's receiver rules keep money safe.
export const AGENT_METHODS = ['register_worker', 'register_verifier', 'leave_worker', 'leave_verifier', 'claim', 'commit', 'reveal', 'verify', 'challenge', 'advance', 'finalize', 'withdraw'];

const stateDir = process.env.PM_STATE || new URL('../state/', import.meta.url).pathname;
const fcDir = join(stateDir, 'fckeys');
mkdirSync(fcDir, { recursive: true, mode: 0o700 });
const ledgerFile = join(stateDir, 'accounts.json');
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { contract: CONTRACT, accounts: {} };

async function waitExists(id, tries = 25) {
  for (let k = 0; k < tries && !(await accountExists(id)); k++) await new Promise((r) => setTimeout(r, 1500));
  return accountExists(id);
}

// 1. contract account
if (!(await accountExists(CONTRACT))) {
  if (!args.faucet) throw new Error(`${CONTRACT} does not exist; add --faucet`);
  if (!/^[a-z0-9_-]+\.testnet$/.test(CONTRACT)) throw new Error('faucet only creates top-level <name>.testnet');
  const kp = KeyPair.fromRandom('ed25519');
  const r = await fetch(FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: CONTRACT, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`faucet refused (${r.status}): ${(await r.text()).slice(0, 200)}`);
  saveKey(CONTRACT, kp);
  if (!(await waitExists(CONTRACT))) throw new Error('faucet account did not appear');
  console.log(`created contract account ${CONTRACT} from the faucet`);
} else {
  console.log(`contract account ${CONTRACT} exists`);
}
if (!hasKey(CONTRACT)) throw new Error(`no full-access key for ${CONTRACT} in the keychain`);
const root = account(CONTRACT);

// 2. sub-accounts
const plan = [['poster', Number(args['poster-near'] || 1.2)]];
for (let i = 1; i <= WORKERS; i++) plan.push([`w${i}`, Number(args['worker-near'] || 0.8)]);
for (let i = 1; i <= VERIFIERS; i++) plan.push([`v${i}`, Number(args['verifier-near'] || 0.8)]);

for (const [prefix, amount] of plan) {
  const id = `${prefix}.${CONTRACT}`;
  if (await accountExists(id)) {
    console.log(`exists  ${id}`);
  } else {
    const kp = KeyPair.fromRandom('ed25519');
    saveKey(id, kp);
    const res = await root.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: near(amount) });
    ledger.accounts[id] = { role: prefix.startsWith('w') ? 'worker' : prefix.startsWith('v') ? 'verifier' : 'poster', created_tx: res?.transaction?.hash };
    console.log(`created ${id} with ${amount} NEAR  ${EXPLORER}${res?.transaction?.hash}`);
    await waitExists(id);
  }
}

// 3. function-call-only agent keys for workers and verifiers
for (const [prefix] of plan) {
  if (prefix === 'poster') continue;
  const id = `${prefix}.${CONTRACT}`;
  const fcPath = join(fcDir, `${id}.json`);
  if (existsSync(fcPath)) { console.log(`fc key  ${id} (exists)`); continue; }
  const fc = KeyPair.fromRandom('ed25519');
  const acc = account(id);
  const res = await acc.addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: CONTRACT, methodNames: AGENT_METHODS, allowance: near(0.25) });
  writeFileSync(fcPath, JSON.stringify({ account_id: id, public_key: fc.getPublicKey().toString(), private_key: fc.toString() }));
  mkdirSync(fcDir, { recursive: true, mode: 0o700 });
  const { chmodSync } = await import('node:fs');
  chmodSync(fcPath, 0o600);
  ledger.accounts[id] = { ...(ledger.accounts[id] || {}), fc_key_tx: res?.transaction?.hash, fc_public_key: fc.getPublicKey().toString() };
  console.log(`fc key  ${id} limited to ${CONTRACT} (${AGENT_METHODS.length} methods)  ${EXPLORER}${res?.transaction?.hash}`);
}

writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
console.log(`\nledger written to ${ledgerFile}`);
