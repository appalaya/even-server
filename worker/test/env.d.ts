import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** schema.sql, split into statements by vitest.config.ts. */
      TEST_SCHEMA: string[];
    }
  }
}
