// Fixed pools of planted facts. Each transcript draws distinct entries, so no
// two transcripts share a value. Values are generated from the seed at build
// time, which keeps them out of any model's priors.

export interface ExactSpec { readonly subject: string; readonly prefix: string }
export interface CorrectionSpec { readonly subject: string; readonly unit: string; readonly low: number; readonly high: number }
export interface RejectedSpec {
  readonly topic: string
  readonly rejected: string
  readonly rejectedPattern: RegExp
  readonly accepted: string
  readonly acceptedPattern: RegExp
  readonly reason: string
}
export interface ConstraintSpec {
  readonly rule: string
  readonly task: string
  readonly must: readonly RegExp[]
  readonly mustNot: readonly RegExp[]
}

export const EXACT: readonly ExactSpec[] = [
  { subject: "the staging S3 bucket", prefix: "stg-bkt" },
  { subject: "the feature flag for the new checkout flow", prefix: "ff-checkout" },
  { subject: "the Sentry project slug", prefix: "sentry" },
  { subject: "the database migration lock key", prefix: "miglock" },
  { subject: "the Grafana dashboard UID for request latency", prefix: "graf" },
  { subject: "the PagerDuty escalation policy ID", prefix: "pd-esc" },
  { subject: "the Redis key prefix for sessions", prefix: "sess" },
  { subject: "the Kafka topic for audit events", prefix: "audit-evt" },
  { subject: "the test tenant ID", prefix: "tnt" },
  { subject: "the header name for the internal API key", prefix: "x-int" },
  { subject: "the cron job name for nightly reconciliation", prefix: "recon" },
  { subject: "the pinned base image tag", prefix: "base" },
  { subject: "the Vault path for the payment provider secret", prefix: "kv-pay" },
  { subject: "the canary cohort name", prefix: "canary" },
  { subject: "the CI cache key", prefix: "ci-cache" },
]

export const CORRECTIONS: readonly CorrectionSpec[] = [
  { subject: "the HTTP client timeout", unit: "milliseconds", low: 2_000, high: 15_000 },
  { subject: "the maximum retry count", unit: "retries", low: 3, high: 19 },
  { subject: "the default page size", unit: "items", low: 20, high: 400 },
  { subject: "the rate limit", unit: "requests per minute", low: 60, high: 2_400 },
  { subject: "the cache TTL", unit: "seconds", low: 30, high: 3_600 },
  { subject: "the worker concurrency", unit: "workers", low: 4, high: 48 },
  { subject: "the maximum upload size", unit: "megabytes", low: 5, high: 250 },
  { subject: "the session lifetime", unit: "minutes", low: 15, high: 720 },
  { subject: "the export batch size", unit: "rows", low: 100, high: 9_000 },
  { subject: "the local dev server port", unit: "port number", low: 3_001, high: 8_999 },
  { subject: "the backoff base delay", unit: "milliseconds", low: 50, high: 2_000 },
  { subject: "the database connection pool size", unit: "connections", low: 5, high: 90 },
  { subject: "the log retention", unit: "days", low: 7, high: 400 },
  { subject: "the webhook signature tolerance", unit: "seconds", low: 30, high: 900 },
  { subject: "the circuit breaker failure threshold", unit: "failures", low: 3, high: 60 },
]

export const REJECTED: readonly RejectedSpec[] = [
  { topic: "job deduplication", rejected: "Redis SETNX locks", rejectedPattern: /redis|setnx/i, accepted: "Postgres advisory locks", acceptedPattern: /advisory/i, reason: "locks leaked whenever a worker was killed mid-job" },
  { topic: "the service config file format", rejected: "YAML", rejectedPattern: /yaml|yml/i, accepted: "TOML", acceptedPattern: /toml/i, reason: "the Norway problem bit us twice" },
  { topic: "the test runner", rejected: "Jest", rejectedPattern: /jest/i, accepted: "Vitest", acceptedPattern: /vitest/i, reason: "ESM support kept breaking" },
  { topic: "the background job queue", rejected: "RabbitMQ", rejectedPattern: /rabbit/i, accepted: "SQS", acceptedPattern: /\bsqs\b/i, reason: "nobody wanted to run the broker" },
  { topic: "database access", rejected: "Prisma", rejectedPattern: /prisma/i, accepted: "Kysely", acceptedPattern: /kysely/i, reason: "the generated client was too slow to cold-start" },
  { topic: "the HTTP framework", rejected: "Express", rejectedPattern: /express/i, accepted: "Hono", acceptedPattern: /hono/i, reason: "we need it to run on edge runtimes" },
  { topic: "request schema validation", rejected: "Joi", rejectedPattern: /\bjoi\b/i, accepted: "Valibot", acceptedPattern: /valibot/i, reason: "bundle size on the client" },
  { topic: "feature flag management", rejected: "LaunchDarkly", rejectedPattern: /launch ?darkly/i, accepted: "Unleash", acceptedPattern: /unleash/i, reason: "pricing for our seat count" },
  { topic: "the monorepo task runner", rejected: "Lerna", rejectedPattern: /lerna/i, accepted: "Turborepo", acceptedPattern: /turbo/i, reason: "its caching never hit in CI" },
  { topic: "the read-through cache", rejected: "Memcached", rejectedPattern: /memcache/i, accepted: "an in-process LRU cache", acceptedPattern: /\blru\b/i, reason: "network hops cost more than the misses" },
  { topic: "browser auth tokens", rejected: "JWTs in localStorage", rejectedPattern: /local ?storage/i, accepted: "HttpOnly session cookies", acceptedPattern: /httponly|session cookie/i, reason: "the security review flagged XSS exposure" },
  { topic: "product search", rejected: "Elasticsearch", rejectedPattern: /elastic/i, accepted: "Postgres full-text search", acceptedPattern: /full[- ]?text|tsvector/i, reason: "keeping the index in sync was a full-time job" },
  { topic: "file uploads", rejected: "storing files as database BLOBs", rejectedPattern: /\bblobs?\b/i, accepted: "S3 presigned uploads", acceptedPattern: /presign/i, reason: "backups ballooned to hundreds of gigabytes" },
  { topic: "scheduled jobs", rejected: "node-cron inside the API process", rejectedPattern: /node-cron/i, accepted: "a separate Temporal workflow", acceptedPattern: /temporal/i, reason: "jobs ran twice when we scaled to two pods" },
  { topic: "the production bundler", rejected: "Webpack", rejectedPattern: /webpack/i, accepted: "esbuild", acceptedPattern: /esbuild/i, reason: "builds took four minutes" },
]

export const CONSTRAINTS: readonly ConstraintSpec[] = [
  { rule: "Never use axios or raw fetch; every HTTP call goes through our `httpClient.request()` wrapper.", task: "sends a GET request to /api/users", must: [/httpClient\.request\(/], mustNot: [/axios/i, /\bfetch\(/] },
  { rule: "Timestamps in API payloads must be ISO-8601 strings from `toISOString()`, never epoch numbers.", task: "sets `payload.createdAt` from the Date `d`", must: [/toISOString\(\)/], mustNot: [/getTime\(|valueOf\(|Date\.now/] },
  { rule: "Log with `logger.event(name, fields)`; console.log is banned everywhere in src/.", task: "logs that a user signed in, with their `userId`", must: [/logger\.event\(/], mustNot: [/console\./] },
  { rule: "Money is integer cents in a `bigint`; never use floating-point numbers for money.", task: "declares `price` as twelve dollars and fifty cents", must: [/1250n/], mustNot: [/12\.5/] },
  { rule: "Read settings only through `config.get('NAME')`; never touch process.env directly.", task: "reads the DATABASE_URL setting into `url`", must: [/config\.get\(\s*["'`]DATABASE_URL/], mustNot: [/process\.env/] },
  { rule: "The domain layer never throws; it returns `Result.err(...)` or `Result.ok(...)`.", task: "is the failure branch of `validateEmail` for an invalid address", must: [/Result\.err\(/], mustNot: [/\bthrow\b/] },
  { rule: "IDs come from `newId('prefix')`; never use uuid, randomUUID or Math.random for IDs.", task: "creates `id` for a new invoice", must: [/newId\(/], mustNot: [/uuid|randomUUID|Math\.random/i] },
  { rule: "SQL is written only with the `sql` tagged template; never build queries by string concatenation.", task: "queries the users table for the row whose id is `userId`", must: [/sql`/], mustNot: [/["']\s*\+\s*userId/, /query\(\s*["']/] },
  { rule: "Format dates with `formatDate(d, 'yyyy-MM-dd')` from @acme/time; no moment, dayjs or toLocale* calls.", task: "turns the Date `d` into a day string `day`", must: [/formatDate\(/], mustNot: [/moment|dayjs|toLocale/i] },
  { rule: "Feature flags are read with `flags.isOn('name')`; never read flags from environment variables.", task: "sets `enabled` to whether the new-search flag is on", must: [/flags\.isOn\(\s*["'`]new-search/], mustNot: [/process\.env/] },
  { rule: "Waiting uses `await clock.sleep(ms)` so tests can fake time; setTimeout is banned.", task: "waits 250 milliseconds", must: [/clock\.sleep\(\s*250/], mustNot: [/setTimeout/] },
  { rule: "Build file paths with `path.join`; never concatenate path strings with '/'.", task: "builds `file`, the path of config.json inside `dir`", must: [/path\.join\(/], mustNot: [/\+\s*["'`]\//, /`\$\{dir\}\//] },
  { rule: "Named exports only; `export default` is banned in this codebase.", task: "exports a function `parseInvoice` with an empty body", must: [/export\s+(async\s+)?(function\s+parseInvoice|const\s+parseInvoice)/], mustNot: [/export\s+default/] },
  { rule: "Errors are `new AppError(code, message)`; never construct a plain `Error`.", task: "throws a not-found error for a missing order", must: [/new AppError\(/], mustNot: [/new Error\(/] },
  { rule: "Hash with `hash.sha256(...)` from our crypto module; md5 and direct createHash calls are banned.", task: "computes `digest` of the string `body`", must: [/hash\.sha256\(/], mustNot: [/md5|createHash/i] },
]

/**
 * Settings that come up in passing and are never probed. They compete with
 * the planted facts for room in a compaction summary, as real sessions do.
 */
export const DISTRACTORS: readonly CorrectionSpec[] = [
  { subject: "the lint max line length", unit: "characters", low: 80, high: 160 },
  { subject: "the coverage threshold", unit: "percent", low: 60, high: 95 },
  { subject: "the health check interval", unit: "seconds", low: 5, high: 120 },
  { subject: "the thumbnail width", unit: "pixels", low: 64, high: 512 },
  { subject: "the search debounce", unit: "milliseconds", low: 100, high: 900 },
  { subject: "the password minimum length", unit: "characters", low: 8, high: 24 },
  { subject: "the audit log batch interval", unit: "seconds", low: 1, high: 60 },
  { subject: "the queue visibility timeout", unit: "seconds", low: 30, high: 900 },
  { subject: "the CSV export column limit", unit: "columns", low: 20, high: 200 },
  { subject: "the GraphQL query depth limit", unit: "levels", low: 4, high: 15 },
  { subject: "the image cache size", unit: "megabytes", low: 32, high: 1_024 },
  { subject: "the trial period", unit: "days", low: 7, high: 45 },
]
