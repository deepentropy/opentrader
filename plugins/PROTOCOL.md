# OpenTrader Plugin API

Plugin API version **2**. Version 2 adds `exchanges` (a data plugin serving several exchanges); a version 1 plugin works unchanged.

A plugin is a program outside OpenTrader that supplies:

- **market data**: symbols, bars and live ticks. This is the `datafeed` capability.
- **a broker account**: positions, orders, executions and order commands. This is the `broker` capability.

A plugin can provide either capability or both. It connects to the app over a local socket.

Users install plugins from **Settings > Plugins**, either from the catalog or from a file. OpenTrader ships no plugin code of its own.

To write one, start from [`template/`](template/README.md): a working data and broker plugin in one Python file, with the steps to develop, package and publish it.

## Package

A plugin package is a zip. It holds `opentrader-plugin.json` at its root, plus the plugin's files:

```json
{
  "id": "example",
  "name": "Example",
  "version": "1.0.0",
  "publisher": "You",
  "description": "What it does",
  "api": 1,
  "provides": ["datafeed", "broker"],
  "exchange": "EXAMPLE",
  "runtime": { "type": "process", "entry": "bin/example.exe", "args": [] },
  "install": [],
  "settings": [
    { "key": "host", "label": "Host", "type": "text", "default": "127.0.0.1" },
    { "key": "mode", "label": "Account", "type": "select", "default": "demo",
      "options": [{ "value": "demo", "label": "Demo" }, { "value": "live", "label": "Live" }] }
  ],
  "setup": "Text shown after installation: what to do in the other application.",
  "homepage": "https://example.com",
  "platforms": ["windows"]
}
```

| Field | Meaning |
|---|---|
| `id` | 2 to 40 lowercase letters, digits and `-`. |
| `api` | The Plugin API version the plugin speaks. OpenTrader refuses a package that needs a newer one. |
| `provides` | `datafeed`, `broker`, or both. A plugin is only asked, and only heard, on the methods of what it provides. |
| `exchange` | Required for a data plugin, unless it gives `exchanges`. Its symbols are `<exchange>:<ticker>`, for example `EXAMPLE:EURUSD`. Use 2 to 16 uppercase letters, digits and `_`. `LOCAL` and `ECONOMICS` are reserved. |
| `exchanges` | A data plugin that serves several exchanges from one source, for example the market segments of one broker account: `["NSE","BSE","NFO","MCX"]`. Same rules as `exchange`, no repeats. The app then names the plugin's symbols whole in every message (see below). Plugin API 2. |
| `runtime` | How the plugin runs (see below). |
| `install` | Files to copy into a folder the user picks (see below). |
| `settings` | Fields the user fills in under Settings > Plugins. `type` is `text`, `number`, `bool` (`"true"` / `"false"`) or `select`. Values travel as text. |
| `platforms` | `windows`, `macos` and/or `linux`. Leave it empty for all platforms. |

### Runtime

There are two runtimes:

- **`process`**: OpenTrader starts `entry` (a path inside the package) while the plugin is enabled, and starts it again if it stops. The plugin finds its connection details in its environment: `OPENTRADER_PLUGIN_ADDR` (`127.0.0.1:<port>`), `OPENTRADER_PLUGIN_ID` and `OPENTRADER_PLUGIN_TOKEN`. Its stdout and stderr go to the plugin's log in Settings.
- **`external`**: the plugin runs inside another application, such as a trading terminal, and connects by itself. With `"connectionFile": "<template>"`, OpenTrader writes this file while the plugin is enabled and deletes it when the plugin is disabled:

  ```json
  { "plugin": "example", "host": "127.0.0.1", "port": 47822, "token": "…", "api": 2 }
  ```

Path templates start with `{appData}` (the roaming application data folder), `{localAppData}`, `{documents}` or `{home}`, followed by plain folder names. A connection file is a `.json` file.

### Install steps

```json
"install": [{ "copy": "Bridge.ex5", "to": { "title": "Experts folder of the terminal",
  "suggest": "{appData}/Vendor/Terminal/*/MQL5/Experts", "expect": "MQL5/Experts" } }]
```

Settings lists the existing folders that match `suggest`, where `*` matches any one folder. The user can also choose another folder, which must end with `expect`.

OpenTrader then copies the file into the chosen folders. It copies the file again when the plugin updates, and deletes it when the plugin is removed.

### Signature

A package is *verified* when its minisign signature checks against OpenTrader's release key:

- **Catalog packages** must be verified. The catalog gives their URL, sha256 and signature.
- **Packages installed from a file** may come with their signature in `<file>.sig` next to the file. Without one, Settings warns the user before installing.

## Transport

- Plain TCP to `127.0.0.1:<port>`. The default port is `47822` and can be changed in Settings. The app only listens while at least one plugin is enabled.
- Each message is one line holding one [JSON-RPC 2.0](https://www.jsonrpc.org/specification) object, terminated by `\n`. Messages are UTF-8. A line can be up to 64 MiB.
- Both sides send requests (with an `id`) and notifications (without one), and answer the requests they receive. Request ids are the sender's own.

### Handshake

The first message the plugin sends must be `hello`, within 10 seconds of connecting:

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"plugin":"example","token":"…","api":1,"version":"1.0.0"}}
```

If the plugin is installed and enabled, the token matches and the API version is supported, the app answers:

```json
{"jsonrpc":"2.0","id":1,"result":{"app":"OpenTrader","api":2}}
```

Otherwise the answer is an error (code `-32001`, with a message to show the user), and the app closes the connection.

A newer connection of the same plugin replaces the older one. When the plugin is disabled, removed or given a new token, the app closes its connection.

### Always available

| Direction | Method | Kind | |
|---|---|---|---|
| plugin → app | `ping` | request | Answers `{}`. Use it to keep the connection alive and check that it is up. |
| plugin → app | `log` | notification | `{"level":"info"\|"warn"\|"error","message":"…"}`, shown in the plugin's log. |
| app → plugin | `plugin.configure` | notification | `{"settings":{"key":"value",…}}`. Sent right after `hello` and whenever the user changes the settings. Fields the user left empty carry their manifest default. |

## Data plugins (`datafeed`)

The plugin's symbols are `<exchange>:<ticker>`. Charts, scripts, watchlists and alerts use them like any other symbol. The app asks the plugin with the bare `ticker`.

**Several exchanges.** A plugin with `exchanges` is asked with the whole symbol instead, since one ticker can trade on several of its exchanges: `"ticker":"NSE:RELIANCE"` in `data.symbolInfo`, `data.bars` and `data.subscribe`. It answers the same way: `data.quote` and the `data.search` rows carry whole symbols, and a row of an exchange it does not list is dropped. As a broker too, its positions, orders and executions use whole symbols, which open on the chart as they are.

A manifest may carry both `exchange` and `exchanges` to install on both versions: version 1 apps route `exchange` with bare tickers, version 2 apps route `exchanges` with whole symbols. The `hello` answer's `api` tells the plugin which one it speaks to.

Bars are `[time, open, high, low, close, volume]` arrays. `time` is the bar's start in UNIX seconds (UTC). A daily bar starts at its trading day's midnight in the symbol's time zone. `volume` may be omitted.

### `data.search` (app → plugin, request)

`{"query":"eur"}` → `{"symbols":[{"ticker":"EURUSD","description":"Euro vs US Dollar","type":"forex"}]}`

The query never holds the exchange: the app asks each plugin once and keeps the rows of the exchange the user typed (`NSE:REL`).

Return at most 50 matches; an empty query may return the most used symbols. `type` is one of `stock`, `fund`, `index`, `forex`, `crypto`, `futures`, `cfd`, `bond`. It picks the search tab the row appears under.

### `data.symbolInfo` (app → plugin, request)

`{"ticker":"EURUSD"}` →

```json
{"description":"Euro vs US Dollar","type":"forex","currency":"USD",
 "timezone":"America/New_York","session":"1700-1700:23456","extended":null,"holidays":"",
 "pricescale":100000,"minmov":1,"intervals":["1","5","15","30","60","240","1D","1W","1M"]}
```

| Field | Meaning |
|---|---|
| `timezone` | IANA time zone of the sessions. |
| `session` | Regular session in the usual datafeed grammar, for example `0930-1600` (Monday to Friday), `0930-1600:23456` (explicit days, 1 = Sunday), `1700-1700:23456` (overnight, opens the evening before), `24x7`, or several intervals `0900-1130,1230-1530`. |
| `extended` | The whole traded day, when it is wider than `session`. |
| `holidays` | Full-close days, `YYYYMMDD,YYYYMMDD`. |
| `barOrigin` | Optional, `"HHMM"` in `timezone`. Send it when your intraday bars start on a clock grid that ignores the session opens, as a broker terminal's do: 5-minute bars at 01:00, 01:05… when trading opens at 01:01, 4-hour bars at 00:00, 04:00… of the server's day. Give the time of day the grid starts from (the server's midnight: `"1700"` in New York for a New York close server). The app then shows your bars as they are, builds the other sizes on that grid, and puts live minutes, alerts, the countdown and scripts' `time(tf)` on it too. Without it, bars start at the session opens (see `intervals`). |
| `pricescale`, `minmov` | One tick is `minmov / pricescale`. For example, 100000 and 1 give 0.00001. |
| `pointValue` | Optional, 1 when left out. The money one unit of quantity makes when the price moves by 1, in `currency`. A future counted in contracts gives its multiplier: 65 for an NSE NIFTY future, 50 for an E-mini S&P. Symbol info shows it, and scripts (`syminfo.pointvalue`), the strategy tester and Bar Replay trading compute profits with it. |
| `intervals` | The resolutions served: minutes (`"1"`, `"5"`, `"60"`…), seconds (`"1S"`…), `"1D"`, `"1W"`, `"1M"`. Intraday bars start on the clock grid of their size in the symbol's time zone (a `"60"` bar starts on the hour). Other minute or second sizes are built by the app from a served size that divides them. Bars that start at the session open (09:30, 10:30…) are built from a served size that divides the time from midnight to the open; with none (only `"60"` for a 09:30 open), the bars keep the served grid (09:00, 10:00…) and the one the open falls in is stamped at the open. Weeks and months are built from days. Add `"1T"` when you serve ticks (`data.ticks`): the app then offers tick charts (1T, 10T, 100T, 1000T and custom tick counts), each bar the next N ticks. The interval picker offers only these; another interval shows that it is not supported. |
| `history` | Optional. How far back your source serves each family of bars, in calendar days: `{"second":3,"minute":30,"day":365}`, any of the three. The app then asks for nothing older (scrolling back stops there) and never more bars than fit in what it asks. Weeks and months follow `day`. Without it, the app asks as far back as the chart goes (30 years of days) and you answer what you have. |

**Unknown symbols.** Answer a symbol you don't know (an expired contract, a renamed ticker) with the error code `-32004`. The app then stops asking for it and streaming it until the plugin connects again, and the watchlist shows it in red. Another error is taken as a failure of the moment.

### `data.bars` (app → plugin, request)

`{"ticker":"EURUSD","resolution":"5","from":1730000000,"to":1730600000,"countBack":2000}` → `{"bars":[[1730000100,1.0812,1.0815,1.0809,1.0811,320],…]}`

Return the bars whose start is in `[from, to]`, oldest first. When there are more than `countBack`, return the newest `countBack` of them. You may return fewer, the newest ones: the app then asks for the older ones before the oldest bar you returned when the chart needs them. Return an empty list when there are none: the app reads that as the start of the history.

The app keeps a symbol's recent bars a while, so the chart, the Details panel and the quote of one symbol share one request; after that, it asks only for the bars from the last one it has. When your source is busy (rate limited), answer with the error code `-32005`: the app asks again later, waiting longer each time (1 s, then up to 15 s).

### `data.ticks` (app → plugin, request)

For a plugin that lists `"1T"` in `intervals`: the ticks of tick charts.

`{"ticker":"EURUSD","to":1730600123456,"countBack":20000}` → `{"ticks":[[1730600100015,1.08113,1],[1730600100230,1.08115,1],…]}`

A tick is `[time, price, volume]`: `time` in UNIX milliseconds, `price` the trade price (the bid when the source has no trades), `volume` the traded quantity (the tick count, 1, when the source has none). Return the newest `countBack` ticks whose time is before `to`, oldest first. Return fewer when the history ends there, an empty list when there are none. The app asks for older ticks, before the oldest you returned, when the chart scrolls back.

### `data.tick` (plugin → app, notification)

`{"ticker":"EURUSD","ticks":[[1730600123500,1.08116,1],[1730600123512,1.08117,1]]}`: every new tick of the tickers of `data.watchTicks`, in order. Group the ticks of a moment in one message, a few messages per second at most, and send them besides `data.quote`. A tick chart counts each tick it gets: a tick left out makes its bars longer.

### `data.watchTicks` (app → plugin, notification)

`{"tickers":["EURUSD"]}`: the whole set of tickers a tick chart shows, whose `data.tick` the app wants. An empty list stops them. The app sends it again after each `hello`.

### `data.subscribe` (app → plugin, notification)

`{"tickers":["EURUSD","XAUUSD"]}`: the whole set of tickers to stream from now on. It replaces the previous set, and an empty list stops streaming. The app sends it again after each `hello`.

### `data.quote` (plugin → app, notification)

Send this for every subscribed ticker on each price change. Several per second are fine.

```json
{"ticker":"EURUSD","time":1730600123,"price":1.08115,"prevClose":1.0790,
 "minute":[1730600100,1.0811,1.08118,1.0810,1.08115,12],
 "day":[1730592000,1.0790,1.0830,1.0781,1.08115,15040]}
```

| Field | Meaning |
|---|---|
| `price` | The last price, or the bid when the source has no trades. |
| `minute` | The forming 1-minute bar. It updates the chart's last bar at every minute-based interval. |
| `day` | The forming daily bar. It updates daily, weekly and monthly charts. |
| `prevClose` | The previous session's close. It gives the change shown in watchlists. |

## Broker plugins (`broker`)

The user connects the app to one broker plugin at a time from **Trade > Connect broker…**. Requests are only sent to the connected plugin, and only its notifications are heard.

**Trading switch.** The app refuses `broker.place`, `broker.modify` and `broker.setPositionBrackets` until the user turns trading on in the Trade menu. Trading is off by default. Cancelling an order and closing a position always work.

**Live accounts.** The app asks the user to confirm every order sent to a live account (`isDemo: false`).

**Symbols.** Positions, orders and requests use the broker's own tickers. The app finds the ticker of a chart symbol in this order:

1. the user's mapping (Settings > Plugins);
2. the plugin's own symbols, when it is also a data plugin;
3. `broker.resolveSymbol`.

**Quantities** are in units: shares, currency units or contracts. A broker that counts lots converts. With a contract size of 100,000, 0.01 lot is 1,000 units. A broker that only takes whole lots says so in `broker.instrument`: the order ticket then steps and checks the quantity by the lot.

The unit and the point value go together. A future can be counted either way, as long as orders, positions and point value agree:

- in contracts, as charting platforms usually count futures: a NIFTY lot of 65 is 1, `pointValue` 65 (in `data.symbolInfo` or `broker.instrument`), `qtyStep` 1. The plugin multiplies by 65 when it sends an order to a broker that counts underlying units, and divides the positions, orders and fills it reports;
- in underlying units: one lot is 65, `pointValue` 1, `qtyStep` 65.

When `broker.instrument` gives no point value, the order ticket uses the symbol's (`data.symbolInfo`) for the plugin's own symbols.

**Ticket fields.** A broker that needs a choice with each order that the app doesn't have (a product type: intraday, delivery, carry forward…) declares it in `capabilities.ticketFields`, or per ticker in `broker.instrument`. The order ticket shows each field as a selector and sends the values picked in `fields`; the chart's one-click orders send the last values picked. A modified order keeps the fields it was placed with, from `orders[].fields`.

**Time in force.** A broker that lets the user pick how long an order stays working declares its durations in `capabilities.durations`, or per ticker in `broker.instrument`. The order ticket shows them in a selector (only those whose `orderTypes` include the ticket's order type) and sends the id picked in `duration`; the chart's one-click orders send the last one picked, else the default. A modified order keeps its duration, from `orders[].duration`. A broker that declares none receives no `duration` and keeps its own.

### `broker.state` (plugin → app, notification)

The whole account. Send it once after `hello`, then whenever any part changes: an order, a fill, a position, the balance, the P&L, and `connected` turning true or false. A few per second are fine. The app keeps the last one it got: a plugin that sends `connected: false` at start and nothing once it is logged in stays "not connected". The app also asks for it with `broker.getState` when the plugin connects and when the order ticket or the account manager opens.

```json
{
  "connected": true,
  "accounts": [{ "id": "51234567", "name": "Demo 51234567" }],
  "account": { "id": "51234567", "name": "Demo 51234567", "currency": "USD", "isDemo": true,
               "balance": 10000, "equity": 10012.5, "unrealizedPnl": 12.5, "realizedPnl": 0,
               "marginUsed": 36.1, "marginFree": 9976.4,
               "values": [{ "label": "Leverage", "value": "1:30" }] },
  "positionMode": "hedging",
  "capabilities": { "orderTypes": ["market", "limit", "stop", "stopLimit"], "brackets": true,
                    "positionBrackets": true, "partialClose": true, "modifyOrders": true,
                    "ticketFields": [],
                    "durations": [{ "id": "day", "label": "Day", "default": true },
                                  { "id": "gtc", "label": "Good Till Cancel" },
                                  { "id": "ioc", "label": "Immediate or Cancel", "orderTypes": ["market", "limit"] }] },
  "positions": [{ "id": "8812", "ticker": "EURUSD", "side": "buy", "qty": 1000, "avgPrice": 1.0811,
                  "last": 1.0823, "unrealizedPnl": 1.2, "takeProfit": 1.09, "stopLoss": null }],
  "orders": [{ "id": "8813", "ticker": "EURUSD", "side": "sell", "type": "limit", "qty": 1000,
               "filledQty": 0, "limitPrice": 1.095, "stopPrice": null, "takeProfit": null, "stopLoss": null,
               "status": "working", "duration": "gtc", "updatedMs": 1730600123000 }],
  "executions": [{ "id": "d771", "orderId": "8812", "ticker": "EURUSD", "side": "buy", "qty": 1000,
                   "price": 1.0811, "timeMs": 1730600000000, "commission": 0, "realizedPnl": 0 }]
}
```

| Field | Meaning |
|---|---|
| `connected` | The plugin is logged in to its broker. While it is `false`, the app shows the broker as not connected. |
| `capabilities` | What the broker supports. The order ticket, the chart and the DOM offer only that: `orderTypes` are the ticket's order types; without `brackets` a new order has no take profit / stop loss; without `positionBrackets` there is no Protect position; without `partialClose` a position closes whole; without `modifyOrders` orders are not dragged or modified. A field left out is supported. |
| `positionMode` | `netting` gives one position per symbol. `hedging` allows several, each closed on its own. A chart shows a hedging account's positions of a symbol as one net position. |
| `orders[].status` | `placing`, `working`, `inactive`, `filled`, `cancelled` or `rejected`. Keep recent filled, cancelled and rejected orders for the account manager's filters. |
| `capabilities.ticketFields` | The broker's own choices for each order, for example `[{"id":"product","label":"Product","options":[{"value":"MIS","label":"Intraday"},{"value":"CNC","label":"Delivery"}],"default":"MIS"}]`. `default` is the value picked at first (the first option when left out). Leave it out or empty when there are none. |
| `capabilities.durations` | The times in force the broker takes: `id` goes with the order and comes back in `orders[].duration`, `label` is what the ticket shows (the id when left out), `orderTypes` the order types it applies to (all when left out), `default: true` marks the one picked at first (else the first that applies). Leave it out or empty to keep the broker's own. |
| `capabilities` price rules | The app refuses an order price that would surprise the user before it reaches the broker: a price that is not a whole number of ticks, a stop on the wrong side of the market (a buy stop below the ask, a sell stop above the bid: it would trigger at once; the same for the stop of a stop limit), and a limit more than half the market price on the wrong side. A marketable limit (a buy limit above the ask) is sent. Declare `"stopOrdersBothSides": true` or `"stopLimitOrdersBothSides": true` if your broker takes stops on either side, `"strictLimitPrice": true` if it refuses any limit that crosses the market. All three are `false` when left out. Your broker still has the last word: refuse what it doesn't take with an error. |
| `orders[].duration` | The order's time in force, a `durations` id: shown in the account manager and sent back by `broker.modify`. |
| `orders[].takeProfit`, `stopLoss` | The brackets an order opens its position with. |
| `orders[].fields` | The ticket fields' values the order was placed with (`{"product":"CNC"}`): `broker.modify` sends them back. |
| `positions[].takeProfit`, `stopLoss` | A position's brackets. |

### `broker.event` (plugin → app, notification)

An order notification, shown as a toast:

```json
{"kind":"executed","ticker":"EURUSD","side":"buy","type":"market","qty":1000,"price":1.0811}
```

`kind` is `placed`, `executed`, `modified`, `cancelled` or `rejected`. For `rejected`, add a `message` to show the user.

### `broker.notice` (plugin → app, notification)

`{"level":"info"|"warn"|"error","message":"…"}` adds a line to the account manager's notifications log.

### `broker.quote` (plugin → app, notification)

`{"ticker":"EURUSD","bid":1.08110,"ask":1.08118,"last":null}`: the order ticket's bid and ask, for the tickers of `broker.watchQuote`.

### `broker.depth` (plugin → app, notification)

The order book of the tickers of `broker.watchDepth`, shown in the DOM tab: the quantity at each bid and ask price, the totals of each side, and the best bid and ask.

```json
{"ticker":"EURUSD","snapshot":true,
 "bids":[{"price":1.09738,"qty":2475000},{"price":1.09737,"qty":3000000}],
 "asks":[{"price":1.0974,"qty":4000000},{"price":1.09741,"qty":4500000}]}
```

With `snapshot: true` (or left out) the levels are the whole book. With `snapshot: false` they are the levels that changed since the last message; a `qty` of 0 removes its level. Quantities are in units, like orders. Send at most a few per second. A plugin without an order book sends nothing: the DOM's sizes stay empty and its totals read "-". When the book stops (the exchange halted it), send an empty snapshot.

### Requests (app → plugin)

| Method | Params | Result |
|---|---|---|
| `broker.getState` | `{}` | The whole account, as `broker.state` sends it. Optional: a plugin that answers `-32601` is only read from its `broker.state`. |
| `broker.resolveSymbol` | `{"symbol":"NASDAQ:AAPL","ticker":"AAPL"}` | `{"ticker":"AAPL.US"}`, or `{"ticker":null}` when the broker doesn't trade it. |
| `broker.instrument` | `{"ticker":"NIFTY25NOVFUT"}` | How the ticker trades, every field optional: `{"qtyMin":65,"qtyStep":65,"qtyMax":1800,"pointValue":1,"ticketFields":[…]}`. `qtyStep` is the lot in units; orders are whole multiples of it. `pointValue` is the money one unit makes when the price moves by 1 (a futures multiplier; 1 when left out): the ticket's risk sizing and tick value use it. `ticketFields` and `durations` replace the capabilities' for this ticker. Asked once per ticker and connection. Optional: a plugin that answers `-32601` trades any quantity with a point value of 1. |
| `broker.selectAccount` | `{"account":"51234567"}` | `{}`. Then send the new account's `broker.state`. |
| `broker.place` | `{"ticker","side","type","qty","limitPrice","stopPrice","takeProfit","stopLoss","fields","duration"}` | `{"orderId":"8813"}`. An error answer is shown as a rejected order with its message. `fields` holds the ticket fields' values (`{"product":"CNC"}`), `{}` without any. `duration` is a `durations` id, left out when the broker declares none. |
| `broker.modify` | the same as `broker.place`, plus `"orderId"` | `{}` |
| `broker.cancel` | `{"orderId":"8813"}` | `{}` |
| `broker.closePosition` | `{"positionId":"8812","qty":null}` | `{}`. `qty` null closes the whole position. |
| `broker.setPositionBrackets` | `{"positionId":"8812","takeProfit":1.09,"stopLoss":null}` | `{}`. A null removes that bracket. |

There are also two notifications (app → plugin), each with the whole set of tickers the app wants; an empty list stops them:

- `broker.watchQuote`: `{"tickers":["EURUSD"]}`, the tickers whose `broker.quote` the order ticket shows;
- `broker.watchDepth`: `{"tickers":["EURUSD"]}`, the tickers whose `broker.depth` the DOM tab shows, while it is open.

Answer a request once the broker has accepted or refused it. Report what happens afterwards (fills, cancellations) through `broker.state` and `broker.event`.

Errors use the JSON-RPC codes: `-32700` parse error, `-32601` unknown method, `-32602` bad parameters, `-32004` unknown symbol (`data.symbolInfo`) and `-32005` busy, try again later (`data.bars`). Use `-32000` for anything else. The `message` is shown to the user.
