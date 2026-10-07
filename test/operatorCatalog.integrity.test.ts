import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator } from '../src/operator';
import {
  ARRAY_OPERATOR_CATALOG,
  type CatalogEntry,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  getArrayOperators,
  getValueShape,
  isOperatorSupportedForTarget,
  type OperatorFamily,
  RuleTarget,
  ValueShape,
} from '../src/operatorCatalog';

const VALUE_SHAPES = new Set<string>(Object.values(ValueShape));
const TARGETS = new Set<string>(Object.values(RuleTarget));

type CommonEntry = Pick<CatalogEntry, 'valueShape' | 'targets'>;

const cases = [
  { name: 'Operator', family: 'field', enumObj: Operator, catalog: FIELD_OPERATOR_CATALOG },
  { name: 'DateOperator', family: 'date', enumObj: DateOperator, catalog: DATE_OPERATOR_CATALOG },
  {
    name: 'ArrayOperator',
    family: 'array',
    enumObj: ArrayOperator,
    catalog: ARRAY_OPERATOR_CATALOG,
  },
].map(({ name, family, enumObj, catalog }) => ({
  name,
  family: family as OperatorFamily,
  operators: Object.values(enumObj) as string[],
  catalog: catalog as Record<string, CommonEntry>,
}));

describe('operator catalog integrity', () => {
  for (const { name, family, operators, catalog } of cases) {
    describe(name, () => {
      const catalogKeys = Object.keys(catalog);

      test('every operator has a catalog entry', () => {
        const missing = operators.filter((op) => !Object.hasOwn(catalog, op));
        expect(missing).toEqual([]);
      });

      test('catalog has no entries beyond the operator enum', () => {
        const extra = catalogKeys.filter((key) => !operators.includes(key));
        expect(extra).toEqual([]);
      });

      test('every entry has a known valueShape and known targets', () => {
        for (const op of operators) {
          const entry = catalog[op as keyof typeof catalog];
          expect(VALUE_SHAPES.has(entry.valueShape)).toBe(true);
          expect(entry.targets.length).toBeGreaterThan(0);
          for (const target of entry.targets) expect(TARGETS.has(target)).toBe(true);
        }
      });

      test('getValueShape reads the family the operator belongs to', () => {
        for (const op of operators)
          expect(getValueShape(op, family)).toBe(catalog[op as keyof typeof catalog].valueShape);
      });

      test('isOperatorSupportedForTarget agrees with the entry targets', () => {
        for (const op of operators) {
          const entry = catalog[op as keyof typeof catalog];
          for (const target of Object.values(RuleTarget)) {
            expect(isOperatorSupportedForTarget(op, family, target)).toBe(
              entry.targets.includes(target),
            );
          }
        }
      });
    });
  }

  test('every date operator declares an explicit acceptsExpr decision', () => {
    for (const op of Object.values(DateOperator)) {
      expect(typeof DATE_OPERATOR_CATALOG[op].acceptsExpr).toBe('boolean');
    }
  });
});

describe('getArrayOperators', () => {
  test('every array operator, or those a target compiles', () => {
    expect(getArrayOperators()).toEqual(Object.values(ArrayOperator));
    expect(getArrayOperators('toSql')).toEqual([ArrayOperator.empty, ArrayOperator.notEmpty]);
    expect(getArrayOperators('check')).toEqual(Object.values(ArrayOperator));
  });
});
