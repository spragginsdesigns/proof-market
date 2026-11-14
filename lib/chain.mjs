// Thin NEAR testnet helpers on near-api-js v7, shared by the provisioning scripts, the worker and
// verifier agents, and the local guest relayer. Keys are read from NEAR_CREDENTIALS_DIR (default
// ~/.near-credentials/testnet, the legacy keychain near-cli writes) or from a passed key dir.
// Nothing here ever prints or logs a key.
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NETWORK = 'testnet';
export const RPCS = (process.env.NEAR_RPCS || 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://archival-rpc.testnet.fastnear.com').split(',');
export const RPC = RPCS[0];
export const CONTRACT = process.env.PM_CONTRACT || 'pmarket.testnet';
export const EXPLORER = 'https://testnet.nearblocks.io/txns/';
export const YOCTO = 10n ** 24n;
export const near = (x) => (YOCTO * BigInt(Math.round(Number(x) * 1e6))) / 1000000n;
export const toNear = (y) => Number((BigInt(y) * 1000000n) / YOCTO) / 1e6;

const opts = { retries: 8, wait: 700, backoff: 1.7 };
export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url }, opts)));
export const credDir = process.env.NEAR_CREDENTIALS_DIR || join(homedir(), '.near-credentials', NETWORK);

export function keyFile(accountId, dir = credDir) {
  return join(dir, `${accountId}.json`);
}
export function hasKey(accountId, dir = credDir) {
  return existsSync(keyFile(accountId, dir));
}
export function saveKey(accountId, keyPair, dir = credDir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = keyFile(accountId, dir);
  writeFileSync(f, JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }));
  chmodSync(f, 0o600);
  return f;
}
export function loadSigner(accountId, dir = credDir) {
  const j = JSON.parse(readFileSync(keyFile(accountId, dir), 'utf8'));
  return KeyPairSigner.fromSecretKey(j.private_key || j.secret_key);
}
export function account(accountId, dir = credDir) {
  return new Account(accountId, provider, loadSigner(accountId, dir));
}

export async function view(method, args = {}, contractId = CONTRACT) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.callFunction({ contractId, method, args });
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

export async function accountExists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

// Decode a transaction response: hash, ok, error text, logs, JSON return value, gas.
export function outcome(res) {
  const hash = res?.transaction?.hash || res?.transaction_outcome?.id;
  const st = res?.status || {};
  let ok = st.SuccessValue !== undefined;
  let error = null;
  if (st.Failure) {
    ok = false;
    error = JSON.stringify(st.Failure).slice(0, 600);
  }
  const logs = [];
  let gasBurnt = BigInt(res?.transaction_outcome?.outcome?.gas_burnt || 0);
  for (const r of res?.receipts_outcome || []) {
    logs.push(...(r.outcome?.logs || []));
    gasBurnt += BigInt(r.outcome?.gas_burnt || 0);
    const s = r.outcome?.status || {};
    if (s.Failure && !error) {
      ok = false;
      error = JSON.stringify(s.Failure).slice(0, 600);
    }
  }
  let value = null;
  if (ok && st.SuccessValue) {
    try {
      value = JSON.parse(Buffer.from(st.SuccessValue, 'base64').toString());
    } catch {
      value = null;
    }
  }
  return { hash, ok, error, logs, value, gasBurnt, blockHash: res?.transaction_outcome?.block_hash };
}

// One transaction, one or more function calls. Never throws on a failed call: the caller gets the
// hash and the error, so failed cheats are recorded on chain and in proofs too.
export async function send(acct, calls, contractId = CONTRACT) {
  const acts = calls.map((c) => actions.functionCall(c.method, c.args, BigInt(c.gasTgas || 60) * 10n ** 12n, BigInt(c.deposit || 0)));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await acct.signAndSendTransaction({ receiverId: contractId, actions: acts, throwOnFailure: false, waitUntil: 'EXECUTED_OPTIMISTIC' });
      return outcome(res);
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt < 6 && /timeout|ECONNRESET|429|Rate limit|503|502|fetch failed|nonce|EAI_AGAIN|Exceeded \d+ providers/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      return { hash: null, ok: false, error: msg.slice(0, 600), logs: [], value: null, gasBurnt: 0n };
    }
  }
}

// Convenience: call one method and return the decoded outcome.
export async function call(acct, method, args = {}, { deposit = 0, gasTgas = 60 } = {}, contractId = CONTRACT) {
  return send(acct, [{ method, args, deposit, gasTgas }], contractId);
}

export async function blockTimeMs() {
  return Number(await view('block_time_ms'));
}

export { KeyPair, actions };
