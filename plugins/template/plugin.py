#!/usr/bin/env python3
"""OpenTrader plugin template: a data feed and a broker in one file, Python standard library only.

It runs as it is against a simulated market and account, so you can see every part working in OpenTrader before
you change anything. To make it yours, replace the `Source` class with calls to your data or broker API; the rest
(connection, JSON-RPC, streaming) stays as it is. The protocol is described in plugins/PROTOCOL.md.

Run it:
  - during development:  python plugin.py           (reads the connection file the app writes, see README)
  - when installed:      the app starts the built executable and passes the connection in the environment.
"""
import json
import math
import os
import socket
import sys
import threading
import time

PLUGIN_ID = "template"  # the manifest's id
PLUGIN_VERSION = "0.1.0"
API = 2  # the Plugin API version this plugin speaks
EXCHANGE = "TEMPLATE"  # the manifest's exchange: symbols show as TEMPLATE:EURUSD
DEV_CONNECTION_FILE = "OpenTraderPlugins/template-dev.json"  # under {localAppData}, as in opentrader-plugin.dev.json


# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
# 1. The source. Replace this class with your API. Every method is called from the app's requests; keep the same
#    return shapes. Prices are floats, times UNIX seconds (bars, quotes) or milliseconds (account state).
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


class PluginError(Exception):
    """An error answered to the app; `message` is shown to the user."""

    def __init__(self, message, code=-32000):
        super().__init__(message)
        self.code = code


class Source:
    # ticker: description, type, base price, pricescale (one tick = 1 / pricescale), currency
    SYMBOLS = {
        "EURUSD": ("Euro vs US Dollar", "forex", 1.08, 100000, "USD"),
        "XAUUSD": ("Gold vs US Dollar", "cfd", 2650.0, 100, "USD"),
        "DEMOCO": ("Demo Company Inc.", "stock", 42.0, 100, "USD"),
    }
    RESOLUTIONS = {"1": 60, "5": 300, "15": 900, "60": 3600, "1D": 86400}

    def __init__(self):
        self.lock = threading.Lock()
        self.settings = {}
        self.balance = 100_000.0
        self.realized = 0.0
        self.next_id = 1000
        self.positions = {}  # ticker -> {"id","ticker","side","qty","avgPrice","takeProfit","stopLoss"} (netting)
        self.orders = {}  # id -> order dict as broker.state lists it
        self.executions = []

    def configure(self, settings):
        """The user's values of the manifest's settings (all strings)."""
        self.settings = settings

    # ── market data ──
    def _info(self, ticker):
        if ticker not in self.SYMBOLS:
            raise PluginError(f"Unknown symbol {ticker}", -32602)
        return self.SYMBOLS[ticker]

    def price(self, ticker, t):
        """A made-up price path, the same for bars and live quotes."""
        base = self._info(ticker)[2]
        scale = self._info(ticker)[3]
        p = base * (1 + 0.01 * math.sin(t / 7200.0) + 0.002 * math.sin(t / 300.0) + 0.0005 * math.sin(t / 37.0))
        return round(p * scale) / scale

    def _bar(self, ticker, start, step):
        points = [self.price(ticker, start + i * step // 8) for i in range(9)]
        return [start, points[0], max(points), min(points), points[-1], 100 + start % 900]

    def search(self, query):
        q = query.upper()
        return [
            {"ticker": t, "description": d, "type": kind}
            for t, (d, kind, *_rest) in self.SYMBOLS.items()
            if q in t or q in d.upper()
        ]

    def symbol_info(self, ticker):
        description, kind, _base, scale, currency = self._info(ticker)
        return {
            "description": description,
            "type": kind,
            "currency": currency,
            "timezone": "Etc/UTC",
            "session": "24x7",
            "pricescale": scale,
            "minmov": 1,
            "intervals": list(self.RESOLUTIONS),
        }

    def bars(self, ticker, resolution, frm, to, count_back):
        step = self.RESOLUTIONS.get(resolution)
        if step is None:
            raise PluginError(f"Resolution {resolution} is not served", -32602)
        self._info(ticker)
        last = min(to, int(time.time())) // step * step
        first = max(frm // step * step, last - (count_back - 1) * step)
        return [self._bar(ticker, t, step) for t in range(first, last + 1, step)]

    def quote(self, ticker):
        now = int(time.time())
        price = self.price(ticker, now)
        minute = self._bar(ticker, now // 60 * 60, 60)
        day = self._bar(ticker, now // 86400 * 86400, 86400)
        minute[4] = day[4] = price
        return {"ticker": ticker, "time": now, "price": price, "prevClose": self.price(ticker, now // 86400 * 86400 - 1),
                "minute": minute, "day": day}

    # ── broker ──
    def resolve_symbol(self, symbol, ticker):
        """The broker ticker of a chart symbol from another exchange (e.g. NASDAQ:AAPL), or None."""
        return ticker if ticker in self.SYMBOLS else None

    def _id(self):
        self.next_id += 1
        return str(self.next_id)

    def _fill(self, ticker, side, qty, price, order_id, tp=None, sl=None):
        """A fill moves the position (netting: one position per ticker) and books the realized P&L."""
        now_ms = int(time.time() * 1000)
        pos = self.positions.get(ticker)
        signed = qty if side == "buy" else -qty
        realized = 0.0
        if pos is None:
            self.positions[ticker] = {"id": self._id(), "ticker": ticker, "side": side, "qty": qty, "avgPrice": price,
                                      "takeProfit": tp, "stopLoss": sl}
        else:
            held = pos["qty"] if pos["side"] == "buy" else -pos["qty"]
            total = held + signed
            if held * signed > 0:  # adding
                pos["avgPrice"] = (pos["avgPrice"] * abs(held) + price * qty) / abs(total)
                pos["qty"] = abs(total)
            else:  # reducing, closing or reversing
                closed = min(abs(held), qty)
                realized = closed * (price - pos["avgPrice"]) * (1 if held > 0 else -1)
                if total == 0:
                    del self.positions[ticker]
                elif total * held > 0:
                    pos["qty"] = abs(total)
                else:
                    self.positions[ticker] = {"id": self._id(), "ticker": ticker, "side": side, "qty": abs(total),
                                              "avgPrice": price, "takeProfit": tp, "stopLoss": sl}
        self.realized += realized
        self.balance += realized
        self.executions.append({"id": self._id(), "orderId": order_id, "ticker": ticker, "side": side, "qty": qty,
                                "price": price, "timeMs": now_ms, "commission": 0, "realizedPnl": realized})
        return realized

    def place(self, p):
        """`broker.place`: returns the order id, raises PluginError to refuse (shown as a rejected order)."""
        ticker, side, kind, qty = p["ticker"], p["side"], p["type"], float(p["qty"] or 0)
        self._info(ticker)
        if qty <= 0:
            raise PluginError("The quantity must be above 0", -32602)
        order_id = self._id()
        order = {"id": order_id, "ticker": ticker, "side": side, "type": kind, "qty": qty, "filledQty": 0,
                 "limitPrice": p.get("limitPrice"), "stopPrice": p.get("stopPrice"),
                 "takeProfit": p.get("takeProfit"), "stopLoss": p.get("stopLoss"), "status": "working",
                 "duration": "gtc", "updatedMs": int(time.time() * 1000)}
        self.orders[order_id] = order
        events = [{"kind": "placed", "ticker": ticker, "side": side, "type": kind, "qty": qty}]
        if kind == "market":
            events += self._execute(order, self.price(ticker, time.time()))
        return order_id, events

    def _execute(self, order, price):
        order.update(status="filled", filledQty=order["qty"], avgFillPrice=price, updatedMs=int(time.time() * 1000))
        self._fill(order["ticker"], order["side"], order["qty"], price, order["id"], order.get("takeProfit"), order.get("stopLoss"))
        return [{"kind": "executed", "ticker": order["ticker"], "side": order["side"], "type": order["type"],
                 "qty": order["qty"], "price": price}]

    def modify(self, p):
        order = self.orders.get(p["orderId"])
        if not order or order["status"] != "working":
            raise PluginError("The order is no longer working")
        for k in ("qty", "limitPrice", "stopPrice", "takeProfit", "stopLoss"):
            if k in p:
                order[k] = p[k]
        order["updatedMs"] = int(time.time() * 1000)
        return [{"kind": "modified", "ticker": order["ticker"], "side": order["side"], "type": order["type"], "qty": order["qty"]}]

    def cancel(self, order_id):
        order = self.orders.get(order_id)
        if not order or order["status"] != "working":
            raise PluginError("The order is no longer working")
        order.update(status="cancelled", updatedMs=int(time.time() * 1000))
        return [{"kind": "cancelled", "ticker": order["ticker"], "side": order["side"], "type": order["type"], "qty": order["qty"]}]

    def close_position(self, position_id, qty):
        pos = next((x for x in self.positions.values() if x["id"] == position_id), None)
        if pos is None:
            raise PluginError("No such position")
        amount = min(float(qty), pos["qty"]) if qty else pos["qty"]
        side = "sell" if pos["side"] == "buy" else "buy"
        order_id, events = self.place({"ticker": pos["ticker"], "side": side, "type": "market", "qty": amount})
        return events

    def set_position_brackets(self, position_id, take_profit, stop_loss):
        pos = next((x for x in self.positions.values() if x["id"] == position_id), None)
        if pos is None:
            raise PluginError("No such position")
        pos["takeProfit"], pos["stopLoss"] = take_profit, stop_loss

    def on_tick(self):
        """Called every second: working orders and position brackets that the price reached fill."""
        events = []
        for order in list(self.orders.values()):
            if order["status"] != "working" or order["type"] == "market":
                continue
            px = self.price(order["ticker"], time.time())
            buy = order["side"] == "buy"
            limit_hit = order["type"] == "limit" and (px <= order["limitPrice"] if buy else px >= order["limitPrice"])
            stop_hit = order["type"] in ("stop", "stopLimit") and (px >= order["stopPrice"] if buy else px <= order["stopPrice"])
            if limit_hit or stop_hit:
                events += self._execute(order, px)
        for pos in list(self.positions.values()):
            px = self.price(pos["ticker"], time.time())
            long = pos["side"] == "buy"
            tp, sl = pos.get("takeProfit"), pos.get("stopLoss")
            if (tp is not None and (px >= tp if long else px <= tp)) or (sl is not None and (px <= sl if long else px >= sl)):
                events += self.close_position(pos["id"], None)
        return events

    def state(self):
        """The whole account, as `broker.state` sends it."""
        now = time.time()
        positions = []
        unrealized = 0.0
        for pos in self.positions.values():
            last = self.price(pos["ticker"], now)
            pnl = pos["qty"] * (last - pos["avgPrice"]) * (1 if pos["side"] == "buy" else -1)
            unrealized += pnl
            positions.append({**pos, "last": last, "unrealizedPnl": round(pnl, 2)})
        account = {"id": "DEMO-1", "name": "Demo account", "currency": "USD", "isDemo": True,
                   "balance": round(self.balance, 2), "equity": round(self.balance + unrealized, 2),
                   "unrealizedPnl": round(unrealized, 2), "realizedPnl": round(self.realized, 2),
                   "marginUsed": 0, "marginFree": round(self.balance + unrealized, 2),
                   "values": [{"label": "Mode", "value": "Simulated"}]}
        return {
            "connected": True,
            "accounts": [{"id": account["id"], "name": account["name"]}],
            "account": account,
            "positionMode": "netting",
            "capabilities": {"orderTypes": ["market", "limit", "stop"], "brackets": True, "positionBrackets": True,
                             "partialClose": True, "modifyOrders": True},
            "positions": positions,
            "orders": sorted(self.orders.values(), key=lambda o: o["updatedMs"])[-200:],
            "executions": self.executions[-200:],
        }


# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
# 2. The connection to OpenTrader. You should not need to change anything below.
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def local_app_data():
    if sys.platform == "win32":
        return os.environ["LOCALAPPDATA"]
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support")
    return os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")


def connection():
    """Where to connect: the environment when the app started us, else the connection file (development)."""
    addr = os.environ.get("OPENTRADER_PLUGIN_ADDR")
    if addr:
        host, port = addr.rsplit(":", 1)
        return host, int(port), os.environ["OPENTRADER_PLUGIN_ID"], os.environ["OPENTRADER_PLUGIN_TOKEN"]
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(local_app_data(), DEV_CONNECTION_FILE)
    with open(path, encoding="utf-8") as f:
        c = json.load(f)
    return c["host"], int(c["port"]), c["plugin"], c["token"]


class Plugin:
    def __init__(self, source):
        self.source = source
        self.sock = None
        self.send_lock = threading.Lock()
        self.tickers = set()  # data.subscribe
        self.watched = set()  # broker.watchQuote
        self.alive = False

    # ── JSON-RPC ──
    def send(self, message):
        line = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        with self.send_lock:
            self.sock.sendall(line)

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def log(self, message, level="info"):
        """A line in the plugin's log in Settings (stdout reaches it too, but without a level)."""
        if self.alive:
            self.notify("log", {"level": level, "message": message})
        else:
            print(message, flush=True)

    def push_state(self):
        with self.source.lock:
            state = self.source.state()
        self.notify("broker.state", state)

    def events(self, events):
        for e in events:
            self.notify("broker.event", e)
        if events:
            self.push_state()

    def handle(self, method, p):
        """One request of the app: returns its result or raises."""
        s = self.source
        with s.lock:
            if method == "data.search":
                return {"symbols": s.search(p.get("query", ""))[:50]}
            if method == "data.symbolInfo":
                return s.symbol_info(p["ticker"])
            if method == "data.bars":
                return {"bars": s.bars(p["ticker"], p["resolution"], int(p["from"]), int(p["to"]), int(p.get("countBack", 2000)))}
            if method == "broker.resolveSymbol":
                return {"ticker": s.resolve_symbol(p.get("symbol"), p.get("ticker"))}
            if method == "broker.selectAccount":
                return {}
            if method == "broker.place":
                order_id, events = s.place(p)
            elif method == "broker.modify":
                order_id, events = None, s.modify(p)
            elif method == "broker.cancel":
                order_id, events = None, s.cancel(p["orderId"])
            elif method == "broker.closePosition":
                order_id, events = None, s.close_position(p["positionId"], p.get("qty"))
            elif method == "broker.setPositionBrackets":
                s.set_position_brackets(p["positionId"], p.get("takeProfit"), p.get("stopLoss"))
                order_id, events = None, []
            else:
                raise PluginError(f"Unknown method {method}", -32601)
        self.events(events)
        if not events:
            self.push_state()
        return {"orderId": order_id} if method == "broker.place" else {}

    def on_request(self, message):
        try:
            result = self.handle(message["method"], message.get("params") or {})
            self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        except PluginError as e:
            self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": e.code, "message": str(e)}})
        except (KeyError, TypeError, ValueError) as e:
            self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32602, "message": f"Bad parameters: {e}"}})
        except Exception as e:  # noqa: BLE001 - any failure is answered, never left hanging
            self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(e)}})

    def on_notification(self, method, p):
        if method == "plugin.configure":
            with self.source.lock:
                self.source.configure(p.get("settings", {}))
        elif method == "data.subscribe":
            self.tickers = set(p.get("tickers", []))
        elif method == "broker.watchQuote":
            self.watched = set(p.get("tickers", []))

    # ── streaming: live prices, the ticket's bid / ask, orders reaching their price ──
    def stream(self):
        while self.alive:
            try:
                with self.source.lock:
                    quotes = [self.source.quote(t) for t in self.tickers | self.watched if t in self.source.SYMBOLS]
                    events = self.source.on_tick()
                for q in quotes:
                    if q["ticker"] in self.tickers:
                        self.notify("data.quote", q)
                    if q["ticker"] in self.watched:
                        tick = 1 / self.source.SYMBOLS[q["ticker"]][3]
                        self.notify("broker.quote", {"ticker": q["ticker"], "bid": q["price"], "ask": round(q["price"] + 2 * tick, 10), "last": None})
                self.events(events)
                if self.source.positions:
                    self.push_state()  # the open P&L moves with the price
            except OSError:
                return
            time.sleep(1)

    # ── one connection ──
    def run_once(self):
        host, port, plugin, token = connection()
        self.sock = socket.create_connection((host, port), timeout=10)
        reader = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self.send({"jsonrpc": "2.0", "id": 1, "method": "hello",
                   "params": {"plugin": plugin, "token": token, "api": API, "version": PLUGIN_VERSION}})
        welcome = json.loads(reader.readline() or "{}")
        if "error" in welcome:
            raise PluginError(welcome["error"].get("message", "refused"))
        self.sock.settimeout(None)
        self.alive = True
        self.log(f"Connected to {welcome.get('result', {}).get('app', 'OpenTrader')} (Plugin API {welcome.get('result', {}).get('api')})")
        self.push_state()
        threading.Thread(target=self.stream, daemon=True).start()
        for line in reader:
            if not line.strip():
                continue
            message = json.loads(line)
            if "method" in message and "id" in message:
                # Requests run on their own thread: a slow history request must not hold up the others.
                threading.Thread(target=self.on_request, args=(message,), daemon=True).start()
            elif "method" in message:
                self.on_notification(message["method"], message.get("params") or {})
        self.alive = False

    def run(self):
        """Connect. Started by the app, end when the connection ends (the app starts the program again when it
        wants it). Run by hand, connect again whenever the app closes the connection or is not there yet."""
        started_by_app = "OPENTRADER_PLUGIN_ADDR" in os.environ
        while True:
            try:
                self.run_once()
                print("The app closed the connection", flush=True)
            except PluginError as e:
                print(f"Refused: {e}", flush=True)
            except (OSError, ValueError) as e:
                print(f"Not connected ({e})", flush=True)
            self.alive = False
            if started_by_app:
                sys.exit(1)
            time.sleep(3)


if __name__ == "__main__":
    Plugin(Source()).run()
