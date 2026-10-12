import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { weeklyDue } from '../../src/memory/weekly-due.js';

const at = (iso: string): number => Date.parse(iso);
const activation = at('2026-01-01T00:00:00Z');
const sunday = at('2026-10-11T04:30:00Z');
const followingSunday = at('2026-10-18T04:30:00Z');

function expectSchedule(
  now: string,
  activated: string,
  due: string | null,
  next: string,
  completed: string | null = null,
): void {
  deepStrictEqual(weeklyDue(at(now), at(activated), completed === null ? null : at(completed)), {
    timeZone: 'Asia/Kolkata',
    dueAt: due === null ? null : at(due),
    nextDueAt: at(next),
  });
}

test('Sunday immediately before, exactly at, and immediately after 10:00 IST', () => {
  deepStrictEqual(weeklyDue(sunday - 1, activation), {
    timeZone: 'Asia/Kolkata',
    dueAt: at('2026-10-04T04:30:00Z'),
    nextDueAt: sunday,
  });
  for (const now of [sunday, sunday + 1]) {
    deepStrictEqual(weeklyDue(now, activation), {
      timeZone: 'Asia/Kolkata', dueAt: sunday, nextDueAt: followingSunday,
    });
  }
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  equal(clock.format(sunday), '10:00');
});

test('Monday and multiple missed weeks collapse to the latest boundary', () => {
  for (const now of ['2026-10-12T00:00:00Z', '2026-10-17T23:59:59Z']) {
    expectSchedule(now, '2026-08-01T00:00:00Z',
      '2026-10-11T04:30:00Z', '2026-10-18T04:30:00Z');
  }
  expectSchedule('2026-11-30T00:00:00Z', '2026-08-01T00:00:00Z',
    '2026-11-29T04:30:00Z', '2026-12-06T04:30:00Z');
});

test('completion suppresses repeats until the next boundary', () => {
  for (const now of [sunday, sunday + 1, at('2026-10-12T12:00:00Z'), followingSunday - 1]) {
    deepStrictEqual(weeklyDue(now, activation, sunday), {
      timeZone: 'Asia/Kolkata', dueAt: null, nextDueAt: followingSunday,
    });
  }
  equal(weeklyDue(followingSunday, activation, sunday).dueAt, followingSunday);
  equal(weeklyDue(followingSunday, activation, followingSunday).dueAt, null);
  equal(weeklyDue(sunday, activation, at('2026-09-06T04:30:00Z')).dueAt, sunday);
});

test('activation before, exactly at, and after a boundary', () => {
  for (const activated of [sunday - 1, sunday]) {
    equal(weeklyDue(sunday, activated).dueAt, sunday);
    equal(weeklyDue(sunday + 1, activated).dueAt, sunday);
  }
  deepStrictEqual(weeklyDue(sunday + 1, sunday + 1), {
    timeZone: 'Asia/Kolkata', dueAt: null, nextDueAt: followingSunday,
  });
  equal(weeklyDue(at('2026-10-12T00:00:00Z'), sunday + 1).dueAt, null);
  equal(weeklyDue(followingSunday, sunday + 1).dueAt, followingSunday);
});

test('future activation selects the earliest boundary at or after activation', () => {
  deepStrictEqual(weeklyDue(sunday - 1, sunday), {
    timeZone: 'Asia/Kolkata', dueAt: null, nextDueAt: sunday,
  });
  deepStrictEqual(weeklyDue(sunday, sunday + 1), {
    timeZone: 'Asia/Kolkata', dueAt: null, nextDueAt: followingSunday,
  });
  for (const activated of ['2026-10-22T00:00:00Z', '2026-10-25T04:30:00Z']) {
    expectSchedule('2026-10-12T00:00:00Z', activated,
      null, '2026-10-25T04:30:00Z');
  }
  expectSchedule('2026-10-12T00:00:00Z', '2026-10-25T04:30:00.001Z',
    null, '2026-11-01T04:30:00Z');
});

test('month, year, and leap-day transitions', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['2026-08-31T12:00:00Z', '2026-08-30T04:30:00Z', '2026-09-06T04:30:00Z'],
    ['2027-01-01T00:00:00Z', '2026-12-27T04:30:00Z', '2027-01-03T04:30:00Z'],
    ['2023-01-01T04:29:59.999Z', '2022-12-25T04:30:00Z', '2023-01-01T04:30:00Z'],
    ['2023-01-01T04:30:00Z', '2023-01-01T04:30:00Z', '2023-01-08T04:30:00Z'],
    ['2024-02-29T12:00:00Z', '2024-02-25T04:30:00Z', '2024-03-03T04:30:00Z'],
    ['2000-02-29T12:00:00Z', '2000-02-27T04:30:00Z', '2000-03-05T04:30:00Z'],
  ];
  for (const [now, due, next] of cases) {
    expectSchedule(now, '2000-01-01T00:00:00Z', due, next);
  }
});

test('inclusive lower edge and computed boundaries beyond the upper input edge', () => {
  const lower = at('2000-01-01T00:00:00Z');
  const first = at('2000-01-02T04:30:00Z');
  for (const now of [lower, first - 1]) {
    deepStrictEqual(weeklyDue(now, lower), {
      timeZone: 'Asia/Kolkata', dueAt: null, nextDueAt: first,
    });
  }
  equal(weeklyDue(first, lower).dueAt, first);
  equal(weeklyDue(first, first, first).dueAt, null);
  expectSchedule('2099-12-31T23:59:59.999Z', '2000-01-01T00:00:00Z',
    '2099-12-27T04:30:00Z', '2100-01-03T04:30:00Z');
  expectSchedule('2099-12-31T23:59:59.999Z', '2000-01-01T00:00:00Z',
    null, '2100-01-03T04:30:00Z', '2099-12-27T04:30:00Z');
  expectSchedule('2000-01-01T00:00:00Z', '2099-12-31T23:59:59.999Z',
    null, '2100-01-03T04:30:00Z');
});

test('invalid timestamps are rejected in every argument, including erased types', () => {
  const invalid: readonly unknown[] = [
    undefined, NaN, Infinity, -Infinity, -1, 0, sunday + 0.5,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    at('2000-01-01T00:00:00Z') - 1, at('2100-01-01T00:00:00Z'),
    at('2100-01-01T00:00:00Z') + 1,
    '2026-10-11T04:30:00Z', String(sunday), true, false,
    {}, [], new Date(sunday), new Number(sunday), 1n, Symbol('timestamp'),
  ];
  for (const value of [...invalid, null]) {
    throws(() => weeklyDue(value as any, activation), RangeError);
    throws(() => weeklyDue(sunday, value as any), RangeError);
  }
  for (const value of invalid) {
    throws(() => weeklyDue(sunday, activation, value as any), RangeError);
  }
  deepStrictEqual(weeklyDue(sunday, activation), weeklyDue(sunday, activation, null));
});

test('completion must be a boundary between activation and now', () => {
  for (const completed of [sunday - 1, sunday + 1, at('2026-10-11T00:00:00Z')]) {
    throws(() => weeklyDue(at('2026-10-12T00:00:00Z'), activation, completed), RangeError);
  }
  throws(() => weeklyDue(sunday, activation, followingSunday), RangeError);
  throws(() => weeklyDue(sunday, sunday, at('2026-10-04T04:30:00Z')), RangeError);
  throws(() => weeklyDue(sunday + 1, sunday + 1, sunday), RangeError);
  throws(() => weeklyDue(sunday, followingSunday, followingSunday), RangeError);
});

test('results have a fixed frozen shape and are deterministic', () => {
  const result = weeklyDue(sunday, activation);
  deepStrictEqual(Object.keys(result).sort(), ['dueAt', 'nextDueAt', 'timeZone']);
  equal(Object.isFrozen(result), true);
  equal(Reflect.set(result, 'dueAt', 0), false);
  equal(Reflect.defineProperty(result, 'extra', { value: 1 }), false);
  equal(Reflect.deleteProperty(result, 'timeZone'), false);
  for (let index = 0; index < 10; index += 1) {
    deepStrictEqual(weeklyDue(sunday, activation), result);
  }
  deepStrictEqual(result, {
    timeZone: 'Asia/Kolkata', dueAt: sunday, nextDueAt: followingSunday,
  });
});
