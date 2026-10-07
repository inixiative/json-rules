import dayjs from 'dayjs';
import { resolveMagnitude, resolveUnits } from '../amount';
import { shiftByUnits } from '../dateExpr';
import type { FieldShape } from '../fieldMap/shape';
import {
  INTERVAL_FIELDS,
  isCalendarUnit,
  RELATIVE_UNITS,
  type RelativeUnit,
} from '../operatorCatalog';
import type { Magnitude, RelativeUnits } from '../types';
import { rowRef } from '../valueSource';
import type { FieldSql } from './join';
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
  typeof magnitude === 'object' && rowRef(magnitude) !== null;

/**
 * A date read from the row as an instant, whatever the session zone. A DateTime column goes
 * through its epoch, which a `timestamp` column (UTC wall time, as Prisma writes it) and a
 * `timestamptz` share. Text — a JSON path — reads as check() reads it: a number is epoch
 * milliseconds, a string with a zone is that instant, and a zoneless one is wall time in the
 * evaluation's zone.
 */
export const asInstant = (
  { sql, shape }: Pick<FieldSql, 'sql'> & { shape?: FieldShape },
  state: BuilderState,
): string => {
  if (shape !== 'json-path' && shape !== 'text') return `to_timestamp(EXTRACT(EPOCH FROM ${sql}))`;
  const zone = nextParam(state, dateConfigOf(state).timeZone);
  return (
    `(CASE WHEN btrim(${sql}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN to_timestamp(btrim(${sql})::numeric / 1000)` +
    ` WHEN ${sql} ~* '[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?\\s*(z|[+-][0-9]{2}(:?[0-9]{2})?)\\s*$'` +
    ` OR ${sql} ~* '\\m(gmt|utc)\\M' THEN (${sql})::timestamptz` +
    ` ELSE (${sql})::timestamp AT TIME ZONE ${zone} END)`
  );
};

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

/** `units` as a Postgres interval; NULL when an amount reads NULL. */
const intervalSql = (units: RelativeUnits, state: BuilderState): string => {
  const args = INTERVAL_FIELDS.flatMap((field) => {
    const terms = (Object.keys(units) as RelativeUnit[])
      .filter((unit) => units[unit] !== undefined && RELATIVE_UNITS[unit].interval === field)
      .map((unit) => {
        const term = magnitudeSql(units[unit] as Magnitude, state, unit);
        const { factor } = RELATIVE_UNITS[unit];
        return factor === 1 ? term : `${factor} * ${term}`;
      });
    return terms.length ? [`${field} => ${terms.join(' + ')}`] : [];
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
  const zone = dateConfigOf(state).timeZone;
  if (rhs.type === 'value' && !readsRow(units)) {
    const resolved = resolveUnits(units, compileTimeRead(state));
    if (rhs.value === null || rhs.value === undefined || resolved === null) return NO_VALUE;
    return {
      type: 'value',
      value: shiftByUnits(dayjs(rhs.value as Date), resolved, direction, zone).toDate(),
    };
  }
  const base =
    rhs.type === 'column'
      ? rhs.computed
        ? rhs.sql
        : asInstant(rhs, state)
      : `${nextParam(state, rhs.value ?? null)}::timestamptz`;
  const z = nextParam(state, zone);
  const sign = direction === 1 ? '+' : '-';
  return {
    type: 'column',
    computed: true,
    sql: `(((${base} AT TIME ZONE ${z}) ${sign} ${intervalSql(units, state)}) AT TIME ZONE ${z})`,
  };
};
