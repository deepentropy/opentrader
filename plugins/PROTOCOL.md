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
| `pricescale`, `minmov` | One tick is `minmov / pricescale`. For example, 100000 and 1 give 0.00001. |
| `intervals` | The resolutions served: minutes (`"1"`, `"5"`, `"60"`…), seconds (`"1S"`…), `"1D"`, `"1W"`, `"1M"`. Other minute or second sizes are built by the app from the largest served size that divides them, on the clock grid. Weeks and months are built from days. The interval picker offers only these; another interval shows that it is not supported. |

### `data.bars` (app → plugin, request)

`{"ticker":"EURUSD","resolution":"5","from":1730000000,"to":1730600000,"countBack":2000}` → `{"bars":[[1730000100,1.0812,1.0815,1.0809,1.0811,320],…]}`

Return the bars whose start is in `[from, to]`, oldest first. When there are more than `countBack`, return the newest `countBack` of them. Return an empty list when there are none: the app reads that as the start of the history.

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

**Quantities** are in units: shares, currency units, contracts. A broker that counts lots converts. With a contract size of 100,000, 0.01 lot is 1,000 units.

### `broker.state` (plugin → app, notification)

The whole account. Send it once after `hello`, then whenever any part changes: an order, a fill, a position, the balance or the P&L. A few per second are fine.

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
                    "positionBrackets": true, "partialClose": true, "modifyOrders": true },
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
| `orders[].takeProfit`, `stopLoss` | The brackets an order opens its position with. |
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

### Requests (app → plugin)

| Method | Params | Result |
|---|---|---|
| `broker.resolveSymbol` | `{"symbol":"NASDAQ:AAPL","ticker":"AAPL"}` | `{"ticker":"AAPL.US"}`, or `{"ticker":null}` when the broker doesn't trade it. |
| `broker.selectAccount` | `{"account":"51234567"}` | `{}`. Then send the new account's `broker.state`. |
| `broker.place` | `{"ticker","side","type","qty","limitPrice","stopPrice","takeProfit","stopLoss"}` | `{"orderId":"8813"}`. An error answer is shown as a rejected order with its message. |
| `broker.modify` | the same as `broker.place`, plus `"orderId"` | `{}` |
| `broker.cancel` | `{"orderId":"8813"}` | `{}` |
| `broker.closePosition` | `{"positionId":"8812","qty":null}` | `{}`. `qty` null closes the whole position. |
| `broker.setPositionBrackets` | `{"positionId":"8812","takeProfit":1.09,"stopLoss":null}` | `{}`. A null removes that bracket. |

There is also one notification, `broker.watchQuote` (app → plugin): `{"tickers":["EURUSD"]}`, the whole set of tickers whose `broker.quote` the app wants. An empty list stops them.

Answer a request once the broker has accepted or refused it. Report what happens afterwards (fills, cancellations) through `broker.state` and `broker.event`.

Errors use the JSON-RPC codes: `-32700` parse error, `-32601` unknown method, `-32602` bad parameters. Use `-32000` for anything else. The `message` is shown to the user.
