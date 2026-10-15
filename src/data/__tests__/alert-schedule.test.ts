import { describe, expect, it } from "vitest";
import { formatDays, inSchedule, schedulePreset, scheduleTitle, segmentText } from "../alert-schedule";

const NY = "America/New_York";
/** Epoch ms of a New York wall time in October 2026 (EDT, UTC-4). */
const ny = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00-04:00`);

describe("alert notification schedule", () => {
  it("writes the days as the reference does", () => {
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe("Mo-Su");
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mo-Fr");
    expect(formatDays([1, 3])).toBe("Mo, We");
    expect(formatDays([1, 2, 4])).toBe("Mo, Tu, Th");
    expect(formatDays([6, 7, 1])).toBe("Sa-Mo");
    expect(formatDays([])).toBe("");
  });

  it("knows its presets and titles", () => {
    expect(schedulePreset(null)).toBe("24/7");
    expect(schedulePreset({ days: [1, 2, 3, 4, 5], from: "00:00", to: "00:00", timeZone: NY })).toBe("weekdays");
    expect(schedulePreset({ days: [5, 4, 3, 2, 1], from: "09:00", to: "18:00", timeZone: NY })).toBe("standard_working_hours");
    expect(scheduleTitle({ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timeZone: NY })).toBe("Standard working hours");
    expect(scheduleTitle({ days: [1, 2, 3], from: "10:00", to: "16:00", timeZone: NY })).toBe("Mo-We · 10:00–16:00");
    expect(segmentText({ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" })).toBe("Mo-Fr · 09:00–18:00");
  });

  it("is inside on its days and hours, in its time zone", () => {
    const work = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timeZone: NY };
    // Thursday 15/10/2026.
    expect(inSchedule(work, ny("2026-10-15", "09:00"))).toBe(true);
    expect(inSchedule(work, ny("2026-10-15", "17:59"))).toBe(true);
    expect(inSchedule(work, ny("2026-10-15", "18:00"))).toBe(false);
    expect(inSchedule(work, ny("2026-10-15", "08:59"))).toBe(false);
    // Saturday 17/10/2026.
    expect(inSchedule(work, ny("2026-10-17", "12:00"))).toBe(false);
    // All day on weekdays.
    expect(inSchedule({ ...work, from: "00:00", to: "00:00" }, ny("2026-10-15", "23:30"))).toBe(true);
    expect(inSchedule({ ...work, from: "00:00", to: "00:00" }, ny("2026-10-18", "10:00"))).toBe(false);
    // Unset: always.
    expect(inSchedule(null, ny("2026-10-18", "03:00"))).toBe(true);
  });

  it("a range ending before it starts runs past midnight", () => {
    const night = { days: [5], from: "22:00", to: "06:00", timeZone: NY };
    expect(inSchedule(night, ny("2026-10-16", "23:00"))).toBe(true); // Friday evening
    expect(inSchedule(night, ny("2026-10-17", "05:00"))).toBe(true); // Saturday morning after it
    expect(inSchedule(night, ny("2026-10-17", "07:00"))).toBe(false);
    expect(inSchedule(night, ny("2026-10-15", "23:00"))).toBe(false); // Thursday
  });
});
