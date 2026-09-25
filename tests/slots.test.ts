import { describe, expect, it } from "vitest";
import { computeFreeSlots } from "@/server/services/slots";

const now = new Date("2026-10-01T00:00:00Z"); // 05:00 in Karachi, the day before
const iso = (d: Date) => d.toISOString();

describe("computeFreeSlots", () => {
  it("offers 09:00-16:30 local (04:00-11:30 UTC) for a 30-min service on an empty day", () => {
    const slots = computeFreeSlots({ date: "2026-10-02", durationMinutes: 30, busy: [], now });
    expect(slots).toHaveLength(16);
    expect(iso(slots[0]!)).toBe("2026-10-02T04:00:00.000Z");
    expect(iso(slots.at(-1)!)).toBe("2026-10-02T11:30:00.000Z");
  });

  it("removes slots that overlap a booking, but allows back-to-back", () => {
    // Existing booking 10:00-11:00 local = 05:00-06:00 UTC
    const busy = [{ start: new Date("2026-10-02T05:00:00Z"), end: new Date("2026-10-02T06:00:00Z") }];
    const slots = computeFreeSlots({ date: "2026-10-02", durationMinutes: 60, busy, now }).map(iso);

    expect(slots).toContain("2026-10-02T04:00:00.000Z"); // 09:00-10:00 ends exactly at start: OK
    expect(slots).not.toContain("2026-10-02T04:30:00.000Z"); // 09:30-10:30 partial overlap
    expect(slots).not.toContain("2026-10-02T05:30:00.000Z"); // 10:30-11:30 partial overlap
    expect(slots).toContain("2026-10-02T06:00:00.000Z"); // 11:00-12:00 starts exactly at end: OK
  });

  it("never offers a slot in the past", () => {
    const midday = new Date("2026-10-02T07:00:00Z"); // 12:00 local
    const slots = computeFreeSlots({ date: "2026-10-02", durationMinutes: 30, busy: [], now: midday });
    expect(slots.every((s) => s > midday)).toBe(true);
    expect(iso(slots[0]!)).toBe("2026-10-02T07:30:00.000Z");
  });

  it("never offers a 90-min slot that would run past 17:00 local closing time", () => {
    // 90 doesn't divide the 8-hour (480-min) window evenly, so the last possible
    // start on the 30-min grid is 15:30 local, ending exactly at 17:00 local.
    // A slot starting at 16:00 local would end at 17:30 local and must be excluded.
    const slots = computeFreeSlots({ date: "2026-10-02", durationMinutes: 90, busy: [], now });
    expect(slots).toHaveLength(14);

    const last = slots.at(-1)!;
    expect(iso(last)).toBe("2026-10-02T10:30:00.000Z"); // 15:30 local
    const lastEnd = new Date(last.getTime() + 90 * 60_000);
    expect(iso(lastEnd)).toBe("2026-10-02T12:00:00.000Z"); // 17:00 local exactly, not later
  });
});
