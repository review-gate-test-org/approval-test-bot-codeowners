export function formatTodo(todo) {
  return `${todo.done ? '[x]' : '[ ]'} ${todo.title}`;
}

export function formatSummary(done, total) {
  return `${done}/${total} done`;
}
