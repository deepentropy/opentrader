//+------------------------------------------------------------------+
//| OpenTraderBridge.mq5: the MetaTrader 5 plugin of OpenTrader.      |
//|                                                                  |
//| Attached to any one chart, it connects to OpenTrader's Plugin API |
//| on this computer (plugins/PROTOCOL.md) and serves it:            |
//|  - data: the broker's symbols, their bars and live quotes;        |
//|  - broker: the account, positions, orders, deals, and the orders |
//|    OpenTrader sends.                                              |
//| The address and token come from the file OpenTrader writes in the |
//| terminals' common folder (Common\Files\OpenTrader\mt5.json).      |
//|                                                                  |
//| Times: MetaTrader gives server wall times; OpenTrader takes UTC.  |
//| The server's clock is told by the "serverTime" setting (auto:     |
//| guessed from the server's current offset).                        |
//+------------------------------------------------------------------+
#property copyright "OpenTrader contributors"
#property link      "https://github.com/deepentropy/opentrader"
#property description "Connects this terminal to OpenTrader: data and trading."
#property strict

#include <Trade/Trade.mqh>
#include "OpenTraderJson.mqh"

input string InpConnectionFile = "OpenTrader\\mt5.json"; // Connection file (terminals' common folder)

#define API_VERSION 1
#define PLUGIN_VERSION "0.4.0"
#define TOASTS_API 8             // the app's Plugin API that has toasts; older apps do without
#define RECONNECT_MS 3000
#define LOST_MS 5000             // the trade server away this long: said to the user
#define MAX_BARS 50000

//--- Connection
int      g_sock = INVALID_HANDLE;
bool     g_ready = false;          // hello answered
bool     g_toasts = false;         // the app shows toasts
bool     g_serverSeen = false;     // the terminal was connected to its trade server
ulong    g_serverDown = 0;         // since when it is not
bool     g_serverLost = false;     // the user was told
uchar    g_in[];                   // bytes read, not yet a whole line
ulong    g_lastTry = 0;
string   g_plugin = "mt5";
//--- Settings (plugin.configure)
string   g_serverTime = "auto";
//--- Streams
string   g_tickers[];              // data.subscribe
long     g_lastTick[];             // their last tick time (ms)
string   g_watch[];                // broker.watchQuote
string   g_tickWatch[];            // data.watchTicks: the tickers a tick chart shows
long     g_tickFrom[];             // their last tick sent (server ms)
int      g_tickSame[];             // how many ticks of that millisecond were sent
string   g_depth[];                // broker.watchDepth: the order books subscribed (MarketBookAdd)
bool     g_depthDirty[];           // their book changed since it was sent
ulong    g_lastDepth = 0;
bool     g_stateDirty = true;
ulong    g_placed[];               // pending orders already announced (their next update is a modification)
ulong    g_lastState = 0;
CTrade   g_trade;

#include "OpenTraderLevels.mqh"

//--- A long text built in parts: appending to one string copies it whole each time.
class CText
  {
private:
   string            m_parts[];
   string            m_cur;
public:
   void              Add(const string s)
     {
      m_cur += s;
      if(StringLen(m_cur) > 16384)
        {
         int n = ArraySize(m_parts);
         ArrayResize(m_parts, n + 1);
         m_parts[n] = m_cur;
         m_cur = "";
        }
     }
   string            Text(void)
     {
      string out = "";
      for(int i = 0; i < ArraySize(m_parts); i++)
         out += m_parts[i];
      return out + m_cur;
     }
  };

//+------------------------------------------------------------------+
//| Server time ↔ UTC                                                 |
//+------------------------------------------------------------------+
//--- Day of month of the n-th (1..) Sunday of a month, or of the last one (n = 0).
int SundayOf(const int year, const int month, const int n)
  {
   MqlDateTime d;
   d.year = year;
   d.mon = month;
   d.day = 1;
   d.hour = 0;
   d.min = 0;
   d.sec = 0;
   datetime first = StructToTime(d);
   TimeToStruct(first, d);
   int firstSunday = 1 + (7 - d.day_of_week) % 7;
   if(n > 0)
      return firstSunday + 7 * (n - 1);
   int days = (month == 2) ? ((year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28) : ((month == 4 || month == 6 || month == 9 || month == 11) ? 30 : 31);
   int last = firstSunday;
   while(last + 7 <= days)
      last += 7;
   return last;
  }

//--- European summer time on that (server) date.
bool EuSummer(const datetime t)
  {
   MqlDateTime d;
   TimeToStruct(t, d);
   if(d.mon < 3 || d.mon > 10)
      return false;
   if(d.mon > 3 && d.mon < 10)
      return true;
   int sunday = SundayOf(d.year, d.mon, 0);
   return d.mon == 3 ? d.day >= sunday : d.day < sunday;
  }

//--- US summer time on that (server) date.
bool UsSummer(const datetime t)
  {
   MqlDateTime d;
   TimeToStruct(t, d);
   if(d.mon < 3 || d.mon > 11)
      return false;
   if(d.mon > 3 && d.mon < 11)
      return true;
   if(d.mon == 3)
      return d.day >= SundayOf(d.year, 3, 2);
   return d.day < SundayOf(d.year, 11, 1);
  }

//--- The server's offset from UTC now, rounded to 30 minutes.
int CurrentOffset(void)
  {
   long diff = (long)(TimeTradeServer() - TimeGMT());
   return (int)(MathRound(diff / 1800.0) * 1800);
  }

string   g_clock = "";
ulong    g_clockAt = 0;

//--- The server clock in use: "eet" (Europe/Athens), "nyclose" (New York + 7 h), "utc" or "fixed". Worked out once a
//--- minute: a request of thousands of bars converts each bar's time.
string Clock(void)
  {
   if(g_serverTime != "auto")
      return g_serverTime;
   ulong now = GetTickCount64();
   if(g_clock != "" && now - g_clockAt < 60000)
      return g_clock;
   g_clock = GuessClock();
   g_clockAt = now;
   return g_clock;
  }

string GuessClock(void)
  {
   int off = CurrentOffset();
   if(off == 0)
      return "utc";
   if(off == 7200 || off == 10800)
     {
      // MetaQuotes' own servers run on Athens time; most brokers close the day with New York.
      if(StringFind(AccountInfoString(ACCOUNT_SERVER), "MetaQuotes") >= 0)
         return "eet";
      bool eu = (off == 10800) == EuSummer(TimeTradeServer());
      bool us = (off == 10800) == UsSummer(TimeTradeServer());
      if(us && !eu)
         return "nyclose";
      if(eu && !us)
         return "eet";
      return "nyclose";
     }
   return "fixed";
  }

//--- The offset of a server wall time.
int OffsetAt(const datetime server)
  {
   string c = Clock();
   if(c == "utc")
      return 0;
   if(c == "eet")
      return EuSummer(server) ? 10800 : 7200;
   if(c == "nyclose")
      return UsSummer(server) ? 10800 : 7200;
   return CurrentOffset();
  }

long ToUtc(const datetime server) { return (long)server - OffsetAt(server); }
datetime ToServer(const long utc) { return (datetime)(utc + OffsetAt((datetime)(utc + CurrentOffset()))); }

//--- The symbols' time zone, and how far its wall clock is behind the server's.
string Zone(int &shift)
  {
   string c = Clock();
   shift = 0;
   if(c == "utc")
      return "Etc/UTC";
   if(c == "eet")
      return "Europe/Athens";
   if(c == "nyclose")
     {
      shift = 7 * 3600;
      return "America/New_York";
     }
   int h = CurrentOffset() / 3600;
   return h >= 0 ? StringFormat("Etc/GMT-%d", h) : StringFormat("Etc/GMT+%d", -h);
  }

//+------------------------------------------------------------------+
//| Connection                                                        |
//+------------------------------------------------------------------+
bool ReadConnection(string &host, int &port, string &token, string &plugin)
  {
   int f = FileOpen(InpConnectionFile, FILE_READ | FILE_TXT | FILE_COMMON | FILE_ANSI | FILE_SHARE_READ);
   if(f == INVALID_HANDLE)
      return false;
   string text = "";
   while(!FileIsEnding(f))
      text += FileReadString(f) + "\n";
   FileClose(f);
   CJReader r;
   CJ *o = r.Parse(text);
   if(o == NULL)
      return false;
   host = JStr(o, "host", "127.0.0.1");
   port = (int)JNum(o, "port", 47822);
   token = JStr(o, "token");
   plugin = JStr(o, "plugin", "mt5");
   delete o;
   return token != "";
  }

void Disconnect(void)
  {
   if(g_sock != INVALID_HANDLE)
      SocketClose(g_sock);
   g_sock = INVALID_HANDLE;
   g_ready = false;
   ArrayResize(g_in, 0);
   ArrayResize(g_tickers, 0);
   ArrayResize(g_lastTick, 0);
   ArrayResize(g_watch, 0);
   ArrayResize(g_tickWatch, 0);
   ArrayResize(g_tickFrom, 0);
   ArrayResize(g_tickSame, 0);
   for(int i = 0; i < ArraySize(g_depth); i++)
      MarketBookRelease(g_depth[i]);
   ArrayResize(g_depth, 0);
   ArrayResize(g_depthDirty, 0);
  }

bool SendLine(const string line)
  {
   if(g_sock == INVALID_HANDLE)
      return false;
   uchar buf[];
   int n = StringToCharArray(line + "\n", buf, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   int sent = 0;
   while(sent < n)
     {
      uchar part[];
      ArrayCopy(part, buf, 0, sent, n - sent);
      int k = SocketSend(g_sock, part, n - sent);
      if(k <= 0)
        {
         Print("OpenTrader: send failed (", GetLastError(), "), connecting again");
         Disconnect();
         return false;
        }
      sent += k;
     }
   return true;
  }

void Notify(const string method, const string params)
  {
   SendLine("{\"jsonrpc\":\"2.0\",\"method\":" + JQ(method) + ",\"params\":" + params + "}");
  }

void Reply(const string id, const string result)
  {
   SendLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}");
  }

void ReplyError(const string id, const int code, const string message)
  {
   SendLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"error\":{\"code\":" + IntegerToString(code) + ",\"message\":" + JQ(message) + "}}");
  }

void Log(const string level, const string message)
  {
   if(g_ready)
      Notify("log", "{\"level\":" + JQ(level) + ",\"message\":" + JQ(message) + "}");
  }

//--- A short message on the user's screen. Orders have their own (broker.event).
void Toast(const string level, const string message, const bool sound)
  {
   if(g_ready && g_toasts)
      Notify("plugin.toast", "{\"level\":" + JQ(level) + ",\"message\":" + JQ(message) + ",\"sound\":" + (sound ? "true" : "false") + "}");
  }

//--- The terminal's link to its trade server: said when it is lost for a few seconds, and when it is back.
void WatchServer(void)
  {
   if(TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      if(g_serverLost)
         Toast("info", "The connection to " + AccountInfoString(ACCOUNT_SERVER) + " is back", false);
      g_serverLost = false;
      g_serverSeen = true;
      g_serverDown = 0;
      return;
     }
   if(!g_serverSeen || g_serverLost)
      return;
   ulong now = GetTickCount64();
   if(g_serverDown == 0)
      g_serverDown = now;
   if(now - g_serverDown < LOST_MS)
      return;
   g_serverLost = true;
   Toast("error", "MetaTrader 5 lost the connection to " + AccountInfoString(ACCOUNT_SERVER), true);
  }

void TryConnect(void)
  {
   ulong now = GetTickCount64();
   if(now - g_lastTry < RECONNECT_MS)
      return;
   g_lastTry = now;
   string host, token, plugin;
   int port;
   if(!ReadConnection(host, port, token, plugin))
      return;
   g_sock = SocketCreate();
   if(g_sock == INVALID_HANDLE)
      return;
   if(!SocketConnect(g_sock, host, port, 2000))
     {
      int err = GetLastError();
      SocketClose(g_sock);
      g_sock = INVALID_HANDLE;
      if(err == 4014)
         Print("OpenTrader: add ", host, " to Tools > Options > Expert Advisors > Allow WebRequest for listed URL");
      return;
     }
   g_plugin = plugin;
   SendLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"plugin\":" + JQ(plugin) + ",\"token\":" + JQ(token) +
            ",\"api\":" + IntegerToString(API_VERSION) + ",\"version\":" + JQ(PLUGIN_VERSION) + "}}");
  }

//--- Bytes waiting on the socket, split into lines.
void ReadSocket(void)
  {
   if(g_sock == INVALID_HANDLE)
      return;
   if(!SocketIsConnected(g_sock))
     {
      Print("OpenTrader: disconnected");
      Disconnect();
      return;
     }
   uint avail = SocketIsReadable(g_sock);
   while(avail > 0)
     {
      uchar buf[];
      int k = SocketRead(g_sock, buf, avail, 100);
      if(k <= 0)
         break;
      int n = ArraySize(g_in);
      ArrayResize(g_in, n + k);
      ArrayCopy(g_in, buf, n, 0, k);
      avail = SocketIsReadable(g_sock);
     }
   while(true)
     {
      int nl = -1;
      int size = ArraySize(g_in);
      for(int i = 0; i < size; i++)
         if(g_in[i] == 10)
           {
            nl = i;
            break;
           }
      if(nl < 0)
         break;
      string line = CharArrayToString(g_in, 0, nl, CP_UTF8);
      int rest = size - nl - 1;
      uchar left[];
      if(rest > 0)
         ArrayCopy(left, g_in, 0, nl + 1, rest);
      ArrayResize(g_in, 0);
      if(rest > 0)
         ArrayCopy(g_in, left);
      if(StringLen(line) > 0)
         OnMessage(line);
      if(g_sock == INVALID_HANDLE)
         return;
     }
  }

//+------------------------------------------------------------------+
//| Messages                                                          |
//+------------------------------------------------------------------+
void OnMessage(const string line)
  {
   CJReader r;
   CJ *m = r.Parse(line);
   if(m == NULL)
      return;
   string method = JStr(m, "method");
   CJ *idv = m.Get("id");
   string id = "null";
   if(idv != NULL && idv.type == J_NUM)
      id = JN(idv.num, 0);
   else
      if(idv != NULL && idv.type == J_STR)
         id = JQ(idv.str);
   CJ *params = m.Get("params");
   if(method == "")
     {
      // The answer to hello.
      if(!g_ready && id == "1")
        {
         CJ *err = m.Get("error");
         if(err != NULL)
           {
            Print("OpenTrader refused the connection: ", JStr(err, "message"));
            Disconnect();
           }
         else
           {
            g_ready = true;
            CJ *answer = m.Get("result");
            CJ *api = answer == NULL ? NULL : answer.Get("api");
            g_toasts = api != NULL && api.type == J_NUM && api.num >= TOASTS_API;
            g_stateDirty = true;
            // The orders already working were announced before: their updates are modifications.
            ArrayResize(g_placed, 0);
            for(int i = 0; i < OrdersTotal(); i++)
              {
               ulong ticket = OrderGetTicket(i);
               if(ticket > 0)
                 {
                  int n = ArraySize(g_placed);
                  ArrayResize(g_placed, n + 1);
                  g_placed[n] = ticket;
                 }
              }
            Print("OpenTrader: connected");
            Log("info", "MetaTrader 5 " + AccountInfoString(ACCOUNT_COMPANY) + ", server " + AccountInfoString(ACCOUNT_SERVER) + ", clock " + Clock());
           }
        }
      delete m;
      return;
     }
   if(idv == NULL || idv.type == J_NULL)
     {
      OnNotification(method, params);
      delete m;
      return;
     }
   string error = "";
   string result = Handle(method, params, error);
   if(error != "")
      ReplyError(id, result == "unknown" ? -32601 : result == "unknownSymbol" ? -32004 : -32000, error);
   else
      Reply(id, result);
   delete m;
  }

void OnNotification(const string method, CJ *params)
  {
   if(method == "plugin.configure")
     {
      CJ *s = params != NULL ? params.Get("settings") : NULL;
      string clock = JStr(s, "serverTime", "auto");
      if(clock != g_serverTime)
        {
         g_serverTime = clock;
         Log("info", "Server clock: " + Clock());
        }
      return;
     }
   if(method == "data.watchTicks")
     {
      CJ *list = params != NULL ? params.Get("tickers") : NULL;
      string tickers[];
      int n = list != NULL ? list.Size() : 0;
      ArrayResize(tickers, n);
      for(int i = 0; i < n; i++)
         tickers[i] = list.At(i).str;
      WatchTicks(tickers);
      return;
     }
   if(method == "broker.watchDepth")
     {
      CJ *list = params != NULL ? params.Get("tickers") : NULL;
      string tickers[];
      int n = list != NULL ? list.Size() : 0;
      ArrayResize(tickers, n);
      for(int i = 0; i < n; i++)
         tickers[i] = list.At(i).str;
      WatchDepth(tickers);
      return;
     }
   if(method == "data.subscribe" || method == "broker.watchQuote")
     {
      CJ *list = params != NULL ? params.Get("tickers") : NULL;
      string tickers[];
      int n = list != NULL ? list.Size() : 0;
      ArrayResize(tickers, n);
      for(int i = 0; i < n; i++)
        {
         tickers[i] = list.At(i).str;
         SymbolSelect(tickers[i], true);
        }
      if(method == "data.subscribe")
        {
         ArrayCopy(g_tickers, tickers);
         ArrayResize(g_tickers, n);
         ArrayResize(g_lastTick, n);
         ArrayInitialize(g_lastTick, 0);
        }
      else
        {
         ArrayCopy(g_watch, tickers);
         ArrayResize(g_watch, n);
        }
     }
  }

string Handle(const string method, CJ *p, string &error)
  {
   if(method == "data.search")
      return DataSearch(p);
   if(method == "data.symbolInfo")
      return DataSymbolInfo(p, error);
   if(method == "data.bars")
      return DataBars(p, error);
   if(method == "data.ticks")
      return DataTicks(p, error);
   if(method == "broker.resolveSymbol")
      return BrokerResolve(p);
   if(method == "broker.getState")
      return BrokerState();
   if(method == "broker.instrument")
      return BrokerInstrument(p, error);
   if(method == "broker.selectAccount")
     {
      error = "MetaTrader 5 trades the account the terminal is logged in to: switch accounts in the terminal";
      return "";
     }
   if(method == "broker.place")
      return BrokerPlace(p, error);
   if(method == "broker.previewOrder")
      return BrokerPreview(p, error);
   if(method == "broker.modify")
      return BrokerModify(p, error);
   if(method == "broker.cancel")
      return BrokerCancel(p, error);
   if(method == "broker.closePosition")
      return BrokerClose(p, error);
   if(method == "broker.setPositionBrackets")
      return BrokerBrackets(p, error);
   error = "Method not found: " + method;
   return "unknown";
  }

//+------------------------------------------------------------------+
//| Data                                                              |
//+------------------------------------------------------------------+
string Upper(const string s)
  {
   string u = s;
   StringToUpper(u);
   return u;
  }

//--- The search tab of a symbol: forex, crypto, index, stock, futures, cfd, bond.
string KindOf(const string symbol)
  {
   string path = Upper(SymbolInfoString(symbol, SYMBOL_PATH));
   if(StringFind(path, "CRYPTO") >= 0)
      return "crypto";
   // Funds trade as exchange stocks: their folder tells them apart (MetaQuotes-Demo: "NASDAQ\ETF\XAUG").
   if(StringFind(path, "ETF") >= 0 || StringFind(path, "FUND") >= 0)
      return "fund";
   ENUM_SYMBOL_CALC_MODE mode = (ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(symbol, SYMBOL_TRADE_CALC_MODE);
   switch(mode)
     {
      case SYMBOL_CALC_MODE_FOREX:
      case SYMBOL_CALC_MODE_FOREX_NO_LEVERAGE:
         return "forex";
      case SYMBOL_CALC_MODE_FUTURES:
      case SYMBOL_CALC_MODE_EXCH_FUTURES:
      case SYMBOL_CALC_MODE_EXCH_FUTURES_FORTS:
         return "futures";
      case SYMBOL_CALC_MODE_EXCH_STOCKS:
      case SYMBOL_CALC_MODE_EXCH_STOCKS_MOEX:
         return "stock";
      case SYMBOL_CALC_MODE_EXCH_BONDS:
      case SYMBOL_CALC_MODE_EXCH_BONDS_MOEX:
         return "bond";
      default:
         break;
     }
   if(StringFind(path, "INDIC") >= 0 || StringFind(path, "INDEX") >= 0)
      return "index";
   if(StringFind(path, "STOCK") >= 0 || StringFind(path, "SHARE") >= 0 || StringFind(path, "EQUIT") >= 0)
      return "stock";
   return "cfd";
  }

string DataSearch(CJ *p)
  {
   string q = Upper(JStr(p, "query"));
   string out = "";
   int found = 0;
   // The Market Watch symbols first, then the rest of the server's.
   for(int pass = 0; pass < 2 && found < 50; pass++)
     {
      bool selected = pass == 0;
      int total = SymbolsTotal(selected);
      for(int i = 0; i < total && found < 50; i++)
        {
         string name = SymbolName(i, selected);
         if(!selected && SymbolInfoInteger(name, SYMBOL_SELECT))
            continue;
         string desc = SymbolInfoString(name, SYMBOL_DESCRIPTION);
         if(q != "" && StringFind(Upper(name), q) < 0 && StringFind(Upper(desc), q) < 0)
            continue;
         if(found > 0)
            out += ",";
         out += "{\"ticker\":" + JQ(name) + ",\"description\":" + JQ(desc) + ",\"type\":" + JQ(KindOf(name)) + "}";
         found++;
        }
     }
   return "{\"symbols\":[" + out + "]}";
  }

//--- "HHMM" of minutes in a day.
string Hhmm(int minutes)
  {
   minutes = ((minutes % 1440) + 1440) % 1440;
   return StringFormat("%02d%02d", minutes / 60, minutes % 60);
  }

//--- The trading sessions in the symbol's zone, in the datafeed grammar ("1700-1700:23456", "24x7").
string SessionSpec(const string symbol, const int shift)
  {
   string perDay[7];      // spec of each weekday (MT5: 0 = Sunday)
   int fullDays = 0;
   for(int d = 0; d < 7; d++)
     {
      perDay[d] = "";
      datetime from, to;
      int total = 0;
      for(int i = 0; SymbolInfoSessionTrade(symbol, (ENUM_DAY_OF_WEEK)d, i, from, to); i++)
        {
         int a = (int)(from / 60);
         int b = (int)(to / 60);
         if(b <= a)
            continue;
         total += b - a;
         // The session in the symbol's zone; one that starts the day before ends on this day (overnight).
         int sa = a - shift / 60;
         int sb = b - shift / 60;
         // A whole day from midnight is "0000-2400"; "1700-1700" (an end at its start) opens the evening before.
         string part = (sb - sa >= 1440 && ((sa % 1440) + 1440) % 1440 == 0) ? "0000-2400"
                       : Hhmm(sa) + "-" + (sb - sa < 1440 && sb % 1440 == 0 && sb > 0 ? "2400" : Hhmm(sb));
         if(sa < 0 && sb <= 0)
            continue;
         perDay[d] += (perDay[d] == "" ? "" : ",") + part;
        }
      if(total >= 1440)
         fullDays++;
     }
   if(fullDays == 7)
      return "24x7";
   // Days with the same sessions together: "spec:days|spec:days" (1 = Sunday).
   string out = "";
   bool done[7];
   ArrayInitialize(done, false);
   for(int d = 0; d < 7; d++)
     {
      if(done[d] || perDay[d] == "")
         continue;
      string days = "";
      for(int e = d; e < 7; e++)
         if(!done[e] && perDay[e] == perDay[d])
           {
            days += IntegerToString(e + 1);
            done[e] = true;
           }
      out += (out == "" ? "" : "|") + perDay[d] + ":" + days;
     }
   return out == "" ? "24x7" : out;
  }

string DataSymbolInfo(CJ *p, string &error)
  {
   string t = JStr(p, "ticker");
   if(!SymbolSelect(t, true))
     {
      // The app stops asking for it (an expired contract in a watchlist).
      error = "Unknown symbol " + t;
      return "unknownSymbol";
     }
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(t, SYMBOL_POINT);
   double tick = SymbolInfoDouble(t, SYMBOL_TRADE_TICK_SIZE);
   long pricescale = (long)MathRound(MathPow(10, digits));
   long minmov = (point > 0 && tick > 0) ? (long)MathMax(1, MathRound(tick / point)) : 1;
   int shift;
   string zone = Zone(shift);
   string currency = SymbolInfoString(t, SYMBOL_CURRENCY_PROFIT);
   // MetaTrader's bars start on the server clock, whatever the trading hours (5 minutes at 01:00 when trading opens
   // at 01:01): their grid starts at the server's midnight, in the zone's time.
   return "{\"description\":" + JQ(SymbolInfoString(t, SYMBOL_DESCRIPTION)) +
          ",\"type\":" + JQ(KindOf(t)) +
          ",\"currency\":" + JQ(currency) +
          ",\"timezone\":" + JQ(zone) +
          ",\"session\":" + JQ(SessionSpec(t, shift)) +
          ",\"barOrigin\":" + JQ(Hhmm(-shift / 60)) +
          ",\"pricescale\":" + IntegerToString(pricescale) +
          ",\"minmov\":" + IntegerToString(minmov) +
          ",\"intervals\":[\"1T\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"10\",\"12\",\"15\",\"20\",\"30\",\"60\",\"120\",\"180\",\"240\",\"360\",\"480\",\"720\",\"1D\"]}";
  }

ENUM_TIMEFRAMES Timeframe(const string res)
  {
   if(res == "1D" || res == "D")
      return PERIOD_D1;
   int m = (int)StringToInteger(res);
   switch(m)
     {
      case 1: return PERIOD_M1;
      case 2: return PERIOD_M2;
      case 3: return PERIOD_M3;
      case 4: return PERIOD_M4;
      case 5: return PERIOD_M5;
      case 6: return PERIOD_M6;
      case 10: return PERIOD_M10;
      case 12: return PERIOD_M12;
      case 15: return PERIOD_M15;
      case 20: return PERIOD_M20;
      case 30: return PERIOD_M30;
      case 60: return PERIOD_H1;
      case 120: return PERIOD_H2;
      case 180: return PERIOD_H3;
      case 240: return PERIOD_H4;
      case 360: return PERIOD_H6;
      case 480: return PERIOD_H8;
      case 720: return PERIOD_H12;
     }
   return PERIOD_CURRENT;
  }

//--- A bar's start in UTC: intraday bars at their real time, daily bars at their trading day's midnight in the zone.
long BarTime(const datetime server, const bool daily)
  {
   if(!daily)
      return ToUtc(server);
   int shift;
   Zone(shift);
   return ToUtc(server + shift);
  }

double Volume(const MqlRates &r) { return r.real_volume > 0 ? (double)r.real_volume : (double)r.tick_volume; }

string DataBars(CJ *p, string &error)
  {
   string t = JStr(p, "ticker");
   ENUM_TIMEFRAMES tf = Timeframe(JStr(p, "resolution"));
   if(tf == PERIOD_CURRENT)
     {
      error = "Resolution not served: " + JStr(p, "resolution");
      return "";
     }
   if(!SymbolSelect(t, true))
     {
      error = "Unknown symbol " + t;
      return "";
     }
   bool daily = tf == PERIOD_D1;
   long from = (long)JNum(p, "from");
   long to = (long)JNum(p, "to");
   int count = (int)MathMin(MAX_BARS, MathMax(1, JNum(p, "countBack", 1000)));
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   // The terminal may still be loading the history: asked again for a few seconds.
   int got = -1;
   for(int attempt = 0; attempt < 25; attempt++)
     {
      got = CopyRates(t, tf, ToServer(to), count, rates);
      if(got >= 0 && (got > 0 || attempt >= 5))
         break;
      Sleep(200);
     }
   if(got < 0)
     {
      error = "History not available yet for " + t + " (error " + IntegerToString(GetLastError()) + ")";
      return "";
     }
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   CText out;
   out.Add("{\"bars\":[");
   int n = 0;
   for(int i = 0; i < got; i++)
     {
      long time = BarTime(rates[i].time, daily);
      if(time < from || time > to)
         continue;
      out.Add((n > 0 ? ",[" : "[") + IntegerToString(time) + "," + JN(rates[i].open, digits) + "," + JN(rates[i].high, digits) + "," +
              JN(rates[i].low, digits) + "," + JN(rates[i].close, digits) + "," + JN(Volume(rates[i]), 2) + "]");
      n++;
     }
   out.Add("]}");
   return out.Text();
  }

//+------------------------------------------------------------------+
//| Ticks (tick charts)                                               |
//+------------------------------------------------------------------+
#define MAX_TICKS 100000

//--- Charted on trades (exchange symbols) or on the bid: the ticks of the same kind.
bool TradeTicks(const string t)
  {
   return (ENUM_SYMBOL_CHART_MODE)SymbolInfoInteger(t, SYMBOL_CHART_MODE) == SYMBOL_CHART_MODE_LAST;
  }

//--- A tick as data.ticks / data.tick send it ("" when it is not one of the chart's: an ask-only change, no trade).
string TickJson(const MqlTick &k, const bool trades, const int digits)
  {
   double price = trades ? k.last : k.bid;
   if(price <= 0 || (trades ? (k.flags & TICK_FLAG_LAST) == 0 : (k.flags & TICK_FLAG_BID) == 0))
      return "";
   double volume = trades ? (k.volume_real > 0 ? k.volume_real : (double)k.volume) : 1;
   long utc = ToUtc((datetime)(k.time_msc / 1000)) * 1000 + k.time_msc % 1000;
   return "[" + IntegerToString(utc) + "," + JN(price, digits) + "," + JN(volume, 4) + "]";
  }

//--- data.ticks: the newest `countBack` ticks before `to` (UTC ms), oldest first. The window back from `to` widens
//--- until it holds enough of them or reaches 30 days.
string DataTicks(CJ *p, string &error)
  {
   string t = JStr(p, "ticker");
   if(!SymbolSelect(t, true))
     {
      error = "Unknown symbol " + t;
      return "";
     }
   long to = (long)JNum(p, "to");
   int count = (int)MathMin(MAX_TICKS, MathMax(1, JNum(p, "countBack", 1000)));
   long toSrv = (long)ToServer(to / 1000) * 1000 + to % 1000;
   bool trades = TradeTicks(t);
   uint flags = trades ? COPY_TICKS_TRADE : COPY_TICKS_INFO;
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   MqlTick ticks[];
   string rows[];
   // With `from`: the first ticks from then on (Bar Replay reads forward).
   if(p != NULL && p.Get("from") != NULL)
     {
      long from = (long)JNum(p, "from");
      long cur = (long)ToServer(from / 1000) * 1000 + from % 1000;
      // The ticks of the chart's kind only (an ask-only change is left out): pages are read until `count` of them,
      // or the end of the ticks. A short answer means there are no more yet.
      int skip = 0;
      int n = 0;
      CText fwd;
      fwd.Add("{\"ticks\":[");
      while(n < count)
        {
         int want = (int)MathMin(MAX_TICKS, 2 * (count - n) + 16);
         int got = -1;
         for(int attempt = 0; attempt < 25; attempt++)
           {
            got = CopyTicks(t, ticks, flags, (ulong)MathMax(1, cur), want);
            if(got >= 0)
               break;
            Sleep(200);
           }
         if(got < 0)
           {
            error = "Ticks not available yet for " + t + " (error " + IntegerToString(GetLastError()) + ")";
            return "";
           }
         int k = 0;
         while(k < got && k < skip && ticks[k].time_msc == cur)
            k++;
         bool end = got < want;
         for(; k < got && n < count; k++)
           {
            if(ticks[k].time_msc >= toSrv)
              {
               end = true;
               break;
              }
            string row = TickJson(ticks[k], trades, digits);
            if(row == "")
               continue;
            fwd.Add((n > 0 ? "," : "") + row);
            n++;
           }
         if(end || got == 0)
            break;
         // The next page from the last tick read, the ticks of its millisecond read already skipped.
         long last = ticks[got - 1].time_msc;
         int same = 0;
         for(int j = got - 1; j >= 0 && ticks[j].time_msc == last; j--)
            same++;
         skip = last == cur ? got : same;
         cur = last;
        }
      fwd.Add("]}");
      return fwd.Text();
     }
   long span = 600000;
   while(true)
     {
      int got = -1;
      // The terminal may still be loading the history: asked again for a few seconds.
      for(int attempt = 0; attempt < 25; attempt++)
        {
         got = CopyTicksRange(t, ticks, flags, (ulong)MathMax(1, toSrv - span), (ulong)(toSrv - 1));
         if(got >= 0)
            break;
         Sleep(200);
        }
      if(got < 0)
        {
         error = "Ticks not available yet for " + t + " (error " + IntegerToString(GetLastError()) + ")";
         return "";
        }
      ArrayResize(rows, 0);
      for(int i = 0; i < got; i++)
        {
         string row = TickJson(ticks[i], trades, digits);
         if(row == "")
            continue;
         int n = ArraySize(rows);
         ArrayResize(rows, n + 1);
         rows[n] = row;
        }
      if(ArraySize(rows) >= count || span >= (long)30 * 86400000)
         break;
      span *= 4;
     }
   CText out;
   out.Add("{\"ticks\":[");
   int first = MathMax(0, ArraySize(rows) - count);
   for(int i = first; i < ArraySize(rows); i++)
      out.Add((i > first ? "," : "") + rows[i]);
   out.Add("]}");
   return out.Text();
  }

//--- data.watchTicks: the tickers whose new ticks go out as data.tick, from now on.
void WatchTicks(const string &tickers[])
  {
   string next[];
   long from[];
   int same[];
   int n = ArraySize(tickers);
   ArrayResize(next, n);
   ArrayResize(from, n);
   ArrayResize(same, n);
   for(int i = 0; i < n; i++)
     {
      next[i] = tickers[i];
      int k = IndexOf(g_tickWatch, tickers[i]);
      if(k >= 0)
        {
         from[i] = g_tickFrom[k];
         same[i] = g_tickSame[k];
         continue;
        }
      SymbolSelect(tickers[i], true);
      MqlTick last;
      from[i] = SymbolInfoTick(tickers[i], last) ? last.time_msc + 1 : (long)TimeTradeServer() * 1000;
      same[i] = 0;
     }
   ArrayCopy(g_tickWatch, next);
   ArrayResize(g_tickWatch, n);
   ArrayCopy(g_tickFrom, from);
   ArrayResize(g_tickFrom, n);
   ArrayCopy(g_tickSame, same);
   ArrayResize(g_tickSame, n);
  }

//--- The new ticks of the watched tickers: the ones after the last sent (the ticks of its millisecond already sent
//--- are skipped).
void StreamTicks(void)
  {
   for(int i = 0; i < ArraySize(g_tickWatch); i++)
     {
      string t = g_tickWatch[i];
      bool trades = TradeTicks(t);
      MqlTick ticks[];
      int got = CopyTicks(t, ticks, trades ? COPY_TICKS_TRADE : COPY_TICKS_INFO, (ulong)g_tickFrom[i], 5000);
      if(got <= 0)
         continue;
      int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
      int skip = 0;
      while(skip < got && skip < g_tickSame[i] && ticks[skip].time_msc == g_tickFrom[i])
         skip++;
      if(skip >= got)
         continue;
      string rows = "";
      for(int k = skip; k < got; k++)
        {
         string row = TickJson(ticks[k], trades, digits);
         if(row != "")
            rows += (rows == "" ? "" : ",") + row;
        }
      long lastMsc = ticks[got - 1].time_msc;
      int sameNow = 0;
      for(int k = got - 1; k >= 0 && ticks[k].time_msc == lastMsc; k--)
         sameNow++;
      g_tickSame[i] = lastMsc == g_tickFrom[i] ? g_tickSame[i] + got - skip : sameNow;
      g_tickFrom[i] = lastMsc;
      if(rows != "")
         Notify("data.tick", "{\"ticker\":" + JQ(t) + ",\"ticks\":[" + rows + "]}");
     }
  }

string BarJson(const MqlRates &r, const bool daily, const int digits)
  {
   return "[" + IntegerToString(BarTime(r.time, daily)) + "," + JN(r.open, digits) + "," + JN(r.high, digits) + "," + JN(r.low, digits) + "," + JN(r.close, digits) +
          "," + JN(Volume(r), 2) + "]";
  }

//--- A data.quote for each subscribed ticker whose price moved.
void StreamQuotes(void)
  {
   for(int i = 0; i < ArraySize(g_tickers); i++)
     {
      string t = g_tickers[i];
      MqlTick tick;
      if(!SymbolInfoTick(t, tick) || tick.time_msc == g_lastTick[i])
         continue;
      g_lastTick[i] = tick.time_msc;
      int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
      double price = tick.last > 0 && (ENUM_SYMBOL_CHART_MODE)SymbolInfoInteger(t, SYMBOL_CHART_MODE) == SYMBOL_CHART_MODE_LAST ? tick.last : tick.bid;
      MqlRates m[], d[];
      string params = "{\"ticker\":" + JQ(t) + ",\"time\":" + IntegerToString(ToUtc(tick.time)) + ",\"price\":" + JN(price, digits);
      if(CopyRates(t, PERIOD_M1, 0, 1, m) == 1)
         params += ",\"minute\":" + BarJson(m[0], false, digits);
      if(CopyRates(t, PERIOD_D1, 0, 2, d) == 2)
         params += ",\"day\":" + BarJson(d[1], true, digits) + ",\"prevClose\":" + JN(d[0].close, digits);
      Notify("data.quote", params + "}");
     }
   for(int i = 0; i < ArraySize(g_watch); i++)
     {
      MqlTick tick;
      if(!SymbolInfoTick(g_watch[i], tick))
         continue;
      int digits = (int)SymbolInfoInteger(g_watch[i], SYMBOL_DIGITS);
      Notify("broker.quote", "{\"ticker\":" + JQ(g_watch[i]) + ",\"bid\":" + JP(tick.bid, digits) + ",\"ask\":" + JP(tick.ask, digits) +
             ",\"last\":" + JP(tick.last, digits) + "}");
     }
  }

//+------------------------------------------------------------------+
//| Order books (the DOM tab)                                         |
//+------------------------------------------------------------------+
int IndexOf(const string &list[], const string s)
  {
   for(int i = 0; i < ArraySize(list); i++)
      if(list[i] == s)
         return i;
   return -1;
  }

//--- broker.watchDepth: the whole set of tickers whose book the app wants. A server without a book for a symbol sends no
//--- book event: nothing goes out and the DOM shows no sizes.
void WatchDepth(const string &tickers[])
  {
   for(int i = 0; i < ArraySize(g_depth); i++)
      if(IndexOf(tickers, g_depth[i]) < 0)
         MarketBookRelease(g_depth[i]);
   string kept[];
   for(int i = 0; i < ArraySize(tickers); i++)
     {
      string t = tickers[i];
      if(IndexOf(g_depth, t) < 0)
        {
         SymbolSelect(t, true);
         if(!MarketBookAdd(t))
           {
            Log("warn", "No order book for " + t + " (error " + IntegerToString(GetLastError()) + ")");
            continue;
           }
        }
      int n = ArraySize(kept);
      ArrayResize(kept, n + 1);
      kept[n] = t;
     }
   ArrayCopy(g_depth, kept);
   ArrayResize(g_depth, ArraySize(kept));
   // Each book goes out whole once, then on its changes.
   ArrayResize(g_depthDirty, ArraySize(g_depth));
   ArrayInitialize(g_depthDirty, true);
  }

//--- What one unit of a book volume is in the plugin's units. Exchange instruments count their book in lots (contracts);
//--- the others (forex, CFDs) already in units: the terminal shows them either way, and MetaQuotes-Demo's EURUSD book
//--- reads 100 000 to 5 000 000, which are units (as lots they would be up to 5 million lots a level).
double BookUnit(const string t)
  {
   switch((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(t, SYMBOL_TRADE_CALC_MODE))
     {
      case SYMBOL_CALC_MODE_EXCH_STOCKS:
      case SYMBOL_CALC_MODE_EXCH_STOCKS_MOEX:
      case SYMBOL_CALC_MODE_EXCH_FUTURES:
      case SYMBOL_CALC_MODE_EXCH_FUTURES_FORTS:
      case SYMBOL_CALC_MODE_EXCH_BONDS:
      case SYMBOL_CALC_MODE_EXCH_BONDS_MOEX:
         return ContractSize(t);
      default:
         return 1;
     }
  }

//--- The whole book of a ticker as broker.depth: levels in units, market-price rows left out.
string BookJson(const string t)
  {
   MqlBookInfo book[];
   string bids = "", asks = "";
   if(MarketBookGet(t, book))
     {
      int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
      double contract = BookUnit(t);
      for(int i = 0; i < ArraySize(book); i++)
        {
         double lots = book[i].volume_real > 0 ? book[i].volume_real : (double)book[i].volume;
         if(book[i].price <= 0 || lots <= 0)
            continue;
         string level = "{\"price\":" + JN(book[i].price, digits) + ",\"qty\":" + JN(lots * contract, 4) + "}";
         if(book[i].type == BOOK_TYPE_BUY || book[i].type == BOOK_TYPE_BUY_MARKET)
            bids += (bids == "" ? "" : ",") + level;
         else
            asks += (asks == "" ? "" : ",") + level;
        }
     }
   return "{\"ticker\":" + JQ(t) + ",\"snapshot\":true,\"bids\":[" + bids + "],\"asks\":[" + asks + "]}";
  }

//--- The books that changed, at most 4 times a second.
void StreamDepth(void)
  {
   ulong now = GetTickCount64();
   if(now - g_lastDepth < 250)
      return;
   g_lastDepth = now;
   for(int i = 0; i < ArraySize(g_depth); i++)
      if(g_depthDirty[i])
        {
         g_depthDirty[i] = false;
         Notify("broker.depth", BookJson(g_depth[i]));
        }
  }

void OnBookEvent(const string &symbol)
  {
   int i = IndexOf(g_depth, symbol);
   if(i >= 0)
      g_depthDirty[i] = true;
  }

//+------------------------------------------------------------------+
//| Broker                                                            |
//+------------------------------------------------------------------+
double ContractSize(const string t)
  {
   double c = SymbolInfoDouble(t, SYMBOL_TRADE_CONTRACT_SIZE);
   return c > 0 ? c : 1;
  }

//--- Units → lots on the symbol's volume step; 0 when below its minimum.
double Lots(const string t, const double units, string &error)
  {
   double lots = units / ContractSize(t);
   double step = SymbolInfoDouble(t, SYMBOL_VOLUME_STEP);
   double min = SymbolInfoDouble(t, SYMBOL_VOLUME_MIN);
   double max = SymbolInfoDouble(t, SYMBOL_VOLUME_MAX);
   if(step > 0)
      lots = MathRound(lots / step) * step;
   if(lots < min - 1e-12)
     {
      error = StringFormat("The smallest order of %s is %s units (%s lot)", t, JN(min * ContractSize(t), 2), JN(min, 4));
      return 0;
     }
   if(max > 0 && lots > max)
     {
      error = StringFormat("The largest order of %s is %s units (%s lot)", t, JN(max * ContractSize(t), 2), JN(max, 4));
      return 0;
     }
   return NormalizeDouble(lots, 8);
  }

//--- The times in force a symbol takes (its expiration modes): until cancelled (the default) and today, for pending
//--- orders only. A market order fills at once.
string Durations(const string t)
  {
   long modes = SymbolInfoInteger(t, SYMBOL_EXPIRATION_MODE);
   string pending = ",\"orderTypes\":[\"limit\",\"stop\",\"stopLimit\"]";
   string out = "";
   if((modes & SYMBOL_EXPIRATION_GTC) != 0)
      out += "{\"id\":\"gtc\",\"label\":\"Good Till Cancel\",\"default\":true" + pending + "}";
   if((modes & SYMBOL_EXPIRATION_DAY) != 0)
      out += (out == "" ? "" : ",") + "{\"id\":\"day\",\"label\":\"Day\"" + pending + "}";
   return out;
  }

//--- The expiration of a pending order: the duration picked, else until cancelled when the symbol takes it, else today.
ENUM_ORDER_TYPE_TIME Life(CJ *p, const string t)
  {
   string d = JStr(p, "duration");
   if(d == "day")
      return ORDER_TIME_DAY;
   if(d == "gtc")
      return ORDER_TIME_GTC;
   return (SymbolInfoInteger(t, SYMBOL_EXPIRATION_MODE) & SYMBOL_EXPIRATION_GTC) != 0 ? ORDER_TIME_GTC : ORDER_TIME_DAY;
  }

//--- How a symbol trades (broker.instrument): its volumes in units (lots × contract size), so the order ticket steps
//--- and checks by the volume step, and the money one unit makes per price point (the ticket's risk and tick value).
string BrokerInstrument(CJ *p, string &error)
  {
   string t = JStr(p, "ticker");
   if(!SymbolSelect(t, true))
     {
      error = "Unknown symbol " + t;
      return "unknownSymbol";
     }
   double size = ContractSize(t);
   double step = SymbolInfoDouble(t, SYMBOL_VOLUME_STEP);
   double min = SymbolInfoDouble(t, SYMBOL_VOLUME_MIN);
   double max = SymbolInfoDouble(t, SYMBOL_VOLUME_MAX);
   // The profit the terminal books for one lot over 100 ticks, in the account currency: the tick value property can
   // be stale or in another unit for metals and indices.
   double tickSize = SymbolInfoDouble(t, SYMBOL_TRADE_TICK_SIZE);
   double price = SymbolInfoDouble(t, SYMBOL_ASK);
   double pointValue = 0, profit = 0;
   if(tickSize > 0 && price > 0 && OrderCalcProfit(ORDER_TYPE_BUY, t, 1.0, price, price + 100 * tickSize, profit) && profit > 0)
      pointValue = profit / (100 * tickSize) / size;
   else
      if(tickSize > 0)
         pointValue = SymbolInfoDouble(t, SYMBOL_TRADE_TICK_VALUE) / tickSize / size;
   string out = "{";
   if(step > 0)
      out += "\"qtyStep\":" + JN(step * size, 8) + ",";
   if(min > 0)
      out += "\"qtyMin\":" + JN(min * size, 8) + ",";
   if(max > 0)
      out += "\"qtyMax\":" + JN(max * size, 8) + ",";
   if(pointValue > 0)
      out += "\"pointValue\":" + JN(pointValue, 10) + ",";
   // The margin of one lot over its value, both in the account currency: the ticket's leverage and free margin.
   double margin = 0;
   if(pointValue > 0 && price > 0 && OrderCalcMargin(ORDER_TYPE_BUY, t, 1.0, price, margin) && margin > 0)
      out += "\"marginRate\":" + JN(margin / (size * price * pointValue), 10) + ",";
   string durations = Durations(t);
   if(durations != "")
      out += "\"durations\":[" + durations + "],";
   if(StringLen(out) > 1)
      out = StringSubstr(out, 0, StringLen(out) - 1);
   return out + "}";
  }

string Side(const bool buy) { return buy ? "\"buy\"" : "\"sell\""; }

string OrderTypeOf(const ENUM_ORDER_TYPE t)
  {
   switch(t)
     {
      case ORDER_TYPE_BUY_LIMIT:
      case ORDER_TYPE_SELL_LIMIT:
         return "limit";
      case ORDER_TYPE_BUY_STOP:
      case ORDER_TYPE_SELL_STOP:
         return "stop";
      case ORDER_TYPE_BUY_STOP_LIMIT:
      case ORDER_TYPE_SELL_STOP_LIMIT:
         return "stopLimit";
      default:
         return "market";
     }
  }

bool IsBuy(const ENUM_ORDER_TYPE t) { return t == ORDER_TYPE_BUY || t == ORDER_TYPE_BUY_LIMIT || t == ORDER_TYPE_BUY_STOP || t == ORDER_TYPE_BUY_STOP_LIMIT; }

string StatusOf(const ENUM_ORDER_STATE s)
  {
   switch(s)
     {
      case ORDER_STATE_STARTED:
      case ORDER_STATE_REQUEST_ADD:
         return "placing";
      case ORDER_STATE_PLACED:
      case ORDER_STATE_PARTIAL:
      case ORDER_STATE_REQUEST_MODIFY:
      case ORDER_STATE_REQUEST_CANCEL:
         return "working";
      case ORDER_STATE_FILLED:
         return "filled";
      case ORDER_STATE_REJECTED:
         return "rejected";
      default:
         return "cancelled";
     }
  }

//--- The whole account (broker.state).
string BrokerState(void)
  {
   ENUM_ACCOUNT_TRADE_MODE mode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string login = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string name = AccountInfoString(ACCOUNT_COMPANY) + " " + login;
   string ccy = AccountInfoString(ACCOUNT_CURRENCY);
   bool hedging = Hedging();
   string account = "{\"id\":" + JQ(login) + ",\"name\":" + JQ(name) + ",\"currency\":" + JQ(ccy) + ",\"isDemo\":" + (mode == ACCOUNT_TRADE_MODE_REAL ? "false" : "true") +
                    ",\"balance\":" + JN(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + JN(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                    ",\"unrealizedPnl\":" + JN(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",\"marginUsed\":" + JN(AccountInfoDouble(ACCOUNT_MARGIN), 2) +
                    ",\"marginFree\":" + JN(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
                    ",\"values\":[{\"label\":\"Server\",\"value\":" + JQ(AccountInfoString(ACCOUNT_SERVER)) + "},{\"label\":\"Leverage\",\"value\":" +
                    JQ("1:" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE))) + "},{\"label\":\"Margin level\",\"value\":" +
                    JQ(JN(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + "%") + "},{\"label\":\"Credit\",\"value\":" + JQ(JN(AccountInfoDouble(ACCOUNT_CREDIT), 2)) + "}]}";
   //--- Positions
   // A hedging account's parts of one order with exit levels (one magic number) are one position, and one order.
   string positions = "";
   long groups[];
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      long magic = PositionGetInteger(POSITION_MAGIC);
      if(hedging && IsOt(magic))
        {
         if(Listed(groups, magic))
            continue;
         positions += (positions == "" ? "" : ",") + GroupPositionJson(magic);
         continue;
        }
      string t = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
      bool buy = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double tp = PositionGetDouble(POSITION_TP), sl = PositionGetDouble(POSITION_SL);
      string head = "{\"id\":" + JQ(IntegerToString(ticket)) + ",\"ticker\":" + JQ(t) + ",\"side\":" + Side(buy) +
                    ",\"qty\":" + JN(PositionGetDouble(POSITION_VOLUME) * ContractSize(t), 4) + ",\"avgPrice\":" + JN(PositionGetDouble(POSITION_PRICE_OPEN), digits) +
                    ",\"last\":" + JN(PositionGetDouble(POSITION_PRICE_CURRENT), digits) + ",\"unrealizedPnl\":" + JN(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP), 2) +
                    ",\"takeProfit\":" + JP(tp, digits) + ",\"stopLoss\":" + JP(sl, digits);
      // A netting position's levels are the EA's pending order pairs on its symbol.
      string levels = hedging ? "" : NetExits(t, buy);
      positions += (positions == "" ? "" : ",") + head + (levels != "" ? ",\"exitLevels\":[" + levels + "]" : "") + "}";
     }
   //--- Working orders, then the last week's finished ones
   CText orders, deals;
   bool firstOrder = true, firstDeal = true;
   ArrayResize(groups, 0);
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;
      long magic = OrderGetInteger(ORDER_MAGIC);
      string one;
      if(IsOt(magic))
        {
         // Netting: a level's leg, listed with its position.
         if(!hedging || Listed(groups, magic))
            continue;
         one = GroupOrderJson(magic);
        }
      else
        {
         int plan = hedging ? -1 : PlanOf(ticket);
         one = OrderJson(ticket, false, -1, plan >= 0 ? PlanExits(plan) : "");
        }
      if(one == "")
         continue;
      orders.Add((firstOrder ? "" : ",") + one);
      firstOrder = false;
     }
   if(HistorySelect(TimeCurrent() - 7 * 86400, TimeCurrent() + 86400))
     {
      int n = HistoryOrdersTotal();
      for(int i = MathMax(0, n - 100); i < n; i++)
        {
         ulong ticket = HistoryOrderGetTicket(i);
         // A netting level's leg cancelled by the EA (its other leg filled, or sent again) is not an order the user
         // placed.
         if(ticket > 0 && !hedging && IsOt(HistoryOrderGetInteger(ticket, ORDER_MAGIC)) && HistoryOrderGetInteger(ticket, ORDER_STATE) == ORDER_STATE_CANCELED)
            continue;
         if(ticket > 0)
           {
            orders.Add((firstOrder ? "" : ",") + OrderJson(ticket, true));
            firstOrder = false;
           }
        }
      int k = HistoryDealsTotal();
      for(int i = MathMax(0, k - 200); i < k; i++)
        {
         ulong ticket = HistoryDealGetTicket(i);
         if(ticket == 0)
            continue;
         ENUM_DEAL_TYPE type = (ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket, DEAL_TYPE);
         if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
            continue;
         string t = HistoryDealGetString(ticket, DEAL_SYMBOL);
         int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
         deals.Add((firstDeal ? "" : ",") + "{\"id\":" + JQ(IntegerToString(ticket)) + ",\"orderId\":" + JQ(IntegerToString(HistoryDealGetInteger(ticket, DEAL_ORDER))) +
                  ",\"ticker\":" + JQ(t) + ",\"side\":" + Side(type == DEAL_TYPE_BUY) + ",\"qty\":" + JN(HistoryDealGetDouble(ticket, DEAL_VOLUME) * ContractSize(t), 4) +
                  ",\"price\":" + JN(HistoryDealGetDouble(ticket, DEAL_PRICE), digits) + ",\"timeMs\":" + IntegerToString(ToUtc((datetime)(HistoryDealGetInteger(ticket, DEAL_TIME_MSC) / 1000)) * 1000 + HistoryDealGetInteger(ticket, DEAL_TIME_MSC) % 1000) +
                  ",\"commission\":" + JN(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",\"realizedPnl\":" + JN(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + "}");
         firstDeal = false;
        }
     }
   return "{\"connected\":" + (TerminalInfoInteger(TERMINAL_CONNECTED) ? "true" : "false") + ",\"accounts\":[{\"id\":" + JQ(login) + ",\"name\":" + JQ(name) + "}]" +
          ",\"account\":" + account + ",\"positionMode\":" + (hedging ? "\"hedging\"" : "\"netting\"") +
          ",\"capabilities\":{\"orderTypes\":[\"market\",\"limit\",\"stop\",\"stopLimit\"],\"brackets\":true,\"positionBrackets\":true,\"partialClose\":true,\"modifyOrders\":true,\"orderPreview\":true,\"exitLevels\":true,\"maxExitLevels\":" + IntegerToString(MAX_LEVELS) + "}" +
          ",\"positions\":[" + positions + "],\"orders\":[" + orders.Text() + "],\"executions\":[" + deals.Text() + "]}";
  }

//--- One order (working: OrderGet…, history: HistoryOrderGet…). A group's order gives its parts' quantity (`lots`) and
//--- exits (`exits`, the takeProfit / stopLoss / exitLevels fields).
string OrderJson(const ulong ticket, const bool history, const double lots = -1, const string exits = "")
  {
   string t = history ? HistoryOrderGetString(ticket, ORDER_SYMBOL) : OrderGetString(ORDER_SYMBOL);
   ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)(history ? HistoryOrderGetInteger(ticket, ORDER_TYPE) : OrderGetInteger(ORDER_TYPE));
   ENUM_ORDER_STATE state = (ENUM_ORDER_STATE)(history ? HistoryOrderGetInteger(ticket, ORDER_STATE) : OrderGetInteger(ORDER_STATE));
   double initial = history ? HistoryOrderGetDouble(ticket, ORDER_VOLUME_INITIAL) : OrderGetDouble(ORDER_VOLUME_INITIAL);
   double current = history ? HistoryOrderGetDouble(ticket, ORDER_VOLUME_CURRENT) : OrderGetDouble(ORDER_VOLUME_CURRENT);
   double open = history ? HistoryOrderGetDouble(ticket, ORDER_PRICE_OPEN) : OrderGetDouble(ORDER_PRICE_OPEN);
   double stoplimit = history ? HistoryOrderGetDouble(ticket, ORDER_PRICE_STOPLIMIT) : OrderGetDouble(ORDER_PRICE_STOPLIMIT);
   double sl = history ? HistoryOrderGetDouble(ticket, ORDER_SL) : OrderGetDouble(ORDER_SL);
   double tp = history ? HistoryOrderGetDouble(ticket, ORDER_TP) : OrderGetDouble(ORDER_TP);
   long done = history ? HistoryOrderGetInteger(ticket, ORDER_TIME_DONE_MSC) : 0;
   long setup = history ? HistoryOrderGetInteger(ticket, ORDER_TIME_SETUP_MSC) : OrderGetInteger(ORDER_TIME_SETUP_MSC);
   long when = done > 0 ? done : setup;
   ENUM_ORDER_TYPE_TIME life = (ENUM_ORDER_TYPE_TIME)(history ? HistoryOrderGetInteger(ticket, ORDER_TYPE_TIME) : OrderGetInteger(ORDER_TYPE_TIME));
   string kind = OrderTypeOf(type);
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   double size = ContractSize(t);
   string limit = kind == "limit" ? JP(open, digits) : kind == "stopLimit" ? JP(stoplimit, digits) : "null";
   string stop = (kind == "stop" || kind == "stopLimit") ? JP(open, digits) : "null";
   if(lots >= 0)
     {
      initial = lots;
      current = lots;
     }
   return "{\"id\":" + JQ(IntegerToString(ticket)) + ",\"ticker\":" + JQ(t) + ",\"side\":" + Side(IsBuy(type)) + ",\"type\":" + JQ(kind) +
          ",\"qty\":" + JN(initial * size, 4) + ",\"filledQty\":" + JN((initial - current) * size, 4) + ",\"limitPrice\":" + limit + ",\"stopPrice\":" + stop +
          "," + (exits != "" ? exits : "\"takeProfit\":" + JP(tp, digits) + ",\"stopLoss\":" + JP(sl, digits)) + ",\"status\":" + JQ(StatusOf(state)) +
          ",\"duration\":" + JQ(life == ORDER_TIME_DAY ? "day" : "gtc") + ",\"updatedMs\":" + IntegerToString(ToUtc((datetime)(when / 1000)) * 1000 + when % 1000) + "}";
  }

//--- The broker's name of a chart symbol: the symbol itself, or one of its names with a suffix or prefix ("EURUSD.m", "#AAPL").
string BrokerResolve(CJ *p)
  {
   string t = Upper(JStr(p, "ticker"));
   bool custom;
   if(t != "" && SymbolExist(t, custom))
      return "{\"ticker\":" + JQ(t) + "}";
   string best = "";
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string name = SymbolName(i, false);
      string u = Upper(name);
      string core = "";
      for(int k = 0; k < StringLen(u); k++)
        {
         ushort c = StringGetCharacter(u, k);
         if((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
            core += ShortToString(c);
        }
      // "EURUSD.m", "EURUSDm", "#AAPL", "AAPL.US": the ticker once the broker's marks are taken off.
      if(core == t || (StringFind(core, t) == 0 && StringLen(core) - StringLen(t) <= 3) || (StringFind(u, t + ".") == 0))
        {
         if(best == "" || StringLen(name) < StringLen(best))
            best = name;
        }
     }
   return best == "" ? "{\"ticker\":null}" : "{\"ticker\":" + JQ(best) + "}";
  }

bool TradeAllowed(string &error)
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     {
      error = "Algo Trading is off in MetaTrader 5: turn it on in the toolbar";
      return false;
     }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))
     {
      error = "The OpenTrader Expert Advisor may not trade: tick Allow Algo Trading in its settings";
      return false;
     }
   return true;
  }

//--- The result of a trade request: "" when done, else why.
string Outcome(void)
  {
   uint code = g_trade.ResultRetcode();
   if(code == TRADE_RETCODE_DONE || code == TRADE_RETCODE_PLACED || code == TRADE_RETCODE_DONE_PARTIAL)
      return "";
   return g_trade.ResultRetcodeDescription() + " (" + IntegerToString(code) + ")";
  }

double Price(CJ *p, const string key) { return JHasNum(p, key) ? JNum(p, key) : 0; }

string BrokerPlace(CJ *p, string &error)
  {
   if(!TradeAllowed(error))
      return "";
   string t = JStr(p, "ticker");
   if(!SymbolSelect(t, true))
     {
      error = "Unknown symbol " + t;
      return "";
     }
   double lots = Lots(t, JNum(p, "qty"), error);
   if(lots <= 0)
      return "";
   bool buy = JStr(p, "side") == "buy";
   string type = JStr(p, "type");
   double limit = Price(p, "limitPrice"), stop = Price(p, "stopPrice"), tp = Price(p, "takeProfit"), sl = Price(p, "stopLoss");
   CLevels lv;
   bool levels = ReadLevels(p, t, lv, error);
   if(error != "")
      return "";
   if(levels && Hedging())
      return PlaceGroup(p, t, lots, lv, error);
   if(levels)
     {
      // Netting: the order goes without exits; its levels are placed on the position as it fills.
      long protect = 0;
      double from = EntryOf(t, buy, type, limit, stop);
      for(int j = 0; j < lv.Size() && error == ""; j++)
        {
         protect += Steps(t, lv.lots[j]);
         error = ExitError(t, buy, from, lv.tp[j], lv.sl[j]);
        }
      if(error == "" && protect > Steps(t, lots))
         error = "The exit levels protect more than the order's quantity";
      if(error != "")
         return "";
      tp = 0;
      sl = 0;
     }
   ulong id = 0;
   if(!SendOrder(t, buy, type, lots, limit, stop, sl, tp, Life(p, t), 0, id, error))
      return "";
   if(levels && lv.Size() > 0)
     {
      SetPlan(id, t, buy, lv);
      ProcessPlans();
     }
   g_stateDirty = true;
   return "{\"orderId\":" + JQ(IntegerToString(id)) + "}";
  }

//--- What an order would do (broker.previewOrder): the terminal's check of it (OrderCheck), nothing sent. The margin
//--- it takes and the account's free margin and margin level after it; the broker's refusal as an error.
string BrokerPreview(CJ *p, string &error)
  {
   string t = JStr(p, "ticker");
   if(!SymbolSelect(t, true))
     {
      error = "Unknown symbol " + t;
      return "";
     }
   string lotError = "";
   double lots = Lots(t, JNum(p, "qty"), lotError);
   if(lots <= 0)
      return "{\"sections\":[],\"errors\":[" + JQ(lotError) + "]}";
   bool buy = JStr(p, "side") == "buy";
   string type = JStr(p, "type");
   MqlTradeRequest r;
   ZeroMemory(r);
   r.symbol = t;
   r.volume = lots;
   r.sl = Price(p, "stopLoss");
   r.tp = Price(p, "takeProfit");
   r.type_time = Life(p, t);
   r.type_filling = (ENUM_ORDER_TYPE_FILLING)g_trade.RequestTypeFilling();
   if(type == "market")
     {
      r.action = TRADE_ACTION_DEAL;
      r.type = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      r.price = SymbolInfoDouble(t, buy ? SYMBOL_ASK : SYMBOL_BID);
     }
   else
     {
      r.action = TRADE_ACTION_PENDING;
      if(type == "limit")
        {
         r.type = buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT;
         r.price = Price(p, "limitPrice");
        }
      else
         if(type == "stop")
           {
            r.type = buy ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP;
            r.price = Price(p, "stopPrice");
           }
         else
           {
            r.type = buy ? ORDER_TYPE_BUY_STOP_LIMIT : ORDER_TYPE_SELL_STOP_LIMIT;
            r.price = Price(p, "stopPrice");
            r.stoplimit = Price(p, "limitPrice");
           }
     }
   MqlTradeCheckResult c;
   ZeroMemory(c);
   bool ok = OrderCheck(r, c);
   string ccy = JQ(AccountInfoString(ACCOUNT_CURRENCY));
   string row = "{\"label\":\"%s\",\"value\":\"%s\",\"currency\":" + ccy + "}";
   string rows = StringFormat(row, "Margin", DoubleToString(c.margin, 2)) + "," + StringFormat(row, "Free margin after", DoubleToString(c.margin_free, 2));
   string level = c.margin_level > 0 ? ",{\"label\":\"Margin level after\",\"value\":" + JQ(DoubleToString(c.margin_level, 2) + "%") + "}" : "";
   string errors = ok || c.retcode == 0 ? "" : JQ(c.comment + " (" + IntegerToString(c.retcode) + ")");
   return "{\"sections\":[{\"rows\":[" + rows + level + "]}],\"errors\":[" + errors + "]}";
  }

string BrokerModify(CJ *p, string &error)
  {
   if(!TradeAllowed(error))
      return "";
   ulong ticket = (ulong)StringToInteger(JStr(p, "orderId"));
   if(!OrderSelect(ticket))
     {
      error = "No working order " + JStr(p, "orderId");
      return "";
     }
   string t = OrderGetString(ORDER_SYMBOL);
   bool levels = p != NULL && p.Get("exitLevels") != NULL && p.Get("exitLevels").type == J_ARR;
   if(Hedging() && (levels || IsOt(OrderGetInteger(ORDER_MAGIC))))
      return ModifyGroup(p, ticket, error);
   // Netting: the order's levels wait for its fill (they replace its take profit / stop loss).
   CLevels lv;
   if(levels)
     {
      ReadLevels(p, t, lv, error);
      if(error != "")
         return "";
      long protect = 0;
      for(int j = 0; j < lv.Size(); j++)
         protect += Steps(t, lv.lots[j]);
      if(protect > Steps(t, OrderGetDouble(ORDER_VOLUME_CURRENT)))
        {
         error = "The exit levels protect more than the order's quantity";
         return "";
        }
     }
   double size = ContractSize(t);
   double now = OrderGetDouble(ORDER_VOLUME_CURRENT) * size;
   if(JHasNum(p, "qty") && MathAbs(JNum(p, "qty") - now) > size * SymbolInfoDouble(t, SYMBOL_VOLUME_STEP) / 2)
     {
      error = "MetaTrader 5 cannot change an order's quantity: cancel it and place a new one";
      return "";
     }
   string kind = OrderTypeOf((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE));
   double price = kind == "limit" ? Price(p, "limitPrice") : Price(p, "stopPrice");
   double stoplimit = kind == "stopLimit" ? Price(p, "limitPrice") : 0;
   // The duration picked; without one the order keeps its own.
   ENUM_ORDER_TYPE_TIME life = JStr(p, "duration") != "" ? Life(p, t) : (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   bool plain = !levels || lv.Size() == 0;
   bool ok = g_trade.OrderModify(ticket, price, plain ? Price(p, "stopLoss") : 0, plain ? Price(p, "takeProfit") : 0, life, (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION), stoplimit);
   error = Outcome();
   if(!ok && error == "")
      error = "The order was not modified (" + IntegerToString(GetLastError()) + ")";
   if(error == "" && !plain)
      SetPlan(ticket, t, IsBuy((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)), lv);
   else
      if(error == "" && PlanOf(ticket) >= 0)
        {
         DropPlan(PlanOf(ticket));
         SavePlans();
        }
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

string BrokerCancel(CJ *p, string &error)
  {
   ulong ticket = (ulong)StringToInteger(JStr(p, "orderId"));
   // A hedging order with levels: all its parts.
   if(CancelGroup(ticket, error))
      return error == "" ? "{}" : "";
   bool ok = g_trade.OrderDelete(ticket);
   error = Outcome();
   if(!ok && error == "")
      error = "The order was not cancelled (" + IntegerToString(GetLastError()) + ")";
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

string BrokerClose(CJ *p, string &error)
  {
   if(!TradeAllowed(error))
      return "";
   ulong ticket = (ulong)StringToInteger(JStr(p, "positionId"));
   if(!PositionSelectByTicket(ticket))
     {
      error = "No position " + JStr(p, "positionId");
      return "";
     }
   string t = PositionGetString(POSITION_SYMBOL);
   if(Hedging() && IsOt(PositionGetInteger(POSITION_MAGIC)))
     {
      double part = 0;
      if(JHasNum(p, "qty"))
        {
         part = Lots(t, JNum(p, "qty"), error);
         if(part <= 0)
            return "";
        }
      return CloseGroup(ticket, !JHasNum(p, "qty"), part, error);
     }
   // Netting: the levels left over follow the position at once (gone with it, or no more than what is left).
   g_levelsDirty = true;
   bool ok;
   if(JHasNum(p, "qty"))
     {
      double lots = Lots(t, JNum(p, "qty"), error);
      if(lots <= 0)
         return "";
      ok = g_trade.PositionClosePartial(ticket, lots);
     }
   else
      ok = g_trade.PositionClose(ticket);
   error = Outcome();
   if(!ok && error == "")
      error = "The position was not closed (" + IntegerToString(GetLastError()) + ")";
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

string BrokerBrackets(CJ *p, string &error)
  {
   if(!TradeAllowed(error))
      return "";
   ulong ticket = (ulong)StringToInteger(JStr(p, "positionId"));
   if(!PositionSelectByTicket(ticket))
     {
      error = "No position " + JStr(p, "positionId");
      return "";
     }
   if(!Hedging())
      return NetBrackets(p, ticket, error);
   if(IsOt(PositionGetInteger(POSITION_MAGIC)) || (p != NULL && p.Get("exitLevels") != NULL))
      return GroupBrackets(p, ticket, error);
   bool ok = g_trade.PositionModify(ticket, Price(p, "stopLoss"), Price(p, "takeProfit"));
   error = Outcome();
   if(!ok && error == "")
      error = "The position was not changed (" + IntegerToString(GetLastError()) + ")";
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

int Announced(const ulong order)
  {
   for(int i = 0; i < ArraySize(g_placed); i++)
      if(g_placed[i] == order)
         return i;
   return -1;
  }

void Forget(const ulong order)
  {
   int i = Announced(order);
   int n = ArraySize(g_placed);
   if(i < 0)
      return;
   g_placed[i] = g_placed[n - 1];
   ArrayResize(g_placed, n - 1);
  }

//--- Order notifications for the toasts.
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   g_stateDirty = true;
   g_levelsDirty = true;
   if(!g_ready)
      return;
   string kind = "";
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD && (trans.deal_type == DEAL_TYPE_BUY || trans.deal_type == DEAL_TYPE_SELL))
     {
      int digits = (int)SymbolInfoInteger(trans.symbol, SYMBOL_DIGITS);
      Notify("broker.event", "{\"kind\":\"executed\",\"ticker\":" + JQ(trans.symbol) + ",\"side\":" + Side(trans.deal_type == DEAL_TYPE_BUY) +
             ",\"type\":\"market\",\"qty\":" + JN(trans.volume * ContractSize(trans.symbol), 4) + ",\"price\":" + JN(trans.price, digits) + "}");
      return;
     }
   bool pending = trans.order_type != ORDER_TYPE_BUY && trans.order_type != ORDER_TYPE_SELL;
   // A pending order is added (started), then updated once the server placed it: that first update is "placed".
   if(trans.type == TRADE_TRANSACTION_ORDER_UPDATE && trans.order_state == ORDER_STATE_PLACED && pending)
     {
      kind = "modified";
      if(Announced(trans.order) < 0)
        {
         int n = ArraySize(g_placed);
         ArrayResize(g_placed, n + 1);
         g_placed[n] = trans.order;
         kind = "placed";
        }
     }
   else
         if(trans.type == TRADE_TRANSACTION_HISTORY_ADD && (trans.order_state == ORDER_STATE_CANCELED || trans.order_state == ORDER_STATE_EXPIRED))
            kind = "cancelled";
         else
            if(trans.type == TRADE_TRANSACTION_HISTORY_ADD && trans.order_state == ORDER_STATE_REJECTED)
               kind = "rejected";
   if(kind == "cancelled" || kind == "rejected")
      Forget(trans.order);
   if(kind == "")
      return;
   // The EA's own exit orders of a netting position are not the user's orders; the other parts of a hedging order with
   // levels are told by its first part.
   long magic = 0;
   if(OrderSelect(trans.order))
      magic = OrderGetInteger(ORDER_MAGIC);
   else
      if(HistoryOrderSelect(trans.order))
         magic = HistoryOrderGetInteger(trans.order, ORDER_MAGIC);
   if((IsOt(magic) && !Hedging()) || IsQuiet(trans.order))
      return;
   int digits = (int)SymbolInfoInteger(trans.symbol, SYMBOL_DIGITS);
   double price = trans.price > 0 ? trans.price : trans.price_trigger;
   Notify("broker.event", "{\"kind\":" + JQ(kind) + ",\"ticker\":" + JQ(trans.symbol) + ",\"side\":" + Side(IsBuy(trans.order_type)) + ",\"type\":" +
          JQ(OrderTypeOf(trans.order_type)) + ",\"qty\":" + JN(trans.volume * ContractSize(trans.symbol), 4) + ",\"price\":" + JP(price, digits) + "}");
  }

//+------------------------------------------------------------------+
//| Expert                                                            |
//+------------------------------------------------------------------+
int OnInit(void)
  {
   g_trade.SetAsyncMode(false);
   g_trade.SetDeviationInPoints(20);
   EventSetMillisecondTimer(50);
   TryConnect();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Disconnect();
   ClearPlans();
  }

void OnTimer(void)
  {
   // Before the connection: the netting levels are kept while OpenTrader is closed too.
   KeepLevels();
   if(g_sock == INVALID_HANDLE)
     {
      TryConnect();
      return;
     }
   ReadSocket();
   if(!g_ready)
      return;
   WatchServer();
   StreamQuotes();
   StreamTicks();
   StreamDepth();
   // The account: at once after a trade, else every second (P&L).
   ulong now = GetTickCount64();
   if(g_stateDirty || now - g_lastState >= 1000)
     {
      g_stateDirty = false;
      g_lastState = now;
      Notify("broker.state", BrokerState());
     }
  }

void OnTick(void) {}
//+------------------------------------------------------------------+
