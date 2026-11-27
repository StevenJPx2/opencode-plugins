import { describe, expect, test } from "bun:test"
import { ARMS, PIN_PROMPT, importMessages, keptAge, summarize } from "./arms.ts"
import type { ApiMessage } from "./arms.ts"
import { accessOnly, parseModel } from "./opencode.ts"
import { armRow } from "./report.ts"
import { parseAnswers, scoreItem } from "./score.ts"
import { CONSTRAINTS, REJECTED } from "./pools.ts"
import { AGE_BUCKETS, LENGTH, TRANSCRIPT_COUNT, buildProbe, buildTranscript, slots } from "./transcripts.ts"
import type { Item } from "./transcripts.ts"

const transcripts = Array.from({ length: TRANSCRIPT_COUNT }, (_, index) => buildTranscript(index, 1))
const itemOf = <K extends Item["kind"]>(kind: K) => transcripts[0]!.planted.find(planted => planted.item.kind === kind)!.item as Extract<Item, { kind: K }>

describe("transcripts", () => {
  test("are deterministic for a seed and differ across seeds", () => {
    expect(buildTranscript(2, 1)).toEqual(transcripts[2]!)
    expect(buildTranscript(2, 2).messages).not.toEqual(transcripts[2]!.messages)
  })

  test("alternate user and assistant for exactly LENGTH messages", () => {
    for (const transcript of transcripts) {
      expect(transcript.messages.length).toBe(LENGTH)
      expect(transcript.messages.map(message => message.role)).toEqual(Array.from({ length: LENGTH }, (_, index) => index % 2 === 0 ? "user" : "assistant"))
    }
  })

  test("plant four facts per age bucket at the documented ages", () => {
    const ages = transcripts[0]!.planted.map(planted => [planted.item.kind, planted.age])
    expect(ages).toEqual([
      ["exact", 16], ["constraint", 14], ["rejected", 12], ["correction", 10],
      ["exact", 56], ["constraint", 54], ["rejected", 52], ["correction", 50],
      ["exact", 106], ["constraint", 104], ["rejected", 102], ["correction", 100],
    ])
    expect(slots(100)[0]).toBe(0)
  })

  test("say each fact in the user message at its age, and the stale value before the correction", () => {
    for (const transcript of transcripts) {
      for (const { item, age } of transcript.planted) {
        const said = transcript.messages[LENGTH - age]!.text
        if (item.kind === "exact") expect(said.endsWith(`is \`${item.value}\`.`)).toBe(true)
        if (item.kind === "correction") {
          expect(said.endsWith(`make ${item.spec.subject} ${item.current} ${item.spec.unit} instead of ${item.stale}.`)).toBe(true)
          expect(transcript.messages[LENGTH - age - 8]!.text.endsWith(`set ${item.spec.subject} to ${item.stale} ${item.spec.unit}.`)).toBe(true)
        }
      }
    }
  })

  test("never reuse a planted value or pool entry across transcripts", () => {
    const keys = transcripts.flatMap(transcript => transcript.planted.map(({ item }) =>
      item.kind === "exact" ? item.value : item.kind === "correction" ? item.spec.subject : item.kind === "rejected" ? item.spec.topic : item.spec.rule))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("probe asks one question per fact under opaque keys", () => {
    const probe = buildProbe(transcripts[0]!, 1)
    expect([...probe.keys.keys()]).toEqual(Array.from({ length: 12 }, (_, index) => `q${index + 1}`))
    expect(new Set([...probe.keys.values()].map(item => item.id))).toEqual(new Set(transcripts[0]!.planted.map(planted => planted.item.id)))
  })
})

describe("scoring", () => {
  test("exact strings must appear verbatim", () => {
    const item = itemOf("exact")
    expect(scoreItem(item, `It's ${item.value}`)).toEqual({ correct: true, stale: false, violation: false })
    expect(scoreItem(item, item.value.toUpperCase())).toEqual({ correct: false, stale: false, violation: false })
    expect(scoreItem(item, undefined)).toEqual({ correct: false, stale: false, violation: false })
  })

  test("corrections separate the current value from the stale one", () => {
    const item = itemOf("correction")
    expect(scoreItem(item, String(item.current))).toEqual({ correct: true, stale: false, violation: false })
    expect(scoreItem(item, `${item.stale}`)).toEqual({ correct: false, stale: true, violation: false })
    expect(scoreItem(item, `${item.current} (was ${item.stale})`)).toEqual({ correct: true, stale: false, violation: false })
  })

  test("rejected approaches count as stale only without the accepted one", () => {
    const item = itemOf("rejected")
    expect(scoreItem(item, item.spec.accepted)).toEqual({ correct: true, stale: false, violation: false })
    expect(scoreItem(item, item.spec.rejected)).toEqual({ correct: false, stale: true, violation: false })
    expect(scoreItem(item, `${item.spec.accepted}, not ${item.spec.rejected}`)).toEqual({ correct: true, stale: false, violation: false })
  })

  test("constraints need every required pattern and no banned one", () => {
    const item = itemOf("constraint")
    expect(item.spec.task).toBe("sends a GET request to /api/users")
    expect(scoreItem(item, "await httpClient.request({ method: 'GET', url: '/api/users' })")).toEqual({ correct: true, stale: false, violation: false })
    expect(scoreItem(item, "await fetch('/api/users')")).toEqual({ correct: false, stale: false, violation: true })
    expect(scoreItem(item, "await api.get('/api/users')")).toEqual({ correct: false, stale: false, violation: false })
  })

  test("every pool rule accepts a compliant line and flags a typical violation", () => {
    const lines: Array<[string, string]> = [
      ["const users = await httpClient.request({ method: 'GET', url: '/api/users' })", "const users = await axios.get('/api/users')"],
      ["payload.createdAt = d.toISOString()", "payload.createdAt = d.getTime()"],
      ["logger.event('user.signed_in', { userId })", "console.log('signed in', userId)"],
      ["const price: bigint = 1250n", "const price = 12.5"],
      ["const url = config.get('DATABASE_URL')", "const url = process.env.DATABASE_URL"],
      ["return Result.err('invalid email')", "throw new Error('invalid email')"],
      ["const id = newId('inv')", "const id = crypto.randomUUID()"],
      ["const rows = await sql`select * from users where id = ${userId}`", "const rows = await db.query('select * from users where id = ' + userId)"],
      ["const day = formatDate(d, 'yyyy-MM-dd')", "const day = moment(d).format('YYYY-MM-DD')"],
      ["const enabled = flags.isOn('new-search')", "const enabled = process.env.NEW_SEARCH === 'true'"],
      ["await clock.sleep(250)", "await new Promise(resolve => setTimeout(resolve, 250))"],
      ["const file = path.join(dir, 'config.json')", "const file = dir + '/config.json'"],
      ["export function parseInvoice() {}", "export default function parseInvoice() {}"],
      ["throw new AppError('not_found', 'order not found')", "throw new Error('order not found')"],
      ["const digest = hash.sha256(body)", "const digest = createHash('md5').update(body).digest('hex')"],
    ]
    expect(lines.length).toBe(CONSTRAINTS.length)
    CONSTRAINTS.forEach((spec, index) => {
      const item: Item = { kind: "constraint", id: `c${index}`, spec }
      expect([index, scoreItem(item, lines[index]![0])]).toEqual([index, { correct: true, stale: false, violation: false }])
      expect([index, scoreItem(item, lines[index]![1])]).toEqual([index, { correct: false, stale: false, violation: true }])
    })
    REJECTED.forEach((spec, index) => {
      const item: Item = { kind: "rejected", id: `r${index}`, spec }
      expect([index, scoreItem(item, spec.accepted)]).toEqual([index, { correct: true, stale: false, violation: false }])
      expect([index, scoreItem(item, spec.rejected)]).toEqual([index, { correct: false, stale: true, violation: false }])
    })
  })

  test("answers parse from fenced JSON or from qN lines", () => {
    expect(parseAnswers('Sure:\n```json\n{"q1": "a", "q2": 7}\n```')).toEqual(new Map([["q1", "a"], ["q2", "7"]]))
    expect(parseAnswers('q1: "alpha",\n**q2**: beta')).toEqual(new Map([["q1", "alpha"], ["q2", "beta"]]))
  })
})

describe("runs", () => {
  test("imported IDs are unique and sort in transcript order", () => {
    const messages = importMessages(transcripts[0]!, parseModel("opencode/x"), 1, 0)
    const ids = messages.map(message => message.id)
    expect(new Set(ids).size).toBe(LENGTH)
    expect([...ids].sort()).toEqual(ids)
    expect(keptAge(ids[78])).toBe(30)
    expect(keptAge("msg_21c3abcdef01Xyz")).toBe(null)
  })

  test("summarize scores the last reply and counts tools and usage of new messages only", () => {
    const transcript = transcripts[0]!
    const probe = buildProbe(transcript, 1)
    const answers = Object.fromEntries([...probe.keys].map(([key, item]) => [key, item.kind === "exact" ? item.value : "?"]))
    const tokens = { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } }
    const ids = importMessages(transcript, parseModel("opencode/x"), 1, 0).map(message => message.id)
    const messages: ApiMessage[] = [
      { id: ids[0]!, type: "user", text: "old" },
      { id: ids[1]!, type: "assistant", tokens, content: [{ type: "text", text: "old" }] },
      { id: "msg_a1", type: "user", text: PIN_PROMPT },
      { id: "msg_a2", type: "assistant", tokens, content: [{ type: "tool", name: "constraint_pin" }, { type: "tool", name: "constraint_pin" }] },
      { id: "msg_a3", type: "compaction", status: "completed", metadata: { keepID: ids[78] }, tokens },
      { id: "msg_a4", type: "user", text: probe.text },
      { id: "msg_a5", type: "assistant", tokens, content: [{ type: "tool", name: "history_search" }] },
      { id: "msg_a6", type: "assistant", tokens, content: [{ type: "text", text: JSON.stringify(answers) }] },
      { id: "msg_a7", type: "idle", outcome: "succeeded" },
    ]
    const run = summarize(ARMS[2]!, transcript, messages, probe.text, probe.keys, 1234)
    expect(run.status).toBe("ok")
    expect(run.pinTools).toEqual({ constraint_pin: 2 })
    expect(run.probeTools).toEqual({ history_search: 1 })
    expect(run.usage).toEqual({ input: 400, output: 40, reasoning: 20, cacheRead: 200, cacheWrite: 0, cost: 0 })
    expect(run.verbatimFromAge).toBe(30)
    expect(run.scores.map(score => score.correct)).toEqual(transcript.planted.map(({ item }) => item.kind === "exact"))
    expect(armRow("C", "label", [run])).toBe("| C | label | 1/1 | 3/3 (100%) | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 | 1.0 (history_search ×1) | 460 (+200 cached) | $0.0000 | 1.2 |")
  })

  test("a compaction that did not complete fails the run", () => {
    const transcript = transcripts[0]!
    const probe = buildProbe(transcript, 1)
    const run = summarize(ARMS[0]!, transcript, [{ id: "msg_b1", type: "compaction", status: "failed", error: { message: "limit" } }], probe.text, probe.keys, 0)
    expect(run.status).toBe("error")
    expect(run.reason).toBe("compaction failed: limit")
  })

  test("every age bucket has a probe question for each kind", () => {
    for (const bucket of AGE_BUCKETS) {
      expect(transcripts[0]!.planted.filter(planted => planted.bucket === bucket).map(planted => planted.item.kind)).toEqual(["exact", "constraint", "rejected", "correction"])
    }
  })
})

describe("credentials", () => {
  const now = 1_000_000_000
  test("OAuth credentials are copied without their refresh token", () => {
    const entry = { integrationID: "opencode", active: true, value: { type: "oauth", access: "a", refresh: "r", expires: now + 3 * 3_600_000 } }
    expect(accessOnly([entry], "opencode", now)).toEqual({ ...entry, value: { ...entry.value, refresh: "" } })
  })

  test("keys pass through; near-expiry or missing credentials fail", () => {
    const key = { integrationID: "opencode", active: true, value: { type: "key" } }
    expect(accessOnly([key], "opencode", now)).toBe(key)
    expect(() => accessOnly([{ ...key, value: { type: "oauth", expires: now + 60_000 } }], "opencode", now)).toThrow("expires within two hours")
    expect(() => accessOnly([{ ...key, active: false }], "opencode", now)).toThrow("no active credential for opencode")
  })
})
