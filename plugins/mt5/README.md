# MetaTrader 5 plugin

Connects OpenTrader to a MetaTrader 5 terminal on the same computer.

- **Data**: the broker's symbols as `MT5:<symbol>` (search, charts, scripts, watchlists, alerts), their bars from 1 minute to 1 day, and live prices.
- **Trading**: the terminal's account (balance, equity, margin), positions, orders and deals. You can send market, limit, stop and stop-limit orders with take profit and stop loss, modify, cancel and close them.
- **Tick charts**: 1, 10, 100 and 1000 ticks a bar, from the terminal's tick history and its live ticks (the bid, or the trades of exchange symbols charted on their last price); Bar Replay replays them tick by tick.
- **Order book**: the DOM tab's bid and ask sizes, for the symbols whose server sends a Depth of Market (many forex and CFD servers send none: the DOM then shows no sizes). Sizes are in units: exchange instruments' lots times the contract size, other instruments' volumes as the server gives them.
- **Messages**: a short message on the charts, with a sound, when the terminal loses its trade server for a few seconds or an exit level could not be placed, and one when the server is back (OpenTrader releases after 0.4.32).

The login stays in the terminal; OpenTrader keeps no password.

## Install

1. In OpenTrader, open **Settings > Plugins** and install **MetaTrader 5** from the catalog.
2. Under the plugin, tick your terminal's `MQL5\Experts` folder and press **Copy OpenTraderBridge.ex5**.
3. In MetaTrader 5, open **Tools > Options > Expert Advisors**:
   - tick **Allow algorithmic trading**;
   - tick **Allow WebRequest for listed URL** and add `http://127.0.0.1`.
4. In the Navigator, drag **OpenTraderBridge** from **Expert Advisors** onto any one chart and tick **Allow Algo Trading**. Right-click the Navigator and choose **Refresh** if the EA is not listed.

The plugin shows **Connected** in Settings within a few seconds. Leave that chart open while you use OpenTrader.

To trade, choose **Trade > Connect broker… > MetaTrader 5**, then **Trade > Turn trading on**. Orders to a live account are confirmed first.

## Notes

- **Quantities** are in units: 0.01 lot of EURUSD is 1,000 units. Orders are rounded to the symbol's volume step and refused below its minimum.
- **Bar times.** MetaTrader gives the server's own times. The **Server clock** setting tells the plugin which clock the server runs on:
  - **Automatic** works for most brokers;
  - pick **New York close** or **Eastern European time** if bars look shifted by an hour.
- **Updates.** After an update, remove the EA from its chart and attach it again: MetaTrader keeps running the old copy until then.
- **Order quantity.** MetaTrader cannot change a working order's quantity: cancel the order and place a new one.
- **Exit levels.** An order or a position can close in parts (the order ticket's **Add level**), each part with its own take profit and stop loss, up to 8. MetaTrader keeps one take profit and stop loss per position, so the plugin works by account type:
  - **Hedging accounts**: each level is an order, then a position, of its own, with its take profit and stop loss; the part no level protects is one more, without exits. OpenTrader shows them as one order or one position. A level's prices can change at any time. On an open position, a level's quantity cannot: a level can be removed, or put on a part of the same quantity (the part without exits); close part of the position to make it smaller. A pending order's levels can change freely: the order is sent again in its new parts.
  - **Netting accounts**: each level is a pair of pending orders the EA keeps on the position, a limit at the take profit and a stop at the stop loss ("OpenTrader TP" / "OpenTrader SL"). When one fills, the EA cancels the other; when the position closes or turns the other way, it cancels them all; and together they never cover more than the position. The levels of an order waiting to fill are placed as it fills. Keep the terminal running with the EA attached while you have levels: the server keeps the pending orders, but only the EA cancels one when the other fills. On a symbol whose orders last a day at most, the levels end with the day.
- **Order confirmation.** Before sending an order, the order ticket shows the terminal's check of it: the margin it takes and the free margin and margin level after it, or why the server would refuse it. Turn it off with "Show order confirmation" in the ticket's menu.
- **Margin.** Under the quantity, the order ticket shows the order's value with the symbol's leverage ("Trade value (100x)") and the account's free margin.

## Build

`./build.ps1` compiles the EA with MetaEditor, zips it with `opentrader-plugin.json`, signs the zip and prints the catalog entry. It runs on Windows with MetaTrader 5 installed.
