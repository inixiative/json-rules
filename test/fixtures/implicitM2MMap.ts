import type { FieldMap } from '../../index';

/**
 * Post ↔ Category with no explicit @relation (implicit many-to-many).
 * Both sides have empty fromFields/toFields — no FK discoverable.
 */
export const implicitM2MMap: FieldMap = {
  Post: {
    fields: {
      id:         { kind: 'scalar', type: 'String' },
      categories: { kind: 'object', type: 'Category', isList: true, fromFields: [], toFields: [] },
    },
  },
  Category: {
    fields: {
      id:    { kind: 'scalar', type: 'String' },
      posts: { kind: 'object', type: 'Post', isList: true, fromFields: [], toFields: [] },
    },
  },
};
