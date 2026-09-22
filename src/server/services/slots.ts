// Pure logic, no database. Keep the time maths in pure functions (input in,
// output out, no side effects) — pure functions are the easiest code in the
// world to test.

export const CLINIC = {
  timeZone: "Asia/Karachi",
  utcOffsetMinutes: 300, // UTC+5, no daylight saving in Pakistan
  openHour: 9,
  closeHour: 17,
  stepMinutes: 30,
} as const;

export type Interval = { start: Date; end: Date };

const MIN = 60_000;

/** "2026-10-02" (clinic local) -> the UTC instants where that local day starts and ends. */
export function localDayBounds(date: string): Interval {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date: ${date}`);
  const start = new Date(Date.UTC(y, m - 1, d) - CLINIC.utcOffsetMinutes * MIN);
  return { start, end: new Date(start.getTime() + 24 * 60 * MIN) };
}

/** A UTC instant -> "YYYY-MM-DD" in clinic local time. */
export function localDateString(instant: Date): string {
  return new Date(instant.getTime() + CLINIC.utcOffsetMinutes * MIN).toISOString().slice(0, 10);
}

export function formatLocal(instant: Date): string {
  return new Intl.DateTimeFormat("en-PK", {
    timeZone: CLINIC.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

export function computeFreeSlots(opts: {
  date: string;
  durationMinutes: number;
  busy: Interval[];
  now: Date;
}): Date[] {
  const { start: dayStart } = localDayBounds(opts.date);
  const slots: Date[] = [];

  for (
    let minute = CLINIC.openHour * 60;
    // A slot only counts if the service finishes at or before closing time,
    // so a duration that doesn't divide the day evenly (e.g. 90 minutes)
    // never produces a slot that would run past closeHour.
    minute + opts.durationMinutes <= CLINIC.closeHour * 60;
    minute += CLINIC.stepMinutes
  ) {
    const start = new Date(dayStart.getTime() + minute * MIN);
    const end = new Date(start.getTime() + opts.durationMinutes * MIN);
    if (start.getTime() <= opts.now.getTime()) continue;
    // Two intervals overlap when each starts before the other ends.
    const overlaps = opts.busy.some((b) => start < b.end && b.start < end);
    if (!overlaps) slots.push(start);
  }

  return slots;
}
