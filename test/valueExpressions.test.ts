import { describe, expect, test } from 'bun:test';
import {
  type AggregateValue,
  ArrayOperator,
  assertValidValue,
  type Condition,
  check,
  createLens,
  DateOperator,
  describeValue,
  engineGlobals,
  evaluateValue,
  type FieldKind,
  type FieldMapEntry,
  type FieldMapSet,
  inferValueType,
  type LensNarrowing,
  Operator,
  UsageError,
  VALUE_AGGREGATE_MODES,
  type ValueExpression,
  type ValueType,
  validateRule,
  validateValue,
  valueClockUnit,
} from '../index';

// ─── A lens shaped like the consumer's advocate row ─────────────────────────

const rel = (type: string, isList = false): FieldMapEntry => ({
  kind: 'object',
  type,
  isList,
  relationName: type,
  fromFields: [],
  toFields: [],
});

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      FanUser: {
        fields: {
          name: { kind: 'scalar', type: 'String', isRequired: true },
          brandUuid: { kind: 'scalar', type: 'String', isRequired: true },
          score: { kind: 'scalar', type: 'Float' },
          tags: { kind: 'scalar', type: 'String', isList: true },
          meta: { kind: 'scalar', type: 'Json' },
          secret: { kind: 'scalar', type: 'String' },
          fanMissions: rel('FanMission', true),
          brandReferenceRequestFanUsers: rel('BrandReferenceRequestFanUser', true),
          profile: rel('Profile'),
        },
      },
      FanMission: {
        fields: {
          status: { kind: 'enum', type: 'MissionStatus', isRequired: true },
          points: { kind: 'scalar', type: 'Int' },
          weight: { kind: 'scalar', type: 'Decimal' },
          title: { kind: 'scalar', type: 'String' },
          approvedAt: { kind: 'scalar', type: 'DateTime' },
          brandUuid: { kind: 'scalar', type: 'String' },
        },
      },
      BrandReferenceRequestFanUser: {
        fields: {
          affiliation: { kind: 'scalar', type: 'String', isRequired: true },
          status: { kind: 'scalar', type: 'String', isRequired: true },
          activatedAt: { kind: 'scalar', type: 'DateTime' },
          brandReferenceRequest: rel('BrandReferenceRequest'),
        },
      },
      BrandReferenceRequest: {
        fields: { status: { kind: 'scalar', type: 'String', isRequired: true } },
      },
      Profile: {
        fields: { city: { kind: 'scalar', type: 'String' } },
      },
    },
    enums: { MissionStatus: ['approved', 'rejected', 'pending', 'draft'] },
  },
};

const base = createLens({ maps, mapName: 'app', model: 'FanUser' });
const lens: LensNarrowing = {
  parent: base,
  root: {
    omits: ['secret'],
    relations: {
      fanMissions: {},
      brandReferenceRequestFanUsers: { relations: { brandReferenceRequest: {} } },
      profile: {},
    },
  },
};

const NOW = '2026-11-04T12:00:00Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000);

// ─── The five ZLT-6467 values ───────────────────────────────────────────────

const isAsk = {
  all: [
    { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
    { field: 'activatedAt', operator: Operator.exists },
  ],
};

const completedMissions: ValueExpression = {
  field: 'fanMissions',
  aggregate: { mode: 'count' },
  filter: { field: 'status', operator: Operator.equals, value: 'approved' },
};

const completedReferences: ValueExpression = {
  field: 'brandReferenceRequestFanUsers',
  aggregate: { mode: 'count' },
  filter: {
    all: [
      { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
      { field: 'status', operator: Operator.in, value: ['active', 'accepted'] },
      {
        field: 'brandReferenceRequest.status',
        operator: Operator.in,
        value: ['completed', 'meeting_completed'],
      },
    ],
  },
};

const referenceAsks: ValueExpression = {
  field: 'brandReferenceRequestFanUsers',
  aggregate: { mode: 'count' },
  filter: isAsk,
};

const referenceAsksLast90Days: ValueExpression = {
  field: 'brandReferenceRequestFanUsers',
  aggregate: { mode: 'count' },
  filter: {
    all: [
      ...isAsk.all,
      { field: 'activatedAt', dateOperator: DateOperator.onOrAfter, value: { ago: { days: 90 } } },
    ],
  },
};

const lastReferenceAskAt: ValueExpression = {
  field: 'brandReferenceRequestFanUsers',
  aggregate: { mode: 'max', field: 'activatedAt' },
  filter: isAsk,
};

const advocate = {
  name: 'Ann',
  brandUuid: 'b1',
  fanMissions: [
    { status: 'approved', points: 10, approvedAt: daysAgo(5) },
    { status: 'approved', points: 20, approvedAt: daysAgo(200) },
    { status: 'rejected', points: 99, approvedAt: null },
    { status: 'draft', points: null },
  ],
  brandReferenceRequestFanUsers: [
    {
      affiliation: 'advocate',
      status: 'accepted',
      activatedAt: daysAgo(10),
      brandReferenceRequest: { status: 'completed' },
    },
    {
      affiliation: 'advocate',
      status: 'active',
      activatedAt: daysAgo(120),
      brandReferenceRequest: { status: 'meeting_completed' },
    },
    {
      affiliation: 'advocate',
      status: 'pending',
      activatedAt: null,
      brandReferenceRequest: { status: 'open' },
    },
    {
      affiliation: 'prospect',
      status: 'accepted',
      activatedAt: daysAgo(1),
      brandReferenceRequest: { status: 'completed' },
    },
    {
      affiliation: 'advocate',
      status: 'accepted',
      activatedAt: daysAgo(89),
      brandReferenceRequest: { status: 'cancelled' },
    },
  ],
};
const neverAsked = {
  name: 'Bob',
  brandUuid: 'b1',
  fanMissions: [],
  brandReferenceRequestFanUsers: [],
};

describe('the five ZLT-6467 values', () => {
  const at = { now: NOW };

  test('over an advocate with history', () => {
    expect(evaluateValue(completedMissions, advocate, at)).toBe(2);
    expect(evaluateValue(completedReferences, advocate, at)).toBe(2);
    expect(evaluateValue(referenceAsks, advocate, at)).toBe(3);
    expect(evaluateValue(referenceAsksLast90Days, advocate, at)).toBe(2);
    expect(evaluateValue(lastReferenceAskAt, advocate, at)).toEqual(daysAgo(10));
  });

  test('over an advocate never asked: counts are 0, the last ask is null', () => {
    expect(evaluateValue(completedMissions, neverAsked, at)).toBe(0);
    expect(evaluateValue(referenceAsks, neverAsked, at)).toBe(0);
    expect(evaluateValue(referenceAsksLast90Days, neverAsked, at)).toBe(0);
    expect(evaluateValue(lastReferenceAskAt, neverAsked, at)).toBeNull();
  });

  test('a count agrees with the exactly-N array rule over the same filter', () => {
    for (const row of [advocate, neverAsked]) {
      const n = evaluateValue(referenceAsksLast90Days, row, at) as number;
      const rule = {
        field: 'brandReferenceRequestFanUsers',
        arrayOperator: ArrayOperator.exactly,
        count: n,
        condition: (referenceAsksLast90Days as AggregateValue).filter as Condition,
      };
      expect(check(rule, row, at)).toBe(true);
    }
  });

  test('types: four numbers, one nullable date', () => {
    const int: ValueType = { kind: 'Int', isList: false, nullable: false };
    expect(inferValueType(completedMissions, lens)).toEqual(int);
    expect(inferValueType(completedReferences, lens)).toEqual(int);
    expect(inferValueType(referenceAsks, lens)).toEqual(int);
    expect(inferValueType(referenceAsksLast90Days, lens)).toEqual(int);
    expect(inferValueType(lastReferenceAskAt, lens)).toEqual({
      kind: 'DateTime',
      isList: false,
      nullable: true,
    });
  });

  test('clock: only the 90-day window reads one, at day', () => {
    expect(valueClockUnit(completedMissions)).toBeNull();
    expect(valueClockUnit(completedReferences)).toBeNull();
    expect(valueClockUnit(referenceAsks)).toBeNull();
    expect(valueClockUnit(referenceAsksLast90Days)).toBe('day');
    expect(valueClockUnit(lastReferenceAskAt)).toBeNull();
  });

  test('describeValue: the paths each reads, no errors', () => {
    expect(describeValue(completedMissions, lens)).toEqual({
      type: { kind: 'Int', isList: false, nullable: false },
      paths: ['fanMissions', 'fanMissions.status'],
      clockUnit: null,
      errors: [],
    });
    expect(describeValue(completedReferences, lens).paths).toEqual([
      'brandReferenceRequestFanUsers',
      'brandReferenceRequestFanUsers.affiliation',
      'brandReferenceRequestFanUsers.brandReferenceRequest.status',
      'brandReferenceRequestFanUsers.status',
    ]);
    const last = describeValue(lastReferenceAskAt, lens);
    expect(last.paths).toEqual([
      'brandReferenceRequestFanUsers',
      'brandReferenceRequestFanUsers.activatedAt',
      'brandReferenceRequestFanUsers.affiliation',
    ]);
    expect(last.errors).toEqual([]);
    expect(describeValue(referenceAsksLast90Days, lens).clockUnit).toBe('day');
  });
});

// ─── Each mode on empty, one and many rows ──────────────────────────────────

const over = (mode: string, field?: string): ValueExpression =>
  ({ field: 'fanMissions', aggregate: { mode, ...(field && { field }) } }) as ValueExpression;
const rows = (...missions: Record<string, unknown>[]) => ({ fanMissions: missions });

describe('aggregate modes', () => {
  test('VALUE_AGGREGATE_MODES lists every mode; aggregate rules still compare sum and avg only', () => {
    expect([...VALUE_AGGREGATE_MODES]).toEqual(['sum', 'avg', 'count', 'min', 'max']);
    const countRule = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      operator: Operator.greaterThan,
      value: 1,
    } as never;
    expect(validateRule(countRule).errors.map((e) => e.code)).toEqual(['invalid_aggregate_mode']);
    expect(() => check(countRule, rows())).toThrow('aggregate.mode must be one of sum / avg');
  });

  test('empty, absent and NULL lists', () => {
    for (const row of [rows(), {}, { fanMissions: null }]) {
      expect(evaluateValue(over('count'), row)).toBe(0);
      expect(evaluateValue(over('sum', 'points'), row)).toBe(0);
      expect(evaluateValue(over('avg', 'points'), row)).toBe(0);
      expect(evaluateValue(over('min', 'points'), row)).toBeNull();
      expect(evaluateValue(over('max', 'points'), row)).toBeNull();
    }
  });

  test('one row', () => {
    const row = rows({ points: 7 });
    expect(evaluateValue(over('count'), row)).toBe(1);
    expect(evaluateValue(over('sum', 'points'), row)).toBe(7);
    expect(evaluateValue(over('avg', 'points'), row)).toBe(7);
    expect(evaluateValue(over('min', 'points'), row)).toBe(7);
    expect(evaluateValue(over('max', 'points'), row)).toBe(7);
  });

  test('many rows; NULL values are skipped by every mode but count(*)', () => {
    const row = rows({ points: 4 }, { points: null }, { points: 10 }, {}, { points: 1 });
    expect(evaluateValue(over('count'), row)).toBe(5);
    expect(evaluateValue(over('count', 'points'), row)).toBe(3);
    expect(evaluateValue(over('sum', 'points'), row)).toBe(15);
    expect(evaluateValue(over('avg', 'points'), row)).toBe(5);
    expect(evaluateValue(over('min', 'points'), row)).toBe(1);
    expect(evaluateValue(over('max', 'points'), row)).toBe(10);
  });

  test('min / max order dates and strings, and return the value as stored', () => {
    const a = new Date('2026-01-02T00:00:00Z');
    const b = new Date('2026-03-04T00:00:00Z');
    const row = rows({ approvedAt: b, title: 'beta' }, { approvedAt: a, title: 'alpha' });
    expect(evaluateValue(over('min', 'approvedAt'), row)).toBe(a);
    expect(evaluateValue(over('max', 'approvedAt'), row)).toBe(b);
    expect(evaluateValue(over('min', 'title'), row)).toBe('alpha');
    expect(evaluateValue(over('max', 'title'), row)).toBe('beta');
  });

  test('a primitive list aggregates its own values', () => {
    expect(
      evaluateValue({ field: 'scores', aggregate: { mode: 'max' } }, { scores: [3, 9, 2] }),
    ).toBe(9);
    expect(
      evaluateValue({ field: 'scores', aggregate: { mode: 'count' } }, { scores: [3, 9] }),
    ).toBe(2);
  });
});

// ─── Windows: filter, orderBy, take, skip, condition ────────────────────────

describe('windows', () => {
  const missions = rows(
    { points: 1, approvedAt: daysAgo(1), status: 'approved' },
    { points: 2, approvedAt: daysAgo(40), status: 'approved' },
    { points: 3, approvedAt: daysAgo(100), status: 'rejected' },
    { points: 4, approvedAt: daysAgo(2), status: 'approved' },
  );

  test('a relative-date filter against a fixed now', () => {
    const last30: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'sum', field: 'points' },
      filter: {
        field: 'approvedAt',
        dateOperator: DateOperator.after,
        value: { ago: { days: 30 } },
      },
    };
    expect(evaluateValue(last30, missions, { now: NOW })).toBe(5);
    // The same rows a week later: the 2-day-old mission is still in, nothing else changes.
    expect(evaluateValue(last30, missions, { now: daysAgo(-7).toISOString() })).toBe(5);
    // 40 days later none is inside the window.
    expect(evaluateValue(last30, missions, { now: daysAgo(-40).toISOString() })).toBe(0);
  });

  test('a relative date needs now, as check() does', () => {
    const windowed: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: {
        field: 'approvedAt',
        dateOperator: DateOperator.after,
        value: { ago: { days: 30 } },
      },
    };
    expect(() => evaluateValue(windowed, missions)).toThrow(UsageError);
  });

  test('an offset on a row-to-row compare', () => {
    // Missions approved more than 30 days before the row's own cutoff.
    const expr: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: {
        field: 'approvedAt',
        dateOperator: DateOperator.before,
        path: '$$.cutoff',
        offset: { value: { ago: { days: 30 } } },
      },
    };
    expect(evaluateValue(expr, { ...missions, cutoff: NOW })).toBe(2);
  });

  test('orderBy + take: the latest two', () => {
    const latestTwo = (mode: string): ValueExpression =>
      ({
        field: 'fanMissions',
        aggregate: { mode, field: 'points' },
        orderBy: [{ field: 'approvedAt', dir: 'desc' }],
        take: 2,
      }) as ValueExpression;
    expect(evaluateValue(latestTwo('sum'), missions)).toBe(5);
    expect(evaluateValue(latestTwo('min'), missions)).toBe(1);
    expect(evaluateValue(latestTwo('count'), missions)).toBe(2);
  });

  test('skip, and the filter runs before the window, the condition after it', () => {
    const expr = (extra: object): ValueExpression =>
      ({
        field: 'fanMissions',
        aggregate: { mode: 'max', field: 'points' },
        orderBy: [{ field: 'points', dir: 'asc' }],
        ...extra,
      }) as ValueExpression;
    expect(evaluateValue(expr({ skip: 1, take: 2 }), missions)).toBe(3);
    const approved = { field: 'status', operator: Operator.equals, value: 'approved' };
    // filter → [1, 2, 4] → take 2 → [1, 2]
    expect(evaluateValue(expr({ filter: approved, take: 2 }), missions)).toBe(2);
    // take 2 → [1, 2] → condition (all approved) → [1, 2]; take 3 → [1, 2, 3] → [1, 2]
    expect(evaluateValue(expr({ take: 3, condition: approved }), missions)).toBe(2);
  });

  test('a filter reads the row through $$.', () => {
    const row = {
      brandUuid: 'b1',
      fanMissions: [{ brandUuid: 'b1' }, { brandUuid: 'b2' }, { brandUuid: 'b1' }],
    };
    const sameBrand: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: { field: 'brandUuid', operator: Operator.equals, path: '$$.brandUuid' },
    };
    expect(evaluateValue(sameBrand, row)).toBe(2);
  });

  test('bindings reach a filter', () => {
    const bound: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: { field: 'status', operator: Operator.equals, bind: 'status' },
    };
    expect(evaluateValue(bound, missions, { bindings: { status: 'rejected' } })).toBe(1);
    expect(() => evaluateValue(bound, missions)).toThrow('Missing binding for "status"');
  });
});

// ─── Sources, if / else (first match) and lists (match-all) ─────────────────

describe('sources, if / else and lists', () => {
  test('a literal, a path (null when absent) and a binding', () => {
    expect(evaluateValue({ value: 3 }, {})).toBe(3);
    expect(evaluateValue({ path: 'profile.city' }, { profile: { city: 'Lisbon' } })).toBe('Lisbon');
    expect(evaluateValue({ path: 'profile.city' }, {})).toBeNull();
    expect(evaluateValue({ path: '$.name' }, { name: 'Ann' })).toBe('Ann');
    expect(evaluateValue({ bind: 'x' }, {}, { bindings: { x: 'y' } })).toBe('y');
  });

  // First match is an if / else chain: the first rule that holds picks the value, the last
  // `else` is the default.
  const tier: ValueExpression = {
    if: { field: 'fanMissions', arrayOperator: ArrayOperator.atLeast, count: 3, condition: true },
    then: { value: 'gold' },
    else: {
      if: { field: 'fanMissions', arrayOperator: ArrayOperator.notEmpty },
      then: { value: 'silver' },
      else: { value: 'none' },
    },
  };

  test('first match as if / else', () => {
    expect(evaluateValue(tier, rows({}, {}, {}))).toBe('gold');
    expect(evaluateValue(tier, rows({}))).toBe('silver');
    expect(evaluateValue(tier, rows())).toBe('none');
    expect(inferValueType(tier, lens)).toEqual({ kind: 'String', isList: false, nullable: false });
  });

  test('a branch can be computed; an if with no else is null', () => {
    const expr: ValueExpression = {
      if: { field: 'name', operator: Operator.exists },
      then: { field: 'fanMissions', aggregate: { mode: 'count' } },
    };
    expect(evaluateValue(expr, { name: 'Ann', fanMissions: [{}, {}] })).toBe(2);
    expect(evaluateValue(expr, { fanMissions: [{}, {}] })).toBeNull();
    expect(inferValueType(expr, lens)).toEqual({ kind: 'Int', isList: false, nullable: true });
  });

  // Experimental: match-all for a multiselect, as a list whose items are each an if / then.
  const badges: ValueExpression = [
    {
      if: { field: 'fanMissions', arrayOperator: ArrayOperator.notEmpty },
      then: { value: 'active' },
    },
    { if: { field: 'profile.city', operator: Operator.exists }, then: { path: 'profile.city' } },
    { value: 'member' },
  ];

  test('a list: each item that holds adds its value (experimental)', () => {
    expect(evaluateValue(badges, { fanMissions: [{}], profile: { city: 'Porto' } })).toEqual([
      'active',
      'Porto',
      'member',
    ]);
    expect(evaluateValue(badges, { fanMissions: [] })).toEqual(['member']);
    expect(inferValueType(badges, lens)).toEqual({ kind: 'String', isList: true, nullable: true });
  });
});

// ─── Type inference ─────────────────────────────────────────────────────────

describe('inferValueType', () => {
  const type = (kind: FieldKind | null, nullable = false, isList = false): ValueType => ({
    kind,
    isList,
    nullable,
  });

  test('literals', () => {
    expect(inferValueType({ value: 3 })).toEqual(type('Int'));
    expect(inferValueType({ value: 1.5 })).toEqual(type('Float'));
    expect(inferValueType({ value: 'x' })).toEqual(type('String'));
    expect(inferValueType({ value: true })).toEqual(type('Boolean'));
    expect(inferValueType({ value: null })).toEqual(type(null, true));
    expect(inferValueType({ value: ['a', 'b'] })).toEqual(type('String', false, true));
  });

  test('paths take their column kind through the lens', () => {
    expect(inferValueType({ path: 'name' }, lens)).toEqual(type('String'));
    expect(inferValueType({ path: 'score' }, lens)).toEqual(type('Float', true));
    expect(inferValueType({ path: 'tags' }, lens)).toEqual(type('String', true, true));
    expect(inferValueType({ path: 'meta.a.b' }, lens)).toEqual(type('Json', true));
    expect(inferValueType({ path: 'profile.city' }, lens)).toEqual(type('String', true));
  });

  test('each aggregate mode', () => {
    expect(inferValueType(over('count'), lens)).toEqual(type('Int'));
    expect(inferValueType(over('count'))).toEqual(type('Int'));
    expect(inferValueType(over('sum', 'points'), lens)).toEqual(type('Int'));
    expect(inferValueType(over('sum', 'weight'), lens)).toEqual(type('Decimal'));
    expect(inferValueType(over('avg', 'points'), lens)).toEqual(type('Float'));
    expect(inferValueType(over('min', 'title'), lens)).toEqual(type('String', true));
    expect(inferValueType(over('max', 'approvedAt'), lens)).toEqual(type('DateTime', true));
  });

  test('branches unify: two numbers read as Float, a mismatch is refused', () => {
    expect(
      inferValueType({ if: true, then: over('count'), else: over('avg', 'points') }, lens),
    ).toEqual(type('Float'));
    expect(() => inferValueType({ if: true, then: { value: 1 }, else: { value: 'x' } })).toThrow(
      'inferValueType: $: the values here are Int and String',
    );
  });

  test('refusals name the node and why', () => {
    const cases: [ValueExpression, string][] = [
      [{ path: 'fanMissions.status' }, "reads through the to-many relation 'fanMissions'"],
      [{ path: 'fanMissions' }, "names a relation's rows, not a value"],
      [{ path: 'secret' }, "'secret' does not resolve through the lens (hidden)"],
      [{ path: 'nope' }, "'nope' does not resolve through the lens (missing)"],
      [over('sum', 'title'), 'sum adds numbers, not String values'],
      [over('min', 'status'), 'min orders numbers, strings and dates, not Enum values'],
      [over('max'), 'max over rows names the field it reads'],
      [{ field: 'name', aggregate: { mode: 'count' } }, "'name' is not a list"],
      [{ bind: 'x' }, "{ bind: 'x' } has no type until it is bound"],
      [[{ value: 1 }, { value: [1] }], "$[1]: a list's items are single values"],
      [{ path: '$$.name' }, "Scope ref '$$.name' needs depth 2"],
    ];
    for (const [expr, message] of cases) expect(() => inferValueType(expr, lens)).toThrow(message);
  });

  test('a relation the lens does not turn on is hidden', () => {
    expect(() => inferValueType(over('count'), base)).toThrow('(hidden)');
  });

  test('a path with no lens is a usage error; a count needs none', () => {
    expect(() => inferValueType({ path: 'name' })).toThrow(UsageError);
    expect(() => inferValueType(over('max', 'points'))).toThrow(UsageError);
  });
});

// ─── describeValue ──────────────────────────────────────────────────────────

describe('describeValue', () => {
  test('paths through an if, a list and a value-side path', () => {
    const expr: ValueExpression = {
      if: { field: 'score', operator: Operator.greaterThan, path: 'meta.min' },
      then: [
        { path: 'profile.city' },
        { field: 'fanMissions', aggregate: { mode: 'max', field: 'points' } },
      ],
    } as never;
    expect(describeValue(expr, lens).paths).toEqual([
      'fanMissions',
      'fanMissions.points',
      'meta.min',
      'profile.city',
      'score',
    ]);
  });

  test('the lens gate reports a hidden column inside a filter', () => {
    const expr: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: { field: 'missing', operator: Operator.equals, value: 1 },
    };
    const { errors, type } = describeValue(expr, lens);
    expect(type).toEqual({ kind: 'Int', isList: false, nullable: false });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBe('missing');
  });

  test('a type refusal is an issue, not a throw', () => {
    expect(describeValue(over('sum', 'title'), lens)).toMatchObject({
      type: null,
      errors: [{ path: '$.aggregate.field', code: 'aggregate_kind_mismatch' }],
    });
  });

  test('a shape problem stops there', () => {
    expect(describeValue({ value: 1, path: 'x' } as never, lens).errors[0].code).toBe(
      'invalid_value_source',
    );
  });
});

// ─── clockUnit folding ──────────────────────────────────────────────────────

describe('valueClockUnit', () => {
  test('folds the finest unit from every condition an expression holds', () => {
    const expr: ValueExpression = {
      if: { field: 'createdAt', dateOperator: DateOperator.after, value: { this: 'week' } },
      then: {
        field: 'fanMissions',
        aggregate: { mode: 'count' },
        filter: {
          field: 'approvedAt',
          dateOperator: DateOperator.after,
          value: { ago: { hours: 6 } },
        },
      },
      else: { value: 0 },
    };
    expect(valueClockUnit(expr)).toBe('hour');
    expect(valueClockUnit({ value: 1 })).toBeNull();
    expect(valueClockUnit({ path: 'name' })).toBeNull();
    expect(valueClockUnit([{ if: true, then: { value: 1 } }])).toBeNull();
  });

  test('a unit finer than clock.finestUnit throws, and evaluating it does too', () => {
    const expr: ValueExpression = {
      field: 'fanMissions',
      aggregate: { mode: 'count' },
      filter: {
        field: 'approvedAt',
        dateOperator: DateOperator.after,
        value: { ago: { minutes: 5 } },
      },
    };
    engineGlobals.with({ clock: { finestUnit: 'hour' } }, () => {
      expect(() => valueClockUnit(expr)).toThrow();
      expect(() => evaluateValue(expr, rows({ approvedAt: NOW }), { now: NOW })).toThrow();
      expect(describeValue(expr, lens).errors.map((e) => e.code)).toEqual([
        'clock_unit_below_floor',
      ]);
    });
  });
});

// ─── Invalid input ──────────────────────────────────────────────────────────

describe('invalid expressions', () => {
  const codes = (expr: unknown) => validateValue(expr).errors.map((e) => `${e.path} ${e.code}`);

  test('validateValue reports each problem at its node', () => {
    expect(codes({ value: 1 })).toEqual([]);
    expect(codes(lastReferenceAskAt)).toEqual([]);
    expect(codes(3)).toEqual(['$ invalid_value_expression']);
    expect(codes({})).toEqual(['$ invalid_value_expression']);
    expect(codes({ value: 1, path: 'x' })).toEqual(['$ invalid_value_source']);
    expect(codes({ value: 1, offset: 2 })).toEqual(['$.offset unknown_key']);
    expect(codes({ path: '' })).toEqual(['$.path invalid_path']);
    expect(
      codes({
        field: 'fanMissions',
        aggregate: { mode: 'count' },
        operator: 'greaterThan',
        value: 1,
      }),
    ).toEqual(['$ unexpected_comparison']);
    expect(codes({ field: 'fanMissions', aggregate: { mode: 'median' } })).toEqual([
      '$.aggregate.mode invalid_aggregate_mode',
    ]);
    expect(codes({ aggregate: { mode: 'count' } })).toContain('$.field field_required');
    expect(codes({ field: 'fanMissions', aggregate: { mode: 'count' }, take: -1 })).toContain(
      '$.take invalid_window_take',
    );
    expect(
      codes({
        field: 'fanMissions',
        aggregate: { mode: 'count' },
        filter: { field: 'x', operator: 'nope' },
      }),
    ).toEqual(['$.filter.operator invalid_operator']);
    expect(codes({ if: { field: 'x' }, then: { value: 1 } })[0]).toMatch(/^\$\.if/);
    expect(codes({ if: true })).toEqual(['$.then value_required']);
    expect(codes([[{ value: 1 }]])).toEqual(['$[0] nested_list']);
    expect(codes({ path: '$$.x' })[0]).toMatch(/^\$\.path /);
  });

  test('assertValidValue throws them, one per line', () => {
    expect(() => assertValidValue({ field: 'fanMissions', aggregate: { mode: 'median' } })).toThrow(
      'Invalid value expression:\n$.aggregate.mode: aggregate.mode must be one of sum / avg / count / min / max',
    );
  });

  test('evaluateValue throws on what it cannot compute', () => {
    expect(() => evaluateValue({} as never, {})).toThrow('$: a value expression is exactly one of');
    expect(() =>
      evaluateValue(
        { field: 'fanMissions', aggregate: { mode: 'count' }, operator: 'gt' } as never,
        rows(),
      ),
    ).toThrow('takes no operator or value');
    expect(() => evaluateValue(over('median'), rows())).toThrow('aggregate.mode must be one of');
    expect(() => evaluateValue(over('count'), { fanMissions: 3 })).toThrow(
      'fanMissions must be an array',
    );
    expect(() => evaluateValue(over('sum', 'title'), rows({ title: 'x' }))).toThrow(
      'fanMissions[0].title must be a finite number',
    );
    expect(() => evaluateValue(over('max', 'v'), rows({ v: 1 }, { v: 'a' }))).toThrow(
      'fanMissions max orders one kind of value, not number and string',
    );
    expect(() => evaluateValue(over('min', 'v'), rows({ v: true }))).toThrow(
      'fanMissions[0].v must be a finite number, a string or a valid date',
    );
    expect(() => evaluateValue([[{ value: 1 }]] as never, {})).toThrow(
      "$[0]: a list's items are single values",
    );
  });
});
