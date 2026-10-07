import type { BuilderState } from './types';

// A Date binds as its ISO-8601 instant: Postgres reads `…Z` into a timestamp column as UTC wall
// time and into a timestamptz as the instant, while a driver's own Date serialization uses the
// host zone.
const bindable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  return Array.isArray(value) && value.some((item) => item instanceof Date)
    ? value.map(bindable)
    : value;
};

export const nextParam = (state: BuilderState, value: unknown): string => {
  state.params.push(bindable(value));
  return `$${++state.paramIndex}`;
};
