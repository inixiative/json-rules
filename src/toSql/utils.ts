import type { BuilderState } from './types';

export const nextParam = (state: BuilderState, value: unknown): string => {
  state.params.push(value);
  return `$${++state.paramIndex}`;
};

export const quoteField = (field: string): string => {
  // Handle nested JSON paths: data.settings.theme → "data"->>'settings'->>'theme'
  const parts = field.split('.');
  if (parts.length === 1) return `"${field}"`;

  const [column, ...jsonPath] = parts;
  if (jsonPath.length === 0) return `"${column}"`;

  // Build JSON path: "column"->'path1'->>'leaf'
  const pathParts = jsonPath.slice(0, -1).map((p) => `'${p}'`).join('->');
  const leaf = jsonPath[jsonPath.length - 1];

  if (pathParts) {
    return `"${column}"->${pathParts}->>'${leaf}'`;
  }
  return `"${column}"->>'${leaf}'`;
};

export const mapDayNames = (days: string[]): number[] => {
  const dayMap: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  return days.map((d) => {
    const num = dayMap[d.toLowerCase()];
    if (num === undefined) throw new Error(`Unknown day name: ${d}`);
    return num;
  });
};
