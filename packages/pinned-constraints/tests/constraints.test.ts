import { afterEach, expect, test } from "bun:test"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import plugin from "../index.ts"
import { ledgerKey, register } from "../src/constraints.ts"
import { entryValue, MAX_ACTIVE, summaryBlock, type Pin } from "../src/pins.ts"
import { fakeHost, OTHER_SESSION, SESSION } from "./fake-host.ts"

const QUOTE = "never touch the prod database"
const MESSAGES = [
  { id: "msg_1", type: "user", text: `Please ${QUOTE}, use staging.` },
  { id: "msg_2", type: "assistant" },
  { id: "msg_3", type: "user", text: "Keep the column name `user_id`." },
]

const C1: Pin = { id: "c1", text: "Do not touch the prod database.", quote: QUOTE, source: "msg_1", pinnedAt: 1_000 }
const C2: Pin = { id: "c2", text: "Column stays user_id.", quote: "`user_id`", source: "msg_3", pinnedAt: 1_000 }

const running: (() => void)[] = []

afterEach(() => running.splice(0).forEach((stop) => stop()))

async function setup() {
  const fake = fakeHost(MESSAGES)
  const { stop } = await register(fake.host, () => 1_000)

  running.push(stop)

  return fake
}

/** Wait, at most 100 event-loop turns, for the plugin's event loop to catch up. */
async function settle(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !done(); turn++) await Bun.sleep(1)
}

async function pinBoth(fake: Awaited<ReturnType<typeof setup>>) {
  await fake.call("constraint_pin", { text: C1.text, quote: QUOTE })
  await fake.call("constraint_pin", { text: C2.text, quote: "`user_id`", source: "msg_3" })
}

test("the plugin registers three tools and the context and compaction hooks", async () => {
  const fake = await setup()

  expect(plugin.id).toBe("pinned-constraints")
  expect([...fake.tools.keys()]).toEqual(["constraint_pin", "constraint_list", "constraint_release"])
  expect([...fake.hooks.keys()]).toEqual(["context", "compaction"])
})

test("a pin is stored in the ledger and put as a keyed instruction entry, word for word", async () => {
  const fake = await setup()

  expect(await fake.call("constraint_pin", { text: `  ${C1.text} `, quote: QUOTE })).toBe(`Pinned c1: ${C1.text}`)
  expect(fake.storage.get(ledgerKey(SESSION))).toEqual({ next: 2, records: [{ status: "active", pin: C1 }] })
  expect([...fake.entries]).toEqual([["constraint.c1", entryValue(C1)]])
  expect(entryValue(C1)).toBe(`Pinned constraint c1: ${C1.text}\nVerbatim from message msg_1:\n${QUOTE}`)
})

test("pinning the same constraint twice keeps one pin", async () => {
  const fake = await setup()

  await fake.call("constraint_pin", { text: C1.text, quote: QUOTE })

  expect(await fake.call("constraint_pin", { text: C1.text, quote: QUOTE, source: "msg_1" })).toBe(`Already pinned as c1: ${C1.text}`)
  expect([...fake.entries.keys()]).toEqual(["constraint.c1"])
})

test("a quote must appear verbatim in a user message", async () => {
  const fake = await setup()
  const pin = (input: object) => fake.call("constraint_pin", { text: "x", ...input })

  await expect(pin({ quote: "never touch prod" })).rejects.toThrow(new Error("No user message contains the quote verbatim. Copy it exactly from the user's message."))
  await expect(pin({ quote: QUOTE, source: "msg_3" })).rejects.toThrow(new Error("The quote does not appear verbatim in message msg_3."))
  await expect(pin({ quote: QUOTE, source: "msg_2" })).rejects.toThrow(new Error("Message msg_2 is not a user message."))
  await expect(pin({ quote: QUOTE, source: "msg_9" })).rejects.toThrow(new Error("Message msg_9 is not in this session's context."))
  await expect(pin({ quote: "" })).rejects.toThrow(new Error("`quote` must be a non-empty string."))
  await expect(fake.call("constraint_pin", "nope")).rejects.toThrow(new Error("Input must be an object."))
  expect(fake.entries.size).toBe(0)
})

test("parallel pins get distinct ids", async () => {
  const fake = await setup()

  await Promise.all([
    fake.call("constraint_pin", { text: C1.text, quote: QUOTE }),
    fake.call("constraint_pin", { text: C2.text, quote: "`user_id`" }),
  ])

  expect([...fake.entries]).toEqual([
    ["constraint.c1", entryValue(C1)],
    ["constraint.c2", entryValue(C2)],
  ])
})

test("at most MAX_ACTIVE constraints are active", async () => {
  const fake = await setup()

  for (let index = 0; index < MAX_ACTIVE; index++) await fake.call("constraint_pin", { text: `rule ${index}`, quote: QUOTE })

  await expect(fake.call("constraint_pin", { text: "one more", quote: QUOTE })).rejects.toThrow(new Error(`At most ${MAX_ACTIVE} constraints can be active; release one first.`))
  expect(fake.entries.size).toBe(MAX_ACTIVE)
})

test("list shows active and released pins", async () => {
  const fake = await setup()

  expect(await fake.call("constraint_list", {})).toBe("No pinned constraints.")

  await pinBoth(fake)
  await fake.call("constraint_release", { id: "c1", reason: "User: prod is fine now" })

  expect(await fake.call("constraint_list", {})).toBe(
    [
      `- [c1] released: ${C1.text}`,
      "  Overridden: User: prod is fine now",
      `- [c2] active: ${C2.text}`,
      '  Verbatim (msg_3): "`user_id`"',
    ].join("\n"),
  )
})

test("release marks a pin overridden and removes its entry", async () => {
  const fake = await setup()

  await pinBoth(fake)

  expect(await fake.call("constraint_release", { id: "c1", reason: "use prod" })).toBe("Released c1 (overridden: use prod).")
  expect(fake.storage.get(ledgerKey(SESSION))).toEqual({
    next: 3,
    records: [
      { status: "released", pin: C1, releasedAt: 1_000, reason: "use prod" },
      { status: "active", pin: C2 },
    ],
  })
  expect([...fake.entries.keys()]).toEqual(["constraint.c2"])
  await expect(fake.call("constraint_release", { id: "c1", reason: "again" })).rejects.toThrow(new Error("Constraint c1 was already released."))
  await expect(fake.call("constraint_release", { id: "c9", reason: "x" })).rejects.toThrow(new Error("No pinned constraint has id c9."))
})

test("the context hook adds a compact system part listing active pins", async () => {
  const fake = await setup()
  const empty = fake.contextEvent()

  await fake.hooks.get("context")?.(empty)

  expect(empty.system).toEqual([])
  expect(fake.calls).toEqual([])

  await pinBoth(fake)
  fake.calls.length = 0

  const event = fake.contextEvent()

  await fake.hooks.get("context")?.(event)

  expect(fake.calls).toEqual(["list"])

  expect(event.system).toEqual([
    {
      type: "text",
      text: [
        "Active constraints pinned by the user. Follow each until constraint_release marks it overridden:",
        `- [c1] ${C1.text}`,
        `- [c2] ${C2.text}`,
      ].join("\n"),
    },
  ])
})

function compactionEvent(result?: { summary: string }): SessionHooks["compaction"] {
  return { sessionID: SESSION, system: [], result } as unknown as SessionHooks["compaction"]
}

test("compaction re-puts missing and altered entries and drops stale ones", async () => {
  const fake = await setup()

  await pinBoth(fake)
  fake.entries.delete("constraint.c1")
  fake.entries.set("constraint.c2", "paraphrased")
  fake.entries.set("constraint.c7", "stale")
  fake.entries.set("other-plugin", "kept")
  fake.calls.length = 0

  await fake.hooks.get("compaction")?.(compactionEvent({ summary: "Summary." }))

  expect(fake.calls).toEqual(["list", "put constraint.c1", "put constraint.c2", "remove constraint.c7"])
  expect(Object.fromEntries(fake.entries)).toEqual({
    "constraint.c1": entryValue(C1),
    "constraint.c2": entryValue(C2),
    "other-plugin": "kept",
  })
})

test("compaction appends the Active constraints block to a summary that lacks it, once", async () => {
  const fake = await setup()

  await pinBoth(fake)

  const block = summaryBlock([C1, C2])
  const event = compactionEvent({ summary: "Summary." })

  await fake.hooks.get("compaction")?.(event)

  expect(event.result).toEqual({ summary: `Summary.\n\n${block}` })
  expect(block).toBe(
    [
      "## Active constraints",
      `- [c1] ${C1.text}`,
      `  Verbatim: "${QUOTE}"`,
      `- [c2] ${C2.text}`,
      '  Verbatim: "`user_id`"',
    ].join("\n"),
  )

  await fake.hooks.get("compaction")?.(event)

  expect(event.result).toEqual({ summary: `Summary.\n\n${block}` })
})

test("before a native summary, the compaction hook leaves the request alone", async () => {
  const fake = await setup()

  await pinBoth(fake)

  const event = compactionEvent()

  await fake.hooks.get("compaction")?.(event)

  expect(event.result).toBeUndefined()
  expect(event.system).toEqual([])
})

test("after a native compaction without the block, missing pins are re-put and the block follows the summary", async () => {
  const fake = await setup()

  await pinBoth(fake)
  await fake.call("constraint_release", { id: "c2", reason: "rename allowed" })
  fake.entries.clear()
  fake.compactionEnded(SESSION, "Native summary that paraphrases the rules.")
  await settle(() => fake.synthetics.length > 0)

  expect([...fake.entries]).toEqual([["constraint.c1", entryValue(C1)]])
  expect(fake.synthetics).toEqual([
    { sessionID: SESSION, text: summaryBlock([C1]), description: "Active constraints", resume: false },
  ])
})

test("after a compaction whose summary has the block, or in another location, nothing is added", async () => {
  const fake = await setup()

  await pinBoth(fake)
  fake.compactionEnded(OTHER_SESSION, "Summary.")
  fake.compactionEnded(SESSION, `Summary.\n\n${summaryBlock([C1, C2])}`)
  fake.compactionEnded(SESSION, "Second summary.")
  await settle(() => fake.synthetics.length > 0)

  expect(fake.synthetics).toEqual([
    { sessionID: SESSION, text: summaryBlock([C1, C2]), description: "Active constraints", resume: false },
  ])
})

test("a malformed stored ledger is an error, not an empty one", async () => {
  const fake = await setup()

  fake.storage.set(ledgerKey(SESSION), { next: "one", records: [] })

  await expect(fake.call("constraint_list", {})).rejects.toThrow(new Error("The stored constraint ledger is malformed."))
})
