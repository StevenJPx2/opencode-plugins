import { expect, test } from "bun:test"
import { Nudger, type NudgeHost, type NudgeOptions } from "../src/nudge.ts"
import type { Todo } from "../src/todos.ts"

const OPEN: Todo[] = [{ content: "Backfill old rows", status: "in_progress" }]
const DONE: Todo[] = [{ content: "Backfill old rows", status: "completed" }]

const OPTIONS: NudgeOptions = { delayMs: 1000, maxNudges: 2, reminder: "Still open:\n{todos}" }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A nudger on a clock the test winds by hand. */
function harness(options: NudgeOptions = OPTIONS) {
  const sent: string[] = []
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  let todos: Todo[] = OPEN
  let release: (() => void) | undefined

  const host: NudgeHost = {
    read: async () => {
      if (release === undefined) return todos

      await new Promise<void>((resolve) => { release = resolve })

      return todos
    },
    send: async (_session, text) => { sent.push(text) },
    later: (run, ms) => {
      const timer = { run, ms, live: true }

      timers.push(timer)

      return () => { timer.live = false }
    },
  }

  return {
    nudger: new Nudger(host, options),
    sent,
    timers,
    setTodos: (next: Todo[]) => { todos = next },
    holdReads: () => { release = () => {} },
    releaseReads: () => release?.(),
    /** The delay passes. */
    async elapse() {
      for (const timer of timers.filter((candidate) => candidate.live)) {
        timer.live = false
        timer.run()
      }

      await settle()
    },
  }
}

test("a finished turn with open todos is reminded after the delay", async () => {
  const { nudger, sent, timers, elapse } = harness()

  nudger.turnEnded("ses_a")

  expect(timers[0]?.ms).toBe(1000)
  expect(sent).toEqual([])

  await elapse()

  expect(sent).toEqual(["Still open:\n- [>] Backfill old rows"])
})

test("nothing is sent when no todo is open", async () => {
  const { nudger, sent, setTodos, elapse } = harness()

  setTodos(DONE)
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toEqual([])
})

test("anything else waking the session first drops the reminder", async () => {
  const { nudger, sent, elapse } = harness()

  nudger.turnEnded("ses_a")
  nudger.stirred("ses_a")
  await elapse()

  expect(sent).toEqual([])
})

test("a session stirred while the list is being read is not reminded", async () => {
  const { nudger, sent, holdReads, releaseReads, elapse } = harness()

  holdReads()
  nudger.turnEnded("ses_a")
  await elapse()

  nudger.stirred("ses_a")
  releaseReads()
  await settle()

  expect(sent).toEqual([])
})

test("a second finished turn replaces the pending reminder", async () => {
  const { nudger, sent, elapse } = harness()

  nudger.turnEnded("ses_a")
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(1)
})

test("reminders stop after the cap, until the list changes", async () => {
  const { nudger, sent, setTodos, elapse } = harness()
  const wider: Todo[] = [...OPEN, { content: "Update the docs", status: "pending" }]

  for (let turn = 0; turn < 4; turn += 1) {
    nudger.turnEnded("ses_a")
    await elapse()
  }

  expect(sent).toHaveLength(2)

  // The agent rewrites its list: progress, so reminders resume.
  setTodos(wider)
  nudger.listWritten("ses_a", wider)
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(3)

  // Writing the same list again is not progress.
  nudger.listWritten("ses_a", wider)
  nudger.turnEnded("ses_a")
  await elapse()
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(4)

  // The user writing is not progress either.
  nudger.stirred("ses_a")
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(4)
})

test("a list changed without the plugin seeing the write starts the count again", async () => {
  const { nudger, sent, setTodos, elapse } = harness({ ...OPTIONS, maxNudges: 1 })

  nudger.turnEnded("ses_a")
  await elapse()
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(1)

  setTodos([...OPEN, { content: "Update the docs", status: "pending" }])
  nudger.turnEnded("ses_a")
  await elapse()

  expect(sent).toHaveLength(2)
})

test("each session counts on its own", async () => {
  const { nudger, sent, elapse } = harness({ ...OPTIONS, maxNudges: 1 })

  nudger.turnEnded("ses_a")
  await elapse()
  nudger.turnEnded("ses_a")
  await elapse()
  nudger.turnEnded("ses_b")
  await elapse()

  expect(sent).toHaveLength(2)
})
