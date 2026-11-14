import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from './parse.mjs';

test('seconds', () => assert.equal(parseDuration('45s'), 45));
test('minutes', () => assert.equal(parseDuration('5m'), 300));
test('hours', () => assert.equal(parseDuration('2h'), 7200));
test('combined', () => assert.equal(parseDuration('1h30m'), 5400));
test('rejects text that is not a duration', () => assert.throws(() => parseDuration('soon')));
