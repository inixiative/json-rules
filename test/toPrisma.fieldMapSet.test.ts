import { describe, expect, it } from 'bun:test';
import type { FieldMapSet } from '../src/fieldMap/types';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { getWhere } from './fixtures/helpers';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
    },
  },
};

const set: FieldMapSet = { maps: { prisma: prismaMap } };

describe('toPrisma FieldMapSet handling', () => {
  it('FieldMapSet with mapName → resolves the map', () => {
    const result = toPrisma(
      { field: 'email', operator: Operator.equals, value: 'x@y.com' },
      { map: set, mapName: 'prisma', model: 'FanUser' },
    );
    expect(getWhere(result)).toEqual({ email: { equals: 'x@y.com' } });
  });

  it('FieldMapSet without mapName → throws clear error', () => {
    expect(() =>
      toPrisma(
        { field: 'email', operator: Operator.equals, value: 'x@y.com' },
        { map: set, model: 'FanUser' },
      ),
    ).toThrow(/mapName/);
  });

  it('FieldMap (not a set) without mapName → unchanged behavior', () => {
    const result = toPrisma(
      { field: 'email', operator: Operator.equals, value: 'x@y.com' },
      { map: prismaMap, model: 'FanUser' },
    );
    expect(getWhere(result)).toEqual({ email: { equals: 'x@y.com' } });
  });

  it('FieldMapSet with unknown mapName → throws naming the missing entry', () => {
    expect(() =>
      toPrisma(
        { field: 'email', operator: Operator.equals, value: 'x@y.com' },
        { map: set, mapName: 'doesNotExist', model: 'FanUser' },
      ),
    ).toThrow(/doesNotExist/);
  });
});
