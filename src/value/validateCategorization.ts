import { CATEGORIZATION_MATCHES } from '../operatorCatalog';
import {
  throwIfInvalid,
  type ValidationIssue,
  type ValidationResult,
  validateRule,
  validationResult,
} from '../validate';
import { prefixed, validateValue } from './validateValue';

const CATEGORIZATION_KEYS = ['cases', 'match', 'default'];
const CATEGORY_KEYS = ['if', 'then'];

type Node = Record<string, unknown>;

const unknownKeys = (node: Node, allowed: string[], label: string, path: string) =>
  Object.keys(node)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      path: `${path}.${key}`,
      code: 'unknown_key',
      message: `${label} takes ${allowed.join(', ')}, not '${key}'`,
    }));

const validateCategory = (category: unknown, path: string): ValidationIssue[] => {
  if (category === null || typeof category !== 'object' || Array.isArray(category))
    return [{ path, code: 'invalid_case', message: 'a case is { if, then }' }];
  const node = category as Node;
  const issues = unknownKeys(node, CATEGORY_KEYS, 'a case', path);
  if (node.if === undefined)
    issues.push({ path: `${path}.if`, code: 'condition_required', message: 'a case takes an if' });
  else issues.push(...prefixed(validateRule(node.if).errors, `${path}.if`));
  if (node.then === undefined)
    issues.push({ path: `${path}.then`, code: 'value_required', message: 'a case takes a then' });
  else issues.push(...prefixed(validateValue(node.then).errors, `${path}.then`));
  return issues;
};

/** A categorization's shape checked without data: `cases` an array of `{ if, then }`, each `if`
 *  valid as `validateRule` sees it and each `then` and the `default` as `validateValue` does,
 *  `match` one of CATEGORIZATION_MATCHES, every key known. */
export const validateCategorization = (categorization: unknown): ValidationResult => {
  if (
    categorization === null ||
    typeof categorization !== 'object' ||
    Array.isArray(categorization)
  )
    return validationResult([
      {
        path: '$',
        code: 'invalid_categorization',
        message: 'a categorization is { cases, match?, default? }',
      },
    ]);
  const node = categorization as Node;
  const issues = unknownKeys(node, CATEGORIZATION_KEYS, 'a categorization', '$');
  if (!Array.isArray(node.cases))
    issues.push({ path: '$.cases', code: 'invalid_cases', message: 'cases must be an array' });
  else
    issues.push(
      ...node.cases.flatMap((category, index) => validateCategory(category, `$.cases[${index}]`)),
    );
  if (
    node.match !== undefined &&
    !(CATEGORIZATION_MATCHES as readonly unknown[]).includes(node.match)
  )
    issues.push({
      path: '$.match',
      code: 'invalid_match',
      message: `match is one of ${CATEGORIZATION_MATCHES.join(', ')}`,
    });
  if (node.default !== undefined)
    issues.push(...prefixed(validateValue(node.default).errors, '$.default'));
  return validationResult(issues);
};

/** validateCategorization's throwing form. */
export const assertValidCategorization = (categorization: unknown): void =>
  throwIfInvalid(validateCategorization(categorization), 'Invalid categorization');
