export function formatTodo(todo) {
  return `${todo.done ? '[x]' : '[ ]'} ${todo.title}`;
}
