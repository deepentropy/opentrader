/*
 * Spanish, German and Japanese (#292, #293, #294): their numbers, dates, durations, price fields and the words given
 * a sense.
 */
import { afterEach, describe, expect, it } from "vitest";
import de from "../de.json";
import es from "../es.json";
import ja from "../ja.json";
import { formatChartTime, formatTickMark } from "../../window/chart/time-format";
import { chartPriceFormat } from "../../window/chart/price-format";
import { fmtChange, fmtPercent, fmtVolume, formatLast } from "../../window/right-rail/watchlist/format";
import { volumeFormat } from "../../data/volume-format";
import { parseAmountText } from "../../data/study-format";
import { quarterLabel } from "../../window/strategy-tester/report-chart-kit";
import { parsePositive } from "../../window/trading/format";
import { monthLabel } from "../../window/bottom-bar/GoToDateDialog";
import {
  calendarWeekdays,
  durationText,
  englishNumber,
  leftNumber,
  localNumber,
  monthName,
  numberText,
  quarterText,
  shownNumber,
  typedNumber,
} from "../format";
import { languageEntry } from "../languages";
import { setDictionary, translate, translateAs, type Dictionary } from "../translator";

const NNBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0xa0);
const MINUS = String.fromCharCode(0x2212);

const as = (id: string, d: Dictionary = {}) => {
  const l = languageEntry(id)!;
  setDictionary(d, [], l.pluralLocale, l.formats);
};
afterEach(() => setDictionary({}));

// Fri 18 Sep 2026; Mon 9 Nov 2026 13:30 UTC; 14 Jul 2026.
const FRI = Date.UTC(2026, 8, 18) / 1000;
const MON = Date.UTC(2026, 10, 9, 13, 30) / 1000;
const JUL = Date.UTC(2026, 6, 14) / 1000;
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function numbers() {
  const price = chartPriceFormat("2 decimals", null)!.format;
  return {
    price: [price(1234567.891), price(-1234.5), price(0.5)],
    abbreviated: chartPriceFormat(undefined, null, true)!.format(159_040_000),
    volume: [volumeFormat(999), volumeFormat(1234), volumeFormat(103_470_000), volumeFormat(-45_600)].map(localNumber),
    watchlist: [formatLast(1641.6), fmtChange(-3.04), fmtPercent(5.81), fmtVolume(11_950_000)],
    number: [numberText(1250.5), numberText(1234567.891)],
  };
}

function dates() {
  return {
    day: formatChartTime(FRI, "UTC", false, false),
    dayOnly: formatChartTime(FRI, "UTC", false, false, { dayOfWeek: false }),
    intraday: formatChartTime(MON, "UTC", true, false),
    tick: formatTickMark(JUL, "Month", "UTC"),
    months: [monthName(3), monthName(5), monthName(9), monthName(10)],
    calendar: monthLabel(2026, 6),
    week: calendarWeekdays(WEEK),
    quarter: [quarterText(3), quarterLabel(Date.UTC(2026, 7, 1)), formatChartTime(FRI, "UTC", false, false, { dateFormat: "Q3 '97", dayOfWeek: false })],
  };
}

describe("German formats (#294)", () => {
  it("numbers: dot groups, decimal comma, true minus, the unit letters kept after a narrow space", () => {
    as("de");
    expect(numbers()).toEqual({
      price: ["1.234.567,89", `${MINUS}1.234,50`, "0,50"],
      abbreviated: `159,04${NNBSP}M`,
      volume: ["999", `1,23${NNBSP}K`, `103,47${NNBSP}M`, `${MINUS}45,6${NNBSP}K`],
      watchlist: ["1.641,60", `${MINUS}3,04`, "5,81%", `11,95${NNBSP}M`],
      number: ["1.250,5", "1.234.567,891"],
    });
    expect(localNumber("+5.81%")).toBe("+5,81%");
    expect(englishNumber(`${MINUS}1.234,50`)).toBe(`${MINUS}1234.50`);
  });

  it("dates: German months and two-letter weekdays, the calendar's dotted heads", () => {
    as("de");
    expect(dates()).toEqual({
      day: "Fr 18 Sep '26",
      dayOnly: "18 Sep '26",
      intraday: "Mo 09 Nov '26   13:30",
      tick: "Jul",
      months: ["Mrz", "Mai", "Sep", "Okt"],
      calendar: "Juli 2026",
      week: ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."],
      quarter: ["Q3", "Q3 '26", "Q3 '26"],
    });
  });

  it("durations", () => {
    as("de", de as Dictionary);
    expect(durationText(2 * 3600 + 16 * 60)).toBe("2 Stunden und 16 Minuten");
    expect(durationText(3600 + 60)).toBe("1 Stunde und 1 Minute");
    expect(durationText(26 * 3600)).toBe("1 Tag und 2 Stunden");
    expect(durationText(30)).toBe("weniger als 1 Minute");
  });

  it("words with two senses; percents written as the numbers are", () => {
    as("de", de as Dictionary);
    expect(translate("Trade")).toBe("Handeln");
    expect(translateAs("Trade", "economy")).toBe("Handel");
    expect(translateAs("Update", "post")).toBe("Aktualisierung");
    expect(translate("Mid")).toBe("Mittel");
    expect(translateAs("Mid", "profile")).toBe("Mitte");
    expect(translateAs("O", "legend")).toBe("O");
    // "5%", not "5 %" ("{0} {1} % price" keeps the English text's space).
    const spaced = new RegExp(`\\d[ ${NBSP}${NNBSP}]%`);
    expect(Object.values(de).filter((v) => typeof v === "string" && spaced.test(v))).toEqual([]);
  });
});

describe("Spanish formats (#292)", () => {
  it("numbers as German, grouped from four digits", () => {
    as("es");
    expect(numbers()).toEqual({
      price: ["1.234.567,89", `${MINUS}1.234,50`, "0,50"],
      abbreviated: `159,04${NNBSP}M`,
      volume: ["999", `1,23${NNBSP}K`, `103,47${NNBSP}M`, `${MINUS}45,6${NNBSP}K`],
      watchlist: ["1.641,60", `${MINUS}3,04`, "5,81%", `11,95${NNBSP}M`],
      number: ["1.250,5", "1.234.567,891"],
    });
  });

  it("dates: lower-case weekdays, capitalised months, May whole, quarters with T", () => {
    as("es");
    expect(dates()).toEqual({
      day: "vie 18 Sep '26",
      dayOnly: "18 Sep '26",
      intraday: "lun 09 Nov '26   13:30",
      tick: "Jul",
      months: ["Mar", "Mayo", "Sep", "Oct"],
      calendar: "Julio 2026",
      week: ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"],
      quarter: ["T3", "T3 '26", "T3 '26"],
    });
  });

  it("durations and senses", () => {
    as("es", es as Dictionary);
    expect(durationText(2 * 3600 + 16 * 60)).toBe("2 horas y 16 minutos");
    expect(durationText(3600 + 60)).toBe("1 hora y 1 minuto");
    expect(durationText(30)).toBe("menos de 1 minuto");
    expect(translate("Trade")).toBe("Operar");
    expect(translateAs("Trade", "economy")).toBe("Comercio");
    expect(translateAs("Mid", "profile")).toBe("Medio");
  });
});

describe("price fields in German and Spanish (#292, #294)", () => {
  it("one mark, comma or dot, is the decimal sign; with both, the last one", () => {
    for (const id of ["de", "es"]) {
      as(id);
      expect(typedNumber("588,5")).toBe("588.5");
      // Not 5885: a dot typed alone is a decimal point.
      expect(typedNumber("588.5")).toBe("588.5");
      expect(typedNumber("1.234,56")).toBe("1234.56");
      expect(typedNumber("1,234.56")).toBe("1234.56");
      expect(typedNumber("1.234.567")).toBe("1234567");
      expect(typedNumber(`1${NNBSP}234,5`)).toBe("1234.5");
      expect(parsePositive("588.5")).toBe(588.5);
      expect(parsePositive("588,5")).toBe(588.5);
      expect(parsePositive("1.234,56")).toBe(1234.56);
      expect(parseAmountText("5,37 K")).toBe(5370);
      expect(leftNumber("588,5")).toBe("588.5");
      expect(leftNumber("1.234,5")).toBe("1234.5");
      expect(parsePositive(leftNumber("1234"))).toBe(1234);
      expect(shownNumber("1234.5")).toBe("1234,5");
      expect(shownNumber("1,234.5")).toBe("1.234,5");
      // A field of whole amounts shown grouped ("100.000"): groups of three are groups.
      expect(typedNumber("100.000", true)).toBe("100000");
      expect(typedNumber("100.5", true)).toBe("100.5");
    }
  });
});

describe("Japanese formats (#293)", () => {
  it("numbers as English", () => {
    as("ja");
    expect(numbers()).toEqual({
      price: ["1,234,567.89", `${MINUS}1,234.50`, "0.50"],
      abbreviated: "159.04 M",
      volume: ["999", `1.23${NNBSP}K`, `103.47${NNBSP}M`, `${MINUS}45.6${NNBSP}K`],
      watchlist: ["1,641.60", `${MINUS}3.04`, "5.81%", "11.95 M"],
      number: ["1,250.5", "1,234,567.891"],
    });
    // Typed as in English: "," groups.
    expect(typedNumber("588,5")).toBe("588,5");
    expect(parsePositive("1,234.5")).toBe(1234.5);
  });

  it("dates: the day in ISO form with the weekday in brackets, months by number, the calendar's month first", () => {
    as("ja");
    expect(dates()).toEqual({
      day: "2026-09-18 (金)",
      dayOnly: "2026-09-18",
      intraday: "2026-11-09 (月)   13:30",
      tick: "7月",
      months: ["3月", "5月", "9月", "10月"],
      calendar: "7月 2026",
      week: ["月", "火", "水", "木", "金", "土", "日"],
      quarter: ["Q3", "Q3 '26", "Q3 '26"],
    });
  });

  it("durations run together, days and hours joined; the legend's letters as words", () => {
    as("ja", ja as Dictionary);
    expect(durationText(2 * 3600 + 16 * 60)).toBe("2時間16分");
    expect(durationText(27 * 3600)).toBe("1日と3時間");
    expect(durationText(5 * 60)).toBe("5分");
    expect(durationText(30)).toBe("1分未満");
    expect(["O", "H", "L", "C"].map((l) => translateAs(l, "legend"))).toEqual(["始値", "高値", "安値", "終値"]);
    expect(translateAs("Trade", "economy")).toBe("貿易");
    expect(translateAs("Mid", "profile")).toBe("中央");
  });
});
