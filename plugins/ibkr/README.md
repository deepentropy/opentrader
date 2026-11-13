# Interactive Brokers plugin

Connects OpenTrader to your Interactive Brokers account through IB Gateway or TWS running on your computer.

- **Account**: balance, equity, margin, P&L and the other account values; positions with their live P&L; open and recent orders; the last week's executions with commissions.
- **Trading**: market, limit, stop and stop-limit orders with take profit and stop loss; modify, cancel; close a position in whole or in part; add, move or remove a position's take profit and stop loss.
- **Order ticket prices**: bid, ask and last of the ticket's symbol (delayed when the account has no market data subscription for it).

The login stays in IB Gateway or TWS; OpenTrader keeps no password. The plugin provides no chart data.

## Install

1. In OpenTrader, open **Settings > Plugins** and install **Interactive Brokers** from the catalog.
2. In the plugin's settings, pick the **Port** of your application: 4002 for IB Gateway paper, 4001 for IB Gateway live, 7497 for TWS paper, 7496 for TWS live. Change the **Client ID** if another API program uses 17.
3. In IB Gateway or TWS, log in, then open **Configure > Settings > API > Settings**:
   - tick **Enable ActiveX and Socket Clients**;
   - check that **Socket port** matches the plugin's port;
   - untick **Read-Only API** to trade from OpenTrader;
   - keep **Allow connections from localhost only** ticked, or add `127.0.0.1` to the trusted IPs.

The plugin shows **Connected** in Settings within a few seconds. While IB Gateway or TWS is closed it retries on its own and says why in the account manager's notifications.

To trade, choose **Trade > Connect broker… > Interactive Brokers**, then **Trade > Turn trading on**. Orders to a live account are confirmed first; paper accounts (ids starting with D) show DEMO.

## Notes

- **Symbols.** Chart symbols on US stock exchanges (`NASDAQ:`, `NYSE:`, `AMEX:`, `CBOE:`, `IEX:`, `OTC:`) are traded as the US stock or fund of the same name, routed SMART, in USD. Share classes use IB's names: `NYSE:BRK.B` is `BRK B`. Other markets are not mapped yet: use the symbol mapping in Settings > Plugins. Positions in futures, options or forex are shown under IB's local symbol (`ESZ6`, `EUR.USD`).
- **Take profit and stop loss.** IB has no such fields; they are orders:
  - on a new order, a bracket: a limit (take profit) and a stop (stop loss) held by IB until the order fills, the other cancelled when one fills;
  - on a position, a one-cancels-all pair of exit orders for the whole quantity, good till cancelled. A partial fill of one shrinks the other.
  - Moving a price changes the order in place. Adding or removing one replaces the pair: IB cancels both legs of a pair when one is cancelled, so the plugin cancels them and places the wanted ones again once IB confirms. The position is without exit orders for that moment.
  - Exit orders are found again as the position's take profit and stop loss when they are bracket legs or in a one-cancels-all group. Plain opposite orders are listed as orders.
  - Closing a position cancels its exit orders once IB takes the closing order; a partial close cuts them to what is left.
- **Durations.** Market orders are day orders; the others are good till cancelled. Stops trigger in regular hours only.
- **Prices** are rounded to the contract's price step.
- **Orders placed elsewhere** (TWS, another API program) are shown but cannot be changed or cancelled from OpenTrader: IB lets only the program that placed an order change it.
- **One account at a time.** With several accounts under one login, pick the account in the account manager.

## Build

`./build.ps1` builds the program with Cargo, zips it with `opentrader-plugin.json`, signs the zip and prints the catalog entry. `cargo test` runs the tests; they need no IB Gateway.
