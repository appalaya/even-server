/**
 * Even sync server: Cloudflare Workers + D1 reference (PROTOCOL.md v1, design.md "The Worker").
 *
 * fetch: route, handle, map errors to protocol responses, add the headers every response needs, and write one log
 * line. scheduled: idle-group expiry (design.md, "Expiry").
 */
import * as store from './db';
import type { Env } from './env';
import { ApiError, finalize, json } from './http';
import { LimitsMissing } from './limits';
import { logEvent, logException, logRequest } from './log';
import { handle, matchRoute } from './routes';

const DAY_MS = 86_400_000;
const COUNTER_DAYS_KEPT = 7;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    let response: Response;
    try {
      if (route === undefined) throw new ApiError(404, 'not_found');
      response = await handle(request, env, url, route);
    } catch (error) {
      response = errorResponse(error, route?.pattern ?? null);
    }
    response = finalize(response);
    logRequest(request.method, route?.pattern ?? null, response.status, Date.now() - started);
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await expireIdleGroups(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

function errorResponse(error: unknown, route: string | null): Response {
  if (error instanceof ApiError) return error.response();
  if (error instanceof LimitsMissing) {
    // Fail closed: without every limit row the server can neither enforce nor publish its limits.
    logEvent('error', 'limits_missing', {
      route,
      missing: error.missing,
      fix: 'npm run db:seed locally; in production, re-run the deploy workflow',
    });
  } else {
    logException(route, error);
  }
  return json({ error: 'server_error' }, 500);
}

/**
 * Deletes groups with no successful write for `retention_days` (read from the limits table, the value /v1/info
 * publishes), their events, and daily counters older than a week. Reads do not keep a group alive.
 */
export async function expireIdleGroups(env: Env, nowMs: number): Promise<number | undefined> {
  let retentionDays: number;
  try {
    retentionDays = (await store.loadLimits(env.DB)).retention_days;
  } catch (error) {
    // Deleting is the destructive direction, so a missing limit means: delete nothing.
    if (error instanceof LimitsMissing)
      logEvent('error', 'expiry_skipped', { missing: error.missing });
    else logException(null, error);
    return undefined;
  }
  const countersBefore = new Date(nowMs - COUNTER_DAYS_KEPT * DAY_MS).toISOString().slice(0, 10);
  const deleted = await store.expire(env.DB, nowMs - retentionDays * DAY_MS, countersBefore);
  logEvent('info', 'expiry', { groups_deleted: deleted, retention_days: retentionDays });
  return deleted;
}
