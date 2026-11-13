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

  test('a scope ref that climbs back to the row is listed, one relation down or two', () => {
    expect(
      listFields({
        field: 'enrichments',
        arrayOperator: 'any',
        condition: {
          all: [
            { field: 'fieldKey', operator: Operator.equals, value: 'createdDate' },
            {
              field: '$$.references',
              arrayOperator: 'any',
              condition: {
                all: [
                  { field: 'status', operator: Operator.equals, value: 'done' },
                  { field: 'completedAt', operator: Operator.lessThanEquals, path: '$$.valueDate' },
                  { field: '$$$.closedAt', operator: Operator.exists },
                ],
              },
            },
          ],
        },
      } as never),
    ).toEqual(['closedAt', 'enrichments', 'references']);
  });

  test('inside a relation a bare value path reads the row; a $. ref reads the related row', () => {
    expect(
      listFields({
        field: 'lineItems',
        arrayOperator: 'all',
        condition: {
          all: [
            { field: 'qty', operator: Operator.lessThanEquals, path: 'maxQty' },
            { field: 'price', operator: Operator.lessThanEquals, path: '$.listPrice' },
          ],
        },
      } as never),
    ).toEqual(['lineItems', 'maxQty']);
  });

  test('a $. ref at the top reads the row itself', () => {
    expect(
      listFields({
        field: '$.status',
        operator: Operator.equals,
        path: '$.previousStatus',
      } as never),
    ).toEqual(['previousStatus', 'status']);
  });

  test('true and false read nothing', () => {
    expect(listFields(true)).toEqual([]);
  });
});
