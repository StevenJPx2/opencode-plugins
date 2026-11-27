import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { Host } from "../src/constraints.ts"
import type { MessageLike } from "../src/pins.ts"

type Execute = (input: unknown, context: ToolContext) => Promise<{ content?: unknown }>

export const SESSION = "ses_test"
export const OTHER_SESSION = "ses_elsewhere"
const DIRECTORY = "/work/project"

type CompactionEnded = { type: "session.compaction.ended"; data: { sessionID: string; text: string } }

/** An in-memory stand-in for the parts of the plugin context the plugin uses. */
export function fakeHost(messages: MessageLike[]) {
  const storage = new Map<string, unknown>()
  const entries = new Map<string, unknown>()
  const tools = new Map<string, Execute>()
  const hooks = new Map<string, (event: unknown) => Promise<void> | void>()
  const calls: string[] = []
  const synthetics: { sessionID: string; text: string; description?: string; resume?: boolean }[] = []
  const pending: CompactionEnded[] = []
  let wake = () => {}

  async function* subscribe({ signal }: { signal: AbortSignal }): AsyncGenerator<CompactionEnded> {
    while (!signal.aborted) {
      const next = pending.shift()

      if (next !== undefined) {
        yield next
        continue
      }

      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }

  const host = {
    location: { directory: DIRECTORY },
    event: { subscribe },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
    },
    session: {
      context: async () => messages,
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: sessionID === SESSION ? DIRECTORY : "/somewhere/else" },
      }),
      synthetic: async (input: (typeof synthetics)[number]) => void synthetics.push(input),
      instructions: {
        entry: {
          list: async () => {
            calls.push("list")
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          put: async ({ key, value }: { key: string; value: unknown }) => {
            calls.push(`put ${key}`)
            entries.set(key, value)
          },
          remove: async ({ key }: { key: string }) => {
            calls.push(`remove ${key}`)
            entries.delete(key)
          },
        },
      },
      hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string; execute: Execute }) => void }) => void) => {
        callback({ add: (tool) => void tools.set(tool.name, tool.execute) })
        return { dispose: async () => {} }
      },
    },
  }

  const call = async (name: string, input: unknown): Promise<unknown> => {
    const execute = tools.get(name)

    if (execute === undefined) throw new Error(`no tool ${name}`)

    return (await execute(input, { sessionID: SESSION } as ToolContext)).content
  }

  const contextEvent = (): SessionHooks["context"] => ({ sessionID: SESSION, system: [] }) as unknown as SessionHooks["context"]

  const compactionEnded = (sessionID: string, text: string): void => {
    pending.push({ type: "session.compaction.ended", data: { sessionID, text } })
    wake()
  }

  return { host: host as unknown as Host, storage, entries, tools, hooks, calls, synthetics, call, contextEvent, compactionEnded }
}
