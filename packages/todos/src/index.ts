import { Plugin } from "@opencode/plugin"
import { Nudger, type NudgeOptions } from "./nudge.ts"
import { DEFAULT_REMINDER, parseInput, parseList, TODO_TOOL } from "./todos.ts"

const DEFAULT_DELAY_MS = 4_000
const DEFAULT_MAX_NUDGES = 1

const storageKey = (sessionID: string): string => `todos/${sessionID}`

function positive(option: unknown, fallback: number): number {
  return typeof option === "number" && Number.isInteger(option) && option > 0 ? option : fallback
}

/** The plugin's options from `opencode.jsonc`, each falling back to its default. */
function readOptions(options: Readonly<Record<string, unknown>>): NudgeOptions {
  return {
    delayMs: positive(options.delayMs, DEFAULT_DELAY_MS),
    maxNudges: positive(options.maxNudges, DEFAULT_MAX_NUDGES),
    reminder: typeof options.reminder === "string" && options.reminder.includes("{todos}") ? options.reminder : DEFAULT_REMINDER,
  }
}

export default Plugin.define({
  id: "opencode-todos",
  async setup(ctx) {
    const options = readOptions(ctx.options)

    const nudger = new Nudger(
      {
        read: async (sessionID) => parseList(await ctx.storage.get(storageKey(sessionID))) ?? [],
        send: async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID, text, description: "Pending todos", resume: true })
        },
        later: (run, ms) => {
          const timer = setTimeout(run, ms)

          return () => clearTimeout(timer)
        },
      },
      options,
    )

    // Server plugins cannot read the transcript, so keep a copy of each list the built-in tool writes.
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== TODO_TOOL || event.status !== "completed") return

      const todos = parseInput(event.input)

      if (todos === undefined) return

      const sessionID = String(event.sessionID)

      await ctx.storage.set(storageKey(sessionID), todos)
      nudger.listWritten(sessionID, todos)
    })

    // Each plugin instance sees every session's events; only a session's own location reminds it.
    const ownsSession = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID })

        return String(session.location.directory) === String(ctx.location.directory)
      } catch {
        return true
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          switch (event.type) {
            case "session.execution.succeeded":
              if (await ownsSession(event.data.sessionID)) nudger.turnEnded(event.data.sessionID)

              break
            case "session.execution.started":
              nudger.stirred(event.data.sessionID)

              break
            case "session.inbox.enqueued":
              nudger.stirred(event.data.sessionID)

              break
            case "session.deleted":
              nudger.forget(event.data.sessionID)
              void ctx.storage.remove(storageKey(event.data.sessionID)).catch(() => {})

              break
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[opencode-todos] event stream ended", error)
      }
    })()

    return () => controller.abort()
  },
})
