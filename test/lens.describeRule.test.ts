import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../index';
import { ArrayOperator, createLens, DateOperator, describeRule, Operator } from '../index';

const prisma: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        crmId: { kind: 'scalar', type: 'String' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        published: { kind: 'scalar', type: 'Boolean' },
      },
    },
  },
};

const salesforce: FieldMap = {
  models: {
    Contact: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        industry: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const singleSource = createLens({ maps: { prisma }, mapName: 'prisma', model: 'User' });

const bridged = createLens({
  maps: { prisma, salesforce },
  bridges: [
    {
      endpoints: [
        { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
        { fieldMap: 'prisma', model: 'User', on: 'crmId' },
      ],
      cardinality: 'oneToMany',
    },
  ],
  mapName: 'prisma',
  model: 'User',
});

describe('describeRule — single source', () => {
  test('a plain equality is single-source and supported on all targets', () => {
    const d = describeRule(
      { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      singleSource,
    );
    expect(d.sources).toEqual(['prisma']);
    expect(d.bridgesCrossed).toBe(false);
    expect(d.supportedTargets).toEqual(['check', 'toPrisma', 'toSql']);
    expect(d.violations).toEqual([]);
  });

  test('matches is check + toSql only (no toPrisma)', () => {
    const d = describeRule(
      { field: 'email', operator: Operator.matches, value: '^a' },
      singleSource,
    );
    expect(d.supportedTargets).toEqual(['check', 'toSql']);
  });

  test('array all is check + toPrisma only (no toSql)', () => {
    const d = describeRule(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      singleSource,
    );
    expect(d.supportedTargets).toEqual(['check', 'toPrisma']);
  });

  test('dayIn is check + toSql only', () => {
    const d = describeRule(
      { field: 'createdAt', dateOperator: DateOperator.dayIn, value: ['monday'] },
      singleSource,
    );
    expect(d.supportedTargets).toEqual(['check', 'toSql']);
  });

  test('unresolvable field is reported as a violation', () => {
    const d = describeRule({ field: 'nope', operator: Operator.equals, value: 1 }, singleSource);
    expect(d.violations).toEqual(['nope']);
  });
});

describe('describeRule — bridge crossing is check-only', () => {
  test('a rule reaching a bridged source is check-only and lists both sources', () => {
    const d = describeRule(
      { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      bridged,
    );
    expect(d.bridgesCrossed).toBe(true);
    expect(d.sources).toEqual(['prisma', 'salesforce']);
    expect(d.supportedTargets).toEqual(['check']);
  });

  test('a same-source rule on a bridged lens does not cross', () => {
    const d = describeRule(
      { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      bridged,
    );
    expect(d.bridgesCrossed).toBe(false);
    expect(d.sources).toEqual(['prisma']);
    expect(d.supportedTargets).toEqual(['check', 'toPrisma', 'toSql']);
  });
});

describe('describeRule — windowing restricts targets', () => {
  test('a non-extremal window is check-only', () => {
    const d = describeRule(
      {
        field: 'posts',
        orderBy: [{ field: 'title', dir: 'desc' }],
        take: 2,
        arrayOperator: ArrayOperator.all,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      singleSource,
    );
    expect(d.supportedTargets).toEqual(['check']);
  });

  test('an extremal window keeps toPrisma (not toSql)', () => {
    const d = describeRule(
      {
        field: 'posts',
        orderBy: [{ field: 'title', dir: 'desc' }],
        take: 1,
        arrayOperator: ArrayOperator.any,
        condition: { field: 'title', operator: Operator.greaterThan, value: 'm' },
      },
      singleSource,
    );
    expect(d.supportedTargets).toEqual(['check', 'toPrisma']);
  });
});
