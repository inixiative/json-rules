import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { openRails } from './rails/harness';

// A date in Json is text: check() and SQL read it alike — a number is epoch milliseconds, a zone
// names the instant, a zoneless string is wall time in the evaluation's zone — whatever the
// database session's zone. Prisma compares Json as text and refuses. Users 10–15 hold meta.d
// (14 a fractional epoch, 15 a padded one).
const SEED = `
INSERT INTO users (id, name, meta, tags) VALUES
  (10, 'Jo', '{"d":"2026-10-05T10:00:00Z"}', '{}'),
  (11, 'Kai', '{"d":"2026-10-07"}', '{}'),
  (12, 'Lu', '{"d":"2026-10-05T23:00:00-05:00"}', '{}'),
  (13, 'Mo', '{"d":"1759700000000"}', '{}'),
  (14, 'Ny', '{"d":1759700000000.5}', '{}'),
  (15, 'Oz', '{"d":" 1759700000000 "}', '{}');
`;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(SEED);
});
afterAll(async () => {
  await rails.close();
});

describe('dates in Json read as check() reads them, whatever the session zone', () => {
  const PRISMA_REFUSES = 'has no Prisma form';
  test.each([
    [
      'within the last two days',
      { field: 'meta.d', dateOperator: 'within', value: { ago: { days: 2 } } },
      [10, 12],
    ],
    [
      'before an instant',
      { field: 'meta.d', dateOperator: 'before', value: '2026-10-06T02:00:00Z' },
      [10, 13, 14, 15],
    ],
    [
      'between, zoneless in New York',
      { field: 'meta.d', dateOperator: 'between', value: ['2026-10-06', '2026-10-08'] },
      [11, 12],
    ],
  ] as const)('%s', async (_, rule, ids) => {
    const result = await rails.run(rule as Condition, { timeZone: 'America/New_York' });
    expect(result.check).toEqual([...ids]);
    expect(result.sql).toEqual([...ids]);
    expect(result.prisma).toContain(PRISMA_REFUSES);
  });
});
