// An isolated OpenCode for one experiment run: its own XDG config, data, state
// and cache under a scratch root, its own background service on a free port,
// a scratch HOME (so ~/.claude and ~/.agents instructions and skills stay
// out), and one model credential copied in from the user's store. Nothing here
// reads or writes the user's OpenCode configuration or database.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface ModelRef { readonly providerID: string; readonly id: string }

export function parseModel(text: string): ModelRef {
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) throw new Error(`model must be provider/model, got "${text}"`)
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) }
}

const CLI_TIMEOUT_MS = 60_000

/**
 * Tools the probe never needs; denied so a run cannot touch files, the network
 * or other agents. Denying `execute` turns Code Mode off, so plugin tools are
 * called directly and each call is counted under its own name.
 */
const DENIED_ACTIONS = ["shell", "edit", "webfetch", "websearch", "subagent", "question", "skill", "generate_image", "external_directory", "execute"]

export interface InstanceOptions {
  readonly scratch: string
  readonly model: ModelRef
  readonly plugins: readonly string[]
  readonly keepTokens: number
  /** Ceiling for one blocking API call, such as waiting for a reply. */
  readonly turnTimeoutMs: number
}

export class Instance {
  readonly root: string
  readonly work: string
  private readonly env: Record<string, string>
  private started = false

  constructor(private readonly options: InstanceOptions) {
    this.root = mkdtempSync(join(options.scratch, "run-"))
    this.work = join(this.root, "work")
    this.env = isolatedEnv(this.root)
    writeConfig(this.root, options)
    mkdirSync(this.work)
    git(this.work, ["init", "-q"])
    git(this.work, ["-c", "user.name=recall", "-c", "user.email=recall@example.invalid", "commit", "-q", "--allow-empty", "-m", "scratch"])
  }

  start(credential?: string): void {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const port = probe.port!
    probe.stop(true)
    this.cli(["service", "set", "hostname", "127.0.0.1"])
    this.cli(["service", "set", "port", String(port)])
    this.cli(["service", "start"])
    this.started = true
    const db = this.cli(["debug", "paths", "db"])
    if (!db.startsWith(this.root)) throw new Error(`isolation failed: database is ${db}`)
    if (credential !== undefined) this.cli(["auth", "import"], CLI_TIMEOUT_MS, credential)
  }

  /** Stops only this run's service and deletes its scratch root. */
  dispose(): void {
    if (this.started) {
      try { this.cli(["service", "stop"]) } catch (error) { console.error(`could not stop the isolated service: ${String(error)}`) }
      this.started = false
    }
    rmSync(this.root, { recursive: true, force: true })
  }

  api<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = this.options.turnTimeoutMs): T {
    return this.response<{ data: T }>(method, path, body, timeoutMs)?.data as T
  }

  /** The whole response body, for endpoints whose cursor sits beside `data`. */
  response<T>(method: string, path: string, body?: unknown, timeoutMs = this.options.turnTimeoutMs): T | undefined {
    const args = ["api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])]
    const raw = this.cli(args, timeoutMs)
    return raw ? (JSON.parse(raw) as T) : undefined
  }

  private cli(args: readonly string[], timeout = CLI_TIMEOUT_MS, input?: string): string {
    const result = spawnSync("opencode", args, { cwd: this.work, env: this.env, timeout, input, maxBuffer: 64 << 20, encoding: "utf8" })
    if (result.error) throw new Error(`opencode ${args.slice(0, 3).join(" ")}: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`opencode ${args.slice(0, 3).join(" ")} exited ${result.status}: ${result.stderr.slice(0, 500)}`)
    return result.stdout.trim()
  }
}

/** A run must finish well before a copied access token expires. */
const MIN_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000

interface StoredCredential { integrationID: string; active: boolean; value: { type?: string; expires?: number; refresh?: string } }

/**
 * Reads the provider's active credential from the user's store for this run.
 * An API key is copied as is. An OAuth credential is copied without its
 * refresh token, so the isolated instance can never rotate (and thereby
 * revoke) the user's own token; it fails instead once the access token
 * expires. The secret stays in memory and is never printed.
 */
export function exportCredential(providerID: string, now = Date.now()): string {
  const result = spawnSync("opencode", ["auth", "export", providerID], { timeout: CLI_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error(`could not export the ${providerID} credential (exit ${result.status})`)
  return JSON.stringify([accessOnly(JSON.parse(result.stdout) as StoredCredential[], providerID, now)])
}

export function accessOnly(entries: readonly StoredCredential[], providerID: string, now: number): StoredCredential {
  const entry = entries.find(candidate => candidate.integrationID === providerID && candidate.active)
  if (!entry) throw new Error(`no active credential for ${providerID}`)
  if (entry.value.type === "key") return entry
  if (entry.value.type !== "oauth") throw new Error(`unsupported ${providerID} credential type ${entry.value.type}`)
  if ((entry.value.expires ?? 0) < now + MIN_TOKEN_LIFETIME_MS) throw new Error(`the ${providerID} access token expires within two hours; refresh it in OpenCode first`)
  return { ...entry, value: { ...entry.value, refresh: "" } }
}

function isolatedEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("OPENCODE") || key.startsWith("TYPESAFE")) continue
    env[key] = value
  }
  mkdirSync(join(root, "home"), { recursive: true })
  return { ...env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") }
}

function writeConfig(root: string, options: InstanceOptions): void {
  const dir = join(root, "config", "opencode")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${options.model.providerID}/${options.model.id}`,
    plugins: options.plugins,
    compaction: { auto: false, background: false, keep: { tokens: options.keepTokens } },
    permissions: DENIED_ACTIONS.map(action => ({ action, resource: "*", effect: "deny" })),
  }
  writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify(config, null, 2))
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, timeout: CLI_TIMEOUT_MS, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
}
