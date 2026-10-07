// Error texts every rail raises the same way.

/** A rule kind a compiler compiles only with a field (check() also takes a root array). */
export const fieldlessArrayError = (target: 'toSql' | 'toPrisma'): Error =>
  new Error(`${target}: ArrayRule.field is required (fieldless arrayOps are check-only)`);

/** A counting or element-wise array operator with no condition. */
export const conditionRequired = (operator: string): Error =>
  new Error(`${operator} requires a condition to check against array elements`);

/** Comparing a to-one relation as a value. */
export const relationNotValue = (field: string): Error =>
  new Error(
    `'${field}' is a relation: it exists or not; compare its fields with '${field}.<field>'.`,
  );
