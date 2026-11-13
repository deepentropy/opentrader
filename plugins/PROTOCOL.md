# OpenTrader Plugin API

Plugin API version **1**.

A plugin is a program outside OpenTrader that supplies:

- **market data**: symbols, bars and live ticks. This is the `datafeed` capability.
- **a broker account**: positions, orders, executions and order commands. This is the `broker` capability.

A plugin can provide either capability or both. It connects to the app over a local socket.

Users install plugins from **Settings > Plugins**, either from the catalog or from a file. OpenTrader ships no plugin code of its own.

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
| `exchange` | Required for a data plugin. Its symbols are `<exchange>:<ticker>`, for example `EXAMPLE:EURUSD`. Use 2 to 16 uppercase letters, digits and `_`. `LOCAL` and `ECONOMICS` are reserved. |
| `runtime` | How the plugin runs (see below). |
| `install` | Files to copy into a folder the user picks (see below). |
| `settings` | Fields the user fills in under Settings > Plugins. `type` is `text`, `number`, `bool` (`"true"` / `"false"`) or `select`. Values travel as text. |
| `platforms` | `windows`, `macos` and/or `linux`. Leave it empty for all platforms. |

### Runtime

There are two runtimes:

- **`process`**: OpenTrader starts `entry` (a path inside the package) while the plugin is enabled, and starts it again if it stops. The plugin finds its connection details in its environment: `OPENTRADER_PLUGIN_ADDR` (`127.0.0.1:<port>`), `OPENTRADER_PLUGIN_ID` and `OPENTRADER_PLUGIN_TOKEN`. Its stdout and stderr go to the plugin's log in Settings.
- **`external`**: the plugin runs inside another application, such as a trading terminal, and connects by itself. With `"connectionFile": "<template>"`, OpenTrader writes this file while the plugin is enabled and deletes it when the plugin is disabled:

  ```json
  { "plugin": "example", "host": "127.0.0.1", "port": 47822, "token": "…", "api": 1 }
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
{"jsonrpc":"2.0","id":1,"result":{"app":"OpenTrader","api":1}}
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

Bars are `[time, open, high, low, close, volume]` arrays. `time` is the bar's start in UNIX seconds (UTC). A daily bar starts at its trading day's midnight in the symbol's time zone. `volume` may be omitted.

### `data.search` (app → plugin, request)

`{"query":"eur"}` → `{"symbols":[{"ticker":"EURUSD","description":"Euro vs US Dollar","type":"forex"}]}`

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
| `intervals` | The resolutions served: minutes (`"1"`, `"5"`, `"60"`…), seconds (`"1S"`…), `"1D"`, `"1W"`, `"1M"`. Other minute or second sizes are built by the app from the largest served size that divides them, on the clock grid. Weeks and months are built from days. |

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

Errors use the JSON-RPC codes: `-32700` parse error, `-32601` unknown method, `-32602` bad parameters. Use `-32000` for anything else. The `message` is shown to the user.
