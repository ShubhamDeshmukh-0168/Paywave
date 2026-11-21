'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.LOCAL_MODE = 'true';
const { advance, nextAfter } = require('../src/autopay');

const d = (s) => new Date(s);

test('daily and weekly advance', () => {
  assert.equal(advance(d('2026-12-31T10:00:00Z'), 'DAILY').toISOString(), '2027-01-01T10:00:00.000Z');
  assert.equal(advance(d('2026-12-28T10:00:00Z'), 'WEEKLY').toISOString(), '2027-01-04T10:00:00.000Z');
});

test('monthly advance clamps to the end of shorter months', () => {
  assert.equal(advance(d('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(advance(d('2028-01-31T10:00:00Z'), 'MONTHLY').toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(advance(d('2026-12-15T10:00:00Z'), 'MONTHLY').toISOString(), '2027-01-15T10:00:00.000Z');
});

test('nextAfter skips missed runs instead of catching up', () => {
  const next = nextAfter(d('2026-11-01T10:00:00Z'), 'DAILY', d('2026-11-10T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-11-11T10:00:00.000Z');
});
