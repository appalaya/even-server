#!/usr/bin/env node
/**
 * Writes seed-limits.sql: one upsert per published limit, from the EVEN_* vars in wrangler.jsonc.
 *
 *   node scripts/seed-limits.mjs               # top-level vars      (npm run db:seed; the deploy workflow)
 *   node scripts/seed-limits.mjs --env test    # env.test vars       (npm run db:seed:test)
 *   node scripts/seed-limits.mjs --out FILE    # another output path
 *
 * /v1/info and every check read the D1 `limits` table, never the vars, so the table is the single place a limit
 * lives at run time. This script is how a var reaches it. It refuses to write anything when a var is malformed or
 * below its minimum, or when a rate-limiter binding's threshold differs from its EVEN_RATE_* var (the binding is what
 * the platform enforces; the var is what gets published).
 *
 * No dependencies: the JSONC reader below handles comments and trailing commas, which is all wrangler.jsonc uses.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMIT_VARIABLES, RATE_BINDINGS, RATE_PERIOD_SECONDS } from '../src/vars.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`seed-limits: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    env: undefined,
    config: resolve(root, 'wrangler.jsonc'),
    out: resolve(root, 'seed-limits.sql'),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--env' || flag === '-e') args.env = value;
    else if (flag === '--config' || flag === '-c') args.config = resolve(value ?? '');
    else if (flag === '--out' || flag === '-o') args.out = resolve(value ?? '');
    else
      fail(
        `unknown argument ${JSON.stringify(flag)} (expected --env NAME, --config FILE, --out FILE)`,
      );
    if (value === undefined || value.startsWith('-')) fail(`${flag} needs a value`);
    i++;
  }
  return args;
}

/** JSON with // and /* *\/ comments and trailing commas → JSON. String contents are left untouched. */
function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) fail('unterminated /* comment in the wrangler config');
      i = end + 1;
    } else {
      out += ch;
    }
  }
  // Trailing commas: a comma followed only by whitespace before } or ]. Strings were copied verbatim above, and a
  // string cannot contain a raw newline, so a string ending in "," then "}" on the same line is the only false match;
  // wrangler.jsonc has none, and JSON.parse would reject the result loudly rather than seed a wrong value.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function integerVar(vars, { variable, fallback, minimum }) {
  const raw = vars[variable];
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    console.warn(`seed-limits: ${variable} is not set; using the default ${fallback}`);
    return fallback;
  }
  const text = String(raw).trim();
  if (!/^[0-9]{1,15}$/.test(text))
    fail(`${variable} must be a whole number, got ${JSON.stringify(raw)}`);
  const value = Number(text);
  if (value < minimum) fail(`${variable} must be at least ${minimum}, got ${value}`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
let config;
try {
  config = JSON.parse(stripJsonc(readFileSync(args.config, 'utf8')));
} catch (error) {
  fail(`cannot read ${args.config}: ${error instanceof Error ? error.message : String(error)}`);
}

const scope = args.env === undefined ? config : config.env?.[args.env];
if (scope === undefined) fail(`no environment ${JSON.stringify(args.env)} in ${args.config}`);
const where = args.env === undefined ? 'top-level' : `env.${args.env}`;
const vars = scope.vars ?? {};

const rows = LIMIT_VARIABLES.map((entry) => [entry.key, integerVar(vars, entry)]);
const byVariable = new Map(LIMIT_VARIABLES.map((entry, i) => [entry.variable, rows[i][1]]));

// Named environments do not inherit ratelimits, so read them from the same scope as the vars.
const ratelimits = scope.ratelimits ?? [];
for (const { binding, variable } of RATE_BINDINGS) {
  const declared = ratelimits.find((r) => r.name === binding);
  if (declared === undefined) {
    console.warn(
      `seed-limits: no ${binding} rate limiter in ${where} ratelimits; the Worker will allow every request it would have limited`,
    );
    continue;
  }
  const published = byVariable.get(variable);
  if (declared.simple?.period !== RATE_PERIOD_SECONDS) {
    fail(
      `${where} ratelimits ${binding}.simple.period must be ${RATE_PERIOD_SECONDS} (every rate is per minute), got ${declared.simple?.period}`,
    );
  }
  if (declared.simple?.limit !== published) {
    fail(
      `${where} ratelimits ${binding}.simple.limit is ${declared.simple?.limit} but ${variable} is ${published}. ` +
        'They must be equal: the binding is what is enforced and the var is what /v1/info publishes.',
    );
  }
}

const sql = [
  `-- Generated by scripts/seed-limits.mjs from the ${where} vars in ${args.config.replace(`${root}/`, '')}. Do not edit;`,
  '-- change the var and re-run `npm run db:seed` (or db:seed:test); production is re-seeded by every deploy.',
  ...rows.map(
    ([key, value]) =>
      `INSERT INTO limits (key, value) VALUES ('${key}', ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`,
  ),
  '',
].join('\n');
writeFileSync(args.out, sql);
console.log(
  `seed-limits: wrote ${rows.length} limits (${where}) to ${args.out.replace(`${root}/`, '')}`,
);
for (const [key, value] of rows) console.log(`  ${key} = ${value}`);
