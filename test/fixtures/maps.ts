import type { FieldMap } from '../../index';

/**
 * Core blog schema: User / Post / Profile.
 * Used by toPrisma and toSql map-aware tests.
 */
export const blogMap: FieldMap = {
  User: {
    fields: {
      id:        { kind: 'scalar', type: 'String' },
      email:     { kind: 'scalar', type: 'String' },
      name:      { kind: 'scalar', type: 'String' },
      role:      { kind: 'enum',   type: 'UserRole' },
      metadata:  { kind: 'scalar', type: 'Json' },
      createdAt: { kind: 'scalar', type: 'DateTime' },
      posts:     { kind: 'object', type: 'Post',    isList: true,  fromFields: [],           toFields: [] },
      profile:   { kind: 'object', type: 'Profile', isList: false, fromFields: [],           toFields: [] },
    },
  },
  Post: {
    fields: {
      id:        { kind: 'scalar', type: 'String' },
      title:     { kind: 'scalar', type: 'String' },
      published: { kind: 'scalar', type: 'Boolean' },
      authorId:  { kind: 'scalar', type: 'String' },
      author:    { kind: 'object', type: 'User',   isList: false, fromFields: ['authorId'], toFields: ['id'] },
      settings:  { kind: 'scalar', type: 'Json' },
    },
  },
  Profile: {
    fields: {
      id:     { kind: 'scalar', type: 'String' },
      userId: { kind: 'scalar', type: 'String' },
      bio:    { kind: 'scalar', type: 'String' },
      user:   { kind: 'object', type: 'User', isList: false, fromFields: ['userId'], toFields: ['id'] },
    },
  },
};

/**
 * Post with two distinct relations to User (author + editor), each named.
 * Used to test disambiguation of multiple relations between the same two models.
 */
export const multiRelMap: FieldMap = {
  Post: {
    fields: {
      id:           { kind: 'scalar', type: 'String' },
      authorId:     { kind: 'scalar', type: 'String' },
      editorId:     { kind: 'scalar', type: 'String' },
      author:       { kind: 'object', type: 'User', isList: false, fromFields: ['authorId'], toFields: ['id'], relationName: 'PostAuthor' },
      editor:       { kind: 'object', type: 'User', isList: false, fromFields: ['editorId'], toFields: ['id'], relationName: 'PostEditor' },
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

/**
 * Order / OrderItem with a composite FK (orderId + productId → id + code).
 * Used to test multi-condition ON clauses in JOINs and count-step error handling.
 */
export const compositeFkMap: FieldMap = {
  Order: {
    fields: {
      id:    { kind: 'scalar', type: 'String' },
      code:  { kind: 'scalar', type: 'String' },
      items: { kind: 'object', type: 'OrderItem', isList: true, fromFields: [], toFields: [] },
    },
  },
  OrderItem: {
    fields: {
      orderId:   { kind: 'scalar', type: 'String' },
      productId: { kind: 'scalar', type: 'String' },
      qty:       { kind: 'scalar', type: 'Int' },
      order:     { kind: 'object', type: 'Order', isList: false, fromFields: ['orderId', 'productId'], toFields: ['id', 'code'] },
    },
  },
};
