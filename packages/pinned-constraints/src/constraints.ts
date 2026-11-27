import type { Plugin } from "@opencode/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import {
  activePins,
  addPin,
  contextPart,
  ENTRY_PREFIX,
  entryKey,
  entryValue,
  findSource,
  type Ledger,
  parseLedger,
  parsePinInput,
  parseReleaseInput,
  type Pin,
  releasePin,
  summaryBlock,
} from "./pins.ts"

/** The parts of the plugin context this plugin uses. */
export type Host = Pick<Plugin.Context, "storage" | "session" | "tool" | "event" | "location">

export const ledgerKey = (sessionID: string): string => `ledger/${sessionID}`

export type SyncResult = { readonly restored: readonly string[]; readonly removed: readonly string[] }

export class Constraints {
  readonly #host: Host
  readonly #now: () => number
  // Tool calls in one session can run in parallel; each ledger update waits for the previous one.
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(host: Host, now: () => number) {
    this.#host = host
    this.#now = now
  }

  async pin(sessionID: string, input: unknown): Promise<string> {
    const parsed = parsePinInput(input)

    return this.#serial(sessionID, async () => {
      const messages = await this.#host.session.context({ sessionID })
      const source = findSource(messages, parsed.quote, parsed.source)
      const result = addPin(await this.#load(sessionID), { ...parsed, source }, this.#now())

      if (!result.created) return `Already pinned as ${result.pin.id}: ${result.pin.text}`

      await this.#save(sessionID, result.ledger)
      await this.#host.session.instructions.entry.put({ sessionID, key: entryKey(result.pin.id), value: entryValue(result.pin) })

      return `Pinned ${result.pin.id}: ${result.pin.text}`
    })
  }

  async release(sessionID: string, input: unknown): Promise<string> {
    const parsed = parseReleaseInput(input)

    return this.#serial(sessionID, async () => {
      const result = releasePin(await this.#load(sessionID), parsed, this.#now())

      await this.#save(sessionID, result.ledger)
      await this.#host.session.instructions.entry.remove({ sessionID, key: entryKey(result.pin.id) })

      return `Released ${result.pin.id} (overridden: ${parsed.reason}).`
    })
  }

  async list(sessionID: string): Promise<string> {
    const ledger = await this.#load(sessionID)

    if (ledger.records.length === 0) return "No pinned constraints."

    const lines = ledger.records.map((record) =>
      record.status === "active"
        ? `- [${record.pin.id}] active: ${record.pin.text}\n  Verbatim (${record.pin.source}): ${JSON.stringify(record.pin.quote)}`
        : `- [${record.pin.id}] released: ${record.pin.text}\n  Overridden: ${record.reason}`,
    )

    return lines.join("\n")
  }

  /** Make the session's instruction entries match the active pins exactly: re-put missing or altered ones, drop stale ones. */
  async sync(sessionID: string, pins: readonly Pin[]): Promise<SyncResult> {
    const entries = await this.#host.session.instructions.entry.list({ sessionID })
    const present = new Map(entries.filter((entry) => entry.key.startsWith(ENTRY_PREFIX)).map((entry) => [entry.key, entry.value]))
    const wanted = new Map(pins.map((pin) => [entryKey(pin.id), entryValue(pin)]))
    const restored: string[] = []
    const removed: string[] = []

    for (const [key, value] of wanted) {
      if (present.get(key) === value) continue

      await this.#host.session.instructions.entry.put({ sessionID, key, value })
      restored.push(key)
    }

    for (const key of present.keys()) {
      if (wanted.has(key)) continue

      await this.#host.session.instructions.entry.remove({ sessionID, key })
      removed.push(key)
    }

    return { restored, removed }
  }

  async onContext(event: SessionHooks["context"]): Promise<void> {
    const pins = await this.#reconcile(event.sessionID)

    if (pins.length > 0) event.system.push({ type: "text", text: contextPart(pins) })
  }

  async onCompaction(event: SessionHooks["compaction"]): Promise<void> {
    const pins = await this.#reconcile(event.sessionID)

    if (pins.length === 0) return

    const block = summaryBlock(pins)

    // A summary set by an earlier hook can be extended here; a native one is written after hooks run (see afterCompaction).
    if (event.result !== undefined && !event.result.summary.includes(block)) {
      event.result = { ...event.result, summary: `${event.result.summary}\n\n${block}` }
    }
  }

  /**
   * After a compaction is recorded: re-put any pin missing from the instructions, and when the summary lacks the
   * Active constraints block, add it word for word as a synthetic message right after the summary.
   */
  async afterCompaction(sessionID: string, summary: string): Promise<boolean> {
    const pins = await this.#reconcile(sessionID)

    if (pins.length === 0) return false

    const block = summaryBlock(pins)

    if (summary.includes(block)) return false

    await this.#host.session.synthetic({ sessionID, text: block, description: "Active constraints", resume: false })

    return true
  }

  async #reconcile(sessionID: string): Promise<Pin[]> {
    const ledger = await this.#load(sessionID)

    if (ledger.records.length === 0) return []

    const pins = activePins(ledger)

    await this.#serial(sessionID, () => this.sync(sessionID, pins))

    return pins
  }

  async #load(sessionID: string): Promise<Ledger> {
    return parseLedger(await this.#host.storage.get(ledgerKey(sessionID)))
  }

  async #save(sessionID: string, ledger: Ledger): Promise<void> {
    await this.#host.storage.set(ledgerKey(sessionID), ledger)
  }

  #serial<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionID) ?? Promise.resolve()
    const next = previous.then(work)
    const tail = next.catch(() => {})

    this.#queues.set(sessionID, tail)
    void tail.then(() => {
      if (this.#queues.get(sessionID) === tail) this.#queues.delete(sessionID)
    })

    return next
  }
}

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const

/** Every plugin instance sees every session's events; act only on sessions in this instance's location. */
async function ownsSession(host: Host, sessionID: string): Promise<boolean> {
  try {
    const session = await host.session.get({ sessionID })

    return String(session.location.directory) === String(host.location.directory)
  } catch {
    return false
  }
}

function followCompactions(host: Host, constraints: Constraints): () => void {
  const controller = new AbortController()

  void (async () => {
    try {
      const events = host.event.subscribe({ types: ["session.compaction.ended"], signal: controller.signal })

      for await (const event of events) {
        const { sessionID, text } = event.data

        if (!(await ownsSession(host, sessionID))) continue

        await constraints.afterCompaction(sessionID, text).catch((error: unknown) => {
          console.error("[pinned-constraints] restoring after compaction failed", error)
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("[pinned-constraints] event stream ended", error)
    }
  })()

  return () => controller.abort()
}

export async function register(host: Host, now: () => number): Promise<{ constraints: Constraints; stop: () => void }> {
  const constraints = new Constraints(host, now)

  await host.tool.transform((editor) => {
    editor.add({
      name: "constraint_pin",
      description:
        "Pin a constraint the user stated (a requirement, prohibition or exact string) so it is re-sent word for word on every request and survives compaction. `quote` must be copied verbatim from the user's message; `text` states the constraint in one short sentence. `source` is that message's ID when known; when omitted, the newest user message containing the quote is used.",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "The constraint in one short sentence." },
          quote: { type: "string", description: "The user's words, copied exactly." },
          source: { type: "string", description: "ID of the user message the quote comes from." },
        },
        required: ["text", "quote"],
        additionalProperties: false,
      },
      execute: async (input, context) => ({ content: await constraints.pin(context.sessionID, input) }),
    })
    editor.add({
      name: "constraint_list",
      description: "List this session's pinned constraints, active and released.",
      input: NO_INPUT,
      execute: async (_input, context) => ({ content: await constraints.list(context.sessionID) }),
    })
    editor.add({
      name: "constraint_release",
      description:
        "Mark a pinned constraint overridden when the user changes or withdraws it. It stops being re-sent; the audit record keeps it.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "The pin's ID, such as c2." },
          reason: { type: "string", description: "Why it no longer applies, quoting the user's override." },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      execute: async (input, context) => ({ content: await constraints.release(context.sessionID, input) }),
    })
  })

  await host.session.hook("context", (event) => constraints.onContext(event))
  await host.session.hook("compaction", (event) => constraints.onCompaction(event))

  return { constraints, stop: followCompactions(host, constraints) }
}
