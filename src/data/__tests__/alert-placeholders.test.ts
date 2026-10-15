import { describe, expect, it } from "vitest";
import { MAX_PLACEHOLDER_PLOTS, appendPlaceholder, fillPlaceholders, needsBarData, placeholderGroups, type PlaceholderValues } from "../alert-placeholders";

describe("placeholderGroups", () => {
  it("General, Symbol data and Currency for the price", () => {
    const g = placeholderGroups(null);
    expect(g.map((x) => x.id)).toEqual(["general", "symbol_data", "currency"]);
    expect(g[0].items.map((i) => i.value)).toEqual(["{{ticker}}", "{{exchange}}", "{{interval}}", "{{time}}", "{{timenow}}"]);
    expect(g[1].items.map((i) => i.value)).toEqual(["{{open}}", "{{close}}", "{{high}}", "{{low}}", "{{volume}}"]);
    expect(g[2].items).toEqual([
      { title: "Quote", value: "{{syminfo.currency}}" },
      { title: "Base", value: "{{syminfo.basecurrency}}" },
    ]);
    expect(placeholderGroups([])).toHaveLength(3);
  });

  it("adds Plots for a study: each title once, then plot_<n> per plot", () => {
    const g = placeholderGroups([{ title: "MA" }, { title: "MA" }, { title: "Signal" }]);
    expect(g).toHaveLength(4);
    expect(g[3].title).toBe("Plots");
    expect(g[3].items).toEqual([
      { title: "MA", value: '{{plot("MA")}}' },
      { title: "Signal", value: '{{plot("Signal")}}' },
      { title: "Plot 0", value: "{{plot_0}}" },
      { title: "Plot 1", value: "{{plot_1}}" },
      { title: "Plot 2", value: "{{plot_2}}" },
    ]);
  });

  it("offers 20 plots at most", () => {
    const plots = Array.from({ length: 25 }, (_, i) => ({ title: `P${i}` }));
    const items = placeholderGroups(plots)[3].items;
    expect(items.filter((i) => i.title.startsWith("Plot "))).toHaveLength(MAX_PLACEHOLDER_PLOTS);
    expect(items.some((i) => i.title === "P20")).toBe(false);
  });
});

describe("appendPlaceholder", () => {
  it("adds a space unless the message is empty or ends with white space", () => {
    expect(appendPlaceholder("", "{{ticker}}")).toBe("{{ticker}}");
    expect(appendPlaceholder("Hi", "{{ticker}}")).toBe("Hi {{ticker}}");
    expect(appendPlaceholder("Hi ", "{{ticker}}")).toBe("Hi {{ticker}}");
    expect(appendPlaceholder("Hi\n", "{{ticker}}")).toBe("Hi\n{{ticker}}");
  });
});

describe("needsBarData", () => {
  it("is true for bar values and plots only", () => {
    expect(needsBarData("{{close}}")).toBe(true);
    expect(needsBarData("vol {{volume}}")).toBe(true);
    expect(needsBarData("{{plot_3}}")).toBe(true);
    expect(needsBarData('{{plot("MA")}}')).toBe(true);
    expect(needsBarData("{{ticker}} {{time}}")).toBe(false);
    expect(needsBarData("{{ close }}")).toBe(false);
    expect(needsBarData("{{Close}}")).toBe(false);
    expect(needsBarData("")).toBe(false);
  });
});

describe("fillPlaceholders", () => {
  const v: PlaceholderValues = {
    symbol: "NASDAQ:AAPL",
    interval: "60",
    barTime: Date.UTC(2026, 9, 14, 9, 0, 0),
    fireTime: Date.UTC(2026, 9, 14, 9, 0, 5, 789),
    bar: { open: 1.5, high: 2, low: 1, close: 1.75, volume: 12345 },
    currency: "USD",
    baseCurrency: null,
    plots: [
      { title: "MA", value: 10.5 },
      { title: "Signal", value: null },
      { title: "Bad", value: NaN },
    ],
  };

  it("fills the symbol, interval and times (UTC, no milliseconds)", () => {
    expect(fillPlaceholders("{{ticker}} {{exchange}} {{interval}}", v)).toBe("AAPL NASDAQ 60");
    expect(fillPlaceholders("{{time}} / {{timenow}}", v)).toBe("2026-10-14T09:00:00Z / 2026-10-14T09:00:05Z");
  });

  it("fills the bar values as they are", () => {
    expect(fillPlaceholders("{{open}} {{high}} {{low}} {{close}} {{volume}}", v)).toBe("1.5 2 1 1.75 12345");
  });

  it("fills currencies; a missing one stays as written", () => {
    expect(fillPlaceholders("{{syminfo.currency}} {{syminfo.basecurrency}}", v)).toBe("USD {{syminfo.basecurrency}}");
  });

  it("fills plots by index and title, 'null' without a value", () => {
    expect(fillPlaceholders("{{plot_0}} {{plot_1}} {{plot_2}} {{plot_9}}", v)).toBe("10.5 null null null");
    expect(fillPlaceholders('{{plot("MA")}} {{plot("Signal")}} {{plot("Nope")}}', v)).toBe('10.5 null {{plot("Nope")}}');
  });

  it("leaves unknown names, other case and spaced names as written", () => {
    expect(fillPlaceholders("{{Ticker}} {{unknown}} {{ ticker }} {ticker}", v)).toBe("{{Ticker}} {{unknown}} {{ ticker }} {ticker}");
  });

  it("leaves placeholders without a value as written", () => {
    const bare: PlaceholderValues = { ...v, symbol: "AAPL", barTime: null, bar: null, plots: null, currency: null };
    expect(fillPlaceholders("{{ticker}} {{exchange}} {{time}} {{close}} {{plot_0}} {{syminfo.currency}}", bare)).toBe(
      "AAPL {{exchange}} {{time}} {{close}} {{plot_0}} {{syminfo.currency}}",
    );
    expect(fillPlaceholders("{{close}}", { ...v, bar: { ...v.bar!, close: NaN } })).toBe("{{close}}");
  });

  it("fills repeated placeholders and keeps the text around them", () => {
    expect(fillPlaceholders("{{ticker}}: {{close}} ({{ticker}})", v)).toBe("AAPL: 1.75 (AAPL)");
    expect(fillPlaceholders("no placeholders", v)).toBe("no placeholders");
  });
});

describe("strategy and position placeholders", () => {
  const base: PlaceholderValues = {
    symbol: "BINANCE:BTCUSDT",
    interval: "1",
    barTime: Date.UTC(2026, 9, 15, 8, 49, 0),
    fireTime: Date.UTC(2026, 9, 15, 8, 49, 20),
    bar: { open: 81345.89, high: 81350, low: 81340, close: 81346, volume: 3 },
    currency: null,
    baseCurrency: null,
    plots: null,
  };
  const MSG =
    "A={{strategy.order.action}}|N={{strategy.order.contracts}}|P={{strategy.order.price}}|ID={{strategy.order.id}}|CM={{strategy.order.comment}}|AM={{strategy.order.alert_message}}|PS={{strategy.position_size}}|MP={{strategy.market_position}}|MPS={{strategy.market_position_size}}|PMP={{strategy.prev_market_position}}|PMPS={{strategy.prev_market_position_size}}|O={{open}}|C={{close}}|X={{strategy.nothing}}";

  it("fills an order fill as the reference fire gave it (prices in the symbol's format, sizes as they are)", () => {
    const v: PlaceholderValues = {
      ...base,
      priceText: (p) => p.toFixed(2),
      strategy: { action: "buy", contracts: 2.50964, price: 81346, id: "MomLE", comment: "MomLE", alertMessage: "", positionSize: 1.75327, prevPositionSize: -0.75637 },
    };
    expect(fillPlaceholders(MSG, v)).toBe(
      "A=buy|N=2.50964|P=81346.00|ID=MomLE|CM=MomLE|AM=|PS=1.75327|MP=long|MPS=1.75327|PMP=short|PMPS=0.75637|O=81345.89|C=81346.00|X={{strategy.nothing}}",
    );
  });

  it("flat position; without a fill the strategy placeholders stay as written", () => {
    const v: PlaceholderValues = { ...base, strategy: { action: "sell", contracts: 1, price: 10, id: "x", comment: "", alertMessage: "m", positionSize: 0, prevPositionSize: 1 } };
    expect(fillPlaceholders("{{strategy.market_position}} {{strategy.prev_market_position}} {{strategy.order.alert_message}}", v)).toBe("flat long m");
    expect(fillPlaceholders("{{strategy.order.action}}", base)).toBe("{{strategy.order.action}}");
  });

  it("menu groups: Position, Order, Market for a strategy; Position drawing tool for a position", () => {
    expect(placeholderGroups(null, "strategy").map((g) => g.title)).toEqual(["General", "Symbol data", "Currency", "Position", "Order", "Market"]);
    const p = placeholderGroups(null, "position");
    expect(p[3]).toEqual({
      id: "position_tool",
      title: "Position drawing tool",
      items: [
        { title: "Position level", value: "{{position.level}}" },
        { title: "Order price", value: "{{position.price}}" },
        { title: "PnL", value: "{{position.pnl}}" },
      ],
    });
  });

  it("fills a position hit: level name, price as it is, PnL in cents, a dash at the entry", () => {
    const msg = "LV={{position.level}}|PR={{position.price}}|PNL={{position.pnl}}|X={{position.nothing}}";
    expect(fillPlaceholders(msg, { ...base, position: { level: "Profit level", price: 81245.01, pnl: 15.000000000007276 * 16.667 } })).toBe("LV=Profit level|PR=81245.01|PNL=250.01|X={{position.nothing}}");
    expect(fillPlaceholders(msg, { ...base, position: { level: "Profit level", price: 81252.65, pnl: 57.5 } })).toBe("LV=Profit level|PR=81252.65|PNL=57.50|X={{position.nothing}}");
    expect(fillPlaceholders(msg, { ...base, position: { level: "Entry", price: 81343, pnl: null } })).toBe("LV=Entry|PR=81343|PNL=—|X={{position.nothing}}");
  });

  it("numbers a study's outputs given in message order; outputs without a title row are not named", () => {
    const g = placeholderGroups([{ title: "Up" }, { title: "C (Open)", named: false }, { title: "Close" }]);
    expect(g[3].items.map((i) => i.value)).toEqual(['{{plot("Up")}}', '{{plot("Close")}}', "{{plot_0}}", "{{plot_1}}", "{{plot_2}}"]);
  });
});
