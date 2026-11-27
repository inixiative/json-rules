import { isDateExpr } from '../dateExpr';
import { invalidValueExpression, valueTakesNoComparison } from '../errors';
import { listItems, type ValueExpressionShape, valueExpressionShape } from '../traverse';
import {
  coerceTypeNameIssue,
  throwIfInvalid,
  type ValidationIssue,
  type ValidationResult,
  validateAggregateValue,
  validateDateExprValue,
  validateRule,
  validateValueOffset,
  validateValueSource,
  validationResult,
} from '../validate';
import { namesComparison } from './namesComparison';

type Node = Record<string, unknown>;

const SHAPE_KEYS: Record<Exclude<ValueExpressionShape, 'literal' | 'date'>, readonly string[]> = {
  source: ['value', 'path', 'bind', 'bindOptional', 'coerceType', 'offset'],
  if: ['if', 'then', 'else'],
  aggregate: [
    'field',
    'aggregate',
    'condition',
    'filter',
    'orderBy',
    'take',
    'skip',
    'coerceType',
    'caseInsensitive',
  ],
  list: ['list', 'distinct'],
};

export const prefixed = (issues: ValidationIssue[], path: string): ValidationIssue[] =>
  issues.map((issue) => ({
    ...issue,
    path: issue.path.startsWith('$') ? `${path}${issue.path.slice(1)}` : `${path}.${issue.path}`,
  }));

const unknownKeys = (
  node: Node,
  shape: Exclude<ValueExpressionShape, 'literal' | 'date'>,
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

// A source's coerceType reads a literal only: a path's kind comes from the lens, a binding's from
// what is bound.
const literalCoercionIssues = (
  node: Node,
  coerceType: unknown,
  path: string,
): ValidationIssue[] => {
  if (coerceType === undefined) return [];
  const at = `${path}.coerceType`;
  if (!('value' in node))
    return [
      {
        path: at,
        code: 'unexpected_coerce_type',
        message: 'coerceType reads a literal { value }; a path or binding has its own kind',
      },
    ];
  const issue = coerceTypeNameIssue(coerceType, at);
  return issue ? [issue] : [];
};

const validateAt = (expr: unknown, path: string, inList: boolean): ValidationIssue[] => {
  const node = expr as Node;
  switch (valueExpressionShape(expr)) {
    case 'literal':
      return [];
    case 'date':
      return prefixed(validateDateExprValue(expr).errors, path);
    case 'list':
      return validateList(expr, path, inList);
    case 'if':
      return validateIf(node, path, inList);
    case 'aggregate':
      return validateAggregate(node, path);
    case 'source': {
      const { coerceType, offset, ...source } = node;
      return [
        ...unknownKeys(node, 'source', path),
        ...prefixed(validateValueSource(source).errors, path),
        ...literalCoercionIssues(node, coerceType, path),
        ...(offset !== undefined && isDateExpr(node.value)
          ? prefixed(validateDateExprValue(node.value).errors, `${path}.value`)
          : []),
        ...(offset === undefined
          ? []
          : prefixed(validateValueOffset(offset, node.value).errors, `${path}.offset`)),
      ];
    }
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
