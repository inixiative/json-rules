import { afterEach, describe, expect, test } from 'bun:test';
import {
  createLens,
  describeValue,
  engineGlobals,
  evaluateValue,
  FieldKind,
  formatDate,
  inferValueType,
  UsageError,
  validateDateFormat,
  validateValue,
  valueClockUnit,
  valueExpressionShape,
} from '../index';

const NOW = new Date('2026-11-26T19:00:00.000Z'); // Thursday, Nov 26 2026 19:00 UTC / 14:00 EST

const lens = createLens({
  maps: {
    db: {
      models: {
        Order: {
          fields: {
            createdAt: { kind: 'scalar', type: 'DateTime', isRequired: true },
            shippedAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
            graceDays: { kind: 'scalar', type: 'Int', isRequired: true },
            optionalDays: { kind: 'scalar', type: 'Int', isRequired: false },
            ratio: { kind: 'scalar', type: 'Float', isRequired: true },
            price: { kind: 'scalar', type: 'Decimal', isRequired: true },
            amount: { kind: 'scalar', type: 'Int', isRequired: true },
            isActive: { kind: 'scalar', type: 'Boolean', isRequired: true },
            name: { kind: 'scalar', type: 'String', isRequired: true },
            secret: { kind: 'scalar', type: 'Int', isRequired: true },
            customer: {
              kind: 'object',
              type: 'Customer',
              isList: false,
              relationName: 'OrderCustomer',
            },
          },
        },
        Customer: {
          fields: {
            id: { kind: 'scalar', type: 'String', isRequired: true },
          },
        },
      },
    },
  },
  mapName: 'db',
  model: 'Order',
});

const narrowedLens = {
  parent: lens,
  root: { omits: ['secret'], relations: { customer: {} } },
};

afterEach(() => {
  engineGlobals.set('clock.finestUnit', 'second');
});

describe('evaluateValue — DateExpr', () => {
  test('classifies DateExpr as shape "date"', () => {
    expect(valueExpressionShape({ ahead: { weeks: 1 } })).toBe('date');
    expect(valueExpressionShape({ ago: { days: 3 } })).toBe('date');
    expect(valueExpressionShape({ next: 'week' })).toBe('date');
    expect(valueExpressionShape({ start: { this: 'month' } })).toBe('date');
    expect(valueExpressionShape({ end: { last: 'year' } })).toBe('date');
  });

  test('evaluates rolling ahead and ago expressions relative to now', () => {
    const nextWeek = evaluateValue({ ahead: { weeks: 1 } }, {}, { now: NOW });
    expect(nextWeek).toEqual(new Date('2026-12-03T19:00:00.000Z'));

    const threeDaysAgo = evaluateValue({ ago: { days: 3 } }, {}, { now: NOW });
    expect(threeDaysAgo).toEqual(new Date('2026-11-23T19:00:00.000Z'));
  });

  test('evaluates bare periods to their start instant, and honors weekStart and timeZone', () => {
    // 2026-11-26 is Thursday; Monday-start next week is Monday 2026-11-30 00:00 in America/New_York (05:00Z)
    expect(evaluateValue({ next: 'week' }, {}, { now: NOW, timeZone: 'America/New_York' })).toEqual(
      new Date('2026-11-30T05:00:00.000Z'),
    );

    // Sunday-start next week is Sunday 2026-11-29 00:00 in America/New_York (05:00Z)
    expect(
      evaluateValue(
        { next: 'week' },
        {},
        { now: NOW, timeZone: 'America/New_York', weekStart: 'sunday' },
      ),
    ).toEqual(new Date('2026-11-29T05:00:00.000Z'));

    expect(
      evaluateValue({ this: 'month' }, {}, { now: NOW, timeZone: 'America/New_York' }),
    ).toEqual(new Date('2026-11-01T04:00:00.000Z')); // Nov 1 00:00 EDT (before 2am fall-back)
  });

  test('evaluates explicit start/end period edges', () => {
    expect(
      evaluateValue({ start: { next: 'month' } }, {}, { now: NOW, timeZone: 'America/New_York' }),
    ).toEqual(new Date('2026-12-01T05:00:00.000Z'));

    expect(
      evaluateValue({ end: { this: 'month' } }, {}, { now: NOW, timeZone: 'America/New_York' }),
    ).toEqual(new Date('2026-12-01T04:59:59.999Z'));
  });

  test('shifts wall-clock across DST transitions', () => {
    // 2026-10-31 12:00 EDT (16:00Z) + 2 days = 2026-11-02 12:00 EST (17:00Z)
    const beforeFallBack = new Date('2026-10-31T16:00:00.000Z');
    expect(
      evaluateValue(
        { ahead: { days: 2 } },
        {},
        { now: beforeFallBack, timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-11-02T17:00:00.000Z'));
  });

  test('supports path and bind magnitudes, returning null when absent', () => {
    expect(
      evaluateValue({ ahead: { days: { path: 'graceDays' } } }, { graceDays: 5 }, { now: NOW }),
    ).toEqual(new Date('2026-12-01T19:00:00.000Z'));

    expect(
      evaluateValue({ ahead: { days: { path: 'graceDays' } } }, { graceDays: null }, { now: NOW }),
    ).toBeNull();

    expect(
      evaluateValue({ ahead: { days: { bind: 'days' } } }, {}, { now: NOW, bindings: { days: 2 } }),
    ).toEqual(new Date('2026-11-28T19:00:00.000Z'));
  });

  test('throws UsageError when now is omitted', () => {
    expect(() => evaluateValue({ ahead: { days: 1 } }, {})).toThrow(UsageError);
  });

  test('enforces clock.finestUnit floor', () => {
    engineGlobals.set('clock.finestUnit', 'hour');
    expect(() => evaluateValue({ ahead: { minutes: 5 } }, {}, { now: NOW })).toThrow();
    expect(evaluateValue({ ahead: { hours: 1 } }, {}, { now: NOW })).toEqual(
      new Date('2026-11-26T20:00:00.000Z'),
    );
  });
});

describe('evaluateValue — value source offsets', () => {
  test('shifts a date path, ISO literal, DateExpr, or bind by a rolling date offset', () => {
    expect(
      evaluateValue(
        { path: 'createdAt', offset: { value: { ahead: { days: 7 } } } },
        { createdAt: new Date('2026-10-31T16:00:00.000Z') },
        { timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-11-07T17:00:00.000Z'));

    expect(
      evaluateValue(
        { value: '2026-12-01T15:00:00Z', offset: { value: { ago: { hours: 2 } } } },
        {},
        { timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-12-01T13:00:00.000Z'));

    expect(
      evaluateValue(
        { value: { start: { this: 'month' } }, offset: { value: { ahead: { days: 4 } } } },
        {},
        { now: NOW, timeZone: 'UTC' },
      ),
    ).toEqual(new Date('2026-11-05T00:00:00.000Z'));

    expect(
      evaluateValue(
        { bind: 'at', offset: { value: { ahead: { weeks: 1 } } } },
        {},
        { bindings: { at: '2026-11-26T19:00:00Z' } },
      ),
    ).toEqual(new Date('2026-12-03T19:00:00.000Z'));
  });

  test('anchors a naive date string in timeZone before shifting', () => {
    expect(
      evaluateValue(
        { value: '2026-11-26', offset: { value: { ahead: { days: 1 } } } },
        {},
        { timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-11-27T05:00:00.000Z'));
  });

  test('returns null when base or offset is null', () => {
    expect(
      evaluateValue(
        { path: 'shippedAt', offset: { value: { ahead: { days: 7 } } } },
        { shippedAt: null },
      ),
    ).toBeNull();
    expect(
      evaluateValue(
        { path: 'createdAt', offset: { bind: 'shift', bindOptional: true } },
        { createdAt: NOW },
      ),
    ).toBeNull();
  });

  test('supports numeric offsets on numeric value sources', () => {
    expect(evaluateValue({ path: 'amount', offset: { value: 10 } }, { amount: 25 })).toBe(35);
    expect(evaluateValue({ value: 10, offset: { path: 'graceDays' } }, { graceDays: 3 })).toBe(13);
  });
});

describe('validateValue, inferValueType, valueClockUnit, describeValue on date expressions', () => {
  test('validateValue accepts valid DateExpr and offset, and rejects bad ones', () => {
    expect(validateValue({ ahead: { weeks: 1 } }).ok).toBe(true);
    expect(validateValue({ next: 'week' }).ok).toBe(true);
    expect(validateValue({ start: { last: 'month' } }).ok).toBe(true);
    expect(validateValue({ path: 'createdAt', offset: { value: { ahead: { days: 7 } } } }).ok).toBe(
      true,
    );
    expect(validateValue({ path: 'amount', offset: { value: 5 } }).ok).toBe(true);

    expect(validateValue({ ahead: { bogus: 1 } }).ok).toBe(false);
    expect(validateValue({ ahead: { days: -1 } }).ok).toBe(false);
    expect(validateValue({ ahead: { days: 1 }, ago: { days: 1 } }).ok).toBe(false);
    expect(validateValue({ next: 'decade' }).ok).toBe(false);
    expect(validateValue({ path: 'createdAt', offset: { value: 'not-valid' } }).ok).toBe(false);
    expect(validateValue({ path: 'createdAt', offset: { value: { next: 'week' } } }).ok).toBe(
      false,
    );
  });

  test('inferValueType returns DateTime for DateExpr and date-shifted sources', () => {
    expect(inferValueType({ ahead: { weeks: 1 } })).toEqual({
      kind: FieldKind.DateTime,
      isList: false,
      nullable: false,
    });
    expect(inferValueType({ ahead: { days: { path: 'graceDays' } } }, lens)).toEqual({
      kind: FieldKind.DateTime,
      isList: false,
      nullable: true,
    });
    expect(
      inferValueType({ path: 'createdAt', offset: { value: { ahead: { days: 7 } } } }, lens),
    ).toEqual({
      kind: FieldKind.DateTime,
      isList: false,
      nullable: false,
    });
    expect(
      inferValueType({ path: 'shippedAt', offset: { value: { ahead: { days: 7 } } } }, lens),
    ).toEqual({
      kind: FieldKind.DateTime,
      isList: false,
      nullable: true,
    });
  });

  test('valueClockUnit reports the finest clock unit and enforces clock.finestUnit', () => {
    expect(valueClockUnit({ ahead: { weeks: 1 } })).toBe('week');
    expect(valueClockUnit({ ahead: { weeks: 1, hours: 2 } })).toBe('hour');
    expect(valueClockUnit({ next: 'month' })).toBe('month');
    expect(valueClockUnit({ path: 'createdAt', offset: { value: { ahead: { days: 7 } } } })).toBe(
      null,
    );
    expect(
      valueClockUnit({
        value: { start: { this: 'month' } },
        offset: { value: { ahead: { days: 4 } } },
      }),
    ).toBe('day');

    engineGlobals.set('clock.finestUnit', 'day');
    expect(() => valueClockUnit({ ahead: { hours: 1 } })).toThrow();
    expect(() =>
      valueClockUnit({ path: 'createdAt', offset: { value: { ahead: { minutes: 5 } } } }),
    ).toThrow();
  });

  test('describeValue gates paths inside DateExpr magnitudes and offsets through the lens', () => {
    const ok = describeValue(
      { path: 'createdAt', offset: { value: { ahead: { days: { path: 'graceDays' } } } } },
      narrowedLens,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.paths).toEqual(['createdAt', 'graceDays']);
    expect(ok.type).toEqual({ kind: FieldKind.DateTime, isList: false, nullable: true });

    const blocked = describeValue({ ahead: { days: { path: 'secret' } } }, narrowedLens);
    expect(blocked.errors.length).toBeGreaterThan(0);
    expect(blocked.clockUnit).toBe('day');
  });
});

describe('formatDate & validateDateFormat', () => {
  const CALL = '2026-11-26T19:00:00.000Z';

  test('defaults to ISO 8601 in UTC, or with zone offset when timeZone is given', () => {
    expect(formatDate(new Date(CALL))).toBe('2026-11-26T19:00:00Z');
    expect(formatDate(CALL, { timeZone: 'America/New_York' })).toBe('2026-11-26T14:00:00-05:00');
  });

  test('formats with date-fns format strings across DST boundaries', () => {
    expect(formatDate(CALL, { timeZone: 'America/New_York', format: 'MMM d, h:mm a zzz' })).toBe(
      'Nov 26, 2:00 PM EST',
    );
    expect(
      formatDate('2026-10-31T16:00:00.000Z', {
        timeZone: 'America/New_York',
        format: 'MMM d, h:mm a zzz',
      }),
    ).toBe('Oct 31, 12:00 PM EDT');
    expect(
      formatDate('2026-11-02T17:00:00.000Z', {
        timeZone: 'America/New_York',
        format: 'MMM d, h:mm a zzz',
      }),
    ).toBe('Nov 2, 12:00 PM EST');
    expect(formatDate(CALL, { timeZone: 'America/New_York', format: "'zone:' zzz (zzzz)" })).toBe(
      'zone: EST (Eastern Standard Time)',
    );
  });

  test('does not corrupt UTC timestamps during a DST-observing host spring-forward gap', () => {
    const gapInstant = new Date('2026-03-08T02:30:00.000Z');
    expect(formatDate(gapInstant)).toBe('2026-03-08T02:30:00Z');
    expect(evaluateValue({ ahead: { days: 1 } }, {}, { now: gapInstant })).toEqual(
      new Date('2026-03-09T02:30:00.000Z'),
    );
    expect(evaluateValue({ this: 'hour' }, {}, { now: gapInstant })).toEqual(
      new Date('2026-03-08T02:00:00.000Z'),
    );
  });

  test('matches Postgres AT TIME ZONE across spring-forward and fall-back transitions', () => {
    // Spring-forward +1h: 01:30 EST -> 03:30 EDT (07:30Z), never 01:30 EST
    expect(
      evaluateValue(
        { ahead: { hours: 1 } },
        {},
        { now: new Date('2026-03-08T06:30:00.000Z'), timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-03-08T07:30:00.000Z'));

    // Midnight spring-forward in America/Havana: 2026-03-08 00:00 pushes forward to 01:00 CDT (05:00Z)
    expect(
      evaluateValue(
        { this: 'day' },
        {},
        { now: new Date('2026-03-08T15:00:00.000Z'), timeZone: 'America/Havana' },
      ),
    ).toEqual(new Date('2026-03-08T05:00:00.000Z'));

    // Fall-back +10m at 01:30 EST (06:30Z) moves forward to 01:40 EST (06:40Z), never backwards
    expect(
      evaluateValue(
        { ahead: { minutes: 10 } },
        {},
        { now: new Date('2026-11-01T06:30:00.000Z'), timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-11-01T06:40:00.000Z'));

    // Fall-back { this: 'hour' } at 01:30 EST (06:30Z) starts at 01:00 EST (06:00Z), containing now
    expect(
      evaluateValue(
        { this: 'hour' },
        {},
        { now: new Date('2026-11-01T06:30:00.000Z'), timeZone: 'America/New_York' },
      ),
    ).toEqual(new Date('2026-11-01T06:00:00.000Z'));

    // Years 0..99 are never mapped to 1900..1999
    expect(
      evaluateValue({ this: 'year' }, {}, { now: new Date('0050-06-15T12:00:00.000Z') }),
    ).toEqual(new Date('0050-01-01T00:00:00.000Z'));
  });

  test('anchors naive date strings in the target timeZone and parses 2-digit offsets', () => {
    expect(
      formatDate('2026-11-26', { timeZone: 'America/New_York', format: 'yyyy-MM-dd HH:mm zzz' }),
    ).toBe('2026-11-26 00:00 EST');
    expect(formatDate('2026-11-26T14:00:00+00')).toBe('2026-11-26T14:00:00Z');
  });

  test('throws UsageError on invalid date, invalid calendar date, invalid timeZone, or invalid format', () => {
    expect(() => formatDate('not-a-date')).toThrow(UsageError);
    expect(() => formatDate('2026-02-30T12:00:00Z')).toThrow(UsageError);
    expect(() => formatDate(null as never)).toThrow(UsageError);
    expect(() => formatDate({} as never)).toThrow(UsageError);
    expect(() => formatDate(new Date(Number.NaN))).toThrow(UsageError);
    expect(formatDate(new Date(8.64e15))).toBe('275760-09-13T00:00:00Z');
    expect(() => formatDate(CALL, { timeZone: 'Mars/Olympus' })).toThrow(UsageError);
    expect(() => formatDate(CALL, { format: 'YYYY' })).toThrow(UsageError);
    expect(() => formatDate(CALL, { format: 'hello' })).toThrow(UsageError);
    expect(() => formatDate(CALL, { format: '' })).toThrow(UsageError);
  });

  test('validateDateFormat accepts valid date-fns format strings and refuses bad ones', () => {
    expect(validateDateFormat('MMM d, h:mm a zzz')).toEqual({ ok: true, errors: [] });
    expect(validateDateFormat("EEEE, MMMM d 'at' h:mm a zzz")).toEqual({ ok: true, errors: [] });
    expect(validateDateFormat('PPpp')).toEqual({ ok: true, errors: [] });

    expect(validateDateFormat('YYYY').ok).toBe(false);
    expect(validateDateFormat('hello').ok).toBe(false);
    expect(validateDateFormat('').ok).toBe(false);
    expect(validateDateFormat(123).ok).toBe(false);
  });
});

describe('adversarial regressions — offset typing, magnitude gating, and inert wrapped literals', () => {
  test('refuses mismatched base/offset kinds and preserves list flag for numeric list offsets', () => {
    expect(
      describeValue(
        { path: 'isActive', offset: { value: { ahead: { days: 1 } } } },
        lens,
      ).errors.some((e) => e.code === 'offset_kind_mismatch'),
    ).toBe(true);
    expect(
      describeValue({ path: 'createdAt', offset: { value: 5 } }, lens).errors.some(
        (e) => e.code === 'offset_kind_mismatch',
      ),
    ).toBe(true);
    expect(
      describeValue({ path: 'createdAt', offset: { path: 'graceDays' } }, lens).errors.some(
        (e) => e.code === 'offset_kind_mismatch',
      ),
    ).toBe(true);
    expect(
      describeValue({ path: 'graceDays', offset: { path: 'name' } }, lens).errors.some(
        (e) => e.code === 'offset_kind_mismatch',
      ),
    ).toBe(true);
    expect(inferValueType({ value: [1, 2], offset: { value: 5 } })).toEqual({
      kind: FieldKind.Int,
      isList: true,
      nullable: false,
    });
  });

  test('validates DateExpr path magnitudes against the lens (rejects relations, strings, floats on calendar units)', () => {
    expect(
      describeValue({ ahead: { days: { path: 'customer' } } }, narrowedLens).errors.length,
    ).toBeGreaterThan(0);
    expect(
      describeValue({ ahead: { days: { path: 'name' } } }, narrowedLens).errors.length,
    ).toBeGreaterThan(0);
    expect(
      describeValue({ ahead: { days: { path: 'ratio' } } }, narrowedLens).errors.length,
    ).toBeGreaterThan(0);
    expect(describeValue({ ahead: { hours: { path: 'ratio' } } }, narrowedLens).errors).toEqual([]);
    expect(inferValueType({ ahead: { days: { value: 5 } } })).toEqual({
      kind: FieldKind.DateTime,
      isList: false,
      nullable: false,
    });
  });

  test('treats { value: DateExpr } without offset as inert, and validates it when offset is present', () => {
    engineGlobals.set('clock.finestUnit', 'hour');
    const inert = { value: { ahead: { minutes: 5 } } };
    expect(validateValue(inert).ok).toBe(true);
    expect(valueClockUnit(inert)).toBeNull();
    expect(describeValue({ value: { ahead: { days: { path: 'name' } } } }, lens).paths).toEqual([]);

    expect(
      validateValue({ value: { ahead: { days: -5 } }, offset: { value: { ahead: { days: 1 } } } })
        .ok,
    ).toBe(false);
  });

  test('handles Decimal objects with numeric offsets and rejects null now', () => {
    expect(
      evaluateValue(
        { path: 'price', offset: { value: 5 } },
        { price: { toString: () => '10.50' } },
      ),
    ).toBe(15.5);
    expect(() => evaluateValue({ ahead: { days: 1 } }, {}, { now: null as never })).toThrow(
      UsageError,
    );
  });
});
