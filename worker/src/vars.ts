/**
 * The published limits and the `EVEN_*` variables they are seeded from (design.md, "Limits and configuration").
 * Same names, defaults and minimums as the Python reference.
 *
 * This file has no imports and uses only erasable TypeScript, because `scripts/seed-limits.mjs` imports it directly
 * (Node strips the types). The seed script and the Worker therefore cannot disagree about which rows the `limits`
 * table holds.
 */

export const LIMIT_VARIABLES = [
  { variable: 'EVEN_MAX_EVENT_BYTES', key: 'max_event_bytes', fallback: 8192, minimum: 17 },
  { variable: 'EVEN_MAX_GROUP_BYTES', key: 'max_group_bytes', fallback: 2_097_152, minimum: 1 },
  { variable: 'EVEN_MAX_GROUP_EVENTS', key: 'max_group_events', fallback: 10_000, minimum: 1 },
  { variable: 'EVEN_MAX_BATCH', key: 'max_batch', fallback: 25, minimum: 1 },
  { variable: 'EVEN_MAX_PAGE', key: 'max_page', fallback: 500, minimum: 1 },
  { variable: 'EVEN_RETENTION_DAYS', key: 'retention_days', fallback: 365, minimum: 1 },
  {
    variable: 'EVEN_RATE_REQUESTS_PER_MINUTE',
    key: 'requests_per_minute',
    fallback: 120,
    minimum: 1,
  },
  { variable: 'EVEN_RATE_WRITES_PER_MINUTE', key: 'writes_per_minute', fallback: 60, minimum: 1 },
  {
    variable: 'EVEN_RATE_GROUP_CREATES_PER_MINUTE',
    key: 'group_creates_per_minute',
    fallback: 3,
    minimum: 1,
  },
  { variable: 'EVEN_DAILY_WRITE_BUDGET', key: 'daily_write_budget', fallback: 0, minimum: 0 }, // 0 = no budget
] as const;

export type LimitKey = (typeof LIMIT_VARIABLES)[number]['key'];

/**
 * The three Workers Rate Limiting bindings and the variable each one's threshold must equal. The binding thresholds
 * live in wrangler.jsonc next to the vars; the seed script refuses to seed when they disagree, so the rate published
 * in /v1/info is the rate the platform enforces.
 */
export const RATE_BINDINGS = [
  { binding: 'RATE_REQUESTS', variable: 'EVEN_RATE_REQUESTS_PER_MINUTE' },
  { binding: 'RATE_WRITES', variable: 'EVEN_RATE_WRITES_PER_MINUTE' },
  { binding: 'RATE_CREATES', variable: 'EVEN_RATE_GROUP_CREATES_PER_MINUTE' },
] as const;

/** Every rate is per minute: the Rate Limiting binding supports 10- and 60-second periods only. */
export const RATE_PERIOD_SECONDS = 60;
