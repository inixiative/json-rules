/** Own-property read: a name that only exists on Object.prototype reads as absent. */
export const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
