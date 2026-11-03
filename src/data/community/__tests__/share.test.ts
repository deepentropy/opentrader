import { describe, expect, it } from "vitest";
import { backtestTable, requestShare, takeShare } from "../share";

describe("community share", () => {
  it("formats a backtest's headline figures as a table", () => {
    expect(
      backtestTable({
        strategy: "MA Cross",
        symbol: "AAPL",
        interval: "D",
        currency: "USD",
        netProfit: 1234.5,
        netProfitPercent: 12.345,
        totalTrades: 42,
        percentProfitable: 55.2,
        profitFactor: 1.634,
        maxDrawdownPercent: 8.07,
      }),
    ).toBe(
      "Backtest of MA Cross on AAPL, D.\n\n| Net profit | Trades | Profitable | Profit factor | Max drawdown |\n|---|---|---|---|---|\n| +1,234.5 USD (12.3%) | 42 | 55% | 1.63 | 8.1% |\n",
    );
  });

  it("hands a request to the composer once", () => {
    requestShare({ attach: true, to: "c:options" });
    expect(takeShare()).toMatchObject({ attach: true, to: "c:options" });
    expect(takeShare()).toBeNull();
  });
});
