# NinjaTrader 8 plugin

Shows NinjaTrader 8's futures data in OpenTrader, on the same computer.

> **Please read before you use it.** This plugin is not made, reviewed or approved by NinjaTrader, and OpenTrader is not affiliated with NinjaTrader. NinjaTrader's terms, and those of your data provider and the exchanges, may not allow using their data in another application. Read the terms of your account and use the plugin only if they allow it: you are responsible for that use.

- **Data only**: it reads no account and sends no order.
- **Symbols**: `NT8:ES1!` is the front contract, with the earlier contracts joined to it at their real prices (not back-adjusted). `NT8:ESZ2026` is one contract.
- **Bars** of 1, 5 and 15 minutes and 1 day; OpenTrader builds the other sizes. **Tick charts** and live prices.
- A ready-made watchlist of futures.

What you see depends on the data NinjaTrader is connected to.

## Install

Follow the [setup guide](https://opentrader.markets/plugin-ninjatrader.html).

## Notes

- **Times.** NinjaTrader gives its times in the time zone of its options and stamps a bar at its end; the plugin converts them.
- **Contract rolls.** The front contract changes on NinjaTrader's rollover dates.
- **Speed.** NinjaTrader downloads a symbol's history the first time it is asked: long daily histories can take a while to fill in, then come faster.
- **Tick history** goes back as far as NinjaTrader gives it.
- Not served yet: market depth, trading, stocks, forex and options.

## Build

`./build.ps1` checks that the add-on compiles against the installed NinjaTrader, zips its source with `opentrader-plugin.json`, signs the zip and prints the catalog entry. It needs NinjaTrader 8 and the .NET SDK.
