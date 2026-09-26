/**
 * Per-file setup for the server tests.
 *
 * - beforeAll: the preflight gate. global-setup.ts has already fetched and checked /v1/info; if its result is missing
 *   (the suite was started without its config), every test in the file fails with a message instead of misbehaving.
 * - afterEach: every response a test received must have met §5 (Cache-Control: no-store, JSON body and type).
 */
import { afterEach, beforeAll, expect } from 'vitest';
import { takeHeaderViolations } from './client.ts';
import { info, target } from './harness.ts';

beforeAll(() => {
  target();
  info();
});

afterEach(() => {
  const violations = takeHeaderViolations();
  expect(violations, 'responses in this test broke §5 (Cache-Control: no-store; JSON body with a JSON Content-Type)').toEqual([]);
});
