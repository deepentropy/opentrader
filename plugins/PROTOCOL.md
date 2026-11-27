# OpenTrader Plugin API

Plugin API version **12**. Version 2 adds `exchanges` (a data plugin serving several exchanges). Version 3 adds `password` settings, settings shown for another setting's value (`when`), a data folder for each plugin (`OPENTRADER_PLUGIN_DATA`), prompts to the user (`plugin.prompt`) and what the plugin is used for (`provides` in `plugin.configure`). Version 4 adds a data plugin's ready-made watchlists (`data.watchlists`). Version 5 adds a data plugin's symbol events: dividends, splits and earnings (`data.events`). Version 6 adds a symbol's extra series such as its open interest (`series`) and its instrument values (`fields`). Version 7 adds a broker's own tabs in the account manager, such as Holdings (`pages` in `broker.state`). Version 8 adds a data plugin's word that its symbols' info changed (`data.symbolInfoChanged`), short messages that go away by themselves (`plugin.toast`) and a data plugin's scripts (`data.scripts`). Version 9 adds the ticker a symbol trades as (`tradeTicker`). Version 10 adds what scripts read of an instrument (`root`, `expiration`, `isin`, `baseCurrency`, `country`, `sector`, `industry`, `volumeType`). Version 11 adds the bid and ask of a quote (`bid`, `ask`, `bidSize`, `askSize` in `data.quote`). Version 12 adds the app's server clock (`plugin.clock`) and a plugin's server time (`data.serverTime`). A plugin of an earlier version works unchanged.

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
| `settings` | Fields the user fills in under Settings > Plugins. `type` is `text`, `number`, `bool` (`"true"` / `"false"`), `select` or `password`. Values travel as text. A `password` is typed masked and kept in the system's credential store, not with the other settings; Settings never shows it again, only that one is saved (Plugin API 3). `"when": {"connection": ["direct"]}` shows a field only while each named setting has one of the listed values (Plugin API 3); a hidden field keeps its value and is still sent. |
| `platforms` | `windows`, `macos` and/or `linux`. Leave it empty for all platforms. |

### Runtime

There are two runtimes:

- **`process`**: OpenTrader starts `entry` (a path inside the package) while the plugin is enabled, and starts it again if it stops. The plugin finds its connection details in its environment: `OPENTRADER_PLUGIN_ADDR` (`127.0.0.1:<port>`), `OPENTRADER_PLUGIN_ID` and `OPENTRADER_PLUGIN_TOKEN`. `OPENTRADER_PLUGIN_DATA` is a folder for the plugin's own files (a login token, a cache): it is kept across updates and deleted when the plugin is removed (Plugin API 3). Its stdout and stderr go to the plugin's log in Settings.
- **`external`**: the plugin runs inside another application, such as a trading terminal, and connects by itself. With `"connectionFile": "<template>"`, OpenTrader writes this file while the plugin is enabled and deletes it when the plugin is disabled:

  ```json
  { "plugin": "example", "host": "127.0.0.1", "port": 47822, "token": "…", "api": 3 }
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
{"jsonrpc":"2.0","id":1,"result":{"app":"OpenTrader","api":3}}
```

Otherwise the answer is an error (code `-32001`, with a message to show the user), and the app closes the connection.

A newer connection of the same plugin replaces the older one. When the plugin is disabled, removed or given a new token, the app closes its connection.

### Always available

| Direction | Method | Kind | |
|---|---|---|---|
| plugin → app | `ping` | request | Answers `{}`. Use it to keep the connection alive and check that it is up. |
| plugin → app | `log` | notification | `{"level":"info"\|"warn"\|"error","message":"…"}`, shown in the plugin's log. |
| app → plugin | `plugin.configure` | notification | `{"settings":{"key":"value",…},"provides":["broker"]}`. Sent right after `hello`, before any other message, and whenever the user changes the settings. Fields the user left empty carry their manifest default. `provides` (Plugin API 3) is what the plugin is used for: a plugin that provides both can have its chart data or its trading turned off in Settings, and is then neither asked nor heard on those methods. Skip the work of what is off (a data login, quote streams). |
| plugin → app | `plugin.prompt` | notification | A dialog for the user (Plugin API 3), see below. |
| app → plugin | `plugin.promptAnswer` | notification | `{"id":"…","value":"…"}`: the user's answer to a prompt with an `input`; `value` is `null` when they cancelled. |
| plugin → app | `plugin.promptDone` | notification | `{"id":"…"}`: closes the prompt (what it waited for happened). |
| plugin → app | `plugin.toast` | notification | A short message that goes away by itself (Plugin API 8), see below. |
| app → plugin | `plugin.clock` | notification | The app's server clock (Plugin API 12), see below. |
| plugin → app | `data.serverTime` | notification | Your server's time (Plugin API 12), see below. |

### Server clock

The app keeps one clock for the market's time: the countdown, the market status, the session's day, and the time of a quote sent without one. It takes it from its own data server, so a computer whose clock is wrong still shows the right time. Between two readings it runs on its own, so a change of the computer's clock does not move it. Without a server time, it is the computer's clock.

`plugin.clock` (app → plugin, Plugin API 12) is sent after `plugin.configure` and whenever the clock moves by a second or more:

```json
{"time":1795783190223,"offset":3001,"source":"gateway"}
```

`time` is the server time (UNIX milliseconds) when it was sent, `offset` how far the computer's clock is behind it (milliseconds, negative when ahead), `source` where it came from (`"gateway"`, `"plugin"`, or `null` for the computer's clock). A plugin that stamps its quotes with the computer's clock adds `offset` to its times. Times the source gives (an exchange's time of a trade) need nothing.

`data.serverTime` (plugin → app, Plugin API 12): `{"time":1795783190223}`, your server's time in UNIX milliseconds, just read (from a connection's answer or messages). The app uses it when it has no time of its own data server: the app's comes first. Send it when you connect and every few minutes, not with every quote.

### Prompts

A plugin that needs the user, a login code for example, sends `plugin.prompt`:

```json
{"id":"p1","title":"Login code","message":"Type the code sent to your phone.","input":"text","image":null}
```

The app shows it as a dialog in its main window. `id` is the plugin's own. `input` is `"text"` or `"password"` for an answer field, or `null` for a message alone, with a Close button (a wait the user ends elsewhere, such as approving a login on a phone). `image` is an optional PNG, base64, shown above the field. The answer comes back in `plugin.promptAnswer`; a message alone gets none. The app closes a prompt on `plugin.promptDone`, and all of a plugin's prompts when it disconnects. The texts are shown as given: the app doesn't translate them.

### Toasts

A plugin tells the user that something happened, without stopping them, with `plugin.toast`:

```json
{"level":"info","message":"Instrument list reloaded","sound":false,"position":"top-right"}
```

The app shows it in its chart windows, under the plugin's name, and keeps it 10 seconds (25 for an `error`); nothing comes back. `level` is `info`, `warn` or `error` and picks the toast's colour (`info` when left out or unknown). `message` is a short text, shown as given and not translated, on 4 lines at most (the whole text when pointed at); a text over 300 characters is cut. With `"sound": true` the main window plays the alert sound (Thin), unless the sound of alerts is off in Settings > Alerts, at their volume. Any plugin may send it, data or broker, connected to a broker or not. The message is also written to the plugin's log.

`position` is where it shows: `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center` or `bottom-right` (`bottom-left` when left out or unknown). The user may pick one place for every plugin's toasts, or show none, in Settings > Plugins: a plugin can't change that. Several toasts at one place fold into the newest one and the errors, which always stay in view; the rest is under "Show more".

The same message (same level and text) sent again within 10 seconds counts on the toast shown ("×2") instead of adding one, and a plugin shows 5 new toasts of each level a minute at most: the others are only in its log. For an order use `broker.event`, for a line in the account manager's notifications `broker.notice`, and for a question `plugin.prompt`.

## Data plugins (`datafeed`)

The plugin's symbols are `<exchange>:<ticker>`. Charts, scripts, watchlists and alerts use them like any other symbol. The app asks the plugin with the bare `ticker`.

**Several exchanges.** A plugin with `exchanges` is asked with the whole symbol instead, since one ticker can trade on several of its exchanges: `"ticker":"NSE:RELIANCE"` in `data.symbolInfo`, `data.bars` and `data.subscribe`. It answers the same way: `data.quote` and the `data.search` rows carry whole symbols, and a row of an exchange it does not list is dropped. As a broker too, its positions, orders and executions use whole symbols, which open on the chart as they are.

A manifest may carry both `exchange` and `exchanges` to install on both versions: version 1 apps route `exchange` with bare tickers, version 2 apps route `exchanges` with whole symbols. The `hello` answer's `api` tells the plugin which one it speaks to.

Bars are `[time, open, high, low, close, volume]` arrays. `time` is the bar's start in UNIX seconds (UTC). A daily bar starts at its trading day's midnight in the symbol's time zone. `volume` may be omitted.

### `data.search` (app → plugin, request)

`{"query":"eur"}` → `{"symbols":[{"ticker":"EURUSD","description":"Euro vs US Dollar","type":"forex"}]}`

The query never holds the exchange: the app asks each plugin once and keeps the rows of the exchange the user typed (`NSE:REL`).

Return at most 50 matches; an empty query may return the most used symbols. `type` is one of `stock`, `fund`, `index`, `forex`, `crypto`, `futures`, `cfd`, `bond`, `option`. It picks the search tab the row appears under; another type is listed under All only, with the type as its label.

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
| `series` | Optional (Plugin API 6). The symbol's extra series, such as its open interest: `["OI"]`. See [Extra series](#extra-series). |
| `tradeTicker` | Optional (Plugin API 9), for a plugin that is also the broker: its ticker the symbol trades as, when it is another one. A continuous future gives its contract (`ESZ2026` for `ES1!`): the order ticket, the DOM, positions and orders of its charts use it. Send `data.symbolInfoChanged` when it changes. |
| `fields` | Optional (Plugin API 6). Values of the instrument to show with it: `[{"name":"Upper circuit","value":2950.5},{"name":"Price band","value":"10%"}]`. See [Instrument values](#instrument-values). |
| `root`, `expiration`, `isin`, `baseCurrency`, `country`, `sector`, `industry`, `volumeType` | Optional (Plugin API 10). What scripts read of the instrument (`syminfo.*`): the root of a future (`"NIFTY"` for `NIFTY26NOVFUT`; without it, the ticker without a continuous future's `1!` or a contract's month code and year), its last trading day (`"2026-11-25"`), the ISIN, the base currency (`"EUR"` of `EURUSD`; a forex pair of six letters gives it by itself), the two-letter code of the country it trades in, a company's sector and industry, and the unit of the volume (`"base"`, `"quote"`, `"tick"`; `"n/a"` when left out, except for crypto). A continuous future's `tradeTicker` is its `syminfo.current_contract`. A value left out that a symbol of its type has (a company's ISIN) stops a script that reads it with an error; one it doesn't have (a future's sector) reads as na. |

**Unknown symbols.** Answer a symbol you don't know (an expired contract, a renamed ticker) with the error code `-32004`. The app then stops asking for it and streaming it until the plugin connects again, and the watchlist shows it in red. Another error is taken as a failure of the moment. A plugin that cannot read its symbols yet (it waits for the user's login) sends `data.symbolInfoChanged` `{}` once it can: the symbols it answered unknown meanwhile are asked again. A change of the plugin's settings in the app does it too.

### `data.symbolInfoChanged` (plugin → app, notification)

Plugin API 8. The app keeps each symbol's info, and the symbols you answered unknown, until the plugin connects again. Send this when your reference data changed while connected (the day's instrument list reloaded, a setting that changes the symbols): `{}` for all of your symbols, or `{"tickers":["NIFTY26NOVFUT"]}` for some, with the tickers as the app asks them. The app drops what it kept of them, with their extra series, and asks `data.symbolInfo` again for the ones on screen; the symbols of other plugins are kept.

### Extra series

Data your source has besides a symbol's prices, as a time series: the open interest of a future or an option, a provider's own numbers. Each one is a symbol of its own, the symbol's name followed by `_` and the series name: the open interest of `NFO:NIFTY26NOVFUT` is `NFO:NIFTY26NOVFUT_OI`. List the names in the symbol's `series`:

```json
"series":["OI", {"name":"UC","description":"Upper circuit","intervals":["1D"],"pricescale":100}]
```

A name is letters and digits. Given alone, the series has the symbol's info: its sessions, time zone, currency, tick and intervals (ticks excepted), described as `<ticker> <name>`, and `OI` as `<ticker> Open Interest`. An object changes what differs: `description`, `intervals` (the open interest of a future often has daily values only: `["1D"]`), `pricescale`. The app doesn't ask `data.symbolInfo` for the series; you serve it like any symbol:

- `data.bars` with the series' ticker (`"ticker":"NIFTY26NOVFUT_OI"`, or `"NFO:NIFTY26NOVFUT_OI"` for a plugin of several exchanges): `[time, open, high, low, close]`. Give the same value four times when your source has one value per bar.
- `data.subscribe` lists it while a chart or a script reads it: send its `data.quote` with `minute` (and `day`) bars, `price` being the last value.

The series charts like a symbol, and scripts read it with `request.security(syminfo.tickerid + "_OI", timeframe.period, close)`. The built-in **Open Interest** indicator draws the `_OI` series of the chart's symbol: candles when its bars have open, high, low and close, a step line when they have one value; on an intraday chart, a series without intraday bars is shown with its daily values. A symbol that does not list a name may still be served under it: the app then asks its `data.symbolInfo` as for any symbol.

### Instrument values

What your source tells of an instrument beyond its prices: circuit limits, price bands, lot size, expiry. Send them as the `fields` of `data.symbolInfo`, `{"name":…, "value":…}` each, a number or a text. Symbol info lists them after the symbol's own fields, and the Details panel under the plugin's name, in the order given, as given (the app doesn't translate them). At most 50, names up to 64 characters, texts up to 200.

When a value changes during the day, send it in the symbol's `data.quote` (`"fields":[{"name":"Upper circuit","value":3010.0}]`): it replaces the value of that name, adds a name not sent before, and a `null` value removes it. A quote may carry `fields` alone, without `price`. Scripts don't read these values: to give scripts a value's history, serve it as an [extra series](#extra-series) too.

### `data.bars` (app → plugin, request)

`{"ticker":"EURUSD","resolution":"5","from":1730000000,"to":1730600000,"countBack":2000}` → `{"bars":[[1730000100,1.0812,1.0815,1.0809,1.0811,320],…]}`

Return the bars whose start is in `[from, to]`, oldest first. When there are more than `countBack`, return the newest `countBack` of them. You may return fewer, the newest ones: the app then asks for the older ones before the oldest bar you returned when the chart needs them. Return an empty list when there are none: the app reads that as the start of the history.

The app keeps a symbol's recent bars a while, so the chart, the Details panel and the quote of one symbol share one request; after that, it asks only for the bars from the last one it has. When your source is busy (rate limited), answer with the error code `-32005`: the app asks again later, waiting longer each time (1 s, then up to 15 s).

### `data.ticks` (app → plugin, request)

For a plugin that lists `"1T"` in `intervals`: the ticks of tick charts.

`{"ticker":"EURUSD","to":1730600123456,"countBack":20000}` → `{"ticks":[[1730600100015,1.08113,1],[1730600100230,1.08115,1],…]}`

A tick is `[time, price, volume]`: `time` in UNIX milliseconds, `price` the trade price (the bid when the source has no trades), `volume` the traded quantity (the tick count, 1, when the source has none). Return the newest `countBack` ticks whose time is before `to`, oldest first. Return fewer when the history ends there, an empty list when there are none. The app asks for older ticks, before the oldest you returned, when the chart scrolls back.

With `from` (UNIX milliseconds), return instead the first `countBack` ticks whose time is at or after `from` (and before `to`), oldest first: Bar Replay reads the ticks after its replay time this way. Fewer than `countBack` means there are no more ticks yet.

### `data.tick` (plugin → app, notification)

`{"ticker":"EURUSD","ticks":[[1730600123500,1.08116,1],[1730600123512,1.08117,1]]}`: every new tick of the tickers of `data.watchTicks`, in order. Group the ticks of a moment in one message, a few messages per second at most, and send them besides `data.quote`. A tick chart counts each tick it gets: a tick left out makes its bars longer.

### `data.watchTicks` (app → plugin, notification)

`{"tickers":["EURUSD"]}`: the whole set of tickers a tick chart shows, whose `data.tick` the app wants. An empty list stops them. The app sends it again after each `hello`.

### `data.subscribe` (app → plugin, notification)

`{"tickers":["EURUSD","XAUUSD"]}`: the whole set of tickers to stream from now on. It replaces the previous set, and an empty list stops streaming. The app sends it again after each `hello`, after `plugin.configure`. It is not sent again until the set changes: keep the whole set, even tickers you cannot serve yet (settings or symbol list still loading), and start streaming them once you can.

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
| `time` | When the price was quoted: the exchange's time when the source gives one, else the computer's clock plus the `offset` of `plugin.clock`. Left out, the app's server clock stamps it. On a seconds chart, the quote's price goes into the seconds bar of that time, with the volume the `minute` bar (else the `day` bar) gained since the quote before. |
| `day` | The forming daily bar. It updates daily, weekly and monthly charts. |
| `prevClose` | The previous session's close. It gives the change shown in watchlists. |
| `bid`, `ask`, `bidSize`, `askSize` | Optional (Plugin API 11): the best bid and ask and their sizes. A chart of the symbol draws them as its bid and ask lines and labels. Send them in each quote where they changed; a quote without them keeps the last ones. |
| `fields` | Optional: instrument values that changed (see [Instrument values](#instrument-values)). A quote of `fields` alone may leave out `price`. |

### `data.watchlists` (plugin → app, notification)

Ready-made watchlists of the plugin's symbols (Plugin API 4): the members of an index, the contracts of the month, a market segment.

```json
{"watchlists":[
  {"id":"nifty50","name":"NIFTY 50","symbols":["NSE:RELIANCE","NSE:TCS"],
   "sections":[{"name":"Banks","symbols":["NSE:HDFCBANK","NSE:ICICIBANK"]}]},
  {"id":"nifty-fut","name":"NIFTY futures","symbols":["NFO:NIFTY26NOVFUT","NFO:NIFTY26DECFUT"]}]}
```

Send the whole set once you know it (after `plugin.configure`, or once logged in), and again whenever it changes: it replaces the set sent before. The app keeps the last set while the plugin reconnects and forgets it when the plugin is turned off.

| Field | Meaning |
|---|---|
| `id` | Your id of the list, up to 64 characters. The same id sent again is the same list: the app brings it up to date. |
| `name` | Shown in the app (the id when left out). |
| `symbols` | The symbols with no section, shown first. |
| `sections` | Named groups of symbols, shown after them. Section names are shown in capitals. |

Symbols are whole (`NSE:RELIANCE`); a one-exchange plugin may give bare tickers. A symbol of an exchange the plugin does not serve is dropped, and so is a symbol already in the list. A list holds at most 1000 symbols and sections, a set 100 lists.

The Watchlists dialog (Open list…) shows the lists under the plugin's name. A list the user opens appears in the watchlist panel, read-only: the app brings it up to date from each set you send. A set that no longer holds it leaves it as it was, marked "no longer sent", with the user's favourite and alert, until a set holds it again; the user deletes it, and it goes when the plugin is removed. Keep a list's id the same across your versions. The user changes a copy of it ("Make a copy").

### `data.scripts` (plugin → app, notification)

OakScript studies and strategies of the plugin, with their source (Plugin API 8): the user adds them to a chart from the Indicators dialog, where they are listed under the plugin's name.

```json
{"scripts":[
  {"id":"pivot-study","name":"Pivot levels","kind":"indicator","source":"indicator(\"Pivot levels\", { overlay: true });
…"},
  {"id":"flow","name":"Flow","kind":"strategy","source":"strategy(\"Flow\");
…"}]}
```

Send the whole set once you know it (after `plugin.configure`, or once logged in), and again whenever it changes: it replaces the set sent before. The app keeps the last set while the plugin reconnects and forgets it when the plugin is turned off or stops serving chart data.

| Field | Meaning |
|---|---|
| `id` | Your id of the script: letters, digits, `.`, `_` and `-`, up to 64 characters. The same id sent again is the same script: a chart showing it runs the new source. A chart keeps the script by this id, so keep it when you change the source. |
| `name` | Shown in the Indicators dialog and the editor (the id when left out). |
| `kind` | `indicator` or `strategy`: how it goes on a chart before it was ever compiled (left out: a script whose line starts with `strategy(` is a strategy). |
| `source` | The script, as the OakScript editor takes it, up to 512 KB. |

A set holds at most 50 scripts; a script without an id or a source, or with an id already in the set, is dropped. A script runs like the user's own: on charts, in alerts, in the Strategy Tester and the screener. It is read-only: the editor shows its source (Source code… on its study) and offers "Make a copy" to change a copy. Studies of a script the plugin no longer sends stay in the user's layouts and draw nothing until it is sent again. Coding agents read the scripts through `list_scripts` and `read_script`.

### `data.events` (app → plugin, request)

The dividends, splits and earnings of a symbol (Plugin API 5). The chart marks them along its bottom when Chart settings > Events shows them, opens a card on a click, and scripts read them. The app asks once per symbol, and again after an hour.

```json
{"ticker":"RELIANCE"}
```

Answer:

```json
{"events":[
  {"type":"dividend","date":"2024-08-19","amount":10,"payDate":"2024-09-06"},
  {"type":"split","date":"2024-10-28","from":1,"to":2},
  {"type":"earnings","date":"2025-01-16","fiscalPeriod":"Q3","fiscalYear":2025,"periodEnd":"2024-12-31",
   "session":"amc","eps":13.7,"revenue":2.4e12,"currency":"INR"}]}
```

| Field | Meaning |
|---|---|
| `type` | `dividend`, `split` or `earnings`. An event of another type is ignored. |
| `date` | `YYYY-MM-DD`, the calendar day in the symbol's time zone: the ex-dividend date, the split's ex-date, the earnings release. The marker sits on that day's bar. |
| `amount`, `payDate` | Dividend: the cash amount per share (required) and the payment date. |
| `from`, `to` | Split: the shares before and after (required, above 0). A 4-for-1 split is `1` → `4`, a 1-for-10 reverse split `10` → `1`. A **bonus issue** is a split: a 1:1 bonus is `1` → `2`. Any other event that adjusts the price history (a rights issue) may be sent as the split of its adjustment factor, for example `1000` → `1009`. |
| `fiscalPeriod`, `fiscalYear` | Earnings: the period (`Q1`…`Q4`, `H1`, `FY`) and its fiscal year, shown as the marker's caption (`Q3 '25`). |
| `periodEnd` | Earnings: the last day of the period (`YYYY-MM-DD`). |
| `session` | Earnings: `bmo` (before the market opens) or `amc` (after it closes), when known. |
| `eps`, `revenue`, `currency` | Earnings: the reported diluted EPS and revenue, and their currency. |

Every field but `type` and `date` is optional unless marked required; an event missing a required field is dropped. Send at most 5000 events per symbol, in any order. Bars are not adjusted by the app: send them as your source adjusts them.

Answer `-32601` (method not found) if you have no events: the app asks no more until the plugin connects again. `-32004` for an unknown symbol, or `{"events":[]}`, means none.

### `data.eventsChanged` (plugin → app, notification)

Some symbols' events changed (a new dividend announced, an event cancelled): `{"tickers":["RELIANCE"]}`, with the tickers as the app asks them. Without `tickers`, all of the plugin's symbols changed. The app drops what it kept and asks `data.events` again for the charts that show them.

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

**Ticket fields.** A broker that needs a choice with each order that the app doesn't have (a product type: intraday, delivery, carry forward…; a route; trading outside regular hours) declares it in `capabilities.ticketFields`, or per ticker in `broker.instrument`. The order ticket shows each field in its Extra settings, as a selector or, with `"type": "checkbox"`, as a checkbox whose value is `"true"` or `"false"`, and sends the values picked in `fields`; the chart's one-click orders send the last values picked. A field with `orderTypes` is only shown and sent for those order types; a field with `"exit": "takeProfit"` or `"exit": "stopLoss"` (outside regular hours for the take profit…) only while the order has that exit. A modified order keeps the fields it was placed with, from `orders[].fields`.

**Order preview.** A broker that can tell what an order would do before it is sent (its commission, the margin before and after) declares `"orderPreview": true` in `capabilities`. With the ticket's "Show order confirmation" on (the default), the ticket's Buy / Sell asks `broker.previewOrder` with the order, then shows a confirmation page: the broker's errors and warnings, the quotes, the order and the broker's own tables, and Send Order / Cancel. Send Order then sends `broker.place`, with the preview's `confirmId` when it gave one. An error answer is shown in the ticket and nothing is sent.

**Exit levels.** A broker that lets an order or a position close in parts, each part with its own take profit and stop loss, declares `"exitLevels": true` in `capabilities` (and `maxExitLevels`, 8 when left out). The order ticket then offers "Add level", and the chart adds a level when the user drags a take profit or stop loss out of an order or position that has its exits (Settings > Trading > Multiple exit levels). An order or a position with levels carries them in `exitLevels`, `[{"id":"1","qty":1000,"takeProfit":1.09,"stopLoss":1.07}]`, in place of `takeProfit` / `stopLoss` (null then): `broker.place`, `broker.modify` and `broker.setPositionBrackets` send them, `orders[]` and `positions[]` report them. Each level is an exit of its own `qty` with its take profit and stop loss; together the levels protect at most the order's or the position's quantity. When one fills, it is gone and the others stay; when the position closes, they all go. Give each level an `id` that stays the same from one state to the next: the chart's lines follow it. The app sends levels without ids, the whole list each time: the plugin replaces the levels it had. A change the broker cannot make (a level's quantity on an open position, when each level is a position of its own) is refused with an error that says what can be done: the app shows it and keeps the levels the plugin reports. Without `exitLevels`, nothing changes: one take profit and one stop loss.

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
| `capabilities.ticketFields` | The broker's own choices for each order, for example `[{"id":"product","label":"Product","options":[{"value":"MIS","label":"Intraday"},{"value":"CNC","label":"Delivery"}],"default":"MIS"}]` or `[{"id":"outsideRth","label":"Fill order outside RTH","type":"checkbox","orderTypes":["limit"]}, {"id":"tpOutsideRth","label":"Fill take profit outside RTH","type":"checkbox","exit":"takeProfit"}]`. `type` is `select` (when left out) or `checkbox`. `default` is the value picked at first (the first option, `"false"` for a checkbox, when left out). `orderTypes` are the order types it applies to (all when left out); `exit` (`takeProfit` or `stopLoss`) shows it only while the order has that exit. Leave it out or empty when there are none. |
| `capabilities.orderPreview` | `true`: the broker answers `broker.previewOrder`, and the ticket shows the order confirmation page. `false` when left out. |
| `capabilities.exitLevels`, `maxExitLevels` | `true`: orders and positions take exit levels (see Exit levels), at most `maxExitLevels` (8 when left out). `false` when left out. |
| `capabilities.durations` | The times in force the broker takes: `id` goes with the order and comes back in `orders[].duration`, `label` is what the ticket shows (the id when left out), `orderTypes` the order types it applies to (all when left out), `default: true` marks the one picked at first (else the first that applies). Leave it out or empty to keep the broker's own. |
| `capabilities` price rules | The app refuses an order price that would surprise the user before it reaches the broker: a price that is not a whole number of ticks, a stop on the wrong side of the market (a buy stop below the ask, a sell stop above the bid: it would trigger at once; the same for the stop of a stop limit), and a limit more than half the market price on the wrong side. A marketable limit (a buy limit above the ask) is sent. Declare `"stopOrdersBothSides": true` or `"stopLimitOrdersBothSides": true` if your broker takes stops on either side, `"strictLimitPrice": true` if it refuses any limit that crosses the market. All three are `false` when left out. Your broker still has the last word: refuse what it doesn't take with an error. |
| `orders[].duration` | The order's time in force, a `durations` id: shown in the account manager and sent back by `broker.modify`. |
| `orders[].takeProfit`, `stopLoss` | The brackets an order opens its position with. |
| `orders[].fields` | The ticket fields' values the order was placed with (`{"product":"CNC"}`): `broker.modify` sends them back. |
| `positions[].takeProfit`, `stopLoss` | A position's brackets. |
| `orders[].exitLevels`, `positions[].exitLevels` | Their exit levels, in place of `takeProfit` / `stopLoss`: `[{"id","qty","takeProfit","stopLoss"}]`. |
| `pages` | Optional (Plugin API 7). The broker's own tabs in the account manager, such as Holdings. See [Broker pages](#broker-pages). |

### Broker pages

A broker with account data the app's tabs don't hold (holdings, funds, a margin breakdown) sends it as its own tabs in `pages`, part of `broker.state`. They show after Trade history, in the order sent, with the same tables as the app's own tabs: sorting, Column setup, Download data. Send the whole page again with each `broker.state`, as for orders; the app asks for the state when the account manager opens, so the user sees the broker's latest values there.

```json
"pages": [{
  "id": "holdings", "title": "Holdings", "counter": true,
  "tables": [{
    "id": "main",
    "columns": [
      { "id": "symbol", "label": "Symbol", "format": "symbol" },
      { "id": "qty", "label": "Quantity", "format": "qty" },
      { "id": "avgPrice", "label": "Avg price", "format": "price" },
      { "id": "last", "label": "Last price", "format": "price" },
      { "id": "invested", "label": "Invested", "format": "money" },
      { "id": "value", "label": "Current value", "format": "money" },
      { "id": "pnl", "label": "Unrealized P&L", "format": "pnl" },
      { "id": "pnlPct", "label": "Unrealized P&L %", "format": "pnlPercent" },
      { "id": "isin", "label": "ISIN", "hidden": true }
    ],
    "sort": { "column": "value", "asc": false },
    "rows": [{ "id": "RELIANCE", "symbol": "NSE:RELIANCE", "qty": 10, "avgPrice": 2450.5, "last": 2512.3,
               "invested": 24505, "value": 25123, "pnl": 618, "pnlPct": 2.52, "isin": "INE002A01018" }]
  }]
}]
```

| Field | Meaning |
|---|---|
| `id`, `title` | The page's id (kept with the user's column choices) and its tab's title, shown as written. |
| `counter` | The tab shows its number of rows, as Positions does. |
| `tables` | One table, or several: each is then shown under its `title`. A table's `id` keeps the user's column order, shown columns and sort. |
| `columns[].format` | How the values show: `text` (when left out), `symbol` (a ticker of the broker's, as in `positions[].ticker`: the row click shows it on the chart and the table's prices take its tick), `side` (`buy` / `sell`), `qty`, `price`, `money` (the account's currency), `pnl` (signed, green or red), `percent`, `pnlPercent` (signed, green or red), `number` or `time` (UNIX milliseconds). The first `symbol` column stays first. |
| `columns[].hidden` | Shown only once the user picks it in Column setup. |
| `sort` | The rows' order until the user sorts the table: `column` and `asc` (`true` when left out). |
| `rows` | One object per row: a column `id` to a number or a text, `null` or left out when empty. A text in a number column shows as it is. `id` keys the row. |

The labels and texts are shown as the plugin writes them, not translated. A page that doesn't read (a missing `id`, `title` or `tables`) is left out; the rest of the state still reads.

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
| `broker.instrument` | `{"ticker":"NIFTY25NOVFUT"}` | How the ticker trades, every field optional: `{"qtyMin":65,"qtyStep":65,"qtyMax":1800,"pointValue":1,"ticketFields":[…]}`. `qtyStep` is the lot in units; orders are whole multiples of it. `pointValue` is the money one unit makes when the price moves by 1 (a futures multiplier; 1 when left out): the ticket's risk sizing and tick value use it. `ticketFields` and `durations` replace the capabilities' for this ticker. `marginRate` is the margin an order takes as a share of its value (0.05 for a leverage of 1:20): the ticket then shows the order's trade value with the leverage ("Trade value (20x)") and the account's `marginFree` ("Available margin"). Asked once per ticker and connection. Optional: a plugin that answers `-32601` trades any quantity with a point value of 1. |
| `broker.selectAccount` | `{"account":"51234567"}` | `{}`. Then send the new account's `broker.state`. |
| `broker.place` | `{"ticker","side","type","qty","limitPrice","stopPrice","takeProfit","stopLoss","fields","duration","confirmId","exitLevels"}` | `{"orderId":"8813"}`. An error answer is shown as a rejected order with its message. `fields` holds the ticket fields' values (`{"product":"CNC"}`), `{}` without any. `duration` is a `durations` id, left out when the broker declares none. `confirmId` is the preview's, for an order the user confirmed on the confirmation page; left out otherwise. |
| `broker.previewOrder` | the same as `broker.place`, without `confirmId` | What the order would do, nothing placed: `{"sections":[{"rows":[{"label":"Commission","value":"1.00","currency":"USD"}]},{"title":"Initial margin","rows":[{"label":"Current","value":"0.00"},{"label":"Change","value":"262.38"},{"label":"After","value":"262.38"}]}],"warnings":["…"],"errors":[],"confirmId":"p-17"}`. Every field optional. Rows show as written (`currency` in small letters after the value); `warnings` show above them; `errors` mean the broker would refuse the order: they are shown and Send Order is off. Only asked of a broker with `capabilities.orderPreview`. |
| `broker.modify` | the same as `broker.place`, plus `"orderId"` | `{}` |
| `broker.cancel` | `{"orderId":"8813"}` | `{}` |
| `broker.closePosition` | `{"positionId":"8812","qty":null}` | `{}`. `qty` null closes the whole position. |
| `broker.setPositionBrackets` | `{"positionId":"8812","takeProfit":1.09,"stopLoss":null}`, or `{"positionId","takeProfit":null,"stopLoss":null,"exitLevels":[{"qty","takeProfit","stopLoss"}]}` | `{}`. A null removes that bracket. With `exitLevels` the position's levels are those (they replace its take profit / stop loss); both prices null and no `exitLevels` remove every exit. |

There are also two notifications (app → plugin), each with the whole set of tickers the app wants; an empty list stops them:

- `broker.watchQuote`: `{"tickers":["EURUSD"]}`, the tickers whose `broker.quote` the order ticket shows;
- `broker.watchDepth`: `{"tickers":["EURUSD"]}`, the tickers whose `broker.depth` the DOM tab shows, while it is open.

Answer a request once the broker has accepted or refused it. Report what happens afterwards (fills, cancellations) through `broker.state` and `broker.event`.

Errors use the JSON-RPC codes: `-32700` parse error, `-32601` unknown method, `-32602` bad parameters, `-32004` unknown symbol (`data.symbolInfo`) and `-32005` busy, try again later (`data.bars`). Use `-32000` for anything else. The `message` is shown to the user.
