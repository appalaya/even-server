/**
 * Prints the group id the blocked-group test authenticates as, for EVEN_SERVER_URL:
 *
 *   EVEN_SERVER_URL=http://127.0.0.1:8787 npm run --silent blocked-id
 *
 * Block that id on the server (for the reference servers, insert it into the `blocked` table), then run the suite with
 * EVEN_CONFORMANCE_BLOCKED_GROUP_ID set to it.
 */
import { ConfigError, resolveServer } from './env.ts';
import { blockedGroupSecret, deriveServer } from './keys.ts';

try {
  const target = resolveServer();
  console.log(deriveServer(blockedGroupSecret(), target.origin).groupId);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
}
