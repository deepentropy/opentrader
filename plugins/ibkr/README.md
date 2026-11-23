# Interactive Brokers plugin

Connects OpenTrader to your Interactive Brokers account, through IB Gateway or TWS running on your computer, or by logging in to Interactive Brokers directly with no other program (direct login, beta).

- **Account**: balance, equity, margin, P&L and the other account values; positions with their live P&L; open and recent orders; the last week's executions with commissions.
- **Trading**: market, limit, stop and stop-limit orders with take profit and stop loss; modify, cancel; close a position in whole or in part; add, move or remove a position's take profit and stop loss.
- **Order ticket prices**: bid, ask and last of the ticket's symbol (delayed when the account has no market data subscription for it).
- **Order book**: the DOM tab's bid and ask sizes, up to 10 levels a side. Stocks get IB's smart depth: the venues the account has depth permissions for, added up by price. Without permissions IB sends no book and the DOM shows no sizes; the account manager's notifications say why.

Through IB Gateway or TWS, the login stays there and OpenTrader keeps no password. With a direct login, the password is kept in your computer's credential store. 
## Install

1. In OpenTrader, open **Settings > Plugins** and install **Interactive Brokers** from the catalog.
2. In the plugin's settings, pick the **Port** of your application: 4002 for IB Gateway paper, 4001 for IB Gateway live, 7497 for TWS paper, 7496 for TWS live. Change the **Client ID** if another API program uses 17.
3. In IB Gateway or TWS, log in, then open **Configure > Settings > API > Settings**:
   - tick **Enable ActiveX and Socket Clients**;
   - check that **Socket port** matches the plugin's port;
   - untick **Read-Only API** to trade from OpenTrader;
   - keep **Allow connections from localhost only** ticked, or add `127.0.0.1` to the trusted IPs.

### Direct login (beta)

The direct login runs on the [ibx](https://github.com/deepentropy/ibx) engine, which is still in beta: if a login, a quote or an order does not behave as through IB Gateway or TWS, switch back to IB Gateway or TWS and open an issue.

1. In the plugin's settings, set **Connection** to **Direct login**.
2. Enter your **Username** and **Password**, and pick the **Account**: **Paper trading** (with your paper trading username) or **Live**.
3. For a live account, pick how you approve the login: in **IBKR Mobile** on your phone (OpenTrader shows a message while it waits), or **a code you type** in the dialog OpenTrader opens (security code card, authenticator app, code sent by text).
4. **Apply**.

After a login, the plugin keeps the restart token the broker gives in its data folder: the daily reconnection and the next starts need neither the password nor the approval for a few days. Removing the plugin deletes it, with the saved password.

The broker allows one session per username: while the plugin is logged in, TWS, IB Gateway or the mobile app logged in with the same username lose their market data, and the other way round. A second username on the same account (Client Portal > Settings > Users) avoids it.

### Connected

The plugin shows **Connected** in Settings within a few seconds. While IB Gateway or TWS is closed it retries on its own and says why in the account manager's notifications.

To trade, choose **Trade > Connect broker… > Interactive Brokers**, then **Trade > Turn trading on**. Orders to a live account are confirmed first; paper accounts (ids starting with D) show DEMO.

## Chart data

The plugin also serves `IBKR:` chart symbols with the broker's own data:

- **US stocks and funds**: `IBKR:AAPL`, share classes with a dot (`IBKR:BRK.B`).
- **Forex**: `IBKR:EURUSD` (midpoint bars, no volume).
- **Futures**: the contract's code, `IBKR:ESZ6`. Typing the root (`ES`) in the symbol search lists the next expiries first.

Bars are 1, 5, 15, 30 and 60 minutes and days, extended hours included; the app builds the other sizes. One request goes at a time: the broker holds a burst of history requests for several seconds each, so scrolling far back on minute charts is slower than on other symbols. Minute history goes back a year, daily history as far as the broker has it. Quotes are real time where the account has the market data, delayed elsewhere. A symbol is looked up once, then kept in the plugin's data folder.

Chart data and trading can each be turned off in Settings > Plugins (under **Enabled**), for example to trade through the plugin and keep the charts on other data, or the other way round. Both use the same login.

Not served yet: other countries' stocks, options, indexes, tick charts.

## Notes

- **Symbols.** Chart symbols on US stock exchanges (`NASDAQ:`, `NYSE:`, `AMEX:`, `CBOE:`, `IEX:`, `OTC:`) are traded as the US stock or fund of the same name, routed SMART, in USD. Share classes use IB's names: `NYSE:BRK.B` is `BRK B`. Other markets are not mapped yet: use the symbol mapping in Settings > Plugins. Positions in futures, options or forex are shown under IB's local symbol (`ESZ6`, `EUR.USD`).
- **Take profit and stop loss.** IB has no such fields; they are orders:
  - on a new order, a bracket: a limit (take profit) and a stop (stop loss) held by IB until the order fills, the other cancelled when one fills;
  - on a position, a one-cancels-all pair of exit orders for the whole quantity, good till cancelled. A partial fill of one shrinks the other.
  - Moving a price changes the order in place. Adding or removing one replaces the pair: IB cancels both legs of a pair when one is cancelled, so the plugin cancels them and places the wanted ones again once IB confirms. The position is without exit orders for that moment.
  - Exit orders are found again as the position's take profit and stop loss when they are bracket legs or in a one-cancels-all group. Plain opposite orders are listed as orders.
  - Closing a position cancels its exit orders once IB takes the closing order; a partial close cuts them to what is left.
- **Durations.** Market orders are day orders; the others are good till cancelled. Stops trigger in regular hours only.
- **Outside RTH.** The order ticket's Extra settings tick an order (limit and stop orders) and its take profit or stop loss to fill outside regular trading hours, as IB's Outside RTH.
- **Order confirmation.** Before sending an order, the order ticket shows IB's what-if answer: the commission, and the equity with loan, initial and maintenance margin now, the change and after (its take profit and stop loss left out). Turn it off with "Show order confirmation" in the ticket's menu.
- **Prices** are rounded to the contract's price step.
- **Orders placed elsewhere** (TWS, another API program) are shown but cannot be changed or cancelled from OpenTrader: IB lets only the program that placed an order change it.
- **One account at a time.** With several accounts under one login, pick the account in the account manager.

## Build

`./build.ps1` builds the program with Cargo, zips it with `opentrader-plugin.json`, signs the zip and prints the catalog entry. `cargo test` runs the tests; they need no IB Gateway and no login.

The program reaches the broker through `src/link.rs`: `Link::Gateway` speaks the socket API of IB Gateway / TWS (the `ibapi` crate), `Link::Direct` logs in itself with the [ibx](https://github.com/deepentropy/ibx) engine (`src/direct.rs`). Both give the same answers, so the rest of the plugin works the same in both modes. The plugin needs OpenTrader with Plugin API 3 (password settings and prompts).
