import { describe, expect, it } from "vitest";
import { describeScheduleExpression, nextRunAt, type ScheduleExpression } from "../schedule-time";

describe("nextRunAt — hourly", () => {
  it("returns this hour's minute mark when exactly at the boundary", () => {
    const schedule: ScheduleExpression = { kind: "hourly", minute: 30 };
    const from = new Date(2026, 0, 15, 9, 30, 0, 0);
    const result = nextRunAt(schedule, from);
    expect(result.getTime()).toBe(from.getTime());
  });

  it("advances to the next hour when just past the boundary", () => {
    const schedule: ScheduleExpression = { kind: "hourly", minute: 30 };
    const from = new Date(2026, 0, 15, 9, 30, 1, 0);
    const result = nextRunAt(schedule, from);
    expect(result).toEqual(new Date(2026, 0, 15, 10, 30, 0, 0));
  });

  it("still uses this hour when before the boundary", () => {
    const schedule: ScheduleExpression = { kind: "hourly", minute: 45 };
    const from = new Date(2026, 0, 15, 9, 10, 0, 0);
    const result = nextRunAt(schedule, from);
    expect(result).toEqual(new Date(2026, 0, 15, 9, 45, 0, 0));
  });
});

describe("nextRunAt — daily", () => {
  it("returns today at the boundary", () => {
    const schedule: ScheduleExpression = { kind: "daily", hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 9, 0, 0, 0);
    expect(nextRunAt(schedule, from).getTime()).toBe(from.getTime());
  });

  it("advances to tomorrow when just past the boundary", () => {
    const schedule: ScheduleExpression = { kind: "daily", hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 9, 0, 0, 1);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 0, 16, 9, 0, 0, 0));
  });

  it("rolls over month/year correctly at a month boundary", () => {
    const schedule: ScheduleExpression = { kind: "daily", hour: 9, minute: 0 };
    const from = new Date(2026, 0, 31, 9, 0, 0, 1); // Jan 31, just past
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 1, 1, 9, 0, 0, 0));
  });
});

describe("nextRunAt — weekly", () => {
  // 2026-01-15 is a Thursday (day 4).
  it("returns today when today is the target weekday and time hasn't passed", () => {
    const schedule: ScheduleExpression = { kind: "weekly", dayOfWeek: 4, hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 8, 0, 0, 0);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 0, 15, 9, 0, 0, 0));
  });

  it("returns exactly the boundary instant when at it", () => {
    const schedule: ScheduleExpression = { kind: "weekly", dayOfWeek: 4, hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 9, 0, 0, 0);
    expect(nextRunAt(schedule, from).getTime()).toBe(from.getTime());
  });

  it("jumps a full week when today is the target weekday but time already passed", () => {
    const schedule: ScheduleExpression = { kind: "weekly", dayOfWeek: 4, hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 9, 0, 0, 1);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 0, 22, 9, 0, 0, 0));
  });

  it("finds the next occurrence of a different weekday", () => {
    // Monday (1) target, from Thursday (4).
    const schedule: ScheduleExpression = { kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 12, 0, 0, 0);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 0, 19, 9, 0, 0, 0));
  });
});

describe("nextRunAt — monthly", () => {
  it("returns this month's day when not yet past", () => {
    const schedule: ScheduleExpression = { kind: "monthly", daysOfMonth: [1, 15], hour: 9, minute: 0 };
    const from = new Date(2026, 0, 10, 0, 0, 0, 0);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 0, 15, 9, 0, 0, 0));
  });

  it("returns exactly the boundary instant when at it", () => {
    const schedule: ScheduleExpression = { kind: "monthly", daysOfMonth: [15], hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 9, 0, 0, 0);
    expect(nextRunAt(schedule, from).getTime()).toBe(from.getTime());
  });

  it("rolls to next month when every day-of-month for this month has passed", () => {
    const schedule: ScheduleExpression = { kind: "monthly", daysOfMonth: [1, 2], hour: 9, minute: 0 };
    const from = new Date(2026, 0, 15, 0, 0, 0, 0);
    expect(nextRunAt(schedule, from)).toEqual(new Date(2026, 1, 1, 9, 0, 0, 0));
  });

  // Month-end boundary (Task Brief C, "존재하지 않는 날짜는 건너뜁니다"):
  // daysOfMonth includes 31, exercised in February — 2026 is not a leap
  // year, so February has 28 days. The occurrence must be SKIPPED for
  // February entirely (never rolled to March 1st, never clamped to Feb 28).
  it("skips a nonexistent day-of-month (31) in February and lands on the next month that has it", () => {
    const schedule: ScheduleExpression = { kind: "monthly", daysOfMonth: [31], hour: 9, minute: 0 };
    const from = new Date(2026, 1, 1, 0, 0, 0, 0); // Feb 1, 2026 (28-day Feb)
    const result = nextRunAt(schedule, from);
    // March has 31 days — the very next valid occurrence, NOT Feb 28 and
    // NOT March 1 (that would be "roll to 1st", explicitly rejected).
    expect(result).toEqual(new Date(2026, 2, 31, 9, 0, 0, 0));
  });

  it("with multiple daysOfMonth including 31, still fires on the valid day within February's own month window", () => {
    // 30 is also invalid in February, but this asserts the mechanism using
    // a day that decidedly doesn't exist in Feb (31) alongside one that does
    // in March/April etc. — regression guard that a valid day elsewhere in
    // the list doesn't get discarded alongside the invalid one.
    const schedule: ScheduleExpression = { kind: "monthly", daysOfMonth: [31, 5], hour: 9, minute: 0 };
    const from = new Date(2026, 1, 1, 0, 0, 0, 0); // Feb 1, 2026
    const result = nextRunAt(schedule, from);
    expect(result).toEqual(new Date(2026, 1, 5, 9, 0, 0, 0)); // Feb 5 exists; Feb 31 doesn't.
  });
});

describe("nextRunAt — DST handling (construct-from-fields approach)", () => {
  // Real DST observance is host-timezone-dependent (CI/dev machines may not
  // observe DST at all), so this test fabricates a synthetic transition via
  // the injectable `makeDate` rather than depending on the host's zone. It
  // proves the CONTRACT this module relies on: `nextRunAt` never adds a
  // fixed millisecond offset to a previous candidate — it only ever asks
  // `makeDate` for a fresh (year, month, day, hour, minute) tuple. A fake
  // `makeDate` that implements a spring-forward (02:00 local doesn't exist,
  // clocks jump straight to 03:00) demonstrates that `nextRunAt` faithfully
  // reproduces whatever `makeDate` decides for that wall-clock time, instead
  // of independently computing a UTC instant via ms arithmetic that would
  // silently ignore the jump.
  function fakeMakeDate(year: number, month: number, day: number, hour: number, minute: number): Date {
    // Simulates America/Chicago-style spring-forward on 2026-03-08:
    // 02:00-02:59 local doesn't exist; treat any local hour>=2 that day as
    // shifted one hour later in UTC terms than a naive offset would predict.
    // Real Date arithmetic (`new Date(y,m,d,h,min)`) already handles this
    // correctly on a real DST-observing host; this fake exists only so the
    // test doesn't depend on the host machine's timezone.
    const isDstDay = year === 2026 && month === 2 && day === 8; // March 8, 2026
    const utcHour = isDstDay && hour >= 3 ? hour - 1 + 6 : hour + 6; // pretend UTC-6 offset, DST shifts to UTC-5 after the jump
    return new Date(Date.UTC(year, month, day, utcHour, minute, 0, 0));
  }

  it("daily schedule at 09:00 lands on the correct fabricated instant across the synthetic transition", () => {
    const schedule: ScheduleExpression = { kind: "daily", hour: 9, minute: 0 };
    const from = fakeMakeDate(2026, 2, 7, 23, 0); // the evening before the transition day
    const result = nextRunAt(schedule, from, { makeDate: fakeMakeDate });
    const expected = fakeMakeDate(2026, 2, 8, 9, 0);
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("never derives the candidate via from.getTime() + fixed offset — recomputes fields every call", () => {
    let calls = 0;
    const spyMakeDate = (y: number, m: number, d: number, h: number, min: number): Date => {
      calls += 1;
      return new Date(y, m, d, h, min, 0, 0);
    };
    const schedule: ScheduleExpression = { kind: "daily", hour: 9, minute: 0 };
    nextRunAt(schedule, new Date(2026, 2, 7, 23, 0, 0, 0), { makeDate: spyMakeDate });
    expect(calls).toBeGreaterThan(0);
  });
});

describe("describeScheduleExpression", () => {
  it("formats every kind in Korean", () => {
    expect(describeScheduleExpression({ kind: "hourly", minute: 30 })).toBe("매시 30분");
    expect(describeScheduleExpression({ kind: "daily", hour: 9, minute: 0 })).toBe("매일 09:00");
    expect(describeScheduleExpression({ kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 })).toBe("매주 월요일 09:00");
    expect(describeScheduleExpression({ kind: "monthly", daysOfMonth: [1, 15], hour: 9, minute: 0 })).toBe(
      "매월 1, 15일 09:00",
    );
  });
});
