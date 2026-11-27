// One run: one arm on one transcript, in its own isolated OpenCode.
import { Instance } from "./opencode.ts"
import type { ModelRef } from "./opencode.ts"
import { parseAnswers, scoreItem } from "./score.ts"
import type { ItemScore } from "./score.ts"
import { LENGTH, buildProbe, random } from "./transcripts.ts"
import type { Item, Transcript } from "./transcripts.ts"

export type ArmID = "A" | "B" | "C" | "D"

export interface Arm {
  readonly id: ArmID
  readonly label: string
  readonly compact: boolean
  readonly history: boolean
  readonly pinned: boolean
}

export const ARMS: readonly Arm[] = [
  { id: "A", label: "native compaction", compact: true, history: false, pinned: false },
  { id: "B", label: "A + history_search", compact: true, history: true, pinned: false },
  { id: "C", label: "B + pinned constraints", compact: true, history: true, pinned: true },
  { id: "D", label: "full context (oracle)", compact: false, history: false, pinned: false },
]

export const PIN_PROMPT = [
  "Before we continue: use your constraint tools to pin every rule, decision and exact value from this conversation that is still in force, quoting my words exactly.",
  "Release any pin that a later message overrode. Do not create or modify any files. Reply DONE when finished.",
].join(" ")

export interface Settings {
  readonly scratch: string
  readonly model: ModelRef
  readonly keepTokens: number
  readonly turnTimeoutMs: number
  readonly seed: number
  readonly credential: string
  readonly historyPlugin?: string
  readonly pinnedPlugin?: string
}

export interface Usage { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }

export interface RunRecord {
  readonly arm: ArmID
  readonly transcript: number
  readonly status: "ok" | "error" | "skipped"
  readonly reason?: string
  readonly scores: readonly ItemScore[]
  readonly reply?: string
  /** Tool calls the model made while answering the probe, by tool name. */
  readonly probeTools: Readonly<Record<string, number>>
  /** Tool calls during the pin pass (arm C only), by tool name. */
  readonly pinTools: Readonly<Record<string, number>>
  readonly usage: Usage
  readonly wallMs: number
  /** Age of the oldest message compaction kept verbatim; null when nothing was kept or there was no compaction. */
  readonly verbatimFromAge: number | null
  /** The model's context window as OpenCode reports it, when known. */
  readonly contextLimit?: number
}

/** Loosely typed view of the session messages the API returns. */
export interface ApiMessage {
  id: string
  type: string
  text?: string
  status?: string
  outcome?: string
  error?: { message?: string }
  metadata?: { keepID?: string }
  content?: Array<{ type: string; text?: string; name?: string }>
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export function pluginsFor(arm: Arm, settings: Settings): string[] | string {
  const plugins: string[] = []
  if (arm.history) {
    if (!settings.historyPlugin) return "needs --history-plugin"
    plugins.push(settings.historyPlugin)
  }
  if (arm.pinned) {
    if (!settings.pinnedPlugin) return "needs --pinned-plugin"
    plugins.push(settings.pinnedPlugin)
  }
  return plugins
}

export function skipped(arm: Arm, transcript: Transcript, reason: string): RunRecord {
  return { arm: arm.id, transcript: transcript.index, status: "skipped", reason, scores: [], probeTools: {}, pinTools: {}, usage: emptyUsage(), wallMs: 0, verbatimFromAge: null }
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

/** The transcript as OpenCode's session import format, with IDs that sort before anything the run adds. */
export function importMessages(transcript: Transcript, model: ModelRef, seed: number, start: number) {
  const next = random(seed * 104_729 + transcript.index)
  const tag = Array.from({ length: 14 }, () => "abcdefghijkmnopqrstuvwxyz"[Math.floor(next() * 25)]).join("")
  return transcript.messages.map((message, index) => {
    const id = `msg_0000${index.toString(16).padStart(8, "0")}${tag}`
    const created = start + index * 30_000
    return message.role === "user"
      ? { id, type: "user", text: message.text, time: { created } }
      : { id, type: "assistant", agent: "build", model, content: [{ type: "text", text: message.text }], finish: "stop", time: { created, completed: created + 1_000 } }
  })
}

export function runArm(arm: Arm, transcript: Transcript, settings: Settings): RunRecord {
  const plugins = pluginsFor(arm, settings)
  if (typeof plugins === "string") return skipped(arm, transcript, plugins)
  const instance = new Instance({ scratch: settings.scratch, model: settings.model, plugins, keepTokens: settings.keepTokens, turnTimeoutMs: settings.turnTimeoutMs })
  try {
    instance.start(settings.credential)
    return conduct(instance, arm, transcript, settings)
  } catch (error) {
    return { ...skipped(arm, transcript, error instanceof Error ? error.message : String(error)), status: "error" }
  } finally {
    instance.dispose()
  }
}

/** Rough token estimate for the oracle's fit check: code-heavy text runs about 3 characters per token. */
export const estimateTokens = (transcript: Transcript) => Math.ceil(transcript.messages.reduce((total, message) => total + message.text.length, 0) / 3)

function contextLimit(instance: Instance, model: ModelRef): number | undefined {
  const models = instance.api<Array<{ providerID: string; modelID?: string; id: string; limit?: { context: number } }>>(
    "GET", `/api/model?location[directory]=${encodeURIComponent(instance.work)}`)
  return models.find(entry => entry.providerID === model.providerID && (entry.modelID ?? entry.id) === model.id)?.limit?.context
}

function conduct(instance: Instance, arm: Arm, transcript: Transcript, settings: Settings): RunRecord {
  const limit = contextLimit(instance, settings.model)
  if (!arm.compact && limit !== undefined && estimateTokens(transcript) > limit * 0.8) {
    return { ...skipped(arm, transcript, `transcript (~${estimateTokens(transcript)} tokens) does not fit 80% of the ${limit}-token context`), contextLimit: limit }
  }
  const sessionID = importTranscript(instance, transcript, settings)
  const started = performance.now()
  if (arm.pinned) turn(instance, sessionID, PIN_PROMPT)
  if (arm.compact) {
    instance.api("POST", `/api/session/${sessionID}/compact`, {})
    waitIdle(instance, sessionID)
  }
  const probe = buildProbe(transcript, settings.seed)
  turn(instance, sessionID, probe.text)
  const wallMs = Math.round(performance.now() - started)
  const messages = listMessages(instance, sessionID)
  return { ...summarize(arm, transcript, messages, probe.text, probe.keys, wallMs), contextLimit: limit }
}

function importTranscript(instance: Instance, transcript: Transcript, settings: Settings): string {
  const location = { directory: instance.work }
  const seed = instance.api<{ id: string; projectID: string }>("POST", "/api/session", { title: "seed", model: settings.model, location })
  const next = random(settings.seed * 31 + transcript.index)
  const sessionID = `ses_${seed.id.slice(4, 16)}${Array.from({ length: 14 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"[Math.floor(next() * 47)]).join("")}`
  instance.api("DELETE", `/api/session/${seed.id}`)
  const start = Date.now() - (LENGTH + 10) * 30_000
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const info = { id: sessionID, projectID: seed.projectID, model: settings.model, cost: 0, tokens: zero, time: { created: start, updated: start }, title: `recall ${transcript.scenario}`, location }
  instance.api("POST", "/api/experimental/session/import", { info, messages: importMessages(transcript, settings.model, settings.seed, start), location })
  return sessionID
}

const PAGE_SIZE = 100
const MAX_PAGES = 20

/** Every message of the session, oldest first, following cursors for at most MAX_PAGES pages. */
function listMessages(instance: Instance, sessionID: string): ApiMessage[] {
  const messages: ApiMessage[] = []
  let query = `limit=${PAGE_SIZE}&order=asc`
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = instance.response<{ data: ApiMessage[]; cursor?: { next?: string } }>("GET", `/api/session/${sessionID}/message?${query}`)
    const batch = body?.data ?? []
    messages.push(...batch)
    if (batch.length < PAGE_SIZE || !body?.cursor?.next) return messages
    query = `limit=${PAGE_SIZE}&cursor=${encodeURIComponent(body.cursor.next)}`
  }
  throw new Error(`session ${sessionID} has more than ${PAGE_SIZE * MAX_PAGES} messages`)
}

/** Blocks until the session is idle; past the turn timeout it interrupts the session and throws. */
function waitIdle(instance: Instance, sessionID: string): void {
  try {
    instance.api("POST", `/api/experimental/session/${sessionID}/wait`, {})
  } catch (error) {
    try { instance.api("POST", `/api/session/${sessionID}/interrupt`, {}, 30_000) } catch { /* the run is torn down next */ }
    throw error
  }
}

/** Sends one prompt and blocks until the session is idle again; a failed turn throws with the provider's message. */
function turn(instance: Instance, sessionID: string, text: string): void {
  instance.api("POST", `/api/session/${sessionID}/prompt`, { text })
  waitIdle(instance, sessionID)
  const [last] = instance.api<ApiMessage[]>("GET", `/api/session/${sessionID}/message?limit=1`)
  if (last?.type === "idle" && last.outcome === "failed") throw new Error(`turn failed: ${last.error?.message ?? "unknown error"}`)
}

const IMPORTED = /^msg_0000([0-9a-f]{8})/

function countTools(messages: readonly ApiMessage[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const message of messages) {
    for (const part of message.content ?? []) if (part.type === "tool" && part.name) counts[part.name] = (counts[part.name] ?? 0) + 1
  }
  return counts
}

function addUsage(messages: readonly ApiMessage[]): Usage {
  const usage = emptyUsage()
  for (const message of messages) {
    if (IMPORTED.test(message.id) || !message.tokens) continue
    usage.input += message.tokens.input
    usage.output += message.tokens.output
    usage.reasoning += message.tokens.reasoning
    usage.cacheRead += message.tokens.cache.read
    usage.cacheWrite += message.tokens.cache.write
    usage.cost += message.cost ?? 0
  }
  return usage
}

function finalReply(turnMessages: readonly ApiMessage[]): string {
  const texts = turnMessages
    .filter(message => message.type === "assistant")
    .map(message => (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join(""))
    .filter(text => text.trim().length > 0)
  return texts.at(-1) ?? ""
}

/** Age of the first message compaction kept verbatim, from the transcript index encoded in its imported ID. */
export function keptAge(keepID: string | undefined): number | null {
  const match = keepID ? IMPORTED.exec(keepID) : null
  return match ? LENGTH - Number.parseInt(match[1]!, 16) : null
}

export function summarize(arm: Arm, transcript: Transcript, messages: readonly ApiMessage[], probeText: string, keys: ReadonlyMap<string, Item>, wallMs: number): RunRecord {
  const compaction = messages.find(message => message.type === "compaction")
  const base = { ...skipped(arm, transcript, ""), usage: addUsage(messages), wallMs, verbatimFromAge: keptAge(compaction?.metadata?.keepID) }
  if (arm.compact && compaction?.status !== "completed") {
    return { ...base, status: "error", reason: `compaction ${compaction?.status ?? "missing"}: ${compaction?.error?.message ?? ""}` }
  }
  const probeAt = messages.findIndex(message => message.type === "user" && message.text === probeText)
  const pinAt = messages.findIndex(message => message.type === "user" && message.text === PIN_PROMPT)
  const probeTurn = messages.slice(probeAt + 1)
  const reply = finalReply(probeTurn)
  const answers = parseAnswers(reply)
  const keyOf = new Map([...keys].map(([key, item]) => [item.id, key]))
  const scores = transcript.planted.map(({ item, bucket, age }): ItemScore => {
    const answer = answers.get(keyOf.get(item.id) ?? "")
    return { id: item.id, kind: item.kind, bucket, age, answer: answer ?? null, ...scoreItem(item, answer) }
  })
  return {
    ...base,
    status: probeAt < 0 ? "error" : "ok",
    reason: probeAt < 0 ? "probe message not found" : undefined,
    scores,
    reply,
    probeTools: countTools(probeTurn),
    pinTools: pinAt < 0 ? {} : countTools(messages.slice(pinAt + 1, probeAt < 0 ? undefined : probeAt)),
  }
}
