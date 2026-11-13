# MetaTrader 5 plugin

Connects OpenTrader to a MetaTrader 5 terminal on the same computer.

- **Data**: the broker's symbols as `MT5:<symbol>` (search, charts, scripts, watchlists, alerts), their bars from 1 minute to 1 day, and live prices.
- **Trading**: the terminal's account (balance, equity, margin), positions, orders and deals. You can send market, limit, stop and stop-limit orders with take profit and stop loss, modify, cancel and close them.

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

## Build

`./build.ps1` compiles the EA with MetaEditor, zips it with `opentrader-plugin.json`, signs the zip and prints the catalog entry. It runs on Windows with MetaTrader 5 installed.
