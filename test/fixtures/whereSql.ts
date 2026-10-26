import type { Condition, FieldMapSet, LensNarrowing } from '../../index';
import { ArrayOperator, check, Operator, projectRows } from '../../index';

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
          affiliations: {
            kind: 'object',
            type: 'FanUserAffiliation',
            isList: true,
            relationName: 'FanUserAffiliations',
            fromFields: [],
            toFields: [],
          },
        },
      },
      // A soft-delete column the real table lacks, so a model default has a row to hide.
      FanUserAffiliation: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          fanUserId: { kind: 'scalar', type: 'Int' },
          affiliation: { kind: 'scalar', type: 'String' },
          endedAt: { kind: 'scalar', type: 'DateTime' },
          deletedAt: { kind: 'scalar', type: 'DateTime' },
          fanUser: {
            kind: 'object',
            type: 'FanUser',
            relationName: 'FanUserAffiliations',
            fromFields: ['fanUserId'],
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

export type Affiliation = {
  id: number;
  fanUserId: number;
  affiliation: string | null;
  endedAt: Date | null;
  deletedAt: Date | null;
};
// Fan user 1: an advocate and a prospect row. 2: prospect only. 3: no rows. 4: an ended advocate
// row. 5: a live advocate row, soft-deleted. 6: a NULL affiliation and a live advocate row. The
// last row points at no fan user.
export const affiliations: Affiliation[] = [
  { id: 1, fanUserId: 1, affiliation: 'advocate', endedAt: null, deletedAt: null },
  { id: 2, fanUserId: 1, affiliation: 'prospect', endedAt: null, deletedAt: null },
  { id: 3, fanUserId: 2, affiliation: 'prospect', endedAt: null, deletedAt: null },
  {
    id: 4,
    fanUserId: 4,
    affiliation: 'advocate',
    endedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  },
  {
    id: 5,
    fanUserId: 5,
    affiliation: 'advocate',
    endedAt: null,
    deletedAt: new Date('2026-02-01T00:00:00Z'),
  },
  { id: 6, fanUserId: 6, affiliation: null, endedAt: null, deletedAt: null },
  { id: 7, fanUserId: 6, affiliation: 'advocate', endedAt: null, deletedAt: null },
  { id: 8, fanUserId: 99, affiliation: 'advocate', endedAt: null, deletedAt: null },
];

/** Each row as check() reads it: the to-one relation nested, null when there is no row, and the
 *  to-many relation as its rows. */
export const asChecked = (u: FanUser) => ({
  ...u,
  form: forms.find((f) => f.id === u.formId) ?? null,
  affiliations: affiliations.filter((a) => a.fanUserId === u.id),
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
  'affiliations.id': 'a.id',
  'affiliations.fanUserId': 'a.fan_user_id',
  'affiliations.affiliation': 'a.affiliation',
  'affiliations.endedAt': 'a.ended_at',
  'affiliations.deletedAt': 'a.deleted_at',
};

export const whereSqlTables = { affiliations: 'fan_user_affiliations AS a' };

export const eq = (field: string, value: unknown): Condition =>
  ({ field, operator: Operator.equals, value }) as Condition;

const overAffiliations = (arrayOperator: ArrayOperator, condition?: Condition): Condition =>
  ({ field: 'affiliations', arrayOperator, condition }) as Condition;

/** The advocate condition the app reads: a live advocate affiliation, or no affiliation rows. */
export const advocateCondition: Condition = {
  any: [
    overAffiliations(ArrayOperator.any, {
      all: [eq('affiliation', 'advocate'), { field: 'endedAt', operator: Operator.notExists }],
    }),
    overAffiliations(ArrayOperator.none, { field: 'affiliation', operator: Operator.exists }),
  ],
};

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
  'to-many: the advocate condition': advocateCondition,
  'to-many: any': overAffiliations(ArrayOperator.any, eq('affiliation', 'prospect')),
  'to-many: none': overAffiliations(ArrayOperator.none, eq('affiliation', 'prospect')),
  'to-many: all, a NULL row fails': overAffiliations(
    ArrayOperator.all,
    eq('affiliation', 'advocate'),
  ),
  'to-many: all of a negation, a NULL row holds': overAffiliations(ArrayOperator.all, {
    field: 'affiliation',
    operator: Operator.notEquals,
    value: 'prospect',
  }),
  'to-many: empty': overAffiliations(ArrayOperator.empty),
  'to-many: notEmpty': overAffiliations(ArrayOperator.notEmpty),
  'to-many: any of an any': overAffiliations(ArrayOperator.any, {
    any: [eq('affiliation', 'prospect'), { field: 'endedAt', operator: Operator.exists }],
  }),
  'to-many: none of an empty any': overAffiliations(ArrayOperator.none, { any: [] }),
  'to-many: beside a column': {
    all: [
      overAffiliations(ArrayOperator.any, eq('affiliation', 'advocate')),
      { field: 'active', operator: Operator.notEquals, value: false },
    ],
  },
};

/** The ids check() keeps for a rule, in id order. */
export const checkedIds = (rule: Condition): number[] =>
  fanUsers.filter((u) => check(rule, asChecked(u)) === true).map((u) => u.id);

/** The ids a lens keeps, `check()` reading each relation's rows through its clamps. */
export const lensKeptIds = (lens: LensNarrowing): number[] =>
  projectRows(lens, fanUsers.map(asChecked)).map((row) => row.id as number);

const notDeleted: Condition = { field: 'deletedAt', operator: Operator.notExists };
const softDelete = { app: { models: { FanUserAffiliation: { where: notDeleted } } } };
const base = { maps: whereSqlMaps, mapName: 'app', model: 'FanUser' };

/** Lenses whose `where`s read the to-many `affiliations`, each through its clamps. `root` is read
 *  from the root's where; `FanUser`, from the FanUser model default. */
export const whereSqlLensCases: Record<string, { lens: LensNarrowing; read: 'root' | 'FanUser' }> =
  {
    'the advocate condition, a soft-deleted row hidden by its model default': {
      lens: {
        parent: base,
        root: { where: advocateCondition, relations: { affiliations: {} } },
        mapDefaults: softDelete,
      },
      read: 'root',
    },
    'all, under the relation path where': {
      lens: {
        parent: base,
        root: {
          where: overAffiliations(ArrayOperator.all, eq('affiliation', 'advocate')),
          relations: {
            affiliations: { where: { field: 'endedAt', operator: Operator.notExists } },
          },
        },
      },
      read: 'root',
    },
    'all, a NULL row hidden by the path where': {
      lens: {
        parent: base,
        root: {
          where: overAffiliations(ArrayOperator.all, eq('affiliation', 'advocate')),
          relations: {
            affiliations: { where: { field: 'affiliation', operator: Operator.exists } },
          },
        },
      },
      read: 'root',
    },
    'empty, under both clamps': {
      lens: {
        parent: base,
        root: {
          where: overAffiliations(ArrayOperator.empty),
          relations: {
            affiliations: { where: { field: 'endedAt', operator: Operator.notExists } },
          },
        },
        mapDefaults: softDelete,
      },
      read: 'root',
    },
    'none, under the model default': {
      lens: {
        parent: base,
        root: {
          where: overAffiliations(ArrayOperator.none, eq('affiliation', 'advocate')),
          relations: { affiliations: {} },
        },
        mapDefaults: softDelete,
      },
      read: 'root',
    },
    'a FanUser model default reading the relation': {
      lens: {
        parent: base,
        root: { relations: { affiliations: {} } },
        mapDefaults: {
          app: {
            models: {
              FanUser: {
                where: overAffiliations(ArrayOperator.any, eq('affiliation', 'advocate')),
              },
              FanUserAffiliation: { where: notDeleted },
            },
          },
        },
      },
      read: 'FanUser',
    },
  };

/** The columns and tables the lens cases read: paths from the root, and the FanUser default's. */
export const whereSqlLensColumns = {
  ...whereSqlColumns,
  'FanUser.id': 'u.id',
  'FanUser.affiliations.fanUserId': 'a.fan_user_id',
  'FanUser.affiliations.affiliation': 'a.affiliation',
  'FanUser.affiliations.deletedAt': 'a.deleted_at',
  'FanUserAffiliation.deletedAt': 'a.deleted_at',
};
export const whereSqlLensTables = {
  ...whereSqlTables,
  'FanUser.affiliations': 'fan_user_affiliations AS a',
};
