import { defineConfig } from 'vitest/config';

/** Per-test timeout. Generous because the client waits out 429s (Retry-After) on rate-limited servers. */
const testTimeout = Number(process.env.EVEN_CONFORMANCE_TIMEOUT_MS) || 60_000;

export default defineConfig({
  test: {
    projects: [
      {
        // Known-answer tests for §2/§3. No server needed: `npx vitest run --project kat` works offline.
        test: {
          name: 'kat',
          include: ['src/keys.test.ts'],
        },
      },
      {
        // Everything that talks to EVEN_SERVER_URL. global-setup.ts runs the preflight once per run and fails the
        // whole run (before any test) if the URL is missing, the server is unreachable, or test limits are not set.
        test: {
          name: 'server',
          include: ['src/**/*.test.ts'],
          exclude: ['src/keys.test.ts'],
          globalSetup: ['src/global-setup.ts'],
          setupFiles: ['src/setup.ts'],
          testTimeout,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
