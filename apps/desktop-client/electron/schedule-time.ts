// D14 "등록된 에이전트를 스케줄에 따라 수행" — pure schedule-expression time
// math. Zero fs/node/electron imports (this app's CLAUDE.md 코드 배치 규칙의
// "순수 함수/타입" 모듈 분류) so the renderer can import it directly for a
// live "다음 실행" display, and tests can exercise it without touching disk.
//
// Timezone: the machine's LOCAL timezone via native JS `Date` — no timezone
// library dependency (PoC 범위, per repo convention). This is a deliberate,
// documented decision, not a silent UTC assumption: every field below
// (hour/minute/dayOfWeek/daysOfMonth) is interpreted as wall-clock local
// time, exactly what a user typing "매일 오전 9시" means on their own machine.
//
// DST: candidates are always constructed from calendar FIELDS
// (`makeDate(y, m, d, h, min)`, which defaults to `new Date(y, m, d, h, min)`)
// rather than by adding a fixed millisecond offset to a previous candidate.
// `new Date(y, m, d, h, min)` is local-time-based and DST-aware — if 09:00
// local time is unambiguous on the target date, this always returns the
// correct wall-clock instant regardless of how many DST transitions lie
// between `from` and the candidate. Never rewrite this to
// `new Date(prev.getTime() + N)` — that reintroduces the off-by-one-hour bug
// this comment exists to prevent. `makeDate` is injectable so tests can
// fabricate a synthetic DST boundary without depending on the host machine's
// timezone actually observing DST (see schedule-time.test.ts).
//
// Month-end (예: "31일"): if a `daysOfMonth` entry doesn't exist in a given
// month (e.g. 31 in February), that occurrence is SKIPPED for that month —
// never rolled over to the 1st of the next month, never clamped to the
// month's last day. `new Date(y, m, 31)` for a 28-day February silently
// rolls forward to March 3rd; `candidate.getMonth() !== m` below detects
// exactly that rollover and discards the candidate instead of accepting it.

export interface ScheduleHourly {
  kind: "hourly";
  /** 0-59. */
  minute: number;
}

export interface ScheduleDaily {
  kind: "daily";
  /** 0-23. */
  hour: number;
  /** 0-59. */
  minute: number;
}

export interface ScheduleWeekly {
  kind: "weekly";
  /** JS `Date#getDay()` convention: 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  hour: number;
  minute: number;
}

export interface ScheduleMonthly {
  kind: "monthly";
  /** 1-31, can list several days. A day that doesn't exist in a given month
   * (e.g. 31 in April) is skipped for that month only — see module docstring. */
  daysOfMonth: number[];
  hour: number;
  minute: number;
}

export type ScheduleExpression = ScheduleHourly | ScheduleDaily | ScheduleWeekly | ScheduleMonthly;

export interface NextRunAtOptions {
  /** Test-only override — production call sites never pass this. */
  makeDate?: (year: number, month: number, day: number, hour: number, minute: number) => Date;
}

function defaultMakeDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month, day, hour, minute, 0, 0);
}

const MONTHLY_SEARCH_WINDOW_MONTHS = 25;

/** Next occurrence at-or-after `from` (inclusive — a candidate exactly equal
 * to `from` counts as due, matching how the scheduler loop calls this: once
 * a schedule fires, it immediately recomputes from the execution instant,
 * and that instant itself must not be considered "already passed"). Never
 * throws for a structurally valid `daysOfMonth` (guaranteed to find a match
 * within `MONTHLY_SEARCH_WINDOW_MONTHS`, since every month has at least one
 * day between 1 and 28).
 */
export function nextRunAt(schedule: ScheduleExpression, from: Date, options: NextRunAtOptions = {}): Date {
  const makeDate = options.makeDate ?? defaultMakeDate;

  switch (schedule.kind) {
    case "hourly": {
      let candidate = makeDate(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), schedule.minute);
      if (candidate.getTime() < from.getTime()) {
        candidate = makeDate(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours() + 1, schedule.minute);
      }
      return candidate;
    }

    case "daily": {
      let candidate = makeDate(from.getFullYear(), from.getMonth(), from.getDate(), schedule.hour, schedule.minute);
      if (candidate.getTime() < from.getTime()) {
        candidate = makeDate(from.getFullYear(), from.getMonth(), from.getDate() + 1, schedule.hour, schedule.minute);
      }
      return candidate;
    }

    case "weekly": {
      // offset 0..7 (inclusive) — offset 7 revisits the same weekday one
      // week later, guaranteeing a match even when today is the target
      // weekday but its time-of-day has already passed.
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = makeDate(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + offset,
          schedule.hour,
          schedule.minute,
        );
        if (candidate.getDay() === schedule.dayOfWeek && candidate.getTime() >= from.getTime()) {
          return candidate;
        }
      }
      throw new Error(`유효하지 않은 dayOfWeek입니다: ${schedule.dayOfWeek}`);
    }

    case "monthly": {
      const days = [...schedule.daysOfMonth].sort((a, b) => a - b);
      let year = from.getFullYear();
      let month = from.getMonth();
      for (let monthOffset = 0; monthOffset < MONTHLY_SEARCH_WINDOW_MONTHS; monthOffset += 1) {
        const candidatesThisMonth: Date[] = [];
        for (const day of days) {
          const candidate = makeDate(year, month, day, schedule.hour, schedule.minute);
          // Month-end skip: if `day` doesn't exist in this month, JS Date
          // rolls the candidate into the next month — detect that and
          // discard rather than accepting the rolled-over date.
          if (candidate.getMonth() !== month || candidate.getFullYear() !== year) continue;
          if (candidate.getTime() >= from.getTime()) candidatesThisMonth.push(candidate);
        }
        if (candidatesThisMonth.length > 0) {
          candidatesThisMonth.sort((a, b) => a.getTime() - b.getTime());
          return candidatesThisMonth[0];
        }
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
      }
      throw new Error("daysOfMonth에 대해 유효한 다음 실행 시각을 찾지 못했습니다.");
    }

    default: {
      const exhaustive: never = schedule;
      throw new Error(`알 수 없는 스케줄 종류입니다: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Human-readable summary for the schedule list screen — e.g. "매주 월요일
 * 09:00", "매시 30분". Pure formatting, no i18n layer in this PoC. */
const WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function describeScheduleExpression(schedule: ScheduleExpression): string {
  switch (schedule.kind) {
    case "hourly":
      return `매시 ${pad2(schedule.minute)}분`;
    case "daily":
      return `매일 ${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
    case "weekly":
      return `매주 ${WEEKDAY_LABELS_KO[schedule.dayOfWeek] ?? "?"}요일 ${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
    case "monthly": {
      const days = [...schedule.daysOfMonth].sort((a, b) => a - b).join(", ");
      return `매월 ${days}일 ${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
    }
    default:
      return "알 수 없는 스케줄";
  }
}
