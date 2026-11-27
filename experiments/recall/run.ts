// Recall experiment: bun experiments/recall/run.ts --help
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { ARMS, runArm } from "./arms.ts"
import type { ArmID, RunRecord, Settings } from "./arms.ts"
import { exportCredential, parseModel } from "./opencode.ts"
import { renderReport } from "./report.ts"
import { TRANSCRIPT_COUNT, buildTranscript } from "./transcripts.ts"

const HELP = `Usage: bun experiments/recall/run.ts [options]

  --model <provider/model>   One model for every arm (default opencode/hy4-flash-free)
  --arms <A,B,C,D>           Arms to run (default all four)
  --transcripts <1-5>        Number of synthetic transcripts (default 5)
  --seed <n>                 Transcript seed (default 1)
  --keep-tokens <n>          Compaction keep.tokens (default 4000)
  --turn-timeout <seconds>   Ceiling for one model turn (default 300)
  --history-plugin <dir>     opencode-history release or checkout, for arms B and C
  --pinned-plugin <dir>      pinned-constraints package, for arm C (default packages/pinned-constraints)
  --out <dir>                Where results.md and runs.json go (default experiments/recall/results)
`

const MAX_CONSECUTIVE_ERRORS = 3

function options() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: "opencode/hy4-flash-free" },
      arms: { type: "string", default: "A,B,C,D" },
      transcripts: { type: "string", default: String(TRANSCRIPT_COUNT) },
      seed: { type: "string", default: "1" },
      "keep-tokens": { type: "string", default: "4000" },
      "turn-timeout": { type: "string", default: "300" },
      "history-plugin": { type: "string" },
      "pinned-plugin": { type: "string", default: join(import.meta.dir, "..", "..", "packages", "pinned-constraints") },
      out: { type: "string", default: join(import.meta.dir, "results") },
      help: { type: "boolean", default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    process.exit(0)
  }
  const bounded = (name: string, text: string, low: number, high: number) => {
    const value = Number(text)
    if (!Number.isInteger(value) || value < low || value > high) throw new Error(`--${name} must be an integer from ${low} to ${high}`)
    return value
  }
  const arms = values.arms.split(",").map(arm => arm.trim().toUpperCase())
  const unknown = arms.filter(arm => !ARMS.some(known => known.id === arm))
  if (unknown.length > 0) throw new Error(`unknown arm(s): ${unknown.join(", ")}`)
  const plugin = (path: string | undefined) => {
    if (path === undefined) return undefined
    if (!existsSync(path)) throw new Error(`plugin path does not exist: ${path}`)
    return resolve(path)
  }
  return {
    model: parseModel(values.model),
    arms: ARMS.filter(arm => arms.includes(arm.id)),
    transcripts: bounded("transcripts", values.transcripts, 1, TRANSCRIPT_COUNT),
    seed: bounded("seed", values.seed, 1, 1_000_000),
    keepTokens: bounded("keep-tokens", values["keep-tokens"], 0, 200_000),
    turnTimeoutMs: bounded("turn-timeout", values["turn-timeout"], 30, 1_800) * 1_000,
    historyPlugin: plugin(values["history-plugin"]),
    pinnedPlugin: plugin(values["pinned-plugin"]),
    out: resolve(values.out),
  }
}

function opencodeVersion(): string {
  const result = spawnSync("opencode", ["--version"], { timeout: 30_000, encoding: "utf8" })
  return result.stdout?.trim() || "unknown"
}

let interrupted = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true
    console.error(`${signal}: finishing cleanup after the current step`)
  })
}

function main(): void {
  const config = options()
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "opencode", "recall-"))
  const settings: Settings = { ...config, scratch, credential: exportCredential(config.model.providerID) }
  const runs: RunRecord[] = []
  const write = () => {
    mkdirSync(config.out, { recursive: true })
    const contextLimit = runs.find(run => run.contextLimit !== undefined)?.contextLimit ?? null
    const context = { model: `${config.model.providerID}/${config.model.id}`, opencodeVersion: opencodeVersion(), keepTokens: config.keepTokens, transcripts: config.transcripts, seed: config.seed, contextLimit, date: new Date().toISOString().slice(0, 10) }
    writeFileSync(join(config.out, "runs.json"), `${JSON.stringify({ context, runs }, null, 2)}\n`)
    writeFileSync(join(config.out, "results.md"), renderReport(context, runs))
  }
  console.log(`scratch: ${scratch}`)
  try {
    let consecutiveErrors = 0
    for (let index = 0; index < config.transcripts && !interrupted; index++) {
      const transcript = buildTranscript(index, config.seed)
      for (const arm of config.arms) {
        if (interrupted || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break
        const run = runArm(arm, transcript, settings)
        runs.push(run)
        consecutiveErrors = run.status === "error" ? consecutiveErrors + 1 : 0
        const correct = run.scores.filter(score => score.correct).length
        console.log(`transcript ${index + 1} arm ${arm.id}: ${run.status} ${run.status === "ok" ? `${correct}/${run.scores.length} correct, ${(run.wallMs / 1000).toFixed(1)} s` : run.reason ?? ""}`)
        write()
      }
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) console.error(`stopping after ${MAX_CONSECUTIVE_ERRORS} consecutive failed runs`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  write()
  console.log(`results: ${join(config.out, "results.md")}`)
}

main()
