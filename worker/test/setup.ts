import { beforeAll } from 'vitest';
import { applySchema, seedLimits } from './helpers';

beforeAll(async () => {
  await applySchema();
  await seedLimits();
});
