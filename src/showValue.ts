/** A value as error text: scalars and lists of scalars as JSON; anything holding an object is
 *  named, never printed — a rule's operand can be a row or relation the caller may not see. */
export const showValue = (value: unknown): string => {
  const scalar = (v: unknown) => v === null || typeof v !== 'object' || v instanceof Date;
  if (scalar(value)) return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value) && value.every(scalar)) return JSON.stringify(value);
  return Array.isArray(value) ? 'a list' : 'an object';
};
