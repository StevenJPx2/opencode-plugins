/** OpenCode's built-in todo tool, turned on with `experimental.todo`. */
export const TODO_TOOL = "todowrite"

/** A todo named in a reminder is clipped to 512 bytes. */
const TODO_BYTES = 512

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const

export type Status = (typeof STATUSES)[number]

export type Todo = { readonly content: string; readonly status: Status }

export const isOpen = (todo: Todo): boolean => todo.status === "pending" || todo.status === "in_progress"

function isStatus(value: unknown): value is Status {
  return STATUSES.some((status) => status === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `value` truncated to whole code points within `bytes` of UTF-8. */
export function clipBytes(value: string, bytes: number): string {
  const encoder = new TextEncoder()
  let used = 0
  let kept = ""

  for (const point of value) {
    used += encoder.encode(point).length

    if (used > bytes) break

    kept += point
  }

  return kept
}

/** A list read from untrusted JSON, or `undefined` when any item is malformed. Blank items are dropped and long ones clipped. */
export function parseList(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined

  const todos: Todo[] = []

  for (const item of value) {
    if (!isRecord(item) || typeof item.content !== "string" || !isStatus(item.status)) return undefined

    const content = clipBytes(item.content.trim(), TODO_BYTES)

    if (content !== "") todos.push({ content, status: item.status })
  }

  return todos
}

/** The list a `todowrite` call carries, from its raw input. */
export function parseInput(input: unknown): Todo[] | undefined {
  return isRecord(input) ? parseList(input.todos) : undefined
}

/** Equal lists have equal signatures. */
export function signature(todos: ReadonlyArray<Todo>): string {
  return JSON.stringify(todos)
}

const MARKS: Record<Status, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[-]",
}

export const DEFAULT_REMINDER =
  "These todos are still open:\n{todos}\n" +
  "Continue with the next open item. If the user's request is already complete, update the list with todowrite " +
  "to mark finished items completed and cancel any that no longer apply, instead of repeating the work."

/** The reminder text, with `{todos}` replaced by the open todos, one per line. */
export function reminderText(template: string, todos: ReadonlyArray<Todo>): string {
  const lines = todos.filter(isOpen).map((todo) => `- ${MARKS[todo.status]} ${todo.content}`)

  return template.replace("{todos}", () => lines.join("\n"))
}
