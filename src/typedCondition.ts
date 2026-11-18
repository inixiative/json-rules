import type {
  FieldMap,
  RelationFieldNameOf,
  RelationPath,
  RelationPathTarget,
  RelationTargetOf,
  ScalarFieldNameOf,
  ScalarPath,
} from '@inixiative/field-map';
import type { LensNarrowing, ModelNarrowing } from './lens/types';
import type {
  AggregateRule,
  ArrayRule,
  DateRule,
  DateRuleValue,
  Rule,
  RuleValue,
  SortDir,
} from './types';

// Compile-time checked spellings of the rule grammar over a literal field map (`typeof
// prismaMap`, as `field-map generate` writes it). Each is assignable to its untyped twin
// (`Condition`, `ModelNarrowing`), and over a map typed only as `FieldMap` it is that twin.

/**
 * The path spellings `ConditionOn` passes through as `string`, unchecked: a scope ref into an
 * enclosing row (`$.x`, `$$.x`), a bridge into another map (`map:Model.field`), the actor
 * (`__actor.x`), and a bracket spelling (`a[0].b`). The lens gate (`validateRuleInLens`) still
 * reads them at run time.
 */
export type UncheckedPath =
  | `$.${string}`
  | `$$.${string}`
  | `${string}:${string}`
  | `__actor.${string}`
  | `${string}[${string}`;

type FieldOn<M extends FieldMap, Model extends string> = ScalarPath<M, Model> | UncheckedPath;

type Window<M extends FieldMap, Target extends string, Root extends string, TR, TD> = {
  filter?: ConditionOn<M, Target, Root, TR, TD>;
  orderBy?: { field: FieldOn<M, Target>; dir: SortDir }[];
};

type RuleOn<M extends FieldMap, Model extends string, Root extends string, TR> = Omit<
  Rule<TR>,
  'field' | 'path'
> & { field: FieldOn<M, Model>; path?: FieldOn<M, Root> };

type DateRuleOn<M extends FieldMap, Model extends string, Root extends string, TD> = Omit<
  DateRule<TD>,
  'field' | 'path'
> & { field: FieldOn<M, Model>; path?: FieldOn<M, Root> };

// An array rule over a relation: its condition, window and ordering read the related model.
type RelationArrayOn<M extends FieldMap, Model extends string, Root extends string, TR, TD> = {
  [P in RelationPath<M, Model>]: Omit<
    ArrayRule<TR, TD>,
    'field' | 'condition' | 'filter' | 'orderBy'
  > &
    Window<M, RelationPathTarget<M, Model, P>, Root, TR, TD> & {
      field: P;
      condition?: ConditionOn<M, RelationPathTarget<M, Model, P>, Root, TR, TD>;
    };
}[RelationPath<M, Model>];

// An array rule over a scalar list or a Json array: its items have no model, so its condition
// reads them as the grammar does (`$` is the item), unchecked.
type ValueArrayOn<M extends FieldMap, Model extends string, TR, TD> = Omit<
  ArrayRule<TR, TD>,
  'field'
> & { field: FieldOn<M, Model> };

type AggregateOn<M extends FieldMap, Model extends string, Root extends string, TR, TD> = {
  [P in RelationPath<M, Model>]: Omit<
    AggregateRule<TR, TD>,
    'field' | 'aggregate' | 'condition' | 'filter' | 'orderBy'
  > &
    Window<M, RelationPathTarget<M, Model, P>, Root, TR, TD> & {
      field: P;
      aggregate: AggregateRule['aggregate'] & {
        field?: FieldOn<M, RelationPathTarget<M, Model, P>>;
      };
      condition?: ConditionOn<M, RelationPathTarget<M, Model, P>, Root, TR, TD>;
    };
}[RelationPath<M, Model>];

/**
 * A `Condition` whose paths are checked against a literal map at compile time: a field rule or
 * date rule names a `ScalarPath` of `Model` (through to-one relations, into Json); an array or
 * aggregate rule names a `RelationPath` and its `condition`, `filter`, `orderBy` and
 * `aggregate.field` read the related model; a `{ path }` value source reads the root row
 * (`Root`, the model the rule is checked on). `all` / `any` / `if` nest as themselves.
 * `UncheckedPath` spellings pass through. Assignable to `Condition`.
 */
export type ConditionOn<
  M extends FieldMap,
  Model extends string,
  Root extends string = Model,
  TRuleValue = RuleValue,
  TDateValue = DateRuleValue,
> =
  | RuleOn<M, Model, Root, TRuleValue>
  | DateRuleOn<M, Model, Root, TDateValue>
  | RelationArrayOn<M, Model, Root, TRuleValue, TDateValue>
  | ValueArrayOn<M, Model, TRuleValue, TDateValue>
  | AggregateOn<M, Model, Root, TRuleValue, TDateValue>
  | { all: ConditionOn<M, Model, Root, TRuleValue, TDateValue>[]; error?: string }
  | { any: ConditionOn<M, Model, Root, TRuleValue, TDateValue>[]; error?: string }
  | {
      if: ConditionOn<M, Model, Root, TRuleValue, TDateValue>;
      then: ConditionOn<M, Model, Root, TRuleValue, TDateValue>;
      else?: ConditionOn<M, Model, Root, TRuleValue, TDateValue>;
      error?: string;
    }
  | boolean;

/**
 * A `ModelNarrowing` checked against a literal map: `picks` / `omits` name the model's columns,
 * `relations` its relation fields (each narrowing the related model in turn), and `where` is a
 * `ConditionOn` the model. Assignable to `ModelNarrowing`.
 */
export type ModelNarrowingOn<M extends FieldMap, Model extends string> = Omit<
  ModelNarrowing,
  'picks' | 'omits' | 'where' | 'relations'
> & {
  picks?: ScalarFieldNameOf<M, Model>[];
  omits?: ScalarFieldNameOf<M, Model>[];
  where?: ConditionOn<M, Model>;
  relations?: {
    [F in RelationFieldNameOf<M, Model>]?: ModelNarrowingOn<M, RelationTargetOf<M, Model, F>>;
  };
};

/** A `LensNarrowing` whose `root` is a `ModelNarrowingOn` the lens's anchor model. Assignable to
 *  `LensNarrowing`. */
export type LensNarrowingOn<M extends FieldMap, Model extends string> = Omit<
  LensNarrowing,
  'root'
> & { root?: ModelNarrowingOn<M, Model> };
