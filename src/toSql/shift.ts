import dayjs from 'dayjs';
import { isCalendarUnit, resolveMagnitude, resolveUnits } from '../amount';
import { shiftByUnits, zoneOf } from '../dateExpr';
import { parseScopeRef } from '../scope';
import type { Magnitude, RelativeUnits } from '../types';
import { nextParam } from './params';
import type { BuilderState } from './types';
import {
  compileTimeRead,
  dateConfigOf,
  NO_VALUE,
  type ResolvedRhs,
  resolveSource,
} from './valueSource';

// A date moved by relative units, as check() moves it: on the wall clock of the evaluation's
// zone, months then days then time. Postgres does the same arithmetic when an amount or the
// base is read per row.

const isRowRef = (magnitude: Magnitude | undefined): boolean =>
  typeof magnitude === 'object' &&
  magnitude.path !== undefined &&
  parseScopeRef(magnitude.path) !== null;

/** True when any unit is read per row — so the shift must compile to SQL. */
export const readsRow = (units: RelativeUnits): boolean => Object.values(units).some(isRowRef);

const magnitudeSql = (
  magnitude: Magnitude,
  state: BuilderState,
  unit: keyof RelativeUnits,
): string => {
  const whole = isCalendarUnit(unit);
  const cast = whole ? 'int' : 'double precision';
  if (typeof magnitude === 'number' || !isRowRef(magnitude)) {
    const amount = resolveMagnitude(magnitude, compileTimeRead(state), unit);
    return `${nextParam(state, amount)}::${cast}`;
  }
  const c = (resolveSource(magnitude, state) as { sql: string }).sql;
  const usable = whole ? `${c} >= 0 AND ${c} = trunc(${c})` : `${c} >= 0`;
  return `(CASE WHEN ${usable} THEN ${c} END)::${cast}`;
};

const GROUPS: { arg: string; scale: Partial<Record<keyof RelativeUnits, number>> }[] = [
  { arg: 'months', scale: { years: 12, quarters: 3, months: 1 } },
  { arg: 'days', scale: { weeks: 7, days: 1 } },
  { arg: 'secs', scale: { hours: 3600, minutes: 60, seconds: 1 } },
];

/** `units` as a Postgres interval; NULL when an amount reads NULL. */
const intervalSql = (units: RelativeUnits, state: BuilderState): string => {
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

/** A date operand moved by `units`: a value when everything is known now, else SQL. */
export const shiftDate = (
  rhs: ResolvedRhs,
  units: RelativeUnits,
  direction: 1 | -1,
  state: BuilderState,
): ResolvedRhs => {
  const zone = zoneOf(dateConfigOf(state));
  if (rhs.type === 'value' && !readsRow(units)) {
    const resolved = resolveUnits(units, compileTimeRead(state));
    if (rhs.value === null || rhs.value === undefined || resolved === null) return NO_VALUE;
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
    computed: true,
    sql: `(((${base} AT TIME ZONE ${z}) ${sign} ${intervalSql(units, state)}) AT TIME ZONE ${z})`,
  };
};
