import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTodo } from '../src/format.js';

test('formatTodo shows the done state', () => {
  assert.equal(formatTodo({ title: 'milk', done: false }), '[ ] milk');
  assert.equal(formatTodo({ title: 'milk', done: true }), '[x] milk');
});

import { formatSummary } from '../src/format.js';

test('formatSummary shows done and total', () => {
  assert.equal(formatSummary(1, 3), '1/3 done');
});
