import type { FieldMap } from '../../index';

/** Order schema for aggregate rule testing. */
export const orderMap: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      orders: { kind: 'object', type: 'Order', isList: true, fromFields: [], toFields: [] },
      scores: { kind: 'scalar', type: 'Int', isList: true }, // native array
      tags: { kind: 'scalar', type: 'Json' }, // JSONB
      department: {
        kind: 'object',
        type: 'Department',
        isList: false,
        fromFields: ['departmentId'],
        toFields: ['id'],
      },
      departmentId: { kind: 'scalar', type: 'String' },
    },
  },
  Department: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      users: { kind: 'object', type: 'User', isList: true, fromFields: [], toFields: [] },
      projects: {
        kind: 'object',
        type: 'Project',
        isList: true,
        fromFields: [],
        toFields: [],
      },
    },
  },
  Project: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      budget: { kind: 'scalar', type: 'Float' },
      status: { kind: 'scalar', type: 'String' },
      departmentId: { kind: 'scalar', type: 'String' },
      department: {
        kind: 'object',
        type: 'Department',
        isList: false,
        fromFields: ['departmentId'],
        toFields: ['id'],
      },
    },
  },
  Order: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      total: { kind: 'scalar', type: 'Float' },
      status: { kind: 'scalar', type: 'String' },
      createdAt: { kind: 'scalar', type: 'DateTime' },
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
