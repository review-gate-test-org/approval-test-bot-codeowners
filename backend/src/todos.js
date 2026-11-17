export function addTodo(todos, title) {
  if (!title || !title.trim()) throw new Error('title is required');
  return [...todos, { id: todos.length + 1, title: title.trim(), done: false }];
}

export function completeTodo(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: true } : t));
}

export function countDone(todos) {
  return todos.filter((t) => t.done).length;
}
