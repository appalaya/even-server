/** Bindings and vars (wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  /** Per-IP limiters. Optional: a self-deployed Worker without them allows everything and logs that once. */
  RATE_REQUESTS?: RateLimit;
  RATE_WRITES?: RateLimit;
  RATE_CREATES?: RateLimit;
  /** Optional strings for /v1/info; empty means unset. */
  EVEN_OPERATOR?: string;
  EVEN_TERMS_URL?: string;
  /**
   * The EVEN_* limit vars. Only used to warn when the `limits` table has drifted from them; every limit is read
   * from the table (see limits.ts).
   */
  [variable: `EVEN_${string}`]: unknown;
}
