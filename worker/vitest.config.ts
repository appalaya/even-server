/**
 * Tests run inside workerd through @cloudflare/vitest-pool-workers, with the `test` environment from wrangler.jsonc
 * (its D1 database, in memory) and schema.sql split exactly as `wrangler d1 execute --file` splits it.
 */
import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { unstable_splitSqlQuery } from 'wrangler';

const schema = unstable_splitSqlQuery(
  readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
      miniflare: { bindings: { TEST_SCHEMA: schema } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // One D1 database is shared by every file, and some tests change a limit row for a moment.
    fileParallelism: false,
  },
});
