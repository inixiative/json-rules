import type { BuilderState } from './types';

export const nextParam = (state: BuilderState, value: unknown): string => {
  state.params.push(value);
  return `$${++state.paramIndex}`;
};
