// Deterministic synthetic coding transcripts with planted facts at known ages.
import { CONSTRAINTS, CORRECTIONS, DISTRACTORS, EXACT, REJECTED } from "./pools.ts"
import type { ConstraintSpec, CorrectionSpec, RejectedSpec } from "./pools.ts"

/** Messages in a transcript; the probe arrives as message number LENGTH. */
export const LENGTH = 108
/** Nominal ages, in messages before the probe, of the planted fact groups. */
export const AGE_BUCKETS = [10, 50, 100] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]
export const TRANSCRIPT_COUNT = 5

export type Item =
  | { readonly kind: "exact"; readonly id: string; readonly subject: string; readonly value: string }
  | { readonly kind: "correction"; readonly id: string; readonly spec: CorrectionSpec; readonly stale: number; readonly current: number }
  | { readonly kind: "rejected"; readonly id: string; readonly spec: RejectedSpec }
  | { readonly kind: "constraint"; readonly id: string; readonly spec: ConstraintSpec }

export interface Planted { readonly item: Item; readonly bucket: AgeBucket; readonly age: number }

export interface Message { readonly role: "user" | "assistant"; readonly text: string }

export interface Transcript {
  readonly index: number
  readonly scenario: string
  readonly messages: readonly Message[]
  readonly planted: readonly Planted[]
}


interface Scenario { readonly name: string; readonly files: readonly string[]; readonly nouns: readonly string[] }

const SCENARIOS: readonly Scenario[] = [
  { name: "invoice-service", files: ["src/invoice/totals.ts", "src/invoice/lines.ts", "src/tax/rates.ts", "src/report/summary.ts"], nouns: ["invoice", "line", "taxRate", "discount"] },
  { name: "sync-cli", files: ["src/cli/args.ts", "src/sync/diff.ts", "src/sync/plan.ts", "src/fs/walk.ts"], nouns: ["entry", "change", "manifest", "chunk"] },
  { name: "search-indexer", files: ["src/index/tokens.ts", "src/index/rank.ts", "src/index/merge.ts", "src/query/parse.ts"], nouns: ["token", "posting", "document", "score"] },
  { name: "mobile-gateway", files: ["src/routes/profile.ts", "src/routes/feed.ts", "src/auth/scopes.ts", "src/cache/keys.ts"], nouns: ["profile", "post", "scope", "device"] },
  { name: "notification-worker", files: ["src/notify/digest.ts", "src/notify/channels.ts", "src/notify/templates.ts", "src/notify/quiet.ts"], nouns: ["notice", "channel", "recipient", "window"] },
]

/** mulberry32: a small seeded generator, so every run builds identical transcripts. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(next: () => number, list: readonly T[]): T => list[Math.floor(next() * list.length)]!
const integer = (next: () => number, low: number, high: number) => low + Math.floor(next() * (high - low + 1))
const token = (next: () => number, length: number) =>
  Array.from({ length }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(next() * 31)]).join("")

/**
 * Positions of a bucket's facts, as message indexes. The stale value of the
 * correction comes first and its correction last, so the correction is the
 * most recent fact of the group: [stale, exact, constraint, rejected, correction].
 */
export function slots(bucket: AgeBucket): readonly number[] {
  const last = LENGTH - bucket
  return [last - 8, last - 6, last - 4, last - 2, last]
}

function items(transcript: number, slot: number, next: () => number): Item[] {
  const pool = transcript * AGE_BUCKETS.length + slot
  const id = (kind: string) => `t${transcript + 1}-${kind}-${AGE_BUCKETS[slot]}`
  const exact = EXACT[pool % EXACT.length]!
  const correction = CORRECTIONS[pool % CORRECTIONS.length]!
  const stale = integer(next, correction.low, correction.high)
  let current = integer(next, correction.low, correction.high)
  while (current === stale) current = integer(next, correction.low, correction.high)
  return [
    { kind: "exact", id: id("exact"), subject: exact.subject, value: `${exact.prefix}-${token(next, 6)}` },
    { kind: "constraint", id: id("constraint"), spec: CONSTRAINTS[pool % CONSTRAINTS.length]! },
    { kind: "rejected", id: id("rejected"), spec: REJECTED[pool % REJECTED.length]! },
    { kind: "correction", id: id("correction"), spec: correction, stale, current },
  ]
}

export interface Mention { readonly user: string; readonly assistant: string }

/**
 * How a fact is said. It rides at the end of an ordinary coding request, the
 * way rules and values come up in real sessions, rather than in a message of
 * its own that a summary would single out.
 */
export function mention(item: Item, phase: "stale" | "final"): Mention {
  switch (item.kind) {
    case "exact":
      return { user: `By the way, ${item.subject} is \`${item.value}\`.`, assistant: `Noted on ${item.subject}.` }
    case "constraint":
      return { user: `Also, going forward: ${item.spec.rule}`, assistant: "Will do." }
    case "rejected":
      return {
        user: `For the record, we tried ${item.spec.rejected} for ${item.spec.topic} and it failed because ${item.spec.reason}, so we're going with ${item.spec.accepted}; don't bring ${item.spec.rejected} back.`,
        assistant: "Makes sense.",
      }
    case "correction":
      return phase === "stale"
        ? { user: `Also set ${item.spec.subject} to ${item.stale} ${item.spec.unit}.`, assistant: `Set ${item.spec.subject} to ${item.stale}.` }
        : { user: `Actually, make ${item.spec.subject} ${item.current} ${item.spec.unit} instead of ${item.stale}.`, assistant: `Updated ${item.spec.subject} to ${item.current}.` }
  }
}

const FILLER_ASKS = [
  "Can you refactor `{fn}` in `{file}` so it handles an empty list?",
  "The `{fn}` helper in `{file}` is getting long. Can you pull the {noun} grouping out?",
  "Add a test for `{fn}` in `{file}` that covers {count} {noun} records.",
  "Rename the old `{noun}Rows` helper to `{fn}` in `{file}` and tidy it up.",
  "Why does `{fn}` in `{file}` return nothing for a single {noun}? Please fix it.",
]

const SNIPPETS = [
  "interface {Noun}Group {\n  readonly key: string\n  readonly items: readonly {Noun}[]\n}\n\nfunction {fn}(items: readonly {Noun}[]): {Noun}Group[] {\n  const groups = new Map<string, {Noun}[]>()\n  for (const item of items) {\n    const bucket = groups.get(item.{field}) ?? []\n    bucket.push(item)\n    groups.set(item.{field}, bucket)\n  }\n  return [...groups].map(([key, members]) => ({ key, items: members }))\n}",
  "function {fn}(items: readonly {Noun}[], limit = {count}): {Noun}[] {\n  if (items.length === 0) return []\n  const sorted = [...items].sort((a, b) => a.{field}.localeCompare(b.{field}))\n  const unique = sorted.filter((item, index) => index === 0 || item.{field} !== sorted[index - 1]!.{field})\n  return unique.slice(0, limit)\n}",
  "test(\"{fn} keeps {count} {noun} records in order\", () => {\n  const items = Array.from({ length: {count} }, (_, index) => make{Noun}({ {field}: \`k\${index}\` }))\n  const result = {fn}(items)\n  expect(result.map(item => item.{field})).toEqual(items.map(item => item.{field}))\n  expect(result).toHaveLength({count})\n})",
  "function {fn}(items: readonly {Noun}[]): Map<string, number> {\n  const totals = new Map<string, number>()\n  for (const item of items) {\n    totals.set(item.{field}, (totals.get(item.{field}) ?? 0) + 1)\n  }\n  return totals\n}",
]

const EXPLANATIONS = [
  "This stays a single pass over the input, and the Map keeps insertion order, so the snapshot tests stay stable. An empty input now returns an empty result instead of falling through.",
  "I kept the signature the same so callers don't change. The sort is on a copy, so the caller's array is never mutated, which was the source of the flaky ordering we saw last week.",
  "The test builds its fixtures inline so it doesn't depend on the shared factory state. If this passes locally I'd run the whole suite once before we move on, since two other modules import this helper.",
  "Nothing else in the module needed to change. I left the old name out entirely rather than re-exporting it, so any stale import fails loudly at type-check time.",
]

/** Share of ordinary requests that also change an unprobed setting. */
const DISTRACTOR_RATE = 0.35

const FIELDS = ["id", "key", "group", "owner", "kind"]
const VERBS = ["group", "dedupe", "rank", "count", "merge", "split", "collect"]

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function filler(scenario: Scenario, next: () => number): Message[] {
  const noun = pick(next, scenario.nouns)
  const values: Record<string, string> = {
    noun,
    Noun: noun[0]!.toUpperCase() + noun.slice(1),
    file: pick(next, scenario.files),
    fn: `${pick(next, VERBS)}${noun[0]!.toUpperCase()}${noun.slice(1)}s`,
    field: pick(next, FIELDS),
    count: String(integer(next, 3, 40)),
  }
  const first = fill(pick(next, SNIPPETS), values)
  const second = fill(pick(next, SNIPPETS), { ...values, fn: `${values.fn}Sorted`, field: pick(next, FIELDS) })
  const passed = integer(next, 4, 30)
  const lead = integer(next, 0, EXPLANATIONS.length - 1)
  const explanation = `${EXPLANATIONS[lead]} ${EXPLANATIONS[(lead + 1) % EXPLANATIONS.length]}`
  const run = [
    `$ bun test ${values.file.replace(/\.ts$/, ".test.ts")}`,
    ...Array.from({ length: 4 }, (_, n) => ` ✓ ${values.fn} case ${n + 1} [${(next() * 3).toFixed(2)}ms]`),
    `\n ${passed} pass\n 0 fail\n Ran ${passed} tests across 1 file. [${integer(next, 40, 400)}ms]`,
  ].join("\n")
  const aside = next() < DISTRACTOR_RATE ? pick(next, DISTRACTORS) : undefined
  const asideValue = aside ? integer(next, aside.low, aside.high) : 0
  const ask = fill(pick(next, FILLER_ASKS), values)
  return [
    { role: "user", text: aside ? `${ask} While you're in there, set ${aside.subject} to ${asideValue} ${aside.unit}.` : ask },
    {
      role: "assistant",
      text: `Here's the change in \`${values.file}\`:\n\n\`\`\`ts\n${first}\n\`\`\`\n\nAnd the sorted variant the report needs:\n\n\`\`\`ts\n${second}\n\`\`\`\n\n\`\`\`\n${run}\n\`\`\`\n\n${explanation}${aside ? ` I also set ${aside.subject} to ${asideValue}.` : ""}`,
    },
  ]
}

/** Builds transcript `index` (0-based). The same seed always yields the same transcript. */
export function buildTranscript(index: number, seed: number): Transcript {
  const next = random(seed * 1_000 + index)
  const scenario = SCENARIOS[index % SCENARIOS.length]!
  const slotted = new Map<number, Mention>()
  const planted: Planted[] = []
  AGE_BUCKETS.forEach((bucket, slot) => {
    const [staleAt, ...at] = slots(bucket)
    const group = items(index, slot, next)
    const correction = group[3]!
    slotted.set(staleAt!, mention(correction, "stale"))
    group.forEach((item, position) => {
      slotted.set(at[position]!, mention(item, "final"))
      planted.push({ item, bucket, age: LENGTH - at[position]! })
    })
  })
  const messages: Message[] = []
  while (messages.length < LENGTH) {
    const [ask, reply] = filler(scenario, next)
    const fact = slotted.get(messages.length)
    messages.push(
      fact ? { role: "user", text: `${ask!.text} ${fact.user}` } : ask!,
      fact ? { role: "assistant", text: `${reply!.text}\n\n${fact.assistant}` } : reply!,
    )
  }
  if (messages.length !== LENGTH) throw new Error(`transcript ${index} has ${messages.length} messages, expected ${LENGTH}`)
  return { index, scenario: scenario.name, messages, planted }
}

export interface Probe { readonly text: string; readonly keys: ReadonlyMap<string, Item> }

export function question(item: Item): string {
  switch (item.kind) {
    case "exact": return `What is the exact value of ${item.subject}? Give just the string.`
    case "correction": return `What is ${item.spec.subject}, in ${item.spec.unit}? Give just the number.`
    case "rejected": return `Which approach do we use for ${item.spec.topic}? Name it in a few words.`
    case "constraint": return `Write one line of TypeScript that ${item.spec.task}. Give just the code line.`
  }
}

/** One question per planted fact, in a seeded order, keyed q1…qN so keys reveal nothing. */
export function buildProbe(transcript: Transcript, seed: number): Probe {
  const next = random(seed * 7_919 + transcript.index)
  const order = transcript.planted.map(planted => ({ item: planted.item, sort: next() })).sort((a, b) => a.sort - b.sort)
  const keys = new Map(order.map(({ item }, position) => [`q${position + 1}`, item] as const))
  const lines = [...keys].map(([key, item]) => `${key}: ${question(item)}`)
  const text = [
    "Before I hand this project off, answer these from what we agreed in this session.",
    "If you have tools that can look up earlier parts of this conversation or pinned rules, use them when you are unsure. Do not create or modify any files.",
    `Reply with only a JSON object whose keys are ${[...keys.keys()].join(", ")} and whose values are your answers as strings.`,
    "",
    ...lines,
  ].join("\n")
  return { text, keys }
}
