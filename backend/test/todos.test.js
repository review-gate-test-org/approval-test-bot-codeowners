import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, completeTodo } from '../src/todos.js';

test('addTodo appends a trimmed todo', () => {
  assert.deepEqual(addTodo([], '  milk '), [{ id: 1, title: 'milk', done: false }]);
});

test('addTodo rejects an empty title', () => {
  assert.throws(() => addTodo([], ' '));
});

test('completeTodo marks only the given todo', () => {
  const todos = addTodo(addTodo([], 'a'), 'b');
  assert.deepEqual(completeTodo(todos, 2).map((t) => t.done), [false, true]);
});
