import type { ValidationIssue } from '../validate';

/** Why a value expression's type can't be worked out, at the node it was found. */
export class ValueTypeIssue extends Error {
  constructor(readonly issue: ValidationIssue) {
    super(`inferValueType: ${issue.path}: ${issue.message}`);
  }
}

/** Throws the ValueTypeIssue for `path`. */
export const refuse = (path: string, code: string, message: string): never => {
  throw new ValueTypeIssue({ path, code, message });
};
