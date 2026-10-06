import dayjs from 'dayjs';
import { get } from 'lodash-es';
import { resolveTimeZone } from '../date';
import { shiftByUnits } from '../dateExpr';
import { checkOnlyScopeRef, parseScopeRef } from '../scope';
import type { Magnitude, NumberOffset, RelativeUnits } from '../types';
import {
  addOffset,
  isCalendarUnit,
  isPathRef,
  resolveMagnitude,
  resolveUnits,
} from '../valueSource';
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
// ref. A unit's amount must be non-negative, and whole for a calendar unit; a row value that
// isn't reads NULL, as check() reads it — the comparison then fails closed.
const magnitudeSql = (
  magnitude: Magnitude,
  state: BuilderState,
  unit?: keyof RelativeUnits,
): string => {
  const whole = unit !== undefined && isCalendarUnit(unit);
  const cast = whole ? 'int' : 'double precision';
  if (!isRowRef(magnitude)) {
    const amount = resolveMagnitude(magnitude, readContext(state), unit);
    return `${nextParam(state, amount)}::${cast}`;
  }
  const column = resolveRef((magnitude as { path: string }).path, state) as { sql: string };
  const c = column.sql;
  if (unit === undefined) return `(${c})::${cast}`;
  const usable = whole ? `${c} >= 0 AND ${c} = trunc(${c})` : `${c} >= 0`;
  return `(CASE WHEN ${usable} THEN ${c} END)::${cast}`;
};

// Postgres applies an interval month part, then day part, then time — the order check()
// shifts in (see shiftByUnits).
const GROUPS: { arg: string; scale: Partial<Record<keyof RelativeUnits, number>> }[] = [
  { arg: 'months', scale: { years: 12, quarters: 3, months: 1 } },
  { arg: 'days', scale: { weeks: 7, days: 1 } },
  { arg: 'secs', scale: { hours: 3600, minutes: 60, seconds: 1 } },
];

/** `units` as a Postgres interval; NULL when a magnitude reads NULL. */
export const intervalSql = (units: RelativeUnits, state: BuilderState): string => {
  const args = GROUPS.flatMap(({ arg, scale }) => {
    const terms = (Object.entries(scale) as [keyof RelativeUnits, number][])
      .filter(([unit]) => units[unit] !== undefined)
      .map(([unit, factor]) => {
        const term = magnitudeSql(units[unit] as Magnitude, state, unit);
        return factor === 1 ? term : `${factor} * ${term}`;
      });
    return terms.length ? [`${arg} => ${terms.join(' + ')}`] : [];
  });
  return `make_interval(${args.join(', ')})`;
};

/**
 * A date operand moved by `units` on the wall clock of the evaluation's zone, as check() moves
 * it; SQL (`AT TIME ZONE` both ways) when either side is read per row.
 */
export const shiftDate = (
  rhs: ResolvedRhs,
  units: RelativeUnits,
  direction: 1 | -1,
  state: BuilderState,
): ResolvedRhs => {
  const zone = resolveTimeZone(state.dateConfig ?? {});
  if (rhs.type === 'value' && !readsRow(units)) {
    const resolved = resolveUnits(units, readContext(state));
    if (rhs.value === null || rhs.value === undefined || resolved === null)
      return { type: 'value', value: null };
    return {
      type: 'value',
      value: shiftByUnits(dayjs(rhs.value as Date), resolved, direction, zone).toDate(),
    };
  }
  const base =
    rhs.type === 'column' ? rhs.sql : `${nextParam(state, rhs.value ?? null)}::timestamptz`;
  const z = nextParam(state, zone);
  const sign = direction === 1 ? '+' : '-';
  return {
    type: 'column',
    sql: `(((${base} AT TIME ZONE ${z}) ${sign} ${intervalSql(units, state)}) AT TIME ZONE ${z})`,
  };
};

/** A numeric operand moved by `offset`, in double precision as check() adds; SQL when either
 *  side is read per row. */
export const shiftNumber = (
  rhs: ResolvedRhs,
  offset: NumberOffset,
  state: BuilderState,
): ResolvedRhs => {
  if (rhs.type === 'value' && !readsRow(offset)) {
    const amount = resolveMagnitude(offset, readContext(state));
    return { type: 'value', value: amount === null ? null : addOffset(rhs.value, amount) };
  }
  const base =
    rhs.type === 'column' ? rhs.sql : `${nextParam(state, rhs.value ?? null)}::double precision`;
  return { type: 'column', sql: `(${base} + ${magnitudeSql(offset, state)})` };
};
