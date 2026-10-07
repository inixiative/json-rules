import type { PrismaProvider } from '../engineGlobals';
import type { CompileOptions } from '../types';

export type PrismaWhere = Record<string, unknown>;

export type StepRef = { __step: number };

export type GroupByStep = {
  operation: 'groupBy';
  model: string;
  args: {
    by: string[];
    where: Record<string, unknown>;
    having: Record<string, unknown>;
  };
  extract: string;
};

export type WhereStep = {
  operation: 'where';
  where: Record<string, unknown>;
};

export type PrismaStep = GroupByStep | WhereStep;

// steps is always present; the last entry is always a WhereStep.
// GroupBySteps precede it when count-based relation filtering is needed.
export type ToPrismaResult = {
  steps: PrismaStep[];
};

export type ToPrismaOptions = CompileOptions & {
  datasource?: { provider?: PrismaProvider };
};

// Mutable state threaded through build calls to accumulate intermediate groupBy steps
export type PrismaBuildState = {
  steps: GroupByStep[];
};
