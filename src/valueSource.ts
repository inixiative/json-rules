import { readBinding } from './bindings';
import { isDateExpr, isRollingExpr } from './dateExpr';
import { DateOperator, Operator } from './operator';
import { readPath, type Scopes } from './scope';
import type { DateExpr, Magnitude, PathRef, RelativeUnits, RuleValue } from './types';

// A leaf's comparison operand: one of `value` / `bind` / `path`, optionally moved by an
// `offset`, with relative-date magnitudes that may themselves be `{ path }` refs.

type Sourced = { value?: unknown; path?: string; bind?: string; bindOptional?: boolean };

/** check(): the comparison value — the literal, the bound value, or the path read. */
export const readValueSource = (
  rule: Sourced,
  scopes: Scopes,
  context: unknown,
  bindings?: Record<string, RuleValue>,
): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.bind !== undefined) return readBinding(rule.bind, rule.bindOptional, bindings);
  if (rule.path) return readPath(rule.path, scopes, context);
  throw new Error('No value or path specified');
};

/** The operators an offset can shift: one point, or both ends of a range. */
export const OFFSET_OPERATORS: readonly string[] = [
  Operator.equals,
  Operator.notEquals,
  Operator.lessThan,
  Operator.lessThanEquals,
  Operator.greaterThan,
  Operator.greaterThanEquals,
  Operator.between,
  Operator.notBetween,
  DateOperator.before,
  DateOperator.after,
  DateOperator.onOrBefore,
  DateOperator.onOrAfter,
  DateOperator.notBefore,
  DateOperator.notAfter,
];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

export const isPathRef = (v: unknown): v is PathRef =>
  isPlainObject(v) && typeof v.path === 'string';

const unitRefs = (units: unknown): string[] =>
  isPlainObject(units)
    ? Object.values(units)
        .filter(isPathRef)
        .map((m) => m.path)
    : [];

const exprRefs = (expr: unknown): string[] =>
  isDateExpr(expr) && isRollingExpr(expr) ? unitRefs('ago' in expr ? expr.ago : expr.ahead) : [];

/** The refs a leaf reads as amounts: a `{ path }` offset and every `{ path }` magnitude. */
export const magnitudeRefs = (cond: Record<string, unknown>): string[] => {
  const { offset, value } = cond;
  const refs = isPathRef(offset) ? [offset.path] : exprRefs(offset);
  const values = Array.isArray(value) ? value : [value];
  return [...refs, ...values.flatMap(exprRefs)];
};

/** Every ref on a leaf's value side: its `path` and its magnitude refs. */
export const valueRefs = (cond: Record<string, unknown>): string[] => [
  ...(typeof cond.path === 'string' && cond.path !== '' ? [cond.path] : []),
  ...magnitudeRefs(cond),
];

// BigInt compares as Int: a bigint (what Prisma returns for a BigInt column) becomes a JS
// number on every side of a comparison, so 5n matches 5. Past ±2^53 a number cannot hold it
// exactly and every comparison would be silently wrong, so that throws instead.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export const bigIntToNumber = (value: bigint): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE)
    throw new RangeError(
      `BigInt ${value} is outside the safe integer range (±2^53); json-rules compares BigInt as Int.`,
    );
  return Number(value);
};

/** A read for `{ path }` amounts: the row/scope on check(), context on the compilers. */
export type ReadRef = (ref: string) => unknown;

/** A magnitude's number, or null when its path reads nothing — the comparison fails closed. */
export const resolveMagnitude = (magnitude: Magnitude, read: ReadRef): number | null => {
  if (!isPathRef(magnitude)) return magnitude;
  const raw = read(magnitude.path);
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'bigint' ? bigIntToNumber(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`'${magnitude.path}' must read a number (got ${JSON.stringify(raw)})`);
  return value;
};

/** Units with every magnitude resolved, or null when one reads nothing. */
export const resolveUnits = (units: RelativeUnits, read: ReadRef): RelativeUnits | null => {
  const resolved: RelativeUnits = {};
  for (const [unit, magnitude] of Object.entries(units) as [keyof RelativeUnits, Magnitude][]) {
    if (magnitude === undefined) continue;
    const amount = resolveMagnitude(magnitude, read);
    if (amount === null) return null;
    resolved[unit] = amount;
  }
  return resolved;
};

/** A date expression with its rolling magnitudes resolved, or null when one reads nothing. */
export const resolveExpr = (expr: DateExpr, read: ReadRef): DateExpr | null => {
  if (!isRollingExpr(expr)) return expr;
  if ('ago' in expr) {
    const ago = resolveUnits(expr.ago, read);
    return ago && { ago };
  }
  const ahead = resolveUnits(expr.ahead, read);
  return ahead && { ahead };
};

/** A comparison value moved by a resolved numeric offset; a range moves at both ends. */
export const addOffset = (value: unknown, offset: number): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => addOffset(item, offset));
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`offset needs a numeric comparison value (got ${JSON.stringify(value)})`);
  return value + offset;
};
