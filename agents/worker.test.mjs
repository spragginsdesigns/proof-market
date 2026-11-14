import assert from 'node:assert';
import { test } from 'node:test';
import { stripRedundantCd } from './worker.mjs';

test('strips a redundant cd into the job path', () => {
  assert.deepEqual(stripRedundantCd(['bash', '-c', 'cd fixtures/honest && node add.mjs 2 3'], 'fixtures/honest'), ['bash', '-c', 'node add.mjs 2 3']);
  assert.deepEqual(stripRedundantCd(['bash', '-c', 'cd ./fixtures/honest; node add.mjs 2 3'], 'fixtures/honest'), ['bash', '-c', 'node add.mjs 2 3']);
  assert.deepEqual(stripRedundantCd(['cd', 'fixtures/honest'], 'fixtures/honest'), null);
});

test('keeps a cd into a deeper or different directory', () => {
  assert.deepEqual(stripRedundantCd(['bash', '-c', 'cd packages/app && npm test'], 'fixtures/honest'), ['bash', '-c', 'cd packages/app && npm test']);
  assert.deepEqual(stripRedundantCd(['node', 'add.mjs', '2', '3'], 'fixtures/honest'), ['node', 'add.mjs', '2', '3']);
});

test('no-op when there is no path', () => {
  assert.deepEqual(stripRedundantCd(['bash', '-c', 'cd fixtures/honest && x'], ''), ['bash', '-c', 'cd fixtures/honest && x']);
});
