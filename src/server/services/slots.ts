// Pure logic, no database. Keep the time maths in pure functions (input in,
// output out, no side effects) — pure functions are the easiest code in the
// world to test.
//
// Timezone rule: the DB stores UTC instants. "Clinic local" (Asia/Karachi,
// UTC+5) only exists at the edges: turning "2026-10-02" into UTC bounds, and
// formatting a UTC instant for humans. Every time conversion goes through here.

// `as const` freezes the literal types: `openHour` is typed `9`, not `number`,
// `timeZone` is `"Asia/Karachi"`, not `string`, and every field is readonly.
export const CLINIC = {
  timeZone: "Asia/Karachi",
  utcOffsetMinutes: 300, // UTC+5, no daylight saving in Pakistan
  openHour: 9,
  closeHour: 17,
  stepMinutes: 30,
} as const;

// A `type` alias for an object shape (an `interface` would work too).
export type Interval = { start: Date; end: Date };

const MIN = 60_000; // ms in one minute

/** "2026-10-02" (clinic local) -> the UTC instants where that local day starts and ends. */
export function localDayBounds(date: string): Interval {
  // Array destructuring + `.map(Number)` (passing a function as a value).
  // Each of y/m/d is `number | undefined` because of noUncheckedIndexedAccess.
  const [y, m, d] = date.split("-").map(Number);
  // Narrowing guard (also rejects 0 / NaN). Template literal `${...}` builds the message.
  if (!y || !m || !d) throw new Error(`Invalid date: ${date}`);
  // Date.UTC months are 0-based, hence m - 1. Local midnight = UTC midnight minus 5h.
  const start = new Date(Date.UTC(y, m - 1, d) - CLINIC.utcOffsetMinutes * MIN);
  return { start, end: new Date(start.getTime() + 24 * 60 * MIN) };
}

/** A UTC instant -> "YYYY-MM-DD" in clinic local time. (Shift by +5h, then read the UTC date.) */
export function localDateString(instant: Date): string {
  return new Date(instant.getTime() + CLINIC.utcOffsetMinutes * MIN).toISOString().slice(0, 10);
}

/** A UTC instant -> short human label (weekday, day, month, time) in clinic time. Used by the MCP tools. */
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

/**
 * PURE FUNCTION: the slot grid for one day minus anything overlapping `busy`
 * and anything not after `now`. `now` is a parameter (not `new Date()` inside)
 * so tests can pin the clock. Called with `busy: []` by bookAppointment to
 * check a requested time is on the grid.
 * `opts: {...}` = a single "options object" param, so call sites read like named arguments.
 */
export function computeFreeSlots(opts: {
  date: string;
  durationMinutes: number;
  busy: Interval[];
  now: Date;
}): Date[] {
  // Destructuring with rename: take `start` from the result, call it `dayStart`.
  const { start: dayStart } = localDayBounds(opts.date);
  // `const` means the binding can't be reassigned; the array can still be pushed to.
  const slots: Date[] = [];

  for (
    // `let`, not `const`: this variable is reassigned on every loop step.
    let minute = CLINIC.openHour * 60;
    // A slot only counts if the service finishes at or before closing time,
    // so a duration that doesn't divide the day evenly (e.g. 90 minutes)
    // never produces a slot that would run past closeHour.
    minute + opts.durationMinutes <= CLINIC.closeHour * 60;
    minute += CLINIC.stepMinutes
  ) {
    const start = new Date(dayStart.getTime() + minute * MIN);
    const end = new Date(start.getTime() + opts.durationMinutes * MIN);
    if (start.getTime() <= opts.now.getTime()) continue; // skip past slots
    // Two intervals overlap when each starts before the other ends.
    // (`<` on Dates compares their timestamps. `.some` = "does ANY element match?")
    const overlaps = opts.busy.some((b) => start < b.end && b.start < end);
    if (!overlaps) slots.push(start);
  }

  return slots;
}
