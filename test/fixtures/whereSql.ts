import type { Condition, FieldMapSet } from '../../index';
import { check, Operator } from '../../index';

// The rows and rules both toWhereSql differential suites run: check() and the predicate a real
// database executes must return the same ids — NULL rows, a missing relation row and a dangling
// FK included. Each suite owns its DDL and its dialect; the matrix is shared.

export const whereSqlMaps: FieldMapSet['maps'] = {
  app: {
    models: {
      FanUser: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          affiliation: { kind: 'scalar', type: 'String' },
          score: { kind: 'scalar', type: 'Int' },
          active: { kind: 'scalar', type: 'Boolean' },
          verifiedAt: { kind: 'scalar', type: 'DateTime' },
          formId: { kind: 'scalar', type: 'Int' },
          form: {
            kind: 'object',
            type: 'Form',
            relationName: 'FanUserForm',
            fromFields: ['formId'],
            toFields: ['id'],
          },
        },
      },
      Form: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          status: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

export const tricky = "O'Brien \\ x\\' %_";

export type Form = { id: number; status: string | null };
export const forms: Form[] = [
  { id: 1, status: 'open' },
  { id: 2, status: null },
  { id: 3, status: tricky },
];

export type FanUser = {
  id: number;
  affiliation: string | null;
  score: number | null;
  active: boolean | null;
  verifiedAt: Date | null;
  formId: number | null;
};
export const fanUsers: FanUser[] = [
  {
    id: 1,
    affiliation: 'advocate',
    score: 10,
    active: true,
    verifiedAt: new Date('2026-01-02T03:04:05Z'),
    formId: 1,
  },
  { id: 2, affiliation: 'prospect', score: 5, active: false, verifiedAt: null, formId: 2 },
  { id: 3, affiliation: null, score: null, active: null, verifiedAt: null, formId: null },
  {
    id: 4,
    affiliation: tricky,
    score: 0,
    active: true,
    verifiedAt: new Date('2026-02-03T04:05:06Z'),
    formId: 3,
  },
  { id: 5, affiliation: 'Advocate', score: 7, active: null, verifiedAt: null, formId: 99 },
  {
    id: 6,
    affiliation: 'advocate ',
    score: -1,
    active: false,
    verifiedAt: new Date('2026-03-04T05:06:07Z'),
    formId: 1,
  },
];

/** Each row as check() reads it: the to-one relation nested, null when there is no row. */
export const asChecked = (u: FanUser) => ({
  ...u,
  form: forms.find((f) => f.id === u.formId) ?? null,
});

export const whereSqlColumns = {
  id: 'u.id',
  affiliation: 'u.affiliation',
  score: 'u.score',
  active: 'u.active',
  verifiedAt: 'u.verified_at',
  formId: 'u.form_id',
  'form.id': 'f.id',
  'form.status': 'f.status',
};

export const eq = (field: string, value: unknown): Condition =>
  ({ field, operator: Operator.equals, value }) as Condition;

export const whereSqlRules: Record<string, Condition> = {
  'equals advocate': eq('affiliation', 'advocate'),
  'equals null': eq('affiliation', null),
  'equals number': eq('score', 5),
  'equals true': eq('active', true),
  'equals false': eq('active', false),
  'equals quote and backslash': eq('affiliation', tricky),
  'notEquals advocate': { field: 'affiliation', operator: Operator.notEquals, value: 'advocate' },
  'notEquals null': { field: 'affiliation', operator: Operator.notEquals, value: null },
  'notEquals number': { field: 'score', operator: Operator.notEquals, value: 5 },
  'notEquals true': { field: 'active', operator: Operator.notEquals, value: true },
  'notEquals quote and backslash': {
    field: 'affiliation',
    operator: Operator.notEquals,
    value: tricky,
  },
  'in strings': { field: 'affiliation', operator: Operator.in, value: ['advocate', 'prospect'] },
  'in with null': { field: 'affiliation', operator: Operator.in, value: ['prospect', null] },
  'in only null': { field: 'affiliation', operator: Operator.in, value: [null] },
  'in empty': { field: 'affiliation', operator: Operator.in, value: [] },
  'in numbers': { field: 'score', operator: Operator.in, value: [0, 10, -1] },
  'in quote and backslash': { field: 'affiliation', operator: Operator.in, value: [tricky] },
  'notIn strings': {
    field: 'affiliation',
    operator: Operator.notIn,
    value: ['advocate', 'prospect'],
  },
  'notIn with null': { field: 'affiliation', operator: Operator.notIn, value: ['prospect', null] },
  'notIn only null': { field: 'affiliation', operator: Operator.notIn, value: [null] },
  'notIn empty': { field: 'affiliation', operator: Operator.notIn, value: [] },
  'notIn numbers': { field: 'score', operator: Operator.notIn, value: [0, 10] },
  'in null operand': { field: 'affiliation', operator: Operator.in, value: null },
  'notIn null operand': { field: 'affiliation', operator: Operator.notIn, value: null },
  exists: { field: 'affiliation', operator: Operator.exists },
  notExists: { field: 'active', operator: Operator.notExists },
  'date exists': { field: 'verifiedAt', operator: Operator.exists },
  'date notExists': { field: 'verifiedAt', operator: Operator.notExists },
  'date equals null': eq('verifiedAt', null),
  'date notEquals null': { field: 'verifiedAt', operator: Operator.notEquals, value: null },
  'relation exists': { field: 'form', operator: Operator.exists },
  'relation notExists': { field: 'form', operator: Operator.notExists },
  'through a relation': { field: 'form.status', operator: Operator.equals, value: 'open' },
  'negated through a relation': {
    field: 'form.status',
    operator: Operator.notIn,
    value: ['open'],
  },
  all: {
    all: [
      { field: 'form', operator: Operator.exists },
      { field: 'affiliation', operator: Operator.notEquals, value: 'prospect' },
    ],
  },
  any: {
    any: [
      eq('active', true),
      { field: 'score', operator: Operator.in, value: [5] },
      { all: [{ field: 'form', operator: Operator.notExists }, true] },
    ],
  },
  'all empty': { all: [] },
  'any empty': { any: [] },
  false: false,
};

/** The ids check() keeps for a rule, in id order. */
export const checkedIds = (rule: Condition): number[] =>
  fanUsers.filter((u) => check(rule, asChecked(u)) === true).map((u) => u.id);
