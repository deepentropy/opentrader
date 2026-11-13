# Writing an OpenTrader plugin

A plugin brings your own market data, your broker account, or both into OpenTrader. It is a small program that runs
next to the app and talks to it over a local connection. You write it, you publish it from your own repository, and
users install it from **Settings > Plugins > Install from file**.

This folder is a working plugin to start from. It serves a simulated market (three symbols, live prices) and a
simulated account (orders, positions, fills), so every part works before you change a line. You then replace one
class with calls to your own API.

| File | What it is |
|---|---|
| `plugin.py` | The plugin. Python 3.9+, standard library only. Part 1 is the `Source` class you replace; part 2 is the connection, which you keep. |
| `opentrader-plugin.json` | The manifest of the package you publish: the app starts the built program. |
| `opentrader-plugin.dev.json` | The manifest you use while developing: you start `plugin.py` yourself. |
| `build.py` | Builds both packages into `dist/`. |

The full protocol is in [`../PROTOCOL.md`](../PROTOCOL.md). This guide is the short path through it.

## 1. Start from the template

1. Copy this folder into a new repository.
2. In both manifests, set your own `id` (lowercase letters, digits, dashes), `name`, `publisher` and `exchange`, and
   set the same `PLUGIN_ID` and `EXCHANGE` at the top of `plugin.py`. The exchange is the prefix of your symbols:
   with `"exchange": "ACME"`, a user opens `ACME:EURUSD`.
3. Keep only what you provide in `provides`: `datafeed` for market data, `broker` for an account. Remove the other
   half's methods from `Source` if you like; the app never calls them.

## 2. Develop with the app running

1. Build the development package: `python build.py dev`.
2. In OpenTrader, **Settings > Plugins > Install from file**, pick `dist/<id>-dev.zip` and enable it. The app warns
   that the package is not verified: that is expected for any plugin outside OpenTrader's own catalog.
3. Run `python plugin.py` in a terminal. It reads where to connect from the file the app writes
   (`{localAppData}/OpenTraderPlugins/template-dev.json`; change the path in both the dev manifest and
   `DEV_CONNECTION_FILE`), says hello, and stays connected. Stop it and start it again as often as you like: the
   app takes the new connection.
4. Check it in the app:
   - **Data**: search your exchange in the symbol search (`ACME:` lists only yours), open a symbol, change the
     interval, watch the last bar move.
   - **Broker**: **Trade > Connect broker…**, pick your plugin, turn trading on in the Trade menu, place an order
     from the chart or the order ticket, then look at the account manager under the chart.
   - **Log**: Settings > Plugins shows what the plugin prints and the `log` lines it sends.

## 3. Replace the source

Everything the app asks goes through `Source`. Keep the return shapes; change where the values come from.

**Market data**

| Method | Called for | Return |
|---|---|---|
| `search(query)` | the symbol search | up to 50 `{ticker, description, type}`; `type` picks the search tab (`stock`, `fund`, `index`, `forex`, `crypto`, `futures`, `cfd`, `bond`) |
| `symbol_info(ticker)` | opening a symbol | description, type, currency, `timezone` (IANA), `session` (`"0930-1600"`, `"24x7"`…), `pricescale` and `minmov` (one tick = minmov / pricescale), the `intervals` you serve |
| `bars(ticker, resolution, from, to, count_back)` | history | `[time, open, high, low, close, volume]` oldest first, `time` = the bar's start in UNIX seconds; at most the newest `count_back`; an empty list means no more history |
| `quote(ticker)` | every second, for the symbols on screen | the last price, `prevClose`, and the forming `minute` and `day` bars |

Serve the intervals your source has: the app builds the others (5 minutes from 1 minute, weeks from days…). A daily
bar starts at its trading day's midnight in the symbol's time zone.

**Broker**

| Method | Called for | Return |
|---|---|---|
| `state()` | after each change, and every second while positions are open | the whole account: balance, equity, P&L, positions, orders, executions |
| `place(ticket)` | a new order | the order id and the events to show (`placed`, `executed`…); raise `PluginError` to refuse it, with the reason the user will read |
| `modify`, `cancel`, `close_position`, `set_position_brackets` | the ticket, the chart lines, the account manager | the events to show |
| `resolve_symbol(symbol, ticker)` | a chart symbol from another exchange (`NASDAQ:AAPL`) | your ticker for it, or `None` |
| `on_tick()` | every second | events of orders that filled meanwhile (a real broker usually pushes these: send them when they arrive) |

Quantities are units (shares, currency units, contracts): convert lots. Mark a real-money account
`"isDemo": false`; the app then asks the user to confirm each order.

**Settings.** Fields in the manifest's `settings` (an API key, a host, an account type) appear in Settings > Plugins;
the values arrive in `Source.configure(settings)`, as text, at connection and whenever the user changes them.

**Several exchanges from one source.** If one account serves several markets (an exchange's cash and futures
segments, for instance), list them in the manifest as `"exchanges": ["XA", "XB"]` instead of `exchange`. The app then
sends and expects whole symbols (`XA:ABC`) everywhere, since one ticker may trade on several of them. See
PROTOCOL.md.

## 4. Package and publish

1. `python -m pip install pyinstaller`, then `python build.py release`. It builds `plugin.py` into one program and
   writes `dist/<id>-<version>.zip` with the manifest. The app starts that program itself, passes it the connection
   in its environment, starts it again if it stops, and stops it when the plugin is disabled.
2. A built program runs on the system it was built on. The manifest names one `entry` and its `platforms`: publish
   one zip per system (`bin/<name>.exe` and `"platforms": ["windows"]` on Windows, `bin/<name>` and `["macos"]` or
   `["linux"]` elsewhere).
3. Raise `version` in the manifest for each release and attach the zip to a release of your repository, with the
   sha256 `build.py` prints. Users install it with **Install from file**; installing a newer version replaces the
   older one and keeps its settings.

Your plugin stays yours: OpenTrader's catalog lists only the plugins the OpenTrader team ships, and packages from
anywhere else install as *not verified*.

## 5. Before you publish

- [ ] The manifest's `id`, `exchange` and `api` match `plugin.py`.
- [ ] Errors reach the user: raise `PluginError("…")` with a message a trader understands, never let a request go
      unanswered.
- [ ] A slow request (long history) does not block the others: the template answers each request on its own thread.
- [ ] Losing your source's connection shows: send `"connected": false` in the broker state, and `log` a warning.
- [ ] Bars are oldest first, without duplicates, times in UTC seconds; prices on the symbol's tick.
- [ ] Nothing secret is printed to the log (it is shown in Settings).
- [ ] The README of your repository says what the plugin needs (an account, an API key, another program running).
