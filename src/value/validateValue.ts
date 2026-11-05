import { invalidValueExpression, valueTakesNoComparison } from '../errors';
import { listItems, type ValueExpressionShape, valueExpressionShape } from '../traverse';
import {
  throwIfInvalid,
  type ValidationIssue,
  type ValidationResult,
  validateAggregateValue,
  validateRule,
  validateValueSource,
  validationResult,
} from '../validate';
import { namesComparison } from './namesComparison';

type Node = Record<string, unknown>;

const SHAPE_KEYS: Record<Exclude<ValueExpressionShape, 'literal'>, readonly string[]> = {
  source: ['value', 'path', 'bind', 'bindOptional'],
  if: ['if', 'then', 'else'],
  aggregate: ['field', 'aggregate', 'condition', 'filter', 'orderBy', 'take', 'skip'],
  list: ['list', 'distinct'],
};

const prefixed = (issues: ValidationIssue[], path: string): ValidationIssue[] =>
  issues.map((issue) => ({
    ...issue,
    path: issue.path.startsWith('$') ? `${path}${issue.path.slice(1)}` : `${path}.${issue.path}`,
  }));

const unknownKeys = (
  node: Node,
  shape: Exclude<ValueExpressionShape, 'literal'>,
  path: string,
): ValidationIssue[] =>
  Object.keys(node)
    .filter((key) => !SHAPE_KEYS[shape].includes(key))
    .map((key) => ({
      path: `${path}.${key}`,
      code: 'unknown_key',
      message: `a ${shape === 'source' ? 'value source' : `${shape} value`} takes ${SHAPE_KEYS[shape].join(', ')}, not '${key}'`,
    }));

const validateList = (expr: unknown, path: string, inList: boolean): ValidationIssue[] => {
  if (inList) return [{ path, code: 'nested_list', message: "a list's items are single values" }];
  const items = listItems(expr).flatMap((item, index) =>
    validateAt(item, `${path}[${index}]`, true),
  );
  if (Array.isArray(expr)) return items;
  const node = expr as Node;
  const issues = unknownKeys(node, 'list', path);
  if (!Array.isArray(node.list))
    issues.push({ path: `${path}.list`, code: 'invalid_list', message: 'list must be an array' });
  if (node.distinct !== undefined && typeof node.distinct !== 'boolean')
    issues.push({
      path: `${path}.distinct`,
      code: 'invalid_distinct',
      message: 'distinct must be a boolean',
    });
  return [...issues, ...items];
};

const validateIf = (node: Node, path: string, inList: boolean): ValidationIssue[] => {
  const issues = unknownKeys(node, 'if', path);
  if (node.if === undefined)
    issues.push({
      path: `${path}.if`,
      code: 'condition_required',
      message: 'if / then takes an if',
    });
  else issues.push(...prefixed(validateRule(node.if).errors, `${path}.if`));
  if (node.then === undefined)
    issues.push({
      path: `${path}.then`,
      code: 'value_required',
      message: 'if / then takes a then',
    });
  else issues.push(...validateAt(node.then, `${path}.then`, inList));
  if (node.else !== undefined) issues.push(...validateAt(node.else, `${path}.else`, inList));
  return issues;
};

// The aggregate rule's own validator checks what it reads; a value adds a non-empty list field.
const validateAggregate = (node: Node, path: string): ValidationIssue[] => [
  ...unknownKeys(node, 'aggregate', path),
  ...(node.field === ''
    ? [
        {
          path: `${path}.field`,
          code: 'field_required',
          message: 'an aggregate value reads a list field',
        },
      ]
    : []),
  ...prefixed(validateAggregateValue(node).errors, path),
];

const validateAt = (expr: unknown, path: string, inList: boolean): ValidationIssue[] => {
  const node = expr as Node;
  switch (valueExpressionShape(expr)) {
    case 'literal':
      return [];
    case 'list':
      return validateList(expr, path, inList);
    case 'if':
      return validateIf(node, path, inList);
    case 'aggregate':
      return validateAggregate(node, path);
    case 'source':
      return [
        ...unknownKeys(node, 'source', path),
        ...prefixed(validateValueSource(node).errors, path),
      ];
    default: {
      const isComparison = namesComparison(node);
      const error = isComparison ? valueTakesNoComparison(path) : invalidValueExpression(path);
      return [
        {
          path,
          code: isComparison ? 'unexpected_comparison' : 'invalid_value_expression',
          message: error.message.slice(path.length + 2),
        },
      ];
    }
  }
};

/** A value expression's shape checked without data: each node exactly one kind, every key known,
 *  aggregate modes from VALUE_AGGREGATE_MODES, and each condition it holds (`if`, an aggregate's
 *  `filter` / `condition` / window) valid as `validateRule` sees it. */
export const validateValue = (expression: unknown): ValidationResult =>
  validationResult(validateAt(expression, '$', false));

/** validateValue's throwing form. */
export const assertValidValue = (expression: unknown): void =>
  throwIfInvalid(validateValue(expression), 'Invalid value expression');
