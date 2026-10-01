import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens } from '../src/lens/types';
import { ArrayOperator, DateOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const db: FieldMap = {
  models: {
    Event: {
      fields: {
        name: { kind: 'scalar', type: 'String' },
        count: { kind: 'scalar', type: 'Int' },
        big: { kind: 'scalar', type: 'BigInt' },
        ratio: { kind: 'scalar', type: 'Float' },
        amount: { kind: 'scalar', type: 'Decimal' },
        active: { kind: 'scalar', type: 'Boolean' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
        status: { kind: 'enum', type: 'Status' },
        meta: { kind: 'scalar', type: 'Json' },
        blob: { kind: 'scalar', type: 'Bytes' },
        tags: { kind: 'scalar', type: 'String', isList: true },
        nums: { kind: 'scalar', type: 'Int', isList: true },
        legacy: { kind: 'scalar', type: 'Text' },
        crmId: { kind: 'scalar', type: 'String' },
        account: { kind: 'object', type: 'Account', isList: false },
        items: { kind: 'object', type: 'Item', isList: true },
      },
    },
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        seats: { kind: 'scalar', type: 'Int' },
      },
    },
    Item: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        qty: { kind: 'scalar', type: 'Int' },
      },
    },
  },
  enums: { Status: ['OPEN', 'CLOSED'] },
};

const crm: FieldMap = {
  models: {
    Contact: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        industry: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

// Contact is the "one" side: from Event the bridge is to-one, from Contact it is to-many.
const stitched = stitchFieldMaps({
  maps: { db, crm },
  bridges: [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Contact', on: 'id' },
        { fieldMap: 'db', model: 'Event', on: 'crmId' },
      ],
      cardinality: 'oneToMany',
    },
  ],
});

const lens: Lens = { ...stitched, mapName: 'db', model: 'Event' };
const contactLens: Lens = { ...stitched, mapName: 'crm', model: 'Contact' };

const run = (rule: unknown, at: Lens = lens) => checkRuleAgainstLens(rule as Condition, at);
const reasons = (rule: unknown, at: Lens = lens) => run(rule, at).violations.map((v) => v.reason);

describe('checkRuleAgainstLens — operator must apply to the field kind', () => {
  test('contains on a DateTime field', () => {
    expect(run({ field: 'createdAt', operator: Operator.contains, value: 'abc' })).toEqual({
      ok: false,
      violations: [
        {
          path: 'createdAt',
          reason:
            "operator 'contains' does not apply to DateTime field 'createdAt' (applies to: String)",
        },
      ],
    });
  });

  test('ordered comparison on a Boolean field', () => {
    expect(reasons({ field: 'active', operator: Operator.greaterThan, value: true })).toEqual([
      "operator 'greaterThan' does not apply to Boolean field 'active' (applies to: String, Int, Float, Decimal, BigInt, DateTime)",
    ]);
  });

  test('string operator on an enum field', () => {
    expect(run({ field: 'status', operator: Operator.startsWith, value: 'OP' }).ok).toBe(false);
  });

  test('date operator on a String column', () => {
    expect(
      reasons({ field: 'name', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toEqual(["operator 'before' does not apply to String field 'name' (applies to: DateTime)"]);
  });

  test('equality on a Bytes column', () => {
    expect(run({ field: 'blob', operator: Operator.equals, value: 'x' }).ok).toBe(false);
  });

  test('inside an array condition, against the relation target', () => {
    expect(
      run({
        field: 'items',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'qty', operator: Operator.contains, value: '1' },
      }).violations,
    ).toEqual([
      {
        path: 'qty',
        reason: "operator 'contains' does not apply to Int field 'qty' (applies to: String)",
      },
    ]);
  });

  test('through a to-one hop', () => {
    expect(run({ field: 'account.seats', operator: Operator.endsWith, value: '0' }).ok).toBe(false);
  });

  test('a coerceType overrides the declared kind', () => {
    expect(
      run({ field: 'name', operator: Operator.greaterThan, value: 5, coerceType: 'Boolean' }).ok,
    ).toBe(false);
  });
});

describe('checkRuleAgainstLens — a literal must fit the field kind', () => {
  test('number against a String field', () => {
    expect(run({ field: 'name', operator: Operator.equals, value: 123 })).toEqual({
      ok: false,
      violations: [
        {
          path: 'name',
          reason: "value 123 does not fit String field 'name' (expected a string)",
        },
      ],
    });
  });

  test('unparseable string against a DateTime field', () => {
    expect(reasons({ field: 'createdAt', operator: Operator.equals, value: 'not-a-date' })).toEqual(
      ["value 'not-a-date' does not fit DateTime field 'createdAt' (expected a date)"],
    );
  });

  test('string against an Int field', () => {
    expect(reasons({ field: 'count', operator: Operator.equals, value: '5' })).toEqual([
      "value '5' does not fit Int field 'count' (expected an integer)",
    ]);
  });

  test('bigint literal built in code against a String field is reported, not thrown', () => {
    expect(reasons({ field: 'name', operator: Operator.equals, value: 10n })).toEqual([
      "value 10 does not fit String field 'name' (expected a string)",
    ]);
  });

  test('a bigint is not JSON: rejected even on a BigInt field', () => {
    expect(reasons({ field: 'big', operator: Operator.greaterThan, value: 10n })).toEqual([
      "value 10 does not fit BigInt field 'big' (expected an integer or a digit string)",
    ]);
  });

  test('an integer past the safe range against an Int or BigInt field', () => {
    expect(run({ field: 'count', operator: Operator.equals, value: 2 ** 53 }).ok).toBe(false);
    expect(run({ field: 'big', operator: Operator.equals, value: 2 ** 53 }).ok).toBe(false);
  });

  test('a non-digit string against a BigInt field', () => {
    expect(run({ field: 'big', operator: Operator.equals, value: '12a' }).ok).toBe(false);
    expect(run({ field: 'big', operator: Operator.equals, value: '1.5' }).ok).toBe(false);
  });

  test('a non-numeric string against a Decimal field', () => {
    expect(reasons({ field: 'amount', operator: Operator.equals, value: '1.5x' })).toEqual([
      "value '1.5x' does not fit Decimal field 'amount' (expected a number or a numeric string)",
    ]);
  });

  test('an invalid Date against a DateTime field', () => {
    expect(run({ field: 'createdAt', operator: Operator.equals, value: new Date('x') }).ok).toBe(
      false,
    );
  });

  test('fraction against an Int or BigInt field', () => {
    expect(run({ field: 'count', operator: Operator.lessThan, value: 1.5 }).ok).toBe(false);
    expect(run({ field: 'big', operator: Operator.lessThan, value: 1.5 }).ok).toBe(false);
  });

  test('string against a Float field', () => {
    expect(reasons({ field: 'ratio', operator: Operator.greaterThan, value: 'x' })).toEqual([
      "value 'x' does not fit Float field 'ratio' (expected a number)",
    ]);
  });

  test('string "true" against a Boolean field', () => {
    expect(reasons({ field: 'active', operator: Operator.equals, value: 'true' })).toEqual([
      "value 'true' does not fit Boolean field 'active' (expected a boolean)",
    ]);
  });

  test('number against an enum field', () => {
    expect(reasons({ field: 'status', operator: Operator.equals, value: 1 })).toEqual([
      "value 1 does not fit Enum field 'status' (expected a string)",
    ]);
  });

  test('each element of in / notIn / between is checked', () => {
    expect(reasons({ field: 'count', operator: Operator.in, value: [1, 'two', 3] })).toEqual([
      "value 'two' does not fit Int field 'count' (expected an integer)",
    ]);
    expect(run({ field: 'count', operator: Operator.notIn, value: [true] }).ok).toBe(false);
    expect(
      reasons({ field: 'createdAt', operator: Operator.between, value: ['2026-01-01', 'soon'] }),
    ).toEqual(["value 'soon' does not fit DateTime field 'createdAt' (expected a date)"]);
  });

  test('across a bridge, against the other map', () => {
    expect(
      run({ field: 'crm:Contact.industry', operator: Operator.equals, value: 5 }).violations,
    ).toEqual([
      {
        path: 'crm:Contact.industry',
        reason: "value 5 does not fit String field 'crm:Contact.industry' (expected a string)",
      },
    ]);
  });

  test('a coerceType the literal does not coerce to', () => {
    expect(
      reasons({ field: 'name', operator: Operator.greaterThan, value: 'abc', coerceType: 'Int' }),
    ).toEqual(["value 'abc' does not fit field 'name' coerced to Int (expected an integer)"]);
  });

  test('a stamp coerces the literal the way check() and the compilers do', () => {
    // stampCoercions() stamps every leaf; with the stamp, check(), toPrisma and toSql all coerce
    // '5' to 5, so it fits. Without one, the compilers pass '5' raw and Prisma rejects it.
    expect(
      run({ field: 'count', operator: Operator.equals, value: '5', coerceType: 'Int' }).ok,
    ).toBe(true);
    expect(run({ field: 'count', operator: Operator.equals, value: '5' }).ok).toBe(false);
    expect(
      reasons({ field: 'count', operator: Operator.in, value: ['1', 'x'], coerceType: 'Int' }),
    ).toEqual(["value 'x' does not fit Int field 'count' (expected an integer)"]);
  });

  test('a list literal on a single-value operator', () => {
    expect(reasons({ field: 'name', operator: Operator.equals, value: ['a'] })).toEqual([
      "operator 'equals' compares one value, but String field 'name' was given a list",
    ]);
  });

  test('an epoch past the representable range against a DateTime field', () => {
    expect(run({ field: 'createdAt', operator: Operator.equals, value: 1e20 }).ok).toBe(false);
    expect(
      run({ field: 'createdAt', operator: Operator.equals, value: '99999999999999999' }).ok,
    ).toBe(false);
  });
});

describe('checkRuleAgainstLens — an arrayOperator needs a list', () => {
  test('any on a to-one relation', () => {
    expect(
      run({
        field: 'account',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'id', operator: Operator.equals, value: 'a' },
      }),
    ).toEqual({
      ok: false,
      violations: [
        {
          path: 'account',
          reason: "arrayOperator 'any' needs a list, but 'account' is a to-one relation",
        },
      ],
    });
  });

  test('does not descend into the condition of a rejected node', () => {
    expect(
      run({
        field: 'account',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'ghost', operator: Operator.equals, value: 'a' },
      }).violations,
    ).toHaveLength(1);
  });

  test('notEmpty on a to-one bridge', () => {
    expect(reasons({ field: 'crm:Contact', arrayOperator: ArrayOperator.notEmpty })).toEqual([
      "arrayOperator 'notEmpty' needs a list, but 'crm:Contact' is a to-one relation",
    ]);
  });

  test('atLeast on a non-list scalar', () => {
    expect(
      reasons({
        field: 'name',
        arrayOperator: ArrayOperator.atLeast,
        count: 1,
        condition: { field: 'x', operator: Operator.equals, value: 1 },
      }),
    ).toEqual(["arrayOperator 'atLeast' needs a list, but 'name' is a single String value"]);
  });

  test('empty on a non-list enum', () => {
    expect(run({ field: 'status', arrayOperator: ArrayOperator.empty }).ok).toBe(false);
  });

  test('an object relation with no isList declared reads as to-one', () => {
    const bare: Lens = {
      maps: {
        db: {
          models: {
            A: { fields: { b: { kind: 'object', type: 'B' } } },
            B: { fields: { id: { kind: 'scalar', type: 'String' } } },
          },
        },
      },
      mapName: 'db',
      model: 'A',
    };
    expect(run({ field: 'b', arrayOperator: ArrayOperator.notEmpty }, bare).ok).toBe(false);
  });
});

describe('checkRuleAgainstLens — rules that must stay valid', () => {
  const valid: Record<string, [unknown, Lens?]> = {
    'day-only date on a DateTime field operator': [
      { field: 'createdAt', operator: Operator.greaterThan, value: '2026-09-01' },
    ],
    'ISO date with and without a zone': [
      {
        field: 'createdAt',
        operator: Operator.in,
        value: ['2026-09-01T10:00:00Z', '2026-09-01T10:00:00', '2026-09-01 10:00'],
      },
    ],
    'epoch-ms number on a DateTime field': [
      { field: 'createdAt', operator: Operator.lessThan, value: 1_790_000_000_000 },
    ],
    'Date instance and epoch-ms string on a DateTime field': [
      {
        field: 'createdAt',
        operator: Operator.between,
        value: [new Date('2026-09-01T00:00:00Z'), '1790000000000'],
      },
    ],
    'relative date: ago': [
      { field: 'createdAt', dateOperator: DateOperator.after, value: { ago: { hours: 1 } } },
    ],
    'relative date: this month': [
      { field: 'createdAt', dateOperator: DateOperator.within, value: { this: 'month' } },
    ],
    'relative date: last week': [
      { field: 'createdAt', dateOperator: DateOperator.within, value: { last: 'week' } },
    ],
    'absolute date operator on a DateTime field': [
      { field: 'createdAt', dateOperator: DateOperator.onOrBefore, value: '2026-09-01' },
    ],
    'dayIn on a DateTime field': [
      { field: 'createdAt', dateOperator: DateOperator.dayIn, value: ['monday'] },
    ],
    'String column coerced to Int, numeric literal': [
      { field: 'name', operator: Operator.greaterThan, value: 5, coerceType: 'Int' },
    ],
    'String column coerced to Int, numeric string check() coerces': [
      { field: 'name', operator: Operator.greaterThan, value: '5', coerceType: 'Int' },
    ],
    'String column coerced to DateTime, ISO literal': [
      {
        field: 'name',
        operator: Operator.lessThan,
        value: '2026-09-01T00:00:00Z',
        coerceType: 'DateTime',
      },
    ],
    'String column coerced to Boolean, "true"': [
      { field: 'name', operator: Operator.equals, value: 'true', coerceType: 'Boolean' },
    ],
    'stamped coerceType equal to the declared kind': [
      { field: 'count', operator: Operator.equals, value: 3, coerceType: 'Int' },
    ],
    'bare path ref': [{ field: 'name', operator: Operator.equals, path: 'crmId' }],
    '$. path ref inside an array condition': [
      {
        field: 'items',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'qty', operator: Operator.greaterThan, path: '$.id' },
      },
    ],
    '$$. path ref inside an array condition': [
      {
        field: 'items',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'qty', operator: Operator.greaterThan, path: '$$.count' },
      },
    ],
    'bind token': [{ field: 'count', operator: Operator.equals, bind: 'limit' }],
    'optional bind token': [
      { field: 'createdAt', operator: Operator.equals, bind: 'at', bindOptional: true },
    ],
    'Int, Float, Decimal, BigInt numbers': [
      {
        all: [
          { field: 'count', operator: Operator.between, value: [1, 10] },
          { field: 'ratio', operator: Operator.lessThan, value: 0.5 },
          { field: 'amount', operator: Operator.greaterThanEquals, value: 19.99 },
          { field: 'big', operator: Operator.equals, value: 9_007_199_254_740_991 },
        ],
      },
    ],
    'Boolean literal': [{ field: 'active', operator: Operator.notEquals, value: false }],
    'numeric strings on a Decimal field — the lossless JSON spelling a builder keeps': [
      {
        field: 'amount',
        operator: Operator.greaterThan,
        value: '100.10',
        coerceType: 'Decimal',
      },
    ],
    'stamped Int literals from a text input': [
      { field: 'count', operator: Operator.in, value: ['1', '2'], coerceType: 'Int' },
    ],
    'contains on a stamped Int scalar list — list operators are not field-kind gated': [
      { field: 'nums', operator: Operator.contains, value: 3, coerceType: 'Int' },
    ],
    'digit strings on a BigInt field — the lossless JSON spelling': [
      { field: 'big', operator: Operator.in, value: ['9007199254740993', '-1', '42'] },
    ],
    'String operators on a String field': [
      {
        any: [
          { field: 'name', operator: Operator.contains, value: 'a' },
          { field: 'name', operator: Operator.notContains, value: 'a' },
          { field: 'name', operator: Operator.startsWith, value: 'a' },
          { field: 'name', operator: Operator.endsWith, value: 'a' },
          { field: 'name', operator: Operator.matches, value: '^a' },
          { field: 'name', operator: Operator.lessThan, value: 'm' },
        ],
      },
    ],
    'RegExp pattern for matches': [{ field: 'name', operator: Operator.matches, value: /^a/ }],
    'enum literal in the allowed set': [
      { field: 'status', operator: Operator.in, value: ['OPEN', 'CLOSED'] },
    ],
    'no-operand operators on every kind': [
      {
        all: [
          'name',
          'count',
          'big',
          'ratio',
          'amount',
          'active',
          'createdAt',
          'status',
          'meta',
          'blob',
          'tags',
          'legacy',
        ].flatMap((field) => [
          { field, operator: Operator.exists },
          { field, operator: Operator.notExists },
          { field, operator: Operator.isEmpty },
          { field, operator: Operator.notEmpty },
        ]),
      },
    ],
    'null literal on every kind': [
      {
        all: ['name', 'count', 'active', 'createdAt', 'status'].flatMap((field) => [
          { field, operator: Operator.equals, value: null },
          { field, operator: Operator.notEquals, value: null },
          { field, operator: Operator.in, value: [null] },
        ]),
      },
    ],
    'null element beside real ones': [
      { field: 'count', operator: Operator.notIn, value: [1, null] },
    ],
    'Json column, any operator and value': [
      {
        all: [
          { field: 'meta', operator: Operator.equals, value: { a: 1 } },
          { field: 'meta', operator: Operator.contains, value: 'x' },
          { field: 'meta', operator: Operator.greaterThan, value: 3 },
        ],
      },
    ],
    'Json sub-path, any operator and value': [
      {
        all: [
          { field: 'meta.score', operator: Operator.greaterThan, value: 'x' },
          { field: 'meta.flags.beta', operator: Operator.equals, value: true },
          { field: 'meta.when', dateOperator: DateOperator.before, value: '2026-01-01' },
        ],
      },
    ],
    'Json sub-path with a coerceType the literal fits': [
      { field: 'meta.score', operator: Operator.greaterThan, value: '7', coerceType: 'Int' },
    ],
    'scalar list, field operators as today': [
      { field: 'tags', operator: Operator.contains, value: 7 },
    ],
    'type the map declares outside FieldKind': [
      { field: 'legacy', operator: Operator.contains, value: 12 },
    ],
    'string literal across a bridge': [
      { field: 'crm:Contact.industry', operator: Operator.equals, value: 'retail' },
    ],
    'array operators on a to-many relation': [
      {
        all: [
          {
            field: 'items',
            arrayOperator: ArrayOperator.all,
            condition: { field: 'qty', operator: Operator.greaterThan, value: 0 },
          },
          { field: 'items', arrayOperator: ArrayOperator.empty },
          {
            field: 'items',
            arrayOperator: ArrayOperator.atLeast,
            count: 2,
            condition: { field: 'qty', operator: Operator.equals, value: 1 },
          },
        ],
      },
    ],
    'array operator on a to-many bridge': [
      { field: 'db:Event', arrayOperator: ArrayOperator.notEmpty },
      contactLens,
    ],
    'array operator on a scalar list': [{ field: 'tags', arrayOperator: ArrayOperator.notEmpty }],
    'array operator on a Json column': [
      {
        field: 'meta',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'x', operator: Operator.equals, value: 1 },
      },
    ],
    'array operator on a Json sub-path': [
      { field: 'meta.list', arrayOperator: ArrayOperator.notEmpty },
    ],
    'aggregate over a to-many relation': [
      {
        field: 'items',
        aggregate: { mode: 'sum', field: 'qty' },
        operator: Operator.greaterThan,
        value: 10,
      },
    ],
    'to-one hop with a fitting literal': [
      { field: 'account.seats', operator: Operator.greaterThan, value: 3 },
    ],
    'field operator on a relation': [{ field: 'account', operator: Operator.exists }],
  };

  for (const [label, [rule, at]] of Object.entries(valid)) {
    test(label, () => {
      expect(run(rule, at)).toEqual({ ok: true, violations: [] });
    });
  }
});
