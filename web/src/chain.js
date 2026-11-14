// The browser reads NEAR testnet directly over JSON-RPC (no server), with failover across public
// providers. If the contract is unset or unreachable, the app falls back to a bundled snapshot so
// the local, no-keys demo still shows a real finished run.
export const CONTRACT = import.meta.env.VITE_CONTRACT || '';
export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';
export const EXPLORER_ACCOUNT = 'https://testnet.nearblocks.io/address/';
const RPCS = (import.meta.env.VITE_RPCS || 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://archival-rpc.testnet.fastnear.com').split(',');
let current = 0;

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

async function rpc(method, params) {
  let lastErr;
  for (let k = 0; k < RPCS.length * 2; k++) {
    const url = RPCS[(current + k) % RPCS.length];
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'pm', method, params }), signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const e = new Error(j.error?.cause?.name || j.error?.message || JSON.stringify(j.error));
        if (/429|rate/i.test(e.message)) throw new Error('rate limited');
        e.fatal = true;
        throw e;
      }
      current = (current + k) % RPCS.length;
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await new Promise((r) => setTimeout(r, 250 * (k + 1)));
    }
  }
  throw lastErr || new Error('RPC unreachable');
}

export async function view(method, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: method, args_base64: b64(JSON.stringify(args)) });
  const text = new TextDecoder().decode(new Uint8Array(r.result));
  return text ? JSON.parse(text) : null;
}

// Load the bundled snapshot that ships in the build (the local demo and offline fallback).
export async function loadSnapshot() {
  const res = await fetch('./data/snapshot.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('no snapshot');
  return res.json();
}

// Load the recorded command output behind each verdict (built from docs/evidence/transcripts/).
let evidenceCache;
export function loadEvidence() {
  evidenceCache ||= fetch('./data/evidence.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return evidenceCache;
}

export const toNear = (y) => Number(BigInt(y || 0) / 10n ** 18n) / 1e6;
export const fmtNear = (x, d = 2) => `${Number(x).toFixed(d)} NEAR`;
export const shortHash = (h, n = 6) => (h ? `${h.slice(0, n)}...${h.slice(-4)}` : '');
export const shortAcct = (a) => {
  if (!a) return '';
  const parts = String(a).split('.');
  return parts[0].length > 14 ? `${parts[0].slice(0, 12)}...` : parts[0];
};
