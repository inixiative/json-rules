import { describe, expect, test } from 'bun:test';
import { prismaMap } from './fixtures/railsMap';
import { map } from './rails/harness';

describe('test/fixtures/railsMap.ts', () => {
  test('is the map field-map reads from the rail tests’ client (regenerate with `field-map generate`)', () => {
    expect(prismaMap).toEqual(map as typeof prismaMap);
  });
});
