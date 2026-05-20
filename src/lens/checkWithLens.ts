import { check } from '../check.ts';
import type { Condition } from '../types.ts';
import type { Lens } from './types.ts';

type Row = Record<string, unknown>;

export type LensCheckData = {
  main: Row | Row[];
  supplemental?: Record<string, Row | Row[]>;
};

export const checkWithLens = (
  rule: Condition,
  _lens: Lens,
  data: LensCheckData,
): boolean | string => {
  const { main, supplemental = {} } = data;
  if (Array.isArray(main)) return check(rule, main);
  return check(rule, { ...main, ...supplemental });
};
