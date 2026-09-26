/**
 * The suite's environment. EVEN_SERVER_URL is the only required variable; everything else is opt-in.
 * Plain TypeScript with no Vitest imports, so `node src/blocked-id.ts` can use it too.
 */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** http:// is accepted only for these hosts. The app never speaks http; the suite is a test tool. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export interface ServerTarget {
  /** Where requests go: scheme, lowercase host, non-default port, optional path; no trailing slash. */
  readonly base: string;
  /**
   * The origin string fed to key derivation (§2), so tokens are per server as a client's would be. For an https URL
   * this is the §8.1 canonical form. For a loopback http URL it is the same shape with http; a client never derives
   * for http, but the server never sees the origin (only the token and the group id), so any fixed string works.
   */
  readonly origin: string;
}

const HOW_TO_RUN = `Set it to the server under test, for example:

  EVEN_SERVER_URL=http://127.0.0.1:8787 npx vitest run

The server must be running with test limits (see conformance/README.md).`;

export function resolveServer(raw: string | undefined = process.env.EVEN_SERVER_URL): ServerTarget {
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`EVEN_SERVER_URL is not set. ${HOW_TO_RUN}`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(`EVEN_SERVER_URL=${JSON.stringify(raw)} is not a valid URL. ${HOW_TO_RUN}`);
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new ConfigError(
        `EVEN_SERVER_URL=${JSON.stringify(raw)} uses http:// for a non-loopback host. The suite allows http:// only ` +
          'for localhost and 127.0.0.1; use https:// for anything else (the app itself never speaks http).',
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new ConfigError(`EVEN_SERVER_URL=${JSON.stringify(raw)} must be an https:// URL (or http:// on localhost / 127.0.0.1).`);
  }
  if (url.username !== '' || url.password !== '') throw new ConfigError('EVEN_SERVER_URL must not contain a user name or password.');
  if (url.search !== '' || url.hash !== '') throw new ConfigError('EVEN_SERVER_URL must not contain a query or a fragment.');

  // URL already lowercases the scheme and host and drops default ports (:443, :80).
  const path = url.pathname.replace(/\/+$/, '');
  const base = `${url.protocol}//${url.host}${path}`;
  return { base, origin: base };
}

/** Optional switches. Each is documented in the README. */
export const options = {
  /** An operator-blocked group id: enables blocked.test.ts. Must be the id printed by `npm run blocked-id`. */
  blockedGroupId(): string | undefined {
    const value = process.env.EVEN_CONFORMANCE_BLOCKED_GROUP_ID?.trim();
    return value === undefined || value === '' ? undefined : value;
  },
  /** EVEN_CONFORMANCE_RATE=1 enables the rate-limit test, which deliberately gets this client IP limited. */
  rate(): boolean {
    return process.env.EVEN_CONFORMANCE_RATE === '1';
  },
  /** Per-request timeout, so a stuck server fails a test instead of hanging the run. */
  requestTimeoutMs(): number {
    return positiveInt(process.env.EVEN_CONFORMANCE_REQUEST_TIMEOUT_MS, 20_000);
  },
};

export function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
