import type { FieldMap } from '../../index';

/**
 * Order / OrderItem with a composite FK (orderId + productId → id + code).
 * Tests multi-condition ON clauses in JOINs and count-step error handling.
 */
export const compositeFkMap: FieldMap = {
  Order: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      code: { kind: 'scalar', type: 'String' },
      items: { kind: 'object', type: 'OrderItem', isList: true, fromFields: [], toFields: [] },
    },
  },
  OrderItem: {
    fields: {
      orderId: { kind: 'scalar', type: 'String' },
      productId: { kind: 'scalar', type: 'String' },
      qty: { kind: 'scalar', type: 'Int' },
      order: {
        kind: 'object',
        type: 'Order',
        isList: false,
        fromFields: ['orderId', 'productId'],
        toFields: ['id', 'code'],
      },
    },
  },
};
