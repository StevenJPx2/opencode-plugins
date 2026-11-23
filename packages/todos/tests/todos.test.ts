import { expect, test } from "bun:test"
import { clipBytes, DEFAULT_REMINDER, parseInput, parseList, reminderText } from "../src/todos.ts"

test("a list is trimmed, blank items are dropped and long ones clipped", () => {
  const long = "é".repeat(400)

  const todos = parseList([
    { content: "  Backfill old rows  ", status: "in_progress" },
    { content: "   ", status: "pending" },
    { content: long, status: "completed" },
  ])

  expect(todos?.map((todo) => todo.content.length)).toEqual([17, 256])
  expect(todos?.[0]).toEqual({ content: "Backfill old rows", status: "in_progress" })
})

test("a malformed list is refused whole", () => {
  expect(parseList([{ content: "x", status: "someday" }])).toBeUndefined()
  expect(parseList([{ content: 3, status: "pending" }])).toBeUndefined()
  expect(parseList("nope")).toBeUndefined()
  expect(parseInput({ todos: [{ content: "x", status: "pending" }] })).toEqual([{ content: "x", status: "pending" }])
  expect(parseInput(undefined)).toBeUndefined()
})

test("clipping never splits a character", () => {
  expect(clipBytes("a😀b", 4)).toBe("a")
  expect(clipBytes("a😀b", 5)).toBe("a😀")
})

test("the reminder names only the open todos", () => {
  const todos = parseList([
    { content: "Done already", status: "completed" },
    { content: "Backfill old rows", status: "in_progress" },
    { content: "Update the docs", status: "pending" },
  ])

  const text = reminderText(DEFAULT_REMINDER, todos ?? [])

  expect(text).toContain("- [>] Backfill old rows\n- [ ] Update the docs")
  expect(text).not.toContain("Done already")
  expect(text).toContain("mark finished items completed")
})
