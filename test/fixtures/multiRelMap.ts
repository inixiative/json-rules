import type { FieldMap } from '../../index';

/**
 * Post with two distinct named relations to User (author + editor).
 * Tests disambiguation of multiple relations between the same two models.
 */
export const multiRelMap: FieldMap = {
  Post: {
    fields: {
      id:       { kind: 'scalar', type: 'String' },
      authorId: { kind: 'scalar', type: 'String' },
      editorId: { kind: 'scalar', type: 'String' },
      author:   { kind: 'object', type: 'User', isList: false, fromFields: ['authorId'], toFields: ['id'], relationName: 'PostAuthor' },
      editor:   { kind: 'object', type: 'User', isList: false, fromFields: ['editorId'], toFields: ['id'], relationName: 'PostEditor' },
    },
  },
  User: {
    fields: {
      id:            { kind: 'scalar', type: 'String' },
      name:          { kind: 'scalar', type: 'String' },
      authoredPosts: { kind: 'object', type: 'Post', isList: true, fromFields: [], toFields: [], relationName: 'PostAuthor' },
      editedPosts:   { kind: 'object', type: 'Post', isList: true, fromFields: [], toFields: [], relationName: 'PostEditor' },
    },
  },
};
