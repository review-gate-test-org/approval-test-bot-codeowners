export function addTodo(todos, title) {
  if (!title || !title.trim()) throw new Error('title is required');
  return [...todos, { id: todos.length + 1, title: title.trim(), done: false }];
}

export function completeTodo(todos, id) {
  return todos.map((t) => (t.id === id ? { ...t, done: true } : t));
}

export function openTodos(todos) {
  return todos.filter((t) => !t.done);
}

export function todoCount(todos) {
  return todos.length;
}
// gate test: pushed after approval (pretend this is malicious)
