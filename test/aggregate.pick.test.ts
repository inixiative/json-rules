import { beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  createLens,
  evaluateValue,
  getAggregateOperators,
  inferValueType,
  type LensNarrowing,
  toPrisma,
  toSql,
  type ValueExpression,
  validateRule,
  validateRuleInLens,
  validateValue,
} from '../index';
import { negate } from '../src/negate';
import { map, openRails } from './rails/harness';

// `pick`: the window's `aggregate.field` values, in its order — one for `take: 1` (absent over no
// row), a list otherwise (`[]` over none). A value expression, and an aggregate rule's comparison.

const row = {
  enrichments: [
    { field: 'jobTitle', value: 'CTO', sourceRank: 2 },
    { field: 'email', value: 'a@b.co', sourceRank: 0 },
    { field: 'jobTitle', value: 'VP Sales', sourceRank: 1 },
    { field: 'jobTitle', value: 'Founder', sourceRank: 3 },
    { field: 'jobTitle', value: null, sourceRank: 4 },
  ],
};

const jobTitles = {
  field: 'enrichments',
  filter: { field: 'field', operator: 'equals', value: 'jobTitle' },
  orderBy: [{ field: 'sourceRank', dir: 'asc' }],
  aggregate: { mode: 'pick', field: 'value' },
} as const;

const pick = (window: Record<string, unknown>) =>
  ({ ...jobTitles, ...window }) as unknown as ValueExpression;

describe('pick as a value expression', () => {
  test('take 1 is the winning value', () => {
    expect(evaluateValue(pick({ take: 1 }), row)).toBe('VP Sales');
  });

  test('take N is the values in the window order', () => {
    expect(evaluateValue(pick({ take: 2 }), row)).toEqual(['VP Sales', 'CTO']);
    expect(evaluateValue(pick({ take: 3, skip: 1 }), row)).toEqual(['CTO', 'Founder']);
  });

  test('no take is every value of the window, NULLs skipped as every mode skips them', () => {
    expect(evaluateValue(pick({}), row)).toEqual(['VP Sales', 'CTO', 'Founder']);
  });

  test('the filter picks among the rows it keeps', () => {
    const email = { field: 'field', operator: 'equals', value: 'email' };
    expect(evaluateValue(pick({ take: 1, filter: email }), row)).toBe('a@b.co');
  });

  test('an empty window is null for take 1 and [] otherwise', () => {
    for (const data of [row, { enrichments: [] }, {}]) {
      expect(evaluateValue(pick({ take: 1, skip: 9 }), data)).toBeNull();
      expect(evaluateValue(pick({ take: 2, skip: 9 }), data)).toEqual([]);
    }
  });

  test('the winning row with a NULL value picks null', () => {
    const desc = { orderBy: [{ field: 'sourceRank', dir: 'desc' }], take: 1 };
    expect(evaluateValue(pick(desc), row)).toBeNull();
  });

  test('coerceType reads each picked value as its kind', () => {
    const dates = { visits: [{ at: '2026-01-02T00:00:00Z' }, { at: '2026-03-04T00:00:00Z' }] };
    const latest = {
      field: 'visits',
      orderBy: [{ field: 'at', dir: 'desc' }],
      take: 1,
      aggregate: { mode: 'pick', field: 'at' },
      coerceType: 'DateTime',
    } as unknown as ValueExpression;
    expect(evaluateValue(latest, dates)).toEqual(new Date('2026-03-04T00:00:00Z'));
    expect(validateValue(latest).ok).toBe(true);
  });

  test('its type is the column kind: nullable for take 1, a list otherwise', () => {
    const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const lens: LensNarrowing = { parent: base, root: { relations: { posts: {} } } };
    const views = { field: 'posts', orderBy: [{ field: 'views', dir: 'desc' }] };
    const one = { ...views, take: 1, aggregate: { mode: 'pick', field: 'title' } };
    expect(inferValueType(one as unknown as ValueExpression, lens)).toEqual({
      kind: 'String',
      isList: false,
      nullable: true,
    });
    expect(inferValueType({ ...one, take: 3 } as unknown as ValueExpression, lens)).toEqual({
      kind: 'String',
      isList: true,
      nullable: false,
    });
  });
});

describe('pick in a rule', () => {
  const winner = (rest: Record<string, unknown>) =>
    ({ ...jobTitles, take: 1, ...rest }) as unknown as Condition;
  const top = (rest: Record<string, unknown>) =>
    ({ ...jobTitles, take: 2, ...rest }) as unknown as Condition;

  test('the winning value equals X', () => {
    expect(check(winner({ operator: 'equals', value: 'VP Sales' }), row)).toBe(true);
    expect(check(winner({ operator: 'equals', value: 'CTO' }), row)).not.toBe(true);
    expect(check(winner({ operator: 'in', value: ['VP Sales', 'CEO'] }), row)).toBe(true);
    expect(check(winner({ operator: 'contains', value: 'Sales' }), row)).toBe(true);
    expect(validateRule(winner({ operator: 'equals', value: 'VP Sales' })).ok).toBe(true);
  });

  test('the top values contain X', () => {
    expect(check(top({ operator: 'contains', value: 'CTO' }), row)).toBe(true);
    expect(check(top({ operator: 'contains', value: 'Founder' }), row)).not.toBe(true);
    expect(check(top({ operator: 'notContains', value: 'Founder' }), row)).toBe(true);
    expect(validateRule(top({ operator: 'contains', value: 'CTO' })).ok).toBe(true);
  });

  test('a list pick takes contains / notContains of one value only', () => {
    expect(getAggregateOperators('pick', { list: true })).toEqual(['contains', 'notContains']);
    expect(
      validateRule(top({ operator: 'equals', value: 'CTO' })).errors.map((e) => e.code),
    ).toEqual(['invalid_aggregate_operator']);
    expect(
      validateRule(top({ operator: 'contains', value: ['CTO'] })).errors.map((e) => e.code),
    ).toEqual(['invalid_aggregate_value']);
  });

  test('a value is checked against the operator, as on a field', () => {
    expect(
      validateRule(winner({ operator: 'in', value: 'CTO' })).errors.map((e) => e.code),
    ).toEqual(['invalid_membership_value']);
    expect(validateRule(winner({ operator: 'equals', value: null })).ok).toBe(true);
    expect(
      validateRule(winner({ coerceType: 'Nope', operator: 'exists' })).errors.map((e) => e.code),
    ).toEqual(['invalid_coerce_type']);
  });

  test('over an empty window: a positive comparison fails, a negated one holds', () => {
    const empty = { skip: 9 };
    expect(check(winner({ ...empty, operator: 'equals', value: 'CTO' }), row)).not.toBe(true);
    expect(check(winner({ ...empty, operator: 'notEquals', value: 'CTO' }), row)).toBe(true);
    expect(check(winner({ ...empty, operator: 'notExists' }), row)).toBe(true);
    expect(check(top({ ...empty, operator: 'notContains', value: 'CTO' }), row)).toBe(true);
  });

  test('negate() is the complement, the no-value case included', () => {
    const ordered = (rest: Record<string, unknown>) =>
      winner({ operator: 'lessThan', value: 'W', ...rest });
    for (const rule of [ordered({}), ordered({ skip: 9 }), ordered({ value: 'A' })]) {
      expect(check(negate(rule), row) === true).toBe(check(rule, row) !== true);
    }
  });
});

describe('a take-1 pick compares as a field holding the value does, coerceType included', () => {
  const stored = { items: [{ n: '5' }], n: '5' };
  const picked = { field: 'items', take: 1, aggregate: { mode: 'pick', field: 'n' } };

  test.each<[string, unknown]>([
    ['equals', '5'],
    ['equals', 5],
    ['greaterThan', '4'],
    ['in', ['5']],
    ['notEquals', '6'],
  ])('%s %p under coerceType Int', (operator, value) => {
    const comparison = { operator, value, coerceType: 'Int' };
    const asField = check({ field: 'n', ...comparison } as unknown as Condition, stored);
    expect(asField).toBe(true);
    expect(check({ ...picked, ...comparison } as unknown as Condition, stored)).toBe(asField);
  });

  test('coerceType reads the picked values as a value expression does', () => {
    const decimal = { toNumber: () => 2.5, toString: () => '2.5' };
    const rows = { items: [{ n: decimal, at: new Date('2026-01-02T00:00:00.000Z') }] };
    const one = { field: 'items', take: 1 };
    const asDecimal = { ...one, aggregate: { mode: 'pick', field: 'n' }, coerceType: 'Decimal' };
    expect(evaluateValue(asDecimal as unknown as ValueExpression, rows)).toBe(2.5);
    expect(
      check({ ...asDecimal, operator: 'equals', value: 2.5 } as unknown as Condition, rows),
    ).toBe(true);
    const list = { ...asDecimal, take: 3, operator: 'contains', value: 2.5 };
    expect(check(list as unknown as Condition, rows)).toBe(true);
    const asString = { ...one, aggregate: { mode: 'pick', field: 'at' }, coerceType: 'String' };
    const iso = { ...asString, operator: 'equals', value: '2026-01-02T00:00:00.000Z' };
    expect(check(iso as unknown as Condition, rows)).toBe(true);
  });

  test('under a lens the comparison is checked against the picked column, as a field rule is', () => {
    const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const lens: LensNarrowing = { parent: base, root: { relations: { posts: {} } } };
    const top = { field: 'posts', orderBy: [{ field: 'views', dir: 'desc' }], take: 1 };
    const codes = (rule: unknown) =>
      validateRuleInLens(rule as Condition, lens).errors.map((e) => e.code);
    const title = { ...top, aggregate: { mode: 'pick', field: 'title' } };
    const views = { ...top, aggregate: { mode: 'pick', field: 'views' } };
    expect(codes({ ...title, operator: 'equals', value: 'hello' })).toEqual([]);
    expect(codes({ ...title, operator: 'equals', value: 5 })).not.toEqual([]);
    expect(codes({ ...views, operator: 'contains', value: 'x' })).toEqual([
      'operator_kind_mismatch',
    ]);
  });

  test('under a lens a picked enum column takes only the values the lens allows', () => {
    const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Org' });
    const lens: LensNarrowing = {
      parent: base,
      root: { relations: { users: { enumOmits: { role: ['Guest'] } } } },
    };
    const eldest = {
      field: 'users',
      orderBy: [{ field: 'age', dir: 'desc' }],
      take: 1,
      aggregate: { mode: 'pick', field: 'role' },
      operator: 'equals',
    };
    const codes = (value: string) =>
      validateRuleInLens({ ...eldest, value } as unknown as Condition, lens).errors.map(
        (e) => e.code,
      );
    expect(codes('admin')).toEqual([]);
    expect(codes('Guest')).toEqual(['value_not_allowed']);
  });
});

describe('a pick with no orderBy picks in the order the rows are in', () => {
  const { orderBy: _order, ...unordered } = jobTitles;

  test('it validates, as every other mode over a cut window does', () => {
    const value = { ...unordered, take: 1 } as unknown as ValueExpression;
    expect(validateValue(value).ok).toBe(true);
    expect(validateRule({ ...unordered, take: 1, operator: 'equals', value: 'CTO' }).ok).toBe(true);
    expect(validateRule({ ...unordered, skip: 1, operator: 'contains', value: 'CTO' }).ok).toBe(
      true,
    );
  });

  test('take 1 is the first row as stored', () => {
    expect(evaluateValue({ ...unordered, take: 1 } as unknown as ValueExpression, row)).toBe('CTO');
    const firstTag = { field: 'tags', take: 1, aggregate: { mode: 'pick' } };
    expect(evaluateValue(firstTag as unknown as ValueExpression, { tags: ['b', 'a'] })).toBe('b');
  });
});

describe('a take-1 pick over no row is absent; a row holding NULL is null', () => {
  const winner = { ...jobTitles, take: 1 };
  const noRow = { enrichments: [] };
  const nullRow = { enrichments: [{ field: 'jobTitle', value: null, sourceRank: 1 }] };
  const unknown = { absent: 'unknown' } as const;
  const isNull = { ...winner, operator: 'equals', value: null } as unknown as Condition;

  test('a value reads both as null', () => {
    expect(evaluateValue(winner as unknown as ValueExpression, noRow)).toBeNull();
    expect(evaluateValue(winner as unknown as ValueExpression, nullRow)).toBeNull();
  });

  test('by default check() reads no row as null, as it reads an absent path', () => {
    expect(check(isNull, noRow)).toBe(true);
    expect(check(isNull, nullRow)).toBe(true);
  });

  test('a picked row that does not carry the field is absent too', () => {
    const bare = { enrichments: [{ field: 'jobTitle', sourceRank: 1 }] };
    expect(check(isNull, bare)).toBe(true);
    expect(check(isNull, bare, unknown)).not.toBe(true);
  });

  test('a list pick over no row is an empty list, and its negation the exact complement', () => {
    const holds = { ...jobTitles, operator: 'contains', value: 'CTO' } as unknown as Condition;
    expect(check(holds, noRow)).not.toBe(true);
    expect(check(negate(holds), noRow)).toBe(true);
  });

  test("under absent: 'unknown' no row is unknown, and a NULL the row holds is still null", () => {
    expect(check(isNull, noRow, unknown)).not.toBe(true);
    expect(check(isNull, nullRow, unknown)).toBe(true);
    // The operators that hold on a missing value keep their meaning.
    const missing = { ...winner, operator: 'notExists' } as unknown as Condition;
    expect(check(missing, noRow, unknown)).toBe(true);
  });
});

describe('pick on the compiled rails: refused when the rule is validated', () => {
  const rule = {
    ...jobTitles,
    take: 1,
    operator: 'equals',
    value: 'VP Sales',
  } as unknown as Condition;
  // No window: the refusal is the mode's alone.
  const bare = {
    field: 'tags',
    aggregate: { mode: 'pick' },
    operator: 'contains',
    value: 'a',
  } as unknown as Condition;

  test('validateRule names the mode for toSql and toPrisma', () => {
    for (const [target, slug] of [
      ['toSql', 'sql'],
      ['toPrisma', 'prisma'],
    ] as const) {
      const codes = validateRule(bare, { target, map, model: 'User' }).errors.map((e) => e.code);
      expect(codes).toEqual([`unsupported_${slug}_aggregate_mode`]);
      expect(validateRule(rule, { target }).errors.map((e) => e.code)).toContain(
        `unsupported_${slug}_aggregate_mode`,
      );
    }
  });

  test('the compilers throw the same refusal', () => {
    expect(() => toSql(bare, { map, model: 'User' })).toThrow(
      "aggregate.mode 'pick' has no toSql() form",
    );
    expect(() => toPrisma(bare, { map, model: 'User' })).toThrow(
      "aggregate.mode 'pick' has no toPrisma() form",
    );
  });

  describe('over one database', () => {
    let rails: Awaited<ReturnType<typeof openRails>>;
    beforeAll(async () => {
      rails = await openRails();
    });

    test("check() picks each user's most viewed post title; the compilers refuse", async () => {
      const mostViewed = {
        field: 'posts',
        orderBy: [{ field: 'views', dir: 'desc' }],
        take: 1,
        aggregate: { mode: 'pick', field: 'title' },
        operator: 'equals',
        value: 'hello',
      } as unknown as Condition;
      const result = await rails.run(mostViewed);
      expect(result.check).toEqual([1]);
      expect(result.sql).toBe(
        "throws: aggregate.mode 'pick' has no toSql() form — evaluate it in memory with check().",
      );
      expect(result.prisma).toBe(
        "throws: aggregate.mode 'pick' has no toPrisma() form — evaluate it in memory with check().",
      );
    });
  });
});
