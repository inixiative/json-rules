import { describe, expect, test } from 'bun:test';
import { listFields, Operator } from '../index';

describe('listFields', () => {
  test('leaf fields and value-side paths across all / any / if, sorted and unique', () => {
    expect(
      listFields({
        all: [
          { field: 'status', operator: Operator.equals, value: 'live' },
          { any: [{ field: 'brand.code', operator: Operator.equals, path: 'owner.code' }] },
          { field: 'status', operator: Operator.notEquals, value: 'draft' },
        ],
      }),
    ).toEqual(['brand.code', 'owner.code', 'status']);
  });

  test('a relation node lists its own field, not the fields of the rows it reads', () => {
    expect(
      listFields({
        field: 'participants',
        arrayOperator: 'any',
        condition: { field: 'role', operator: Operator.equals, value: 'host' },
      } as never),
    ).toEqual(['participants']);
  });

  test('true and false read nothing', () => {
    expect(listFields(true)).toEqual([]);
  });
});
