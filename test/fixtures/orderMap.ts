import type { FieldMap } from '../../index';

/** Order schema for aggregate rule testing. */
export const orderMap: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      orders: { kind: 'object', type: 'Order', isList: true, fromFields: [], toFields: [] },
      scores: { kind: 'scalar', type: 'Int', isList: true }, // native array
      tags: { kind: 'scalar', type: 'Json' }, // JSONB
    },
  },
  Order: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      total: { kind: 'scalar', type: 'Float' },
      userId: { kind: 'scalar', type: 'String' },
      user: {
        kind: 'object',
        type: 'User',
        isList: false,
        fromFields: ['userId'],
        toFields: ['id'],
      },
    },
  },
};
