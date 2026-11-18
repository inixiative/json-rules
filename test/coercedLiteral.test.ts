import { describe, expect, test } from 'bun:test';
import {
  type Categorization,
  categorize,
  coerceValue,
  createLens,
  describeCategorization,
  evaluateValue,
  type FieldMapSet,
  inferValueType,
  Operator,
  type ValueExpression,
  validateValue,
} from '../index';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      Account: {
        fields: {
          seats: { kind: 'scalar', type: 'Int', isRequired: true },
          renewedAt: { kind: 'scalar', type: 'DateTime', isRequired: true },
        },
      },
    },
  },
};
const lens = createLens({ maps, mapName: 'app', model: 'Account' });
const big = { field: 'seats', operator: Operator.greaterThan, value: 100 };
const renewal: ValueExpression = { value: '2027-01-01', coerceType: 'DateTime' };

describe('a literal with coerceType (FEAT-008)', () => {
  test('a date literal evaluates to a Date and types DateTime', () => {
    expect(evaluateValue(renewal, {})).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(inferValueType(renewal)).toEqual({ kind: 'DateTime', isList: false, nullable: false });
  });

  test('a numeric literal reads as a number; one the kind cannot read stays as it is', () => {
    expect(evaluateValue({ value: '12', coerceType: 'Int' }, {})).toBe(12);
    expect(evaluateValue({ value: 'x', coerceType: 'Int' }, {})).toBe('x');
    expect(inferValueType({ value: 'x', coerceType: 'Int' }).kind).toBe('Int');
  });

  test('a date literal reads in the evaluation zone, as check() reads one', () => {
    expect(
      evaluateValue(
        { value: '2027-01-01', coerceType: 'DateTime' },
        {},
        {
          timeZone: 'America/New_York',
        },
      ),
    ).toEqual(new Date('2027-01-01T05:00:00.000Z'));
  });

  test('a list literal reads item by item', () => {
    expect(evaluateValue({ value: ['1', '2'], coerceType: 'Int' }, {})).toEqual([1, 2]);
    expect(inferValueType({ value: ['1', '2'], coerceType: 'Int' })).toEqual({
      kind: 'Int',
      isList: true,
      nullable: false,
    });
  });

  test('a kind that cannot read what is written is refused', () => {
    expect(() => inferValueType({ value: true, coerceType: 'DateTime' })).toThrow(
      "Boolean values can't be read as DateTime",
    );
  });

  test('coerceType reads a literal only, and must be a kind', () => {
    expect(validateValue({ path: 'renewedAt', coerceType: 'DateTime' } as never).errors).toEqual([
      expect.objectContaining({ path: '$.coerceType', code: 'unexpected_coerce_type' }),
    ]);
    expect(validateValue({ value: 'x', coerceType: 'Nope' } as never).errors).toEqual([
      expect.objectContaining({ path: '$.coerceType', code: 'invalid_coerce_type' }),
    ]);
    expect(validateValue(renewal).errors).toEqual([]);
  });

  test('categorize honours it through evaluateValue; describeCategorization types it', () => {
    const renewsBy: Categorization = {
      cases: [{ if: big, then: renewal }],
      default: { path: 'renewedAt' },
    };
    expect(categorize(renewsBy, { seats: 500, renewedAt: '2026-03-01' })).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(describeCategorization(renewsBy, lens)).toMatchObject({
      type: { kind: 'DateTime', isList: false, nullable: false },
      errors: [],
    });
  });

  test('an unstamped date literal is a String: nothing guesses its kind', () => {
    const unstamped: Categorization = {
      cases: [{ if: big, then: '2027-01-01' }],
      default: { path: 'renewedAt' },
    };
    expect(describeCategorization(unstamped, lens).errors).toEqual([
      expect.objectContaining({ code: 'value_type_mismatch' }),
    ]);
    expect(coerceValue({ if: big, then: '2027-01-01', else: { path: 'renewedAt' } }, lens)).toEqual(
      { if: big, then: '2027-01-01', else: { path: 'renewedAt' } },
    );
  });
});
