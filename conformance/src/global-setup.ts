/**
 * Runs once per `vitest run`, before any server test: resolves EVEN_SERVER_URL (failing fast if it is missing),
 * runs the preflight (GET /v1/info, every limit published, test caps in force) and hands the result to the tests.
 * Throwing here fails the whole run before a single test executes, which is how the suite refuses to report success
 * against a server without test limits.
 */
import type { TestProject } from 'vitest/node';
import type { Info } from './client.ts';
import { ConfigError, options, resolveServer, type ServerTarget } from './env.ts';
import { blockedGroupSecret, deriveServer } from './keys.ts';
import { configWarnings, preflight, PreflightError } from './preflight.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    target: ServerTarget;
    info: Info;
  }
}

/** Configuration and preflight failures are instructions for a human; a stack trace would only bury them. */
function withoutStack<T extends Error>(error: T): T {
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

export default async function setup(project: TestProject): Promise<void> {
  let target: ServerTarget;
  let info: Info;
  try {
    target = resolveServer();
    info = await preflight(target);
  } catch (error) {
    throw error instanceof ConfigError || error instanceof PreflightError ? withoutStack(error) : error;
  }
  const { limits } = info;
  console.log(
    `Even conformance → ${target.base}  protocol=${JSON.stringify(info.protocol)} push=${info.push} ` +
      `max_event_bytes=${limits.max_event_bytes} max_group_bytes=${limits.max_group_bytes} ` +
      `max_group_events=${limits.max_group_events} max_batch=${limits.max_batch} max_page=${limits.max_page}`,
  );
  for (const warning of configWarnings(limits)) console.warn(`Even conformance warning: ${warning}`);
  if (options.blockedGroupId() === undefined) {
    const { groupId } = deriveServer(blockedGroupSecret(), target.origin);
    console.log(`Blocked-group test skipped. To run it, block ${groupId} on the server and set EVEN_CONFORMANCE_BLOCKED_GROUP_ID=${groupId}`);
  }
  if (!options.rate()) console.log('Rate-limit test skipped (opt in with EVEN_CONFORMANCE_RATE=1).');
  project.provide('target', target);
  project.provide('info', info);
}
