import { describe, expect, it, vi } from "vitest";

vi.mock("../../../bindings", () => ({ commands: {} }));

import type { SymbolSession } from "../../../bindings";
import { SymbolSessions } from "../../../data/session/symbol-sessions";
import { localToUtc } from "../../../data/session/zone";
import { CountdownPrimitive, countdownText, type CountdownState } from "../countdown";

const NY = "America/New_York";
const dayNo = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;
const ny = (y: number, m: number, d: number, h: number, mi = 0, s = 0) => localToUtc(NY, dayNo(y, m, d), h * 60 + mi) + s;

function usStock(holidays = ""): SymbolSessions {
  const part = (id: string, session: string) => ({ id, description: id, session, corrections: "" });
  const info: SymbolSession = {
    timezone: NY,
    session: "0930-1600",
    subsessions: [part("regular", "0930-1600"), part("extended", "0400-2000"), part("premarket", "0400-0930"), part("postmarket", "1600-2000")],
    holidays,
    corrections: "",
    pricescale: 100,
    minmov: 1,
    variableTickSize: "",
  };
  return new SymbolSessions(info);
}
const S = usStock("20260403");

describe("countdownText — intraday", () => {
  it("null without sessions", () => {
    expect(countdownText("5", ny(2026, 1, 7, 10), undefined, "RTH", null)).toBeNull();
  });

  it("MM:SS under an hour, aligned on the last bar", () => {
    expect(countdownText("5", ny(2026, 1, 7, 10, 2, 30), ny(2026, 1, 7, 10, 0), "RTH", S)).toBe("02:30");
    // Wall-clock grid without a last bar.
    expect(countdownText("5", ny(2026, 1, 7, 10, 2, 30), undefined, "RTH", S)).toBe("02:30");
  });

  it("session-anchored hour bars (09:30 grid)", () => {
    expect(countdownText("60", ny(2026, 1, 7, 10, 2, 30), ny(2026, 1, 7, 9, 30), "RTH", S)).toBe("27:30");
  });

  it("H:MM:SS above an hour", () => {
    expect(countdownText("240", ny(2026, 1, 7, 10), ny(2026, 1, 7, 9, 30), "RTH", S)).toBe("3:30:00");
  });

  it("a bar never runs past the session close", () => {
    expect(countdownText("60", ny(2026, 1, 7, 15, 50), ny(2026, 1, 7, 15, 30), "RTH", S)).toBe("10:00");
  });

  it("seconds intervals", () => {
    expect(countdownText("10S", ny(2026, 1, 7, 10, 0, 3), undefined, "RTH", S)).toBe("00:07");
    expect(countdownText("10s", ny(2026, 1, 7, 10, 0, 3), undefined, "RTH", S)).toBe("00:07");
  });

  it("outside the chosen session: no countdown; extended hours count in ETH", () => {
    expect(countdownText("1", ny(2026, 1, 7, 8, 0, 15), undefined, "RTH", S)).toBeNull();
    expect(countdownText("1", ny(2026, 1, 7, 8, 0, 15), undefined, "ETH", S)).toBe("00:45");
    expect(countdownText("1", ny(2026, 1, 10, 12), undefined, "ETH", S)).toBeNull(); // Saturday
  });
});

describe("countdownText — daily and above", () => {
  it("1D counts to the regular close, whatever the session toggle", () => {
    expect(countdownText("1D", ny(2026, 1, 7, 10), undefined, "RTH", S)).toBe("6:00:00");
    expect(countdownText("1D", ny(2026, 1, 7, 15, 59, 30), undefined, "ETH", S)).toBe("00:30");
    expect(countdownText("1D", ny(2026, 1, 7, 8), undefined, "ETH", S)).toBeNull();
  });

  it("1W: whole days to the week's last trading day, the clock on that day", () => {
    expect(countdownText("1W", ny(2026, 1, 7, 10), undefined, "RTH", S)).toBe("2d"); // Wed -> Fri
    expect(countdownText("1W", ny(2026, 1, 9, 15), undefined, "RTH", S)).toBe("1:00:00"); // Friday
  });

  it("1W: a Friday holiday makes Thursday the last day", () => {
    // Good Friday 03/04/2026 is a holiday.
    expect(countdownText("1W", ny(2026, 4, 2, 10), undefined, "RTH", S)).toBe("6:00:00");
  });

  it("1M: calendar days to the month end, the clock on the last day", () => {
    expect(countdownText("1M", ny(2026, 1, 7, 10), undefined, "RTH", S)).toBe("24d");
    expect(countdownText("1M", ny(2026, 3, 31, 15), undefined, "RTH", S)).toBe("1:00:00");
  });

  it("intervals without a countdown", () => {
    expect(countdownText("2D", ny(2026, 1, 7, 10), undefined, "RTH", S)).toBeNull();
    expect(countdownText("3M", ny(2026, 1, 7, 10), undefined, "RTH", S)).toBeNull();
  });
});

describe("CountdownPrimitive.setState", () => {
  const state = (over: Partial<CountdownState> = {}): CountdownState => ({
    visible: true, price: 10, priceText: "10.00", pctText: "", text: "01:00",
    backColor: "#000", textColor: "#fff", fontSize: 12, fontFamily: "x", ...over,
  });

  it("repaints only when something drawn changes", () => {
    const p = new CountdownPrimitive();
    const requestUpdate = vi.fn();
    p.attached({ series: {}, requestUpdate } as unknown as Parameters<CountdownPrimitive["attached"]>[0]);
    p.setState(state());
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    p.setState(state());
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    p.setState(state({ text: "00:59" }));
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    p.setState(state({ visible: false }));
    expect(requestUpdate).toHaveBeenCalledTimes(3);
    // Hidden before and after: no repaint.
    p.setState(state({ visible: false, text: "00:58" }));
    expect(requestUpdate).toHaveBeenCalledTimes(3);
    expect(p.getState().text).toBe("00:58");
  });
});
