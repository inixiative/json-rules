import { describe, expect, test } from 'bun:test';
import { validateRule } from '../index';
import { Operator } from '../src/operator';
import { FieldKind, getOperatorsForKind } from '../src/operatorCatalog';

// FIX 1B: isEmpty/notEmpty must be valid on any nullable field kind, not just String.
// The canonical soft-delete grant `deletedAt isEmpty` is authored on a DateTime column,
// and the SQL/Prisma compilers already emit `IS NULL OR = ''` for any nullable column.
describe('isEmpty/notEmpty operator catalog kinds', () => {
  test('DateTime field admits isEmpty/notEmpty', () => {
    const ops = getOperatorsForKind(FieldKind.DateTime).field;
    expect(ops).toContain(Operator.isEmpty);
    expect(ops).toContain(Operator.notEmpty);
  });

  test('non-string nullable kinds (Int, Enum, Boolean) admit isEmpty/notEmpty', () => {
    for (const kind of [FieldKind.Int, FieldKind.Enum, FieldKind.Boolean]) {
      const ops = getOperatorsForKind(kind).field;
      expect(ops).toContain(Operator.isEmpty);
      expect(ops).toContain(Operator.notEmpty);
    }
  });

  test('String field still admits isEmpty/notEmpty (no regression)', () => {
    const ops = getOperatorsForKind(FieldKind.String).field;
    expect(ops).toContain(Operator.isEmpty);
    expect(ops).toContain(Operator.notEmpty);
  });

  test('validateRule accepts deletedAt isEmpty at the shape level', () => {
    expect(validateRule({ field: 'deletedAt', operator: Operator.isEmpty })).toEqual({
      ok: true,
      errors: [],
    });
  });
});
