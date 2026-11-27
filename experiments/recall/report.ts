// Aggregates run records into the Markdown results report.
import { ARMS } from "./arms.ts"
import type { ArmID, RunRecord } from "./arms.ts"
import type { ItemScore } from "./score.ts"
import { AGE_BUCKETS } from "./transcripts.ts"
import type { Item } from "./transcripts.ts"

export interface ReportContext {
  readonly model: string
  readonly opencodeVersion: string
  readonly keepTokens: number
  readonly transcripts: number
  readonly seed: number
  readonly contextLimit: number | null
  readonly date: string
}

export const fraction = (hits: number, total: number) => total === 0 ? "–" : `${hits}/${total} (${Math.round((hits / total) * 100)}%)`

const count = (scores: readonly ItemScore[], keep: (score: ItemScore) => boolean) => scores.filter(keep).length

function kindRate(scores: readonly ItemScore[], kind: Item["kind"]): string {
  const ofKind = scores.filter(score => score.kind === kind)
  return fraction(count(ofKind, score => score.correct), ofKind.length)
}

const sumTools = (tools: Readonly<Record<string, number>>) => Object.values(tools).reduce((total, n) => total + n, 0)

function toolNames(runs: readonly RunRecord[], pick: (run: RunRecord) => Readonly<Record<string, number>>): string {
  const totals: Record<string, number> = {}
  for (const run of runs) for (const [name, n] of Object.entries(pick(run))) totals[name] = (totals[name] ?? 0) + n
  const entries = Object.entries(totals)
  return entries.length === 0 ? "none" : entries.map(([name, n]) => `${name} ×${n}`).join(", ")
}

export function armRow(arm: ArmID, label: string, runs: readonly RunRecord[]): string {
  const mine = runs.filter(run => run.arm === arm)
  const ok = mine.filter(run => run.status === "ok")
  const scores = ok.flatMap(run => run.scores)
  if (ok.length === 0) {
    const why = mine.find(run => run.reason)?.reason ?? "not run"
    return `| ${arm} | ${label} | 0/${mine.length} | ${why} | | | | | | | | |`
  }
  const tokens = ok.reduce((total, run) => total + run.usage.input + run.usage.output + run.usage.reasoning, 0)
  const cacheRead = ok.reduce((total, run) => total + run.usage.cacheRead, 0)
  const cost = ok.reduce((total, run) => total + run.usage.cost, 0)
  const lookups = ok.reduce((total, run) => total + sumTools(run.probeTools), 0)
  const wall = ok.reduce((total, run) => total + run.wallMs, 0) / ok.length / 1000
  return [
    "", arm, label, `${ok.length}/${mine.length}`,
    kindRate(scores, "exact"), kindRate(scores, "constraint"), kindRate(scores, "correction"), kindRate(scores, "rejected"),
    String(count(scores, score => score.stale)),
    `${(lookups / ok.length).toFixed(1)} (${toolNames(ok, run => run.probeTools)})`,
    `${Math.round(tokens / ok.length).toLocaleString("en-US")} (+${Math.round(cacheRead / ok.length).toLocaleString("en-US")} cached)`,
    `$${cost.toFixed(4)}`, wall.toFixed(1), "",
  ].join(" | ").trim()
}

function ageRow(arm: ArmID, runs: readonly RunRecord[]): string {
  const scores = runs.filter(run => run.arm === arm && run.status === "ok").flatMap(run => run.scores)
  const cells = AGE_BUCKETS.map(bucket => {
    const inBucket = scores.filter(score => score.bucket === bucket)
    return fraction(count(inBucket, score => score.correct), inBucket.length)
  })
  return `| ${arm} | ${cells.join(" | ")} |`
}

function verbatimNote(runs: readonly RunRecord[]): string {
  const ages = runs.filter(run => run.status === "ok" && run.verbatimFromAge !== null).map(run => run.verbatimFromAge!)
  if (ages.length === 0) return "Compaction kept no imported message verbatim in any completed run."
  return `Compaction kept the newest messages verbatim from age ${Math.min(...ages)}–${Math.max(...ages)} onward (median ${ages.sort((a, b) => a - b)[Math.floor(ages.length / 2)]}); older facts survive only through the summary, a lookup or a pin.`
}

function pinNote(runs: readonly RunRecord[]): string[] {
  const pinned = runs.filter(run => run.status === "ok" && Object.keys(run.pinTools).length > 0)
  return pinned.length === 0 ? [] : [`- Pin pass tool calls over ${pinned.length} arm C run(s): ${toolNames(pinned, run => run.pinTools)}.`]
}

export function renderReport(context: ReportContext, runs: readonly RunRecord[]): string {
  const failures = runs.filter(run => run.status !== "ok")
  return [
    "# Recall experiment results",
    "",
    `- Date: ${context.date}`,
    `- Model: \`${context.model}\` (${context.contextLimit === null ? "context limit not reported" : `context limit ${context.contextLimit.toLocaleString("en-US")} tokens`}), OpenCode ${context.opencodeVersion.replace(/^opencode\s+/i, "")}`,
    `- Transcripts: ${context.transcripts} × 108 messages, seed ${context.seed}; 12 planted facts each (exact string, constraint, correction, rejected approach at ages ≈10, 50 and 100)`,
    `- Compaction: manual, \`keep.tokens\` = ${context.keepTokens}. ${verbatimNote(runs)}`,
    "",
    "> **Small N.** Each arm is at most 5 runs with 3 facts per kind and age. Differences of a few items are within run-to-run noise of one model at one temperature; nothing here is statistically significant. Read it as a smoke test of the arms, not a ranking.",
    "",
    "| Arm | Setup | Runs ok | Exact-string recall | Constraint adherence | Correction (current value) | Rejected approach avoided | Stale overrides | Lookups per run (tools) | Tokens per run | Cost | Wall s per run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...ARMS.map(arm => armRow(arm.id, arm.label, runs)),
    "",
    "Correct answers by age bucket (all four kinds):",
    "",
    `| Arm | ${AGE_BUCKETS.map(bucket => `age ≈${bucket}`).join(" | ")} |`,
    `| --- | ${AGE_BUCKETS.map(() => "---").join(" | ")} |`,
    ...ARMS.map(arm => ageRow(arm.id, runs)),
    "",
    "- Stale overrides count answers that gave a corrected value's old number, or named a rejected approach without the accepted one.",
    "- Lookups are tool calls made while answering the probe. Tokens are input + output + reasoning for every model call the run made (pin pass, compaction summary, probe), with cache reads listed separately; wall time covers the same span.",
    ...pinNote(runs),
    ...(failures.length === 0 ? [] : ["", "Runs that did not complete:", "", ...failures.map(run => `- ${run.arm} / transcript ${run.transcript + 1}: ${run.status}, ${run.reason ?? ""}`)]),
    "",
  ].join("\n")
}
