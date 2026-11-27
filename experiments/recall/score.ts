// Scoring of probe answers. Every check is a deterministic string or regex
// test against the planted fact, so the same answers always score the same.
import type { AgeBucket, Item } from "./transcripts.ts"

export interface ItemScore {
  readonly id: string
  readonly kind: Item["kind"]
  readonly bucket: AgeBucket
  readonly age: number
  readonly answer: string | null
  /** The answer gives the planted fact: the exact string, the current value, the accepted approach, or rule-abiding code. */
  readonly correct: boolean
  /** The answer gives the superseded value or the rejected approach instead of the current one. */
  readonly stale: boolean
  /** The code answer breaks the planted rule. */
  readonly violation: boolean
}

/** Reads the JSON object the probe asked for, tolerating code fences and prose around it; falls back to "qN: answer" lines. */
export function parseAnswers(text: string): Map<string, string> {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return new Map(Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]))
      }
    } catch {
      // Not valid JSON; try the line form below.
    }
  }
  const answers = new Map<string, string>()
  for (const match of text.matchAll(/^\s*["*]*(q\d+)["*]*\s*[:=]\s*(.+?)\s*,?$/gm)) answers.set(match[1]!, match[2]!.replace(/^"|"$/g, ""))
  return answers
}

const numbers = (text: string) => new Set([...text.replace(/(\d)[,_](\d)/g, "$1$2").matchAll(/\d+/g)].map(match => Number(match[0])))

export function scoreItem(item: Item, answer: string | undefined): Pick<ItemScore, "correct" | "stale" | "violation"> {
  if (answer === undefined) return { correct: false, stale: false, violation: false }
  switch (item.kind) {
    case "exact":
      return { correct: answer.includes(item.value), stale: false, violation: false }
    case "correction": {
      const given = numbers(answer)
      return { correct: given.has(item.current), stale: given.has(item.stale) && !given.has(item.current), violation: false }
    }
    case "rejected": {
      const accepted = item.spec.acceptedPattern.test(answer)
      return { correct: accepted, stale: item.spec.rejectedPattern.test(answer) && !accepted, violation: false }
    }
    case "constraint": {
      const violation = item.spec.mustNot.some(pattern => pattern.test(answer))
      return { correct: !violation && item.spec.must.every(pattern => pattern.test(answer)), stale: false, violation }
    }
  }
}
