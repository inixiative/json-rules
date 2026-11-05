import { isPlainObject } from 'lodash-es';

/** An aggregate value written as an aggregate rule: it names a comparison. */
export const namesComparison = (node: unknown): boolean =>
  isPlainObject(node) &&
  'aggregate' in (node as object) &&
  ['operator', 'value', 'path', 'bind'].some((key) => key in (node as object));
