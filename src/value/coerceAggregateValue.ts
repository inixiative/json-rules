import { applyCoercion } from '../field';
import { bigIntToNumber } from '../number';
import { type FieldKind, NUMERIC_KINDS } from '../operatorCatalog';

// A double holds 15 significant digits exactly; a numeric object with more would round, so it
// throws, as a bigint past the safe range does.
const MAX_SIGNIFICANT_DIGITS = 15;

const significantDigits = (text: string): number =>
  text
    .replace(/^[-+]/, '')
    .replace(/e.*$/i, '')
    .replace('.', '')
    .replace(/^0+/, '')
    .replace(/0+$/, '').length;

const numericObject = (raw: object): unknown => {
  const text = String(raw);
  const number = Number(text);
  if (!Number.isFinite(number)) return raw;
  if (significantDigits(text) > MAX_SIGNIFICANT_DIGITS)
    throw new RangeError(
      `${text} has more digits than a number holds exactly; json-rules reads a coerced Decimal as a number.`,
    );
  return number;
};

/**
 * An aggregate value's `coerceType` as a reader of each value: check()'s own coercion
 * (`applyCoercion`: `'10'` → 10, `'true'` → true, a zoneless date string in `zone`), plus what a
 * value needs that a comparison doesn't — a numeric object (`Decimal('1')`) or a bigint read as a
 * number (throwing past what a number holds exactly), a date handed back as a Date rather than
 * epoch ms, and a Date or numeric object read as a string. A value that won't coerce stays as it
 * is. No kind reads every value as stored.
 */
export const coerceAggregateValue =
  (kind: FieldKind | undefined, zone: string) =>
  (raw: unknown): unknown => {
    if (kind === undefined) return raw;
    if (kind === 'String') {
      if (raw instanceof Date) return raw.toISOString();
      if (typeof raw === 'object' && raw !== null) return String(raw);
    }
    const isNumberOrDate = NUMERIC_KINDS.includes(kind) || kind === 'DateTime';
    const value =
      isNumberOrDate && typeof raw === 'bigint'
        ? bigIntToNumber(raw)
        : NUMERIC_KINDS.includes(kind) &&
            typeof raw === 'object' &&
            raw !== null &&
            !(raw instanceof Date)
          ? numericObject(raw)
          : raw;
    const coerced = applyCoercion(value, kind, zone);
    return kind === 'DateTime' && typeof coerced === 'number' ? new Date(coerced) : coerced;
  };
