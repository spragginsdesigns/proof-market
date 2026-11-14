// Pure report helpers: the commit preimage, verdict encoding and transcript hashing. No network, no
// model, no chain. These must match the contract exactly (docs/SPEC.md "Phase 2"), so they are unit
// tested against fixed vectors and, end to end, against a real reveal (a mismatch panics on chain).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';

export const VERDICTS = ['Pass', 'Fail', 'Unverifiable'];
const CODE = { Pass: 'P', Fail: 'F', Unverifiable: 'U' };

export function verdictsCsv(verdicts) {
  return verdicts.map((v) => {
    if (!(v in CODE)) throw new Error(`bad verdict ${v}`);
    return CODE[v];
  }).join(',');
}

export function sha256hex(s) {
  return bytesToHex(sha256(typeof s === 'string' ? new TextEncoder().encode(s) : s));
}

// A fresh 32-hex salt (16 bytes). Within [16,64] hex per the contract.
export function freshSalt() {
  return bytesToHex(randomBytes(16));
}

// The exact preimage the contract recomputes in `reveal`.
export function reportPreimage({ contractId, jobId, workerId, verdicts, transcriptHash, salt }) {
  return `proof-market report v1|${contractId}|${jobId}|${workerId}|${verdictsCsv(verdicts)}|${transcriptHash}|${salt}`;
}

export function reportHash(args) {
  return sha256hex(reportPreimage(args));
}

// A worker's report object (what it stores and reveals).
export function buildReport({ contractId, jobId, workerId, verdicts, transcriptHash, transcriptUri, salt = freshSalt() }) {
  const hash = reportHash({ contractId, jobId, workerId, verdicts, transcriptHash, salt });
  return { contractId, jobId, workerId, verdicts, transcriptHash, transcriptUri, salt, hash };
}

// Two verdict lists contradict on a step iff one is Pass and the other Fail (Unverifiable never
// contradicts). Used by the local settlement preview and the backtest; the contract is authoritative.
export function contradicts(a, b) {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === 'Pass' && b[i] === 'Fail') || (a[i] === 'Fail' && b[i] === 'Pass')) return true;
  }
  return false;
}
