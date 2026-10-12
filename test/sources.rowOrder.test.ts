import { describe, expect, test } from 'bun:test';
import { materializeSourceQuery, type Row, SourceOptionOrder, type SourceQuery } from '../index';

// A caller whose query ranks its rows (most-held first, most recent first) keeps that ranking with
// `order: SourceOptionOrder.query`: options come back in the order their value first appears. The default still
// sorts, so no rail's row order shows through unless the caller asks for it.

const query = { path: '', mapName: 'app', model: 'User', field: 'title' } as SourceQuery;
const grouped = { ...query, groupBy: ['team'] } as SourceQuery;

// Ranked by the caller's ORDER BY: VP (3 holders), Director (2), Analyst (1).
const ranked = [
  { title: 'VP' },
  { title: 'VP' },
  { title: 'Director' },
  { title: 'VP' },
  { title: 'Analyst' },
  { title: 'Director' },
];
const values = (rows: Row[], q: SourceQuery, order?: SourceOptionOrder) =>
  materializeSourceQuery(q, rows, order ? { order } : {}).options.map((o) =>
    o.groups ? `${o.groups.join('/')}:${o.value}` : o.value,
  );

describe('materializeSourceQuery { order: SourceOptionOrder.query }', () => {
  test('the default sorts by value', () => {
    expect(values(ranked, query)).toEqual(['Analyst', 'Director', 'VP']);
    expect(values(ranked, query, SourceOptionOrder.value)).toEqual(['Analyst', 'Director', 'VP']);
  });

  test('rows keeps first appearance, deduped', () => {
    expect(values(ranked, query, SourceOptionOrder.query)).toEqual(['VP', 'Director', 'Analyst']);
  });

  test('rows keeps each partition in the order its rows came', () => {
    const rows = [
      { team: 'sales', title: 'VP' },
      { team: 'eng', title: 'Staff' },
      { team: 'sales', title: 'AE' },
      { team: 'eng', title: 'Senior' },
    ];
    expect(values(rows, grouped, SourceOptionOrder.query)).toEqual([
      'sales:VP',
      'eng:Staff',
      'sales:AE',
      'eng:Senior',
    ]);
    expect(values(rows, grouped)).toEqual(['eng:Senior', 'eng:Staff', 'sales:AE', 'sales:VP']);
  });
});
