// Compile-time tests (`tsc --noEmit` in `bun run check`): ConditionOn / ModelNarrowingOn over a
// literal map that `field-map generate` wrote from the rail tests' own client.
import type { FieldMap } from '@inixiative/field-map';
import type { Condition, ConditionOn, ModelNarrowing, ModelNarrowingOn } from '../../index';
import { createLens, Operator } from '../../index';
import { type PrismaMap, prismaMap } from '../fixtures/railsMap';

type On<Model extends string> = ConditionOn<PrismaMap, Model>;

// Field rules name a value of the model, through to-one relations, and into Json.
const own: On<'User'> = { field: 'name', operator: Operator.equals, value: 'ada' };
const toOne: On<'User'> = { field: 'org.plan', operator: Operator.equals, value: 'pro' };
const json: On<'User'> = { field: 'meta.flags.beta', operator: Operator.equals, value: true };
// @ts-expect-error not a field
const typo: On<'User'> = { field: 'nmae', operator: Operator.equals, value: 'x' };
// @ts-expect-error a path past a to-many relation reads no single row
const pastToMany: On<'User'> = { field: 'posts.title', operator: Operator.equals, value: 'x' };

// An array or aggregate rule names a relation; what it nests reads the related model.
const anyPost: On<'User'> = {
  field: 'posts',
  arrayOperator: 'any',
  condition: { field: 'title', operator: Operator.equals, value: 'x' },
};
// @ts-expect-error `name` is a User field, not a Post one
const badNested: On<'User'> = {
  field: 'posts',
  arrayOperator: 'any',
  condition: { field: 'name', operator: Operator.equals, value: 'x' },
};
const atLeastTwo: On<'Org'> = { field: 'users', arrayOperator: 'atLeast', count: 2 };
const sum: On<'Org'> = {
  field: 'users',
  aggregate: { mode: 'sum', field: 'age' },
  operator: Operator.greaterThan,
  value: 2,
};
// @ts-expect-error `plan` is an Org column, not a User one
const badSum: On<'Org'> = {
  field: 'users',
  aggregate: { mode: 'sum', field: 'plan' },
  operator: Operator.greaterThan,
  value: 2,
};
const tagList: On<'User'> = {
  field: 'tags',
  arrayOperator: 'any',
  condition: { field: '$', operator: Operator.equals, value: 'x' },
};

// all / any / if nest; scope refs and bridges (the actor's among them) pass through unchecked.
const nested: On<'User'> = {
  all: [
    { field: 'age', operator: Operator.greaterThan, value: 18 },
    { any: [{ field: 'actor:User.id', operator: Operator.equals, path: 'id' }, false] },
  ],
};
// @ts-expect-error a `{ path }` source reads the root model's values
const badPath: On<'User'> = { field: 'name', operator: Operator.equals, path: 'nope' };

// Every ConditionOn is a Condition.
export const asConditions: Condition[] = [
  own,
  toOne,
  json,
  anyPost,
  atLeastTwo,
  sum,
  tagList,
  nested,
];

// A narrowing names the model's columns and relations, and narrows each related model.
const narrowing: ModelNarrowingOn<PrismaMap, 'User'> = {
  picks: ['name', 'role'],
  relations: {
    org: { picks: ['plan'], where: { field: 'seats', operator: Operator.greaterThan, value: 1 } },
  },
};
// @ts-expect-error a relation is turned on through `relations`, never `picks`
const pickRelation: ModelNarrowingOn<PrismaMap, 'User'> = { picks: ['org'] };
// @ts-expect-error `plan` is an Org column, not a User one
const wrongModel: ModelNarrowingOn<PrismaMap, 'User'> = { picks: ['plan'] };
export const asNarrowing: ModelNarrowing = narrowing;

// Over a map typed only as FieldMap, ConditionOn is open: any path.
export const open: ConditionOn<FieldMap, 'Anything'> = {
  field: 'any.path.at.all',
  operator: Operator.equals,
  value: 1,
};

export const used = [typo, pastToMany, badNested, badSum, badPath, pickRelation, wrongModel];

// createLens over a literal map anchors only at one of its models.

export const userLens = createLens({ maps: { app: prismaMap }, mapName: 'app', model: 'User' });
// @ts-expect-error not a model of the map
export const typoLens = createLens({ maps: { app: prismaMap }, mapName: 'app', model: 'Usr' });
