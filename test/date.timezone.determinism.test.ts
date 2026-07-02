import { describe, expect, test } from 'bun:test';
import { check, DateOperator } from '../index';

// FIX 2: checkDate must be consistent with the engine's config.timeZone policy
// (default UTC), not sniff the zone from String(value)/host-local parsing.

// --- host-timezone determinism (subprocess) ---
// The bug: naive strings parse host-local and Date objects render host-locale, so the
// SAME rule/data yields different check() results depending on the host TZ. We run the
// same checks under several host timezones in subprocesses and require identical output.

const REPO_ROOT = `${import.meta.dir}/..`;

// All four scenarios must evaluate to `true` under the correct UTC-anchored policy,
// independent of the host timezone.
const SCRIPT = `
import { check, DateOperator } from './index';
const results = [
  // (1) Date-object comparison value vs naive-string field (naive → anchored UTC)
  check({ field: 'ts', dateOperator: DateOperator.after, value: new Date('2024-06-15T12:00:00Z') }, { ts: '2024-06-15T18:00:00' }),
  // (2) number (epoch) comparison value — an absolute instant
  check({ field: 'ts', dateOperator: DateOperator.before, value: Date.UTC(2024, 5, 15, 12, 0, 0) }, { ts: '2024-06-15T06:00:00Z' }),
  // (3) naive date-only field vs naive date-only value (both midnight UTC)
  check({ field: 'ts', dateOperator: DateOperator.onOrAfter, value: '2024-06-15' }, { ts: '2024-06-16' }),
  // (4) dayIn on an absolute late-UTC-Saturday instant — weekday must be read in UTC
  check({ field: 'ts', dateOperator: DateOperator.dayIn, value: ['saturday'] }, { ts: '2024-06-15T23:00:00Z' }),
];
console.log(JSON.stringify(results));
`;

const runUnderTz = (tz: string): unknown => {
  const proc = Bun.spawnSync({
    cmd: ['bun', '-e', SCRIPT],
    cwd: REPO_ROOT,
    env: { ...process.env, TZ: tz },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new Error(`subprocess failed (TZ=${tz}): ${proc.stderr.toString()}\n${out}`);
  }
  return JSON.parse(out);
};

describe('checkDate — host-timezone determinism', () => {
  const timezones = ['Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Tokyo', 'America/New_York', 'UTC'];

  test('identical results across host timezones', () => {
    const results = timezones.map((tz) => ({ tz, out: runUnderTz(tz) }));
    const baseline = results[0].out;
    for (const { tz, out } of results) {
      expect({ tz, out }).toEqual({ tz, out: baseline });
    }
    // And that the deterministic answer is the correct one.
    expect(baseline).toEqual([true, true, true, true]);
  });
});

// --- naive strings anchor to config.timeZone (in-process) ---
describe('checkDate — naive values anchor to config.timeZone', () => {
  // Asia/Kolkata is a fixed +05:30 offset (no DST) → deterministic anchoring.
  const kolkata = { timeZone: 'Asia/Kolkata' };

  test('naive date-only FIELD anchors to config.timeZone', () => {
    // '2024-06-15' anchored in Kolkata = 2024-06-14T18:30Z; in UTC = 2024-06-15T00:00Z.
    const rule = {
      field: 'ts',
      dateOperator: DateOperator.after,
      value: '2024-06-14T19:00:00Z',
    } as const;
    // Kolkata anchor (18:30Z) is NOT after 19:00Z → fails.
    expect(check(rule, { ts: '2024-06-15' }, kolkata)).not.toBe(true);
    // Default UTC anchor (00:00Z on the 15th) IS after 19:00Z on the 14th → passes.
    expect(check(rule, { ts: '2024-06-15' })).toBe(true);
  });

  test('naive datetime VALUE anchors to config.timeZone', () => {
    // value '2024-06-15T00:00:00' anchored in Kolkata = 2024-06-14T18:30Z.
    const rule = {
      field: 'ts',
      dateOperator: DateOperator.after,
      value: '2024-06-15T00:00:00',
    } as const;
    const data = { ts: '2024-06-14T19:00:00Z' };
    // 19:00Z IS after the Kolkata anchor 18:30Z → passes.
    expect(check(rule, data, kolkata)).toBe(true);
    // 19:00Z is NOT after the UTC anchor 00:00Z on the 15th → fails.
    expect(check(rule, data)).not.toBe(true);
  });

  test('a Date-object value is absolute and NOT shifted by config.timeZone', () => {
    const rule = {
      field: 'ts',
      dateOperator: DateOperator.after,
      value: new Date('2024-06-15T00:00:00Z'),
    } as const;
    const data = { ts: '2024-06-15T01:00:00Z' };
    // 01:00Z is after midnight UTC regardless of config.timeZone.
    expect(check(rule, data, kolkata)).toBe(true);
    expect(check(rule, data)).toBe(true);
  });

  test('explicit-zone string value is absolute, not re-anchored', () => {
    const rule = {
      field: 'ts',
      dateOperator: DateOperator.after,
      value: '2024-06-15T00:00:00+05:30',
    } as const;
    const data = { ts: '2024-06-14T19:00:00Z' };
    // value +05:30 == 2024-06-14T18:30Z; 19:00Z is after it → passes under any config.tz.
    expect(check(rule, data, kolkata)).toBe(true);
    expect(check(rule, data)).toBe(true);
  });
});

// --- the anchoring zone can be BOUND from the evaluation's bindings ---
describe('checkDate — bindable anchoring zone', () => {
  // A naive date-only field anchors in the zone resolved for this evaluation.
  const rule = {
    field: 'ts',
    dateOperator: DateOperator.after,
    value: '2024-06-14T19:00:00Z',
  } as const;
  const data = { ts: '2024-06-15' };

  test('zone bound from bindings anchors the naive value', () => {
    // bound Kolkata: '2024-06-15' → 2024-06-14T18:30Z, NOT after 19:00Z → fails.
    const bound = check(rule, data, {
      timeZone: { bind: 'tz' },
      bindings: { tz: 'Asia/Kolkata' },
    });
    expect(bound).not.toBe(true);
    // Matches the literal-zone result exactly (one zone per evaluation).
    expect(bound).toEqual(check(rule, data, { timeZone: 'Asia/Kolkata' }));
  });

  test('absent binding falls back to UTC', () => {
    // No binding supplied → UTC: '2024-06-15' → 2024-06-15T00:00Z, after 19:00Z(14th) → true.
    expect(check(rule, data, { timeZone: { bind: 'tz' }, bindings: {} })).toBe(true);
    // Same as the default (no timeZone) UTC anchoring.
    expect(check(rule, data, { timeZone: { bind: 'tz' }, bindings: {} })).toBe(check(rule, data));
  });

  test('a Date-object value is still absolute under a bound zone', () => {
    const absRule = {
      field: 'ts',
      dateOperator: DateOperator.after,
      value: new Date('2024-06-15T00:00:00Z'),
    } as const;
    const out = check(
      { ...absRule },
      { ts: '2024-06-15T01:00:00Z' },
      { timeZone: { bind: 'tz' }, bindings: { tz: 'Asia/Kolkata' } },
    );
    expect(out).toBe(true);
  });
});
