import assert from 'node:assert';
import { test } from 'node:test';
import { verdictsCsv, reportPreimage, reportHash, buildReport, contradicts, sha256hex } from './report.mjs';

test('verdict csv encoding', () => {
  assert.equal(verdictsCsv(['Pass', 'Fail', 'Unverifiable']), 'P,F,U');
  assert.throws(() => verdictsCsv(['Nope']));
});

test('preimage is the exact documented string', () => {
  const p = reportPreimage({
    contractId: 'proofmkt.testnet', jobId: 7, workerId: 'w1.proofmkt.testnet',
    verdicts: ['Pass', 'Fail'], transcriptHash: 'a'.repeat(64), salt: 'deadbeefdeadbeef',
  });
  assert.equal(p, 'proof-market report v1|proofmkt.testnet|7|w1.proofmkt.testnet|P,F|' + 'a'.repeat(64) + '|deadbeefdeadbeef');
});

test('report hash matches a fixed SHA-256 vector', () => {
  const args = {
    contractId: 'proofmkt.testnet', jobId: 0, workerId: 'w1.proofmkt.testnet',
    verdicts: ['Pass'], transcriptHash: '0'.repeat(64), salt: '00112233445566778899aabbccddeeff',
  };
  const expected = sha256hex(
    'proof-market report v1|proofmkt.testnet|0|w1.proofmkt.testnet|P|' + '0'.repeat(64) + '|00112233445566778899aabbccddeeff',
  );
  assert.equal(reportHash(args), expected);
  assert.match(reportHash(args), /^[0-9a-f]{64}$/);
});

test('buildReport carries a fresh 32-hex salt and a valid hash', () => {
  const r = buildReport({
    contractId: 'proofmkt.testnet', jobId: 1, workerId: 'w.proofmkt.testnet',
    verdicts: ['Pass', 'Pass'], transcriptHash: 'b'.repeat(64), transcriptUri: 'file://t.json',
  });
  assert.match(r.salt, /^[0-9a-f]{32}$/);
  assert.equal(r.hash, reportHash(r));
});

test('contradiction is Pass vs Fail only', () => {
  assert.equal(contradicts(['Pass'], ['Fail']), true);
  assert.equal(contradicts(['Fail'], ['Pass']), true);
  assert.equal(contradicts(['Pass'], ['Unverifiable']), false);
  assert.equal(contradicts(['Unverifiable'], ['Fail']), false);
  assert.equal(contradicts(['Pass', 'Fail'], ['Pass', 'Fail']), false);
  assert.equal(contradicts(['Pass', 'Fail'], ['Pass', 'Pass']), true);
  assert.equal(contradicts(['Pass'], ['Pass', 'Fail']), true); // length mismatch
});
