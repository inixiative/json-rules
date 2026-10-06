import dayjs from 'dayjs';
import { get } from 'lodash-es';
import { shiftByUnits } from '../dateExpr';
import { checkOnlyScopeRef, parseScopeRef } from '../scope';
import type { Magnitude, NumberOffset, RelativeUnits } from '../types';
import { addOffset, isPathRef, resolveMagnitude, resolveUnits } from '../valueSource';
import { escapeIdentifier } from './escape';
import { nextParam } from './params';
import { quoteField } from './quoting';
import type { BuilderState } from './types';

/** A comparison operand: a value bound as a parameter, or SQL evaluated per row. */
export type ResolvedRhs = { type: 'value'; value: unknown } | { type: 'column'; sql: string };

/** A ref on the SQL rail: `$.x` is a column of the current row; a bare ref reads context. */
export const resolveRef = (ref: string, state: BuilderState): ResolvedRhs => {
  const scoped = parseScopeRef(ref);
  if (scoped) {
    if (scoped.depth > 1) throw new Error(checkOnlyScopeRef(ref, 'toSql'));
    const sql = state.currentAlias
      ? `${escapeIdentifier(state.currentAlias)}.${escapeIdentifier(scoped.path)}`
      : quoteField(scoped.path);
    return { type: 'column', sql };
  }
  if (!state.context) {
    throw new Error(
      `BuilderState.context is required to resolve path '${ref}'. ` +
        `Pass context in options when calling toSql().`,
    );
  }
  return { type: 'value', value: get(state.context, ref) };
};

const isRowRef = (magnitude: unknown): boolean =>
  isPathRef(magnitude) && parseScopeRef(magnitude.path) !== null;

/** True when a magnitude, or any unit of a set, is read per row — so it must compile to SQL. */
export const readsRow = (magnitudes: NumberOffset | RelativeUnits): boolean =>
  isPathRef(magnitudes) || typeof magnitudes === 'number'
    ? isRowRef(magnitudes)
    : Object.values(magnitudes).some(isRowRef);

/** Reads a bare ref from context; a row ref here is a caller bug (check readsRow first). */
export const readContext =
  (state: BuilderState) =>
  (ref: string): unknown => {
    const resolved = resolveRef(ref, state);
    if (resolved.type === 'column') throw new Error(`'${ref}' is a row ref`);
    return resolved.value;
  };

// One SQL term per magnitude: a parameter for a literal or context value, the column for a row
// ref. Context values are checked as check() checks them.
const magnitudeSql = (magnitude: Magnitude, state: BuilderState, cast: string): string => {
  if (isRowRef(magnitude)) {
    const column = resolveRef((magnitude as { path: string }).path, state);
    return `(${(column as { sql: string }).sql})::${cast}`;
  }
  return `${nextParam(state, resolveMagnitude(magnitude, readContext(state)))}::${cast}`;
};

// Postgres applies an interval month part, then day part, then time — the order check()
// shifts in (see shiftByUnits).
const GROUPS: { arg: string; cast: string; scale: Partial<Record<keyof RelativeUnits, number>> }[] =
  [
    { arg: 'months', cast: 'int', scale: { years: 12, quarters: 3, months: 1 } },
    { arg: 'days', cast: 'int', scale: { weeks: 7, days: 1 } },
    { arg: 'secs', cast: 'double precision', scale: { hours: 3600, minutes: 60, seconds: 1 } },
  ];

/** `units` as a Postgres interval; NULL when a magnitude reads NULL. */
export const intervalSql = (units: RelativeUnits, state: BuilderState): string => {
  const args = GROUPS.flatMap(({ arg, cast, scale }) => {
    const terms = (Object.entries(scale) as [keyof RelativeUnits, number][])
      .filter(([unit]) => units[unit] !== undefined)
      .map(([unit, factor]) => {
        const term = magnitudeSql(units[unit] as Magnitude, state, cast);
        return factor === 1 ? term : `${factor} * ${term}`;
      });
    return terms.length ? [`${arg} => ${terms.join(' + ')}`] : [];
  });
  return `make_interval(${args.join(', ')})`;
};

/** A date operand moved by `units`; SQL when either side is read per row. */
export const shiftDate = (
  rhs: ResolvedRhs,
  units: RelativeUnits,
  direction: 1 | -1,
  state: BuilderState,
): ResolvedRhs => {
  if (rhs.type === 'value' && !readsRow(units)) {
    const resolved = resolveUnits(units, readContext(state));
    if (rhs.value === null || rhs.value === undefined || resolved === null)
      return { type: 'value', value: null };
    return {
      type: 'value',
      value: shiftByUnits(dayjs(rhs.value as Date), resolved, direction).toDate(),
    };
  }
  const base =
    rhs.type === 'column' ? rhs.sql : `${nextParam(state, rhs.value ?? null)}::timestamptz`;
  return {
    type: 'column',
    sql: `(${base} ${direction === 1 ? '+' : '-'} ${intervalSql(units, state)})`,
  };
};

/** A numeric operand moved by `offset`; SQL when either side is read per row. */
export const shiftNumber = (
  rhs: ResolvedRhs,
  offset: NumberOffset,
  state: BuilderState,
): ResolvedRhs => {
  if (rhs.type === 'value' && !readsRow(offset)) {
    const amount = resolveMagnitude(offset, readContext(state));
    return { type: 'value', value: amount === null ? null : addOffset(rhs.value, amount) };
  }
  const base = rhs.type === 'column' ? rhs.sql : `${nextParam(state, rhs.value ?? null)}::numeric`;
  return { type: 'column', sql: `(${base} + ${magnitudeSql(offset, state, 'numeric')})` };
};
