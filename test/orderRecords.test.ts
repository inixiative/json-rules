import { describe, expect, test } from 'bun:test';
import { orderRecords } from '../index';

const rows = [
  { id: 1, priority: 2, utilization: 0.5 },
  { id: 2, priority: 1, utilization: null },
  { id: 3, priority: 2, utilization: 0.2 },
  { id: 4, priority: 1, utilization: 0.9 },
  { id: 5, priority: 2 },
];

describe('orderRecords sorts records by an OrderBy as a window does', () => {
  test('each key in turn, in its direction', () => {
    const ordered = orderRecords(rows, [
      { field: 'priority', dir: 'desc' },
      { field: 'utilization', dir: 'asc' },
    ]);
    expect(ordered.map((row) => row.id)).toEqual([3, 1, 5, 4, 2]);
  });

  test('a NULL or absent value sorts last in either direction', () => {
    expect(orderRecords(rows, [{ field: 'utilization', dir: 'asc' }]).map((r) => r.id)).toEqual([
      3, 1, 4, 2, 5,
    ]);
    expect(orderRecords(rows, [{ field: 'utilization', dir: 'desc' }]).map((r) => r.id)).toEqual([
      4, 1, 3, 2, 5,
    ]);
  });

  test('ties keep input order, nested paths read own properties, the input is untouched', () => {
    const nested = [
      { id: 'a', meta: { rank: 1 } },
      { id: 'b', meta: { rank: 1 } },
      { id: 'c', meta: Object.create({ rank: 0 }) },
    ];
    expect(orderRecords(nested, [{ field: 'meta.rank', dir: 'asc' }]).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const before = rows.map((row) => row.id);
    orderRecords(rows, [{ field: 'id', dir: 'desc' }]);
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  test('dates order by time', () => {
    const dated = [
      { id: 1, at: new Date('2026-10-08') },
      { id: 2, at: new Date('2026-10-01') },
    ];
    expect(orderRecords(dated, [{ field: 'at', dir: 'asc' }]).map((r) => r.id)).toEqual([2, 1]);
  });
});
