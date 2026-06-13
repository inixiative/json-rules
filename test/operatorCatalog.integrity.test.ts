import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator } from '../src/operator';
import {
  ARRAY_OPERATOR_CATALOG,
  type CatalogEntry,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  getValueShape,
  isOperatorSupportedForTarget,
  RuleTarget,
  ValueShape,
  WINDOW_SELECTOR,
  WindowSupport,
} from '../src/operatorCatalog';

const VALUE_SHAPES = new Set<string>(Object.values(ValueShape));
const TARGETS = new Set<string>(Object.values(RuleTarget));

type CommonEntry = Pick<CatalogEntry, 'valueShape' | 'targets'>;

const cases = [
  { name: 'Operator', enumObj: Operator, catalog: FIELD_OPERATOR_CATALOG },
  { name: 'DateOperator', enumObj: DateOperator, catalog: DATE_OPERATOR_CATALOG },
  { name: 'ArrayOperator', enumObj: ArrayOperator, catalog: ARRAY_OPERATOR_CATALOG },
].map(({ name, enumObj, catalog }) => ({
  name,
  operators: Object.values(enumObj) as string[],
  catalog: catalog as Record<string, CommonEntry>,
}));

describe('operator catalog integrity', () => {
  for (const { name, operators, catalog } of cases) {
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

      test('getValueShape resolves for every operator', () => {
        for (const op of operators) {
          expect(() => getValueShape(op as never)).not.toThrow();
        }
      });

      test('isOperatorSupportedForTarget agrees with the entry targets', () => {
        for (const op of operators) {
          const entry = catalog[op as keyof typeof catalog];
          for (const target of Object.values(RuleTarget)) {
            expect(isOperatorSupportedForTarget(op as never, target)).toBe(
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

  test('window selector covers every rule type and target', () => {
    for (const ruleType of Object.keys(
      WINDOW_SELECTOR.support,
    ) as (keyof typeof WINDOW_SELECTOR.support)[]) {
      for (const target of Object.values(RuleTarget)) {
        const support = WINDOW_SELECTOR.support[ruleType][target];
        expect(Object.values(WindowSupport)).toContain(support);
      }
    }
  });
});
