/*
 * French (#291): its numbers, dates and price fields, and the English output they leave as it was.
 */
import { afterEach, describe, expect, it } from "vitest";
import fr from "../fr.json";
import { formatChartTime, formatTickMark } from "../../window/chart/time-format";
import { chartNumberOptions, chartPriceFormat, studyScaleFormat } from "../../window/chart/price-format";
import { fmtChange, fmtPercent, fmtVolume, formatLast } from "../../window/right-rail/watchlist/format";
import { valueText } from "../../data/screener-format";
import { volumeFormat } from "../../data/volume-format";
import { parseAmountText, stepAmountText } from "../../data/study-format";
import { compact, money } from "../../window/strategy-tester/format";
import { parsePositive } from "../../window/trading/format";
import {
  calendarWeekdays,
  dateText,
  durationText,
  englishNumber,
  leftNumber,
  localNumber,
  monthName,
  numberText,
  shownNumber,
  typedNumber,
} from "../format";
import { languageEntry } from "../languages";
import { setDictionary, translateAs, type Dictionary } from "../translator";

const NNBSP = " ";
const MINUS = "−";

const as = (id: string, d: Dictionary = {}) => {
  const l = languageEntry(id)!;
  setDictionary(d, [], l.pluralLocale, l.formats);
};
afterEach(() => setDictionary({}));

// Fri 18 Sep 2026; Mon 9 Nov 2026 13:30 UTC.
const FRI = Date.UTC(2026, 8, 18) / 1000;
const MON = Date.UTC(2026, 10, 9, 13, 30) / 1000;
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** The outputs pinned in English and checked in French. */
function outputs() {
  const price = chartPriceFormat("2 decimals", null)!.format;
  return {
    price: [price(1234567.891), price(-1234.5), price(0.5)],
    abbreviated: chartPriceFormat(undefined, null, true)!.format(159_040_000),
    volume: [volumeFormat(999), volumeFormat(1234), volumeFormat(103_470_000), volumeFormat(-45_600)],
    watchlist: [formatLast(1641.6), fmtChange(-3.04), fmtPercent(5.81), fmtVolume(11_950_000)],
    screener: [valueText("percent", -0.3), valueText("volume", 500_000)],
    tester: [compact(36683.12), money(-1234.5)],
    number: numberText(1250.5),
    dates: [formatChartTime(FRI, "UTC", false, false), formatChartTime(MON, "UTC", true, false), formatTickMark(Date.UTC(2026, 6, 14) / 1000, "Month", "UTC")],
    month: monthName(7),
    long: dateText(Date.UTC(2026, 10, 1), { month: "long", year: "numeric", timeZone: "UTC" }),
    week: calendarWeekdays(WEEK),
  };
}

describe("English keeps its formats (#291)", () => {
  it("prices, volumes, percents and dates", () => {
    expect(outputs()).toEqual({
      price: ["1,234,567.89", `${MINUS}1,234.50`, "0.50"],
      abbreviated: "159.04 M",
      volume: ["999", `1.23${NNBSP}K`, `103.47${NNBSP}M`, `${MINUS}45.6${NNBSP}K`],
      watchlist: ["1,641.60", `${MINUS}3.04`, "5.81%", "11.95 M"],
      screener: [`${MINUS}0.3%`, `500${NNBSP}K`],
      tester: [`36.68${NNBSP}K`, `${MINUS}1,234.50`],
      number: "1,250.5",
      dates: ["Fri 18 Sep '26", "Mon 09 Nov '26   13:30", "Jul"],
      month: "Jul",
      long: "November 2026",
      week: WEEK,
    });
    expect(studyScaleFormat("price", 2)).toBeNull();
    expect(chartNumberOptions()).toEqual({});
  });

  it("price fields read and show their text as before", () => {
    for (const t of ["1,234.5", "1234,5", "abc"]) {
      expect(typedNumber(t)).toBe(t);
      expect(shownNumber(t)).toBe(t);
      expect(leftNumber(t)).toBe(t);
      expect(localNumber(t)).toBe(t);
      expect(englishNumber(t)).toBe(t);
    }
    expect(parsePositive("1,234.5")).toBe(1234.5);
    expect(parseAmountText("5.37 K")).toBe(5370);
    expect(stepAmountText("1.25", 1)).toBe("1.26");
  });

  it("Chinese writes its numbers as English does", () => {
    as("zh-Hans");
    expect(outputs().price).toEqual(["1,234,567.89", `${MINUS}1,234.50`, "0.50"]);
    expect(localNumber("103.47 M")).toBe("103.47 M");
  });
});

describe("French formats (#291)", () => {
  it("numbers: decimal comma, narrow no-break spaces, the unit letters kept", () => {
    as("fr");
    const o = outputs();
    expect(o.price).toEqual([`1${NNBSP}234${NNBSP}567,89`, `${MINUS}1${NNBSP}234,50`, "0,50"]);
    expect(o.abbreviated).toBe(`159,04${NNBSP}M`);
    // The volume formatter writes English; its callers show it in the language's marks.
    expect(o.volume.map(localNumber)).toEqual(["999", `1,23${NNBSP}K`, `103,47${NNBSP}M`, `${MINUS}45,6${NNBSP}K`]);
    expect(o.watchlist).toEqual([`1${NNBSP}641,60`, `${MINUS}3,04`, "5,81%", `11,95${NNBSP}M`]);
    expect(o.screener).toEqual([`${MINUS}0,3%`, `500${NNBSP}K`]);
    expect(o.tester).toEqual([`36,68${NNBSP}K`, `${MINUS}1${NNBSP}234,50`]);
    expect(o.number).toBe(`1${NNBSP}250,5`);
    expect(localNumber("+1,234.50%")).toBe(`+1${NNBSP}234,50%`);
    expect(localNumber("123'16")).toBe("123'16");
    expect(englishNumber(`${MINUS}1${NNBSP}234,50`)).toBe(`${MINUS}1234.50`);
  });

  it("the chart's study and percentage scales", () => {
    as("fr");
    expect(studyScaleFormat("price", 2)!.formatter(-1234.5)).toBe(`${MINUS}1${NNBSP}234,50`);
    expect(studyScaleFormat("volume", 2)!.formatter(1_500_000)).toBe(`1,5${NNBSP}M`);
    expect(studyScaleFormat("percent", 2)!.formatter(12.5)).toBe("12,50%");
    expect(studyScaleFormat("price", 2)).toBe(studyScaleFormat("price", 2));
    expect(chartNumberOptions().percentageFormatter!(-0.3)).toBe(`${MINUS}0,30%`);
  });

  it("dates: capitalised short months, French weekdays, Monday-first calendar heads", () => {
    as("fr");
    const o = outputs();
    expect(o.dates).toEqual(["ven. 18 Sept '26", "lun. 09 Nov '26   13:30", "Juill"]);
    expect(o.month).toBe("Juill");
    expect(o.long).toBe("novembre 2026");
    expect(o.week).toEqual(["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"]);
  });

  it("durations and counted texts", () => {
    as("fr", fr as Dictionary);
    expect(durationText(2 * 3600 + 28 * 60)).toBe("2 heures et 28 minutes");
    expect(durationText(26 * 3600)).toBe("1 jour et 2 heures");
    expect(durationText(30)).toBe("moins d'1 minute");
    expect(translateAs("High", "chart")).toBe("High");
  });

  it("price fields take a comma or a dot and keep English marks once left", () => {
    as("fr");
    expect(typedNumber(`1${NNBSP}234,56`)).toBe("1234.56");
    expect(typedNumber("1234.56")).toBe("1234.56");
    expect(typedNumber("1,234.56")).toBe("1,234.56");
    expect(leftNumber("1234,5")).toBe("1,234.5");
    expect(leftNumber("1 234,5")).toBe("1,234.5");
    expect(leftNumber("abc")).toBe("abc");
    expect(shownNumber("1,234.5")).toBe(`1${NNBSP}234,5`);
    expect(shownNumber("1234,5")).toBe("1234,5");
    expect(parsePositive("1234,56")).toBe(1234.56);
    expect(parsePositive("1,234.56")).toBe(1234.56);
    expect(parseAmountText("5,37 K")).toBe(5370);
    expect(parseAmountText(`1${NNBSP}234,5`)).toBe(1234.5);
    expect(stepAmountText("1,25", 1)).toBe("1.26");
  });
});
