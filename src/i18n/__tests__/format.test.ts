import { afterEach, describe, expect, it } from "vitest";
import { formatChartTime, formatTickMark } from "../../window/chart/time-format";
import { dateText, durationText, largestUnitText, monthName, numberText } from "../format";
import { ENGLISH, languageEntry } from "../languages";
import { inEnglish, setDictionary } from "../translator";

const as = (id: string) => {
  const l = languageEntry(id)!;
  setDictionary({}, [], l.pluralLocale, l.formats);
};
afterEach(() => setDictionary({}));

// Mon 26 Oct 2026 14:30 UTC.
const SEC = Date.UTC(2026, 9, 26, 14, 30) / 1000;

describe("formats of the interface language (#288)", () => {
  it("English keeps the app's formats", () => {
    expect(formatChartTime(SEC, "UTC", true, false)).toBe("Mon 26 Oct '26   14:30");
    expect(formatChartTime(SEC, "UTC", false, false, { dayOfWeek: false })).toBe("26 Oct '26");
    expect(formatChartTime(SEC, "UTC", false, false, { dateFormat: "1997-09-29" })).toBe("Mon 2026-10-26");
    expect(formatTickMark(SEC, "Month", "UTC")).toBe("Oct");
    expect(dateText(Date.UTC(2003, 8, 10), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })).toBe("Sep 10, 2003");
    expect(dateText(Date.UTC(2026, 10, 1), { month: "long", year: "numeric", timeZone: "UTC" })).toBe("November 2026");
    expect(monthName(9)).toBe("Sep");
    expect(numberText(1250.5)).toBe("1,250.5");
    expect(durationText(26 * 3600)).toBe("1 day and 2 hours");
    expect(largestUnitText(412 * 86_400_000)).toBe("412 days");
    expect(largestUnitText(30_000)).toBe("< 1 minute");
  });

  it("Chinese writes its dates as the text rules did", () => {
    as("zh-Hans");
    expect(formatChartTime(SEC, "UTC", true, false)).toBe("2026年10月26日 周一   14:30");
    expect(formatChartTime(SEC, "UTC", false, false, { dayOfWeek: false })).toBe("2026年10月26日");
    expect(formatTickMark(SEC, "Month", "UTC")).toBe("10月");
    expect(dateText(Date.UTC(2003, 8, 10), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })).toBe("2003年9月10日");
    expect(dateText(Date.UTC(2026, 10, 1), { month: "long", year: "numeric", timeZone: "UTC" })).toBe("2026年11月");
    expect(numberText(1250.5)).toBe("1,250.5");
    as("zh-Hant");
    expect(formatChartTime(SEC + 86400, "UTC", false, false)).toBe("2026年10月27日 週二");
  });

  it("inEnglish formats in English", () => {
    as("zh-Hans");
    expect(inEnglish(() => formatTickMark(SEC, "Month", "UTC"))).toBe("Oct");
    expect(formatTickMark(SEC, "Month", "UTC")).toBe("10月");
  });

  it("each language has its formats and a direction", () => {
    expect(ENGLISH.direction).toBe("ltr");
    for (const id of ["zh-Hans", "zh-Hant"]) expect(languageEntry(id)?.direction).toBe("ltr");
  });
});
