export type SqlResult = {
  sql: string;
  params: unknown[];
};

export type BuilderState = {
  params: unknown[];
  paramIndex: number;
};
