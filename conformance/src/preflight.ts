/**
 * Preflight: GET /v1/info, check it publishes every limit (§6.1, §9), and refuse to run unless the server has the
 * small caps that the cap tests need (§12). Used once per run by global-setup.ts; info.test.ts reuses the checks.
 */
import { EvenClient, type Info, type Limits, type Reply } from './client.ts';
import type { ServerTarget } from './env.ts';

/** PROTOCOL.md §12: the full suite runs only against caps at most this large. */
export const MAX_TEST_GROUP_BYTES = 65_536;
export const MAX_TEST_GROUP_EVENTS = 200;

/** The test configuration the README recommends; quoted in every refusal so the fix is copy-pasteable. */
export const RECOMMENDED_TEST_ENV = [
  'EVEN_MAX_GROUP_BYTES=65536',
  'EVEN_MAX_GROUP_EVENTS=200',
  'EVEN_MAX_PAGE=50',
  'EVEN_RATE_REQUESTS_PER_MINUTE=100000',
  'EVEN_RATE_WRITES_PER_MINUTE=100000',
  'EVEN_RATE_GROUP_CREATES_PER_MINUTE=100000',
  'EVEN_DAILY_WRITE_BUDGET=0',
] as const;

export const LIMIT_NAMES = ['max_event_bytes', 'max_group_bytes', 'max_group_events', 'max_batch', 'max_page', 'daily_write_budget'] as const;
export const RATE_NAMES = ['requests_per_minute', 'writes_per_minute', 'group_creates_per_minute'] as const;
/** Limits that bound something and so must be at least 1 (daily_write_budget and the rates may be 0). */
const POSITIVE_LIMITS = new Set<string>(['max_event_bytes', 'max_group_bytes', 'max_group_events', 'max_batch', 'max_page']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Every way a /v1/info body falls short of §6.1 and §9. Empty means the shape is right. */
export function infoProblems(body: unknown): string[] {
  if (!isRecord(body)) return ['the body is not a JSON object'];
  const problems: string[] = [];

  const protocol = body.protocol;
  if (!Array.isArray(protocol) || !protocol.every((p) => Number.isSafeInteger(p))) {
    problems.push(`"protocol" must be an array of integers, got ${JSON.stringify(protocol)}`);
  } else if (!protocol.includes(1)) {
    problems.push(`"protocol" must include 1, got ${JSON.stringify(protocol)}`);
  }

  const limits = body.limits;
  if (!isRecord(limits)) {
    problems.push(`"limits" must be an object, got ${JSON.stringify(limits)}`);
  } else {
    for (const name of LIMIT_NAMES) {
      const value = limits[name];
      if (!isCount(value)) problems.push(`"limits.${name}" must be a non-negative integer, got ${JSON.stringify(value)}`);
      else if (POSITIVE_LIMITS.has(name) && value < 1) problems.push(`"limits.${name}" must be at least 1, got ${value}`);
    }
    const rate = limits.rate;
    if (!isRecord(rate)) {
      problems.push(`"limits.rate" must be an object, got ${JSON.stringify(rate)}`);
    } else {
      for (const name of RATE_NAMES) {
        if (!isCount(rate[name])) problems.push(`"limits.rate.${name}" must be a non-negative integer, got ${JSON.stringify(rate[name])}`);
      }
    }
  }

  if (!isCount(body.retention_days)) {
    problems.push(`"retention_days" must be published as a non-negative integer (§9), got ${JSON.stringify(body.retention_days)}`);
  }
  if (typeof body.push !== 'boolean') problems.push(`"push" must be a boolean (§6.1), got ${JSON.stringify(body.push)}`);
  for (const name of ['operator', 'terms'] as const) {
    if (body[name] !== undefined && typeof body[name] !== 'string') {
      problems.push(`"${name}" is optional but must be a string when present, got ${JSON.stringify(body[name])}`);
    }
  }
  return problems;
}

/** Reasons the published limits are not test limits. Empty means the full suite can run. */
export function testLimitProblems(limits: Limits): string[] {
  const problems: string[] = [];
  if (limits.max_group_bytes > MAX_TEST_GROUP_BYTES) {
    problems.push(`max_group_bytes = ${limits.max_group_bytes} (must be ≤ ${MAX_TEST_GROUP_BYTES})`);
  }
  if (limits.max_group_events > MAX_TEST_GROUP_EVENTS) {
    problems.push(`max_group_events = ${limits.max_group_events} (must be ≤ ${MAX_TEST_GROUP_EVENTS})`);
  }
  // The clamping test stores max_page + 3 events in one group; with the default max_page of 500 no test group can.
  if (limits.max_page + 3 > limits.max_group_events) {
    problems.push(
      `max_page = ${limits.max_page} (must be ≤ max_group_events − 3 = ${limits.max_group_events - 3}, so one group ` +
        'can hold more than a page and the limit-clamping test can run)',
    );
  }
  return problems;
}

/** Soft warnings: settings that make the run slow (the client honours Retry-After) or flaky, but not wrong. */
export function configWarnings(limits: Limits): string[] {
  const warnings: string[] = [];
  const low: string[] = [];
  const { rate } = limits;
  if (rate.requests_per_minute > 0 && rate.requests_per_minute < 5000) low.push(`requests_per_minute=${rate.requests_per_minute}`);
  if (rate.writes_per_minute > 0 && rate.writes_per_minute < 2000) low.push(`writes_per_minute=${rate.writes_per_minute}`);
  if (rate.group_creates_per_minute > 0 && rate.group_creates_per_minute < 1000) {
    low.push(`group_creates_per_minute=${rate.group_creates_per_minute}`);
  }
  if (low.length > 0) {
    warnings.push(
      `rate limits ${low.join(', ')} will throttle the suite (every test creates its own group). The client waits out ` +
        '429s, but tests may hit their timeout. Raise the EVEN_RATE_* values for test runs.',
    );
  }
  if (limits.daily_write_budget > 0 && limits.daily_write_budget < 10_000) {
    warnings.push(`daily_write_budget=${limits.daily_write_budget} may be exhausted by the suite (503 over_budget); use 0 for test runs.`);
  }
  return warnings;
}

export class PreflightError extends Error {
  override name = 'PreflightError';
}

function describeReply(reply: Reply): string {
  return `${reply.status} ${reply.text.slice(0, 300)}`;
}

/** Fetches /v1/info and returns it, or throws a PreflightError that says exactly what to fix. */
export async function preflight(target: ServerTarget, timeoutMs = 10_000): Promise<Info> {
  const client = new EvenClient(target.base, timeoutMs);
  let reply: Reply;
  try {
    reply = await client.info();
  } catch (error) {
    throw new PreflightError(
      `Cannot reach the Even server at ${target.base} (GET /v1/info): ${error instanceof Error ? error.message : String(error)}\n` +
        'Is it running, and is EVEN_SERVER_URL right?',
    );
  }
  if (reply.status !== 200) {
    throw new PreflightError(`GET ${target.base}/v1/info must return 200 (§6.1), got ${describeReply(reply)}`);
  }
  const shape = infoProblems(reply.json);
  if (shape.length > 0) {
    throw new PreflightError(
      `GET ${target.base}/v1/info does not publish what §6.1 requires, so the suite cannot read the limits it tests against:\n` +
        shape.map((p) => `  - ${p}`).join('\n'),
    );
  }
  const info = reply.json as Info;
  const limitProblems = testLimitProblems(info.limits);
  if (limitProblems.length > 0) {
    throw new PreflightError(
      'Refusing to run: the conformance suite reports success only against a server configured with test limits ' +
        `(PROTOCOL.md §12), and ${target.base} publishes:\n` +
        limitProblems.map((p) => `  - ${p}`).join('\n') +
        '\n\nStart the server with test limits, for example:\n\n' +
        `  ${RECOMMENDED_TEST_ENV.join(' \\\n  ')}\n\n` +
        'Python reference: export those variables before starting it. Worker: set the same names under "vars" in ' +
        'wrangler.jsonc (or pass --var NAME:VALUE to wrangler dev) and re-seed the limits table, since /v1/info is ' +
        'built from it. See conformance/README.md.',
    );
  }
  return info;
}
