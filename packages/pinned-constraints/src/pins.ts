export const ENTRY_PREFIX = "constraint."
export const MAX_ACTIVE = 32
export const MAX_RECORDS = 128
export const MAX_TEXT_CHARS = 500
export const MAX_QUOTE_CHARS = 2_000
export const SUMMARY_HEADING = "## Active constraints"

export type Pin = {
  readonly id: string
  readonly text: string
  readonly quote: string
  readonly source: string
  readonly pinnedAt: number
}

export type PinRecord =
  | { readonly status: "active"; readonly pin: Pin }
  | { readonly status: "released"; readonly pin: Pin; readonly releasedAt: number; readonly reason: string }

/** Every pin a session made, in pin order; the audit record kept in plugin storage. */
export type Ledger = { readonly next: number; readonly records: readonly PinRecord[] }

export type PinInput = { readonly text: string; readonly quote: string; readonly source?: string }
export type ReleaseInput = { readonly id: string; readonly reason: string }

/** The part of a session message the source check reads. */
export type MessageLike = { readonly id: string; readonly type: string; readonly text?: string }

export const EMPTY_LEDGER: Ledger = { next: 1, records: [] }

export const entryKey = (id: string): string => ENTRY_PREFIX + id

export const activePins = (ledger: Ledger): Pin[] =>
  ledger.records.flatMap((record) => (record.status === "active" ? [record.pin] : []))

/** The instruction entry for one pin; the quote is kept exactly as the user wrote it. */
export function entryValue(pin: Pin): string {
  return [`Pinned constraint ${pin.id}: ${pin.text}`, `Verbatim from message ${pin.source}:`, pin.quote].join("\n")
}

export function contextPart(pins: readonly Pin[]): string {
  return [
    "Active constraints pinned by the user. Follow each until constraint_release marks it overridden:",
    ...pins.map((pin) => `- [${pin.id}] ${pin.text}`),
  ].join("\n")
}

export function summaryBlock(pins: readonly Pin[]): string {
  return [
    SUMMARY_HEADING,
    ...pins.map((pin) => `- [${pin.id}] ${pin.text}\n  Verbatim: ${JSON.stringify(pin.quote)}`),
  ].join("\n")
}

function field(input: Record<string, unknown>, name: string, max: number): string {
  const value = input[name]

  if (typeof value !== "string" || value.trim() === "") throw new Error(`\`${name}\` must be a non-empty string.`)
  if (value.length > max) throw new Error(`\`${name}\` is longer than ${max} characters.`)

  return value
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Input must be an object.")

  return input as Record<string, unknown>
}

export function parsePinInput(input: unknown): PinInput {
  const fields = object(input)
  const text = field(fields, "text", MAX_TEXT_CHARS).trim()
  const quote = field(fields, "quote", MAX_QUOTE_CHARS)

  if (fields.source === undefined) return { text, quote }

  return { text, quote, source: field(fields, "source", MAX_TEXT_CHARS).trim() }
}

export function parseReleaseInput(input: unknown): ReleaseInput {
  const fields = object(input)

  return { id: field(fields, "id", MAX_TEXT_CHARS).trim(), reason: field(fields, "reason", MAX_QUOTE_CHARS).trim() }
}

/** The user message the quote came from: the named one, or the newest that contains it verbatim. */
export function findSource(messages: readonly MessageLike[], quote: string, source?: string): string {
  if (source === undefined) {
    const found = messages.findLast((message) => message.type === "user" && message.text?.includes(quote) === true)

    if (found === undefined) throw new Error("No user message contains the quote verbatim. Copy it exactly from the user's message.")

    return found.id
  }

  const message = messages.find((candidate) => candidate.id === source)

  if (message === undefined) throw new Error(`Message ${source} is not in this session's context.`)
  if (message.type !== "user") throw new Error(`Message ${source} is not a user message.`)
  if (message.text?.includes(quote) !== true) throw new Error(`The quote does not appear verbatim in message ${source}.`)

  return source
}

export function addPin(ledger: Ledger, input: Required<PinInput>, now: number): { ledger: Ledger; pin: Pin; created: boolean } {
  const active = activePins(ledger)
  const existing = active.find((pin) => pin.text === input.text && pin.quote === input.quote && pin.source === input.source)

  if (existing !== undefined) return { ledger, pin: existing, created: false }
  if (active.length >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} constraints can be active; release one first.`)

  const pin: Pin = { id: `c${ledger.next}`, ...input, pinnedAt: now }
  const records = [...ledger.records, { status: "active", pin } as const]

  return { ledger: { next: ledger.next + 1, records: trimReleased(records) }, pin, created: true }
}

export function releasePin(ledger: Ledger, input: ReleaseInput, now: number): { ledger: Ledger; pin: Pin } {
  const record = ledger.records.find((candidate) => candidate.pin.id === input.id)

  if (record === undefined) throw new Error(`No pinned constraint has id ${input.id}.`)
  if (record.status === "released") throw new Error(`Constraint ${input.id} was already released.`)

  const released: PinRecord = { status: "released", pin: record.pin, releasedAt: now, reason: input.reason }
  const records = ledger.records.map((candidate) => (candidate === record ? released : candidate))

  return { ledger: { ...ledger, records }, pin: record.pin }
}

/** Drop the oldest released records once the ledger is full; active pins are capped well below the limit. */
function trimReleased(records: readonly PinRecord[]): PinRecord[] {
  const kept = [...records]

  while (kept.length > MAX_RECORDS) {
    const oldest = kept.findIndex((record) => record.status === "released")

    if (oldest === -1) break

    kept.splice(oldest, 1)
  }

  return kept
}

function isPin(value: unknown): value is Pin {
  if (typeof value !== "object" || value === null) return false

  const pin = value as Record<string, unknown>

  return (
    typeof pin.id === "string" &&
    typeof pin.text === "string" &&
    typeof pin.quote === "string" &&
    typeof pin.source === "string" &&
    typeof pin.pinnedAt === "number"
  )
}

function isRecord(value: unknown): value is PinRecord {
  if (typeof value !== "object" || value === null) return false

  const record = value as Record<string, unknown>

  if (!isPin(record.pin)) return false
  if (record.status === "active") return true

  return record.status === "released" && typeof record.releasedAt === "number" && typeof record.reason === "string"
}

/** A stored ledger, or the empty one when nothing is stored. A malformed ledger is an error, never silently dropped. */
export function parseLedger(value: unknown): Ledger {
  if (value === undefined) return EMPTY_LEDGER

  const ledger = value as { next?: unknown; records?: unknown }

  if (
    typeof ledger !== "object" ||
    ledger === null ||
    typeof ledger.next !== "number" ||
    !Array.isArray(ledger.records) ||
    !ledger.records.every(isRecord)
  ) {
    throw new Error("The stored constraint ledger is malformed.")
  }

  return { next: ledger.next, records: ledger.records }
}
