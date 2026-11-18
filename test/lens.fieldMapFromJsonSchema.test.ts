import { describe, expect, test } from 'bun:test';
import { fieldMapFromJsonSchema, type JsonSchema } from '@inixiative/field-map';
import {
  assertValidFieldMaps,
  check,
  composeLens,
  createLens,
  type LensNarrowing,
  lensVisit,
  projectRows,
  type StoredLens,
  storeLens,
  validateNarrowing,
  validateRuleInLens,
} from '../index';

// A lens over a map read from a JSON Schema (moved from json-rules #45, whose converter is now
// field-map's `fieldMapFromJsonSchema`). The schema is what `z.toJSONSchema` writes for an event
// envelope.
const envelope = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    type: { type: 'string' },
    actor: {
      type: 'object',
      properties: { id: { type: 'string' }, model: { type: 'string', enum: ['User', 'Token'] } },
      required: ['id', 'model'],
    },
    subject: {
      type: 'object',
      properties: { model: { type: 'string' }, id: { type: 'string' } },
      required: ['model', 'id'],
    },
    labels: { type: 'array', items: { type: 'string' } },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['approved', 'changes'] },
          by: { type: 'string' },
        },
        required: ['state', 'by'],
      },
    },
    payload: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
    deliveredAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
  required: ['id', 'occurredAt', 'type', 'subject', 'labels', 'reviews', 'payload'],
} as const satisfies JsonSchema;

const lens = createLens({
  maps: { github: fieldMapFromJsonSchema(envelope, { model: 'Event' }) },
  mapName: 'github',
  model: 'Event',
});

const turnedOn: LensNarrowing = {
  parent: lens,
  root: {
    relations: {
      actor: {},
      reviews: { where: { field: 'state', operator: 'equals', value: 'approved' } },
    },
  },
};
const row = {
  id: 'e1',
  occurredAt: '2026-11-02T10:00:00Z',
  type: 'pull_request.review',
  actor: { id: 'u1', model: 'User' },
  subject: { model: 'PullRequest', id: 'pr1' },
  labels: ['agentic'],
  reviews: [
    { state: 'approved', by: 'u2' },
    { state: 'changes', by: 'u3' },
  ],
  payload: { number: 7 },
  deliveredAt: null,
};

describe('a lens over fieldMapFromJsonSchema', () => {
  test('rules validate against it, an enum gates its values, and a Json field reads by path', () => {
    expect(validateRuleInLens({ field: 'type', operator: 'equals', value: 'x' }, lens).ok).toBe(
      true,
    );
    expect(validateRuleInLens({ field: 'nope', operator: 'equals', value: 1 }, lens).ok).toBe(
      false,
    );
    expect(
      validateRuleInLens({ field: 'payload.number', operator: 'equals', value: 7 }, lens).ok,
    ).toBe(true);
  });

  test('a narrowing turns a nested relation on with a where, and validates', () => {
    expect(validateNarrowing(turnedOn).ok).toBe(true);
    expect(lensVisit(turnedOn, 'reviews')?.model).toBe('Event.reviews');
    expect(lensVisit(turnedOn, 'subject')).toBeNull();
  });

  test('projectRows filters the nested list and cuts relations left off', () => {
    expect(projectRows(turnedOn, [row])).toEqual([
      {
        id: 'e1',
        occurredAt: '2026-11-02T10:00:00Z',
        type: 'pull_request.review',
        actor: { id: 'u1', model: 'User' },
        labels: ['agentic'],
        reviews: [{ state: 'approved', by: 'u2' }],
        payload: { number: 7 },
        deliveredAt: null,
      },
    ]);
  });

  test('a rule over a nested relation evaluates under it', () => {
    const rule = {
      field: 'reviews',
      arrayOperator: 'any',
      condition: { field: 'state', operator: 'equals', value: 'approved' },
    } as const;
    expect(validateRuleInLens(rule, turnedOn).ok).toBe(true);
    expect(check(rule, row)).toBe(true);
  });

  test('stores and composes as a base lens with its narrowings', () => {
    const narrower: LensNarrowing = { parent: turnedOn, root: { omits: ['payload'] } };
    const records: Record<string, StoredLens> = {};
    for (const record of storeLens(narrower, ['base', 'grant', 'holder']))
      records[record.id] = record;
    const composed = composeLens('holder', records);
    expect(composed).toEqual(narrower);
    expect(projectRows(composed, [row])[0]).not.toHaveProperty('payload');
  });

  test('a property name a path cannot address is refused by the field-map check', () => {
    const odd = fieldMapFromJsonSchema(
      { type: 'object', properties: { 'a.b': { type: 'string' } } },
      { model: 'Event' },
    );
    expect(() => assertValidFieldMaps({ maps: { odd } })).toThrow('forbidden character');
  });
});
