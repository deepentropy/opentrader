// OpenTrader bridge for NinjaTrader 8: serves NinjaTrader's futures data to OpenTrader on the same computer
// (OpenTrader Plugin API, see PROTOCOL.md). Data only: it reads no account and sends no order.
//
// It connects by itself once the add-on is compiled, with the file OpenTrader writes while the plugin is enabled.
#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public class OpenTraderBridge : AddOnBase
    {
        private Bridge bridge;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "OpenTraderBridge";
                Description = "Serves NinjaTrader's futures data to OpenTrader on this computer.";
            }
            else if (State == State.Terminated) End();
        }

        // Also called for the open Control Center after a compile: the add-on starts without a restart.
        protected override void OnWindowCreated(Window window)
        {
            if (!(window is ControlCenter) || bridge != null) return;
            bridge = new Bridge();
            bridge.Start();
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (window is ControlCenter) End();
        }

        private void End()
        {
            if (bridge == null) return;
            bridge.Stop();
            bridge = null;
        }

        // ── The connection to OpenTrader ────────────────────────────────────────────────────────────────────────

        private class RpcException : Exception
        {
            public readonly int Code;
            public RpcException(int code, string message) : base(message) { Code = code; }
        }

        private class Bridge
        {
            private const string Version = "0.1.0";
            private const string RunningKey = "OpenTraderBridge.running";
            private readonly string id = Guid.NewGuid().ToString("N");
            private readonly object sending = new object();
            private readonly Feed feed;
            private volatile bool stopped;
            private TcpClient client;
            private StreamWriter writer;

            public Bridge() { feed = new Feed(Notify); }

            public void Start()
            {
                // After a compile the previous version's add-on may still run: the newest one is the one that connects.
                AppDomain.CurrentDomain.SetData(RunningKey, id);
                new Thread(Run) { IsBackground = true, Name = "OpenTrader bridge" }.Start();
            }

            public void Stop()
            {
                stopped = true;
                Close();
            }

            private bool Running
            {
                get { return !stopped && (AppDomain.CurrentDomain.GetData(RunningKey) as string) == id; }
            }

            private void Close()
            {
                TcpClient c = client;
                if (c != null) try { c.Close(); } catch (Exception) { }
            }

            private void Run()
            {
                while (Running)
                {
                    int wait = 3000;
                    try { wait = Session(); }
                    catch (Exception) { }
                    finally
                    {
                        feed.Clear();
                        lock (sending) { writer = null; }
                        Close();
                        client = null;
                    }
                    for (int i = 0; i < wait / 250 && Running; i++) Thread.Sleep(250);
                }
            }

            /// One connection: returns when it ends, with the time to wait before the next one.
            private int Session()
            {
                string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenTraderPlugins", "ninjatrader.json");
                if (!File.Exists(path)) return 2000;
                Dictionary<string, object> file = Json.Parse(File.ReadAllText(path)) as Dictionary<string, object>;
                if (file == null) return 2000;
                client = new TcpClient();
                client.Connect(Json.Text(file, "host", "127.0.0.1"), (int)Json.Number(file, "port", 47822));
                client.NoDelay = true;
                StreamReader reader = new StreamReader(client.GetStream(), new UTF8Encoding(false));
                lock (sending) { writer = new StreamWriter(client.GetStream(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true }; }
                Send("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"plugin\":\"ninjatrader\",\"token\":" + Json.Quote(Json.Text(file, "token", ""))
                    + ",\"api\":4,\"version\":\"" + Version + "\"}}");
                string first = reader.ReadLine();
                if (first == null) return 3000;
                Dictionary<string, object> answer = Json.Parse(first) as Dictionary<string, object>;
                if (answer == null || answer.ContainsKey("error")) return 10000;
                Notify("data.watchlists", feed.Watchlists());
                using (new Timer(delegate { try { if (Running) feed.Flush(); else Close(); } catch (Exception) { } }, null, 200, 200))
                using (new Timer(delegate { Send("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\",\"params\":{}}"); }, null, 15000, 15000))
                using (new Timer(delegate { try { feed.FollowRolls(); } catch (Exception) { } }, null, 600000, 600000))
                {
                    string line;
                    while (Running && (line = reader.ReadLine()) != null)
                    {
                        Dictionary<string, object> message = Json.Parse(line) as Dictionary<string, object>;
                        if (message != null && message.ContainsKey("method")) Handle(message);
                    }
                }
                return 3000;
            }

            private void Handle(Dictionary<string, object> message)
            {
                string method = Json.Text(message, "method", "");
                Dictionary<string, object> p = Json.Object(message, "params");
                if (!message.ContainsKey("id"))
                {
                    if (method == "data.subscribe") feed.Subscribe(Json.Strings(p, "tickers"));
                    else if (method == "data.watchTicks") feed.WatchTicks(Json.Strings(p, "tickers"));
                    return;
                }
                string requestId = Json.Write(message["id"]);
                Task.Run(delegate
                {
                    string body;
                    try { body = "\"result\":" + Answer(method, p); }
                    catch (RpcException e) { body = Error(e.Code, e.Message); }
                    catch (Exception e) { body = Error(-32000, e.Message); }
                    Send("{\"jsonrpc\":\"2.0\",\"id\":" + requestId + "," + body + "}");
                });
            }

            private static string Error(int code, string message)
            {
                return "\"error\":{\"code\":" + code + ",\"message\":" + Json.Quote(message) + "}";
            }

            private string Answer(string method, Dictionary<string, object> p)
            {
                string ticker = Json.Text(p, "ticker", "");
                switch (method)
                {
                    case "ping": return "{}";
                    case "data.search": return feed.Search(Json.Text(p, "query", ""));
                    case "data.symbolInfo": return feed.SymbolInfo(ticker);
                    case "data.bars":
                        return feed.Bars(ticker, Json.Text(p, "resolution", ""), (long)Json.Number(p, "from", 0), (long)Json.Number(p, "to", 0), (int)Json.Number(p, "countBack", 1000));
                    case "data.ticks":
                        return feed.Ticks(ticker, p.ContainsKey("from") ? (long?)(long)Json.Number(p, "from", 0) : null, (long)Json.Number(p, "to", 0), (int)Json.Number(p, "countBack", 1000));
                    default: throw new RpcException(-32601, "Unknown method " + method);
                }
            }

            private void Notify(string method, string parameters)
            {
                Send("{\"jsonrpc\":\"2.0\",\"method\":\"" + method + "\",\"params\":" + parameters + "}");
            }

            private void Send(string line)
            {
                lock (sending)
                {
                    if (writer == null) return;
                    try { writer.WriteLine(line); }
                    catch (Exception) { writer = null; Close(); }
                }
            }
        }

        // ── NinjaTrader's data ──────────────────────────────────────────────────────────────────────────────────

        /// A symbol of the plugin: one contract (ESZ2026), or the front contract with the earlier ones joined to it
        /// at their real prices (ES1!).
        private class Symbol
        {
            public string Ticker;
            public MasterInstrument Master;
            public Instrument Instrument;
            public bool Continuous;

            public MergePolicy Merge { get { return Continuous ? MergePolicy.MergeNonBackAdjusted : MergePolicy.DoNotMerge; } }
        }

        internal struct Row
        {
            public DateTime Time;
            public double Open, High, Low, Close;
            public long Volume;
        }

        private struct Tick
        {
            public long Ms;
            public double Price;
            public long Volume;
        }

        /// A symbol the app streams.
        private class Live
        {
            public Symbol Symbol;
            public BarsRequest Minutes, Days, TickBars;
            public EventHandler<BarsUpdateEventArgs> OnMinutes, OnDays, OnTicks;
            public Row? Minute, Day;
            public double? PrevClose;
            public bool Changed;
            public int LastTick;
            public readonly List<Tick> Ticks = new List<Tick>();
        }

        private class Feed
        {
            private const int AskSeconds = 50; // the app waits 60 s for bars and ticks
            private const int FirstSeconds = 12; // a whole daily history is waited for this long, then its last years come first
            private const int MaxBars = 20000, MaxDays = 750, MaxTicks = 100000;
            private static readonly string[] Favourites = { "ES", "NQ", "RTY", "YM", "MES", "MNQ", "CL", "NG", "GC", "SI", "HG", "ZN", "ZB", "ZF", "6E", "6J", "6B", "ZC", "ZS", "ZW" };
            private readonly Dictionary<string, Task<List<Row>>> dailies = new Dictionary<string, Task<List<Row>>>();
            private readonly Action<string, string> notify;
            private readonly object gate = new object();
            private readonly SemaphoreSlim history = new SemaphoreSlim(3);
            private readonly SemaphoreSlim tickGate = new SemaphoreSlim(1);
            private readonly Dictionary<string, Live> live = new Dictionary<string, Live>();
            private readonly object flushing = new object();
            private HashSet<string> watched = new HashSet<string>();
            private HashSet<string> ticked = new HashSet<string>();
            private readonly List<KeyValuePair<string, KeyValuePair<DateTime, List<Tick>>>> tickDays = new List<KeyValuePair<string, KeyValuePair<DateTime, List<Tick>>>>();

            public Feed(Action<string, string> notify) { this.notify = notify; }

            // Symbols

            private static List<MasterInstrument> Futures()
            {
                MasterInstrument[] all;
                lock (MasterInstrument.All) all = MasterInstrument.All.ToArray();
                return all.Where(m => m != null && m.InstrumentType == InstrumentType.Future && !string.IsNullOrEmpty(m.Name)).ToList();
            }

            private static MasterInstrument Master(string root)
            {
                return Futures().FirstOrDefault(m => m.Name == root);
            }

            private static List<DateTime> Months(MasterInstrument m)
            {
                return m.RolloverCollection.Where(r => r != null).Select(r => new DateTime(r.ContractMonth.Year, r.ContractMonth.Month, 1)).Distinct().OrderBy(d => d).ToList();
            }

            /// The contract month traded today: the last one rolled to.
            private static DateTime Front(MasterInstrument m)
            {
                DateTime today = DateTime.Today;
                Rollover last = m.RolloverCollection.Where(r => r != null && r.Date <= today).OrderBy(r => r.Date).LastOrDefault();
                DateTime month = last != null ? last.ContractMonth : m.GetNextExpiry(today);
                return new DateTime(month.Year, month.Month, 1);
            }

            private static Symbol Resolve(string ticker)
            {
                string root;
                DateTime? month;
                if (!Names.Parse(ticker, out root, out month)) throw new RpcException(-32004, "Unknown symbol " + ticker);
                MasterInstrument m = Master(root);
                if (m == null) throw new RpcException(-32004, "Unknown symbol " + ticker);
                if (month != null)
                {
                    List<DateTime> months = Months(m);
                    if (months.Count > 0 && !months.Contains(month.Value)) throw new RpcException(-32004, "Unknown contract " + ticker);
                }
                DateTime contract = month ?? Front(m);
                Instrument instrument = Instrument.GetInstrument(root + " " + contract.ToString("MM-yy", CultureInfo.InvariantCulture));
                if (instrument == null) throw new RpcException(-32004, "Unknown contract " + ticker);
                return new Symbol { Ticker = ticker, Master = m, Instrument = instrument, Continuous = month == null };
            }

            public string Search(string query)
            {
                string q = query.Trim().ToUpperInvariant();
                string root;
                DateTime? month;
                string typed = Names.Parse(q, out root, out month) ? root : q;
                List<MasterInstrument> all = Futures();
                IEnumerable<MasterInstrument> found = q.Length == 0
                    ? Favourites.Select(f => all.FirstOrDefault(m => m.Name == f)).Where(m => m != null)
                    : all.Where(m => m.Name.StartsWith(typed, StringComparison.OrdinalIgnoreCase) || (m.Description ?? "").ToUpperInvariant().Contains(q))
                        .OrderBy(m => m.Name == typed ? 0 : m.Name.StartsWith(typed, StringComparison.OrdinalIgnoreCase) ? 1 : 2).ThenBy(m => m.Name.Length).ThenBy(m => m.Name, StringComparer.Ordinal);
                List<string> rows = new List<string>();
                foreach (MasterInstrument m in found.Take(20))
                {
                    if (rows.Count >= 50) break;
                    rows.Add(SearchRow(m.Name + "1!", (m.Description ?? m.Name) + ", front contract"));
                    if (m.Name != typed) continue;
                    DateTime front = Front(m);
                    foreach (DateTime d in Months(m).Where(d => d >= front).Take(6))
                        rows.Add(SearchRow(Names.Contract(m.Name, d), (m.Description ?? m.Name) + ", " + d.ToString("MMM yyyy", CultureInfo.InvariantCulture)));
                    // A contract typed whole, an expired one too.
                    if (month != null && month.Value < front && Months(m).Contains(month.Value))
                        rows.Insert(0, SearchRow(Names.Contract(m.Name, month.Value), (m.Description ?? m.Name) + ", " + month.Value.ToString("MMM yyyy", CultureInfo.InvariantCulture)));
                }
                return "{\"symbols\":[" + string.Join(",", rows.Take(50)) + "]}";
            }

            private static string SearchRow(string ticker, string description)
            {
                return "{\"ticker\":" + Json.Quote(ticker) + ",\"description\":" + Json.Quote(description) + ",\"type\":\"futures\"}";
            }

            public string SymbolInfo(string ticker)
            {
                Symbol s = Resolve(ticker);
                MasterInstrument m = s.Master;
                TradingHours hours = m.TradingHours;
                string zone = Zones.Iana(hours.TimeZoneInfo.Id);
                string session = zone == null ? "24x7" : Sessions.Spec(hours.Sessions.Select(x => new Sessions.Part
                {
                    BeginDay = (int)x.BeginDay, Begin = x.BeginTime, EndDay = (int)x.EndDay, End = x.EndTime, Day = (int)x.TradingDay
                }));
                string holidays = zone == null ? "" : string.Join(",", hours.Holidays.Keys.OrderBy(d => d).Select(d => d.ToString("yyyyMMdd", CultureInfo.InvariantCulture)));
                long scale, minmov;
                Prices.Scale(m.TickSize, out scale, out minmov);
                string description = (m.Description ?? m.Name) + ", " + (s.Continuous ? "front contract (" : "")
                    + s.Instrument.Expiry.ToString("MMM yyyy", CultureInfo.InvariantCulture) + (s.Continuous ? ")" : "");
                return "{\"description\":" + Json.Quote(description) + ",\"type\":\"futures\",\"currency\":" + Json.Quote(Zones.Currency(m.Currency.ToString()))
                    + ",\"timezone\":" + Json.Quote(zone ?? "Etc/UTC") + ",\"session\":" + Json.Quote(session) + ",\"extended\":null,\"holidays\":" + Json.Quote(holidays)
                    + ",\"pricescale\":" + scale + ",\"minmov\":" + minmov + ",\"pointValue\":" + Json.Number(m.PointValue)
                    + ",\"intervals\":[\"1T\",\"1\",\"5\",\"15\",\"1D\"]"
                    + ",\"fields\":[{\"name\":\"Contract\",\"value\":" + Json.Quote(Names.Contract(m.Name, s.Instrument.Expiry)) + "},{\"name\":\"Tick value\",\"value\":" + Json.Number(m.TickSize * m.PointValue) + "}]}";
            }

            public string Watchlists()
            {
                List<MasterInstrument> all = Futures();
                Func<string[], string> list = roots => string.Join(",", roots.Where(r => all.Any(m => m.Name == r)).Select(r => Json.Quote(r + "1!")));
                string[][] groups = {
                    new[] { "Indices", "ES", "NQ", "RTY", "YM", "MES", "MNQ" }, new[] { "Energy", "CL", "NG", "RB", "HO" }, new[] { "Metals", "GC", "SI", "HG", "PL" },
                    new[] { "Rates", "ZN", "ZB", "ZF", "ZT" }, new[] { "Currencies", "6E", "6J", "6B", "6A", "6C" }, new[] { "Agriculture", "ZC", "ZS", "ZW", "LE", "HE" },
                };
                IEnumerable<string> sections = groups.Select(g => new { Name = g[0], Symbols = list(g.Skip(1).ToArray()) }).Where(g => g.Symbols.Length > 0)
                    .Select(g => "{\"name\":" + Json.Quote(g.Name) + ",\"symbols\":[" + g.Symbols + "]}");
                return "{\"watchlists\":[{\"id\":\"futures\",\"name\":\"Futures\",\"symbols\":[],\"sections\":[" + string.Join(",", sections) + "]}]}";
            }

            // History

            private static DateTime Epoch { get { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc); } }

            /// NinjaTrader gives its times in the time zone of its options.
            private static TimeZoneInfo Zone { get { return NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo; } }

            private static long Ms(DateTime local) { return Times.ToUnixMs(local, Zone); }

            private static DateTime Local(long seconds) { return TimeZoneInfo.ConvertTimeFromUtc(Epoch.AddSeconds(seconds), Zone); }

            /// The start of a bar, UNIX seconds. NinjaTrader stamps a bar at its end; a daily bar carries its date.
            private static long Start(Symbol s, Row row, int minutes)
            {
                if (minutes == 0) return Times.ToUnixMs(row.Time.Date, s.Master.TradingHours.TimeZoneInfo) / 1000;
                return Times.BarStart(Ms(row.Time) / 1000, minutes * 60);
            }

            /// Ask NinjaTrader for bars.
            private static Task<List<Row>> Fetch(Symbol s, BarsRequest request, BarsPeriodType type, int value)
            {
                TaskCompletionSource<List<Row>> answer = new TaskCompletionSource<List<Row>>(TaskCreationOptions.RunContinuationsAsynchronously);
                request.BarsPeriod = new BarsPeriod { BarsPeriodType = type, Value = value };
                request.TradingHours = s.Master.TradingHours;
                request.MergePolicy = s.Merge;
                request.Request((r, code, message) =>
                {
                    try
                    {
                        if (code != ErrorCode.NoError) throw new RpcException(-32000, "NinjaTrader: " + (string.IsNullOrEmpty(message) ? code.ToString() : message));
                        List<Row> rows = new List<Row>(r.Bars.Count);
                        for (int i = 0; i < r.Bars.Count; i++) rows.Add(RowAt(r.Bars, i));
                        answer.TrySetResult(rows);
                    }
                    catch (Exception e) { answer.TrySetException(e); }
                });
                answer.Task.ContinueWith(t => { try { request.Dispose(); } catch (Exception) { } });
                return answer.Task;
            }

            private static List<Row> Wait(Symbol s, Task<List<Row>> answer, int seconds)
            {
                try
                {
                    if (answer.Wait(TimeSpan.FromSeconds(seconds))) return answer.Result;
                }
                catch (AggregateException e) { throw e.InnerException ?? e; }
                // It goes on loading: the same question asked again is answered sooner.
                throw new RpcException(-32005, "NinjaTrader is still loading " + s.Ticker);
            }

            private static List<Row> Ask(Symbol s, BarsRequest request, BarsPeriodType type, int value)
            {
                return Wait(s, Fetch(s, request, type, value), AskSeconds);
            }

            /// The whole daily history: NinjaTrader reads it contract by contract, which takes up to a minute the first time.
            /// It is kept, and its last days read again; until it is there, the last years are answered.
            private List<Row> Days(Symbol s, int count)
            {
                string key = s.Ticker + " " + s.Instrument.FullName;
                Task<List<Row>> whole;
                bool kept;
                lock (dailies)
                {
                    kept = dailies.TryGetValue(key, out whole) && !whole.IsFaulted;
                    if (!kept) dailies[key] = whole = Fetch(s, new BarsRequest(s.Instrument, count), BarsPeriodType.Day, 1);
                }
                if (!whole.IsCompleted)
                {
                    try { return Wait(s, whole, FirstSeconds); }
                    catch (RpcException e) { if (e.Code != -32005) throw; }
                    return Wait(s, Fetch(s, new BarsRequest(s.Instrument, MaxDays), BarsPeriodType.Day, 1), AskSeconds - FirstSeconds);
                }
                List<Row> rows = Wait(s, whole, 1);
                if (!kept || rows.Count == 0) return rows;
                List<Row> newest = Ask(s, new BarsRequest(s.Instrument, 30), BarsPeriodType.Day, 1);
                // A month since it was read: read it all again.
                if (newest.Count == 0 || newest[0].Time > rows[rows.Count - 1].Time)
                {
                    lock (dailies) dailies.Remove(key);
                    return newest;
                }
                return rows.Where(r => r.Time < newest[0].Time).Concat(newest).ToList();
            }

            public string Bars(string ticker, string resolution, long from, long to, int count)
            {
                int minutes;
                if (resolution == "1D") minutes = 0;
                else if (!(resolution == "1" || resolution == "5" || resolution == "15")) throw new RpcException(-32602, "Resolution " + resolution + " is not served");
                else minutes = int.Parse(resolution, CultureInfo.InvariantCulture);
                Symbol s = Resolve(ticker);
                history.Wait();
                try
                {
                    SortedDictionary<long, Row> bars = Load(s, minutes, from, to, Math.Max(1, Math.Min(count, MaxBars)));
                    int decimals = Prices.Decimals(s.Master.TickSize);
                    StringBuilder b = new StringBuilder("{\"bars\":[");
                    bool first = true;
                    foreach (KeyValuePair<long, Row> bar in bars.Skip(Math.Max(0, bars.Count - count)))
                    {
                        if (!first) b.Append(',');
                        first = false;
                        Json.Bar(b, bar.Key, bar.Value, decimals);
                    }
                    return b.Append("]}").ToString();
                }
                finally { history.Release(); }
            }

            private SortedDictionary<long, Row> Load(Symbol s, int minutes, long from, long to, int count)
            {
                BarsPeriodType type = minutes == 0 ? BarsPeriodType.Day : BarsPeriodType.Minute;
                int value = Math.Max(1, minutes);
                int step = minutes == 0 ? 86400 : minutes * 60;
                long now = (long)(DateTime.UtcNow - Epoch).TotalSeconds;
                SortedDictionary<long, Row> bars = new SortedDictionary<long, Row>();
                if (minutes == 0 && to >= now - step && count > MaxDays)
                {
                    Take(s, Days(s, count), minutes, from, to, bars);
                    return bars;
                }
                if (to >= now - step)
                {
                    Take(s, Ask(s, new BarsRequest(s.Instrument, count + 2), type, value), minutes, from, to, bars);
                    return bars;
                }
                // Older bars: the newest stretch of [from, to] that holds some; the app then asks for what comes before it.
                DateTime started = DateTime.UtcNow;
                long days = minutes == 0 ? Math.Max(10, Math.Min(count, MaxDays) * 3L / 2) : Math.Max(4, (long)count * minutes / 1440 * 2 + 4);
                long end = to;
                while (end >= from && bars.Count == 0)
                {
                    if ((DateTime.UtcNow - started).TotalSeconds > 5) throw new RpcException(-32005, "NinjaTrader is still loading " + s.Ticker);
                    long begin = Math.Max(from, end - days * 86400);
                    DateTime first = Local(begin).Date.AddDays(-2), last = Local(end).Date.AddDays(2);
                    if (last > DateTime.Today) last = DateTime.Today;
                    Take(s, Ask(s, new BarsRequest(s.Instrument, first, last), type, value), minutes, begin, end, bars);
                    end = begin - 1;
                    days = Math.Min(days * 4, 1500);
                }
                return bars;
            }

            private static void Take(Symbol s, List<Row> rows, int minutes, long from, long to, SortedDictionary<long, Row> into)
            {
                foreach (Row row in rows)
                {
                    long start = Start(s, row, minutes);
                    if (start >= from && start <= to) into[start] = row;
                }
            }

            // Ticks

            private static List<Tick> AsTicks(List<Row> rows)
            {
                return rows.Select(r => new Tick { Ms = Ms(r.Time), Price = r.Close, Volume = r.Volume }).ToList();
            }

            /// The ticks NinjaTrader gives for one day, kept a while: a chart reads a day in several pages.
            private List<Tick> TickDay(Symbol s, DateTime day)
            {
                string key = s.Ticker + " " + day.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
                tickDays.RemoveAll(k => (DateTime.UtcNow - k.Value.Key).TotalMinutes > 3);
                int at = tickDays.FindIndex(k => k.Key == key);
                if (at >= 0) return tickDays[at].Value.Value;
                List<Tick> ticks = AsTicks(Ask(s, new BarsRequest(s.Instrument, day, day), BarsPeriodType.Tick, 1));
                if (tickDays.Count >= 2) tickDays.RemoveAt(0);
                tickDays.Add(new KeyValuePair<string, KeyValuePair<DateTime, List<Tick>>>(key, new KeyValuePair<DateTime, List<Tick>>(DateTime.UtcNow, ticks)));
                return ticks;
            }

            public string Ticks(string ticker, long? from, long to, int count)
            {
                Symbol s = Resolve(ticker);
                count = Math.Max(1, Math.Min(count, MaxTicks));
                tickGate.Wait();
                try { return TicksJson(s, from == null ? Before(s, to, count) : From(s, from.Value, to, count)); }
                finally { tickGate.Release(); }
            }

            private List<Tick> Before(Symbol s, long to, int count)
            {
                long now = (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
                if (to >= now - 1000)
                    return AsTicks(Ask(s, new BarsRequest(s.Instrument, count), BarsPeriodType.Tick, 1)).Where(t => t.Ms < to).ToList();
                List<Tick> found = new List<Tick>();
                long bound = to;
                int empty = 0;
                for (DateTime day = Local(to / 1000).Date.AddDays(1); found.Count < count && empty < 6; day = day.AddDays(-1))
                {
                    if (day > DateTime.Today) continue;
                    List<Tick> ticks = TickDay(s, day).Where(t => t.Ms < bound).ToList();
                    if (ticks.Count == 0) { empty++; continue; }
                    empty = 0;
                    bound = ticks[0].Ms;
                    found.InsertRange(0, ticks.Skip(Math.Max(0, ticks.Count - (count - found.Count))));
                }
                return found;
            }

            private List<Tick> From(Symbol s, long from, long to, int count)
            {
                List<Tick> found = new List<Tick>();
                long bound = from;
                for (DateTime day = Local(from / 1000).Date.AddDays(-1); found.Count < count && day <= DateTime.Today; day = day.AddDays(1))
                {
                    List<Tick> ticks = TickDay(s, day).Where(t => t.Ms >= bound && t.Ms < to).ToList();
                    if (ticks.Count == 0) continue;
                    found.AddRange(ticks.Take(count - found.Count));
                    bound = ticks[ticks.Count - 1].Ms + 1;
                }
                return found;
            }

            private static string TicksJson(Symbol s, List<Tick> ticks)
            {
                return "{\"ticks\":[" + TickRows(s, ticks) + "]}";
            }

            private static string TickRows(Symbol s, List<Tick> ticks)
            {
                int decimals = Prices.Decimals(s.Master.TickSize);
                StringBuilder b = new StringBuilder();
                for (int i = 0; i < ticks.Count; i++)
                {
                    if (i > 0) b.Append(',');
                    b.Append('[').Append(ticks[i].Ms).Append(',').Append(Json.Number(Math.Round(ticks[i].Price, decimals))).Append(',').Append(ticks[i].Volume).Append(']');
                }
                return b.ToString();
            }

            // Live data

            public void Subscribe(List<string> tickers)
            {
                lock (gate) watched = new HashSet<string>(tickers);
                Task.Run((Action)Reconcile);
            }

            public void WatchTicks(List<string> tickers)
            {
                lock (gate) ticked = new HashSet<string>(tickers);
                Task.Run((Action)Reconcile);
            }

            public void Clear()
            {
                lock (gate)
                {
                    watched.Clear();
                    ticked.Clear();
                    foreach (Live l in live.Values) End(l);
                    live.Clear();
                }
            }

            /// Stream what the app wants, and nothing else.
            private void Reconcile()
            {
                lock (gate)
                {
                    HashSet<string> want = new HashSet<string>(watched.Concat(ticked));
                    foreach (string t in live.Keys.Where(k => !want.Contains(k)).ToList())
                    {
                        End(live[t]);
                        live.Remove(t);
                    }
                    foreach (string t in want.Where(k => !live.ContainsKey(k)).ToList())
                    {
                        try { live[t] = Begin(Resolve(t)); }
                        catch (Exception) { } // an unknown symbol: its data.symbolInfo says so
                    }
                    foreach (KeyValuePair<string, Live> pair in live)
                    {
                        if (ticked.Contains(pair.Key)) BeginTicks(pair.Value);
                        else EndTicks(pair.Value);
                    }
                }
            }

            /// A front contract that rolled: the symbol goes on with the next one.
            public void FollowRolls()
            {
                List<string> rolled = new List<string>();
                lock (gate)
                {
                    foreach (string t in live.Keys.ToList())
                    {
                        Symbol s;
                        try { s = Resolve(t); } catch (Exception) { continue; }
                        if (s.Instrument == live[t].Symbol.Instrument || s.Instrument.FullName == live[t].Symbol.Instrument.FullName) continue;
                        End(live[t]);
                        live[t] = Begin(s);
                        if (ticked.Contains(t)) BeginTicks(live[t]);
                        rolled.Add(t);
                    }
                }
                if (rolled.Count > 0) notify("data.symbolInfoChanged", "{\"tickers\":[" + string.Join(",", rolled.Select(Json.Quote)) + "]}");
            }

            private Live Begin(Symbol s)
            {
                Live l = new Live { Symbol = s };
                l.OnMinutes = (o, e) => { lock (l) { l.Minute = RowAt(e.BarsSeries, e.MaxIndex); l.Changed = true; } };
                l.OnDays = (o, e) =>
                {
                    lock (l)
                    {
                        Row row = RowAt(e.BarsSeries, e.MaxIndex);
                        if (l.Day != null && row.Time > l.Day.Value.Time) l.PrevClose = l.Day.Value.Close;
                        l.Day = row;
                        l.Changed = true;
                    }
                };
                l.Minutes = Follow(s, BarsPeriodType.Minute, l.OnMinutes, rows => { lock (l) { if (l.Minute == null && rows.Count > 0) l.Minute = rows[rows.Count - 1]; l.Changed = true; } });
                l.Days = Follow(s, BarsPeriodType.Day, l.OnDays, rows =>
                {
                    lock (l)
                    {
                        if (l.Day == null && rows.Count > 0) l.Day = rows[rows.Count - 1];
                        if (l.PrevClose == null && rows.Count > 1) l.PrevClose = rows[rows.Count - 2].Close;
                        l.Changed = true;
                    }
                });
                return l;
            }

            /// The trades, as bars of one tick: NinjaTrader gives its trade events twice, its bars once, and with the
            /// times of the history.
            private static void BeginTicks(Live l)
            {
                if (l.TickBars != null) return;
                l.LastTick = -1;
                l.OnTicks = (o, e) =>
                {
                    lock (l)
                    {
                        for (int i = l.LastTick < 0 ? e.MinIndex : Math.Max(e.MinIndex, l.LastTick + 1); i <= e.MaxIndex; i++)
                        {
                            l.Ticks.Add(new Tick { Ms = Ms(e.BarsSeries.GetTime(i)), Price = e.BarsSeries.GetClose(i), Volume = e.BarsSeries.GetVolume(i) });
                            l.LastTick = i;
                        }
                    }
                };
                l.TickBars = Follow(l.Symbol, BarsPeriodType.Tick, l.OnTicks, rows => { lock (l) l.LastTick = Math.Max(l.LastTick, rows.Count - 1); });
            }

            private static void EndTicks(Live l)
            {
                if (l.TickBars == null) return;
                try
                {
                    l.TickBars.Update -= l.OnTicks;
                    l.TickBars.Dispose();
                }
                catch (Exception) { }
                l.TickBars = null;
                lock (l) l.Ticks.Clear();
            }

            private static Row RowAt(Bars bars, int i)
            {
                return new Row { Time = bars.GetTime(i), Open = bars.GetOpen(i), High = bars.GetHigh(i), Low = bars.GetLow(i), Close = bars.GetClose(i), Volume = bars.GetVolume(i) };
            }

            private static Row RowAt(BarsSeries series, int i)
            {
                return new Row { Time = series.GetTime(i), Open = series.GetOpen(i), High = series.GetHigh(i), Low = series.GetLow(i), Close = series.GetClose(i), Volume = series.GetVolume(i) };
            }

            /// The forming bar of a symbol, and its changes.
            private static BarsRequest Follow(Symbol s, BarsPeriodType type, EventHandler<BarsUpdateEventArgs> update, Action<List<Row>> loaded)
            {
                BarsRequest request = new BarsRequest(s.Instrument, 5);
                request.BarsPeriod = new BarsPeriod { BarsPeriodType = type, Value = 1 };
                request.TradingHours = s.Master.TradingHours;
                request.MergePolicy = s.Merge;
                request.Update += update;
                request.Request((r, code, message) =>
                {
                    if (code != ErrorCode.NoError) return;
                    try
                    {
                        List<Row> rows = new List<Row>();
                        for (int i = 0; i < r.Bars.Count; i++) rows.Add(RowAt(r.Bars, i));
                        loaded(rows);
                    }
                    catch (Exception) { }
                });
                return request;
            }

            private static void End(Live l)
            {
                EndTicks(l);
                try
                {
                    l.Minutes.Update -= l.OnMinutes;
                    l.Days.Update -= l.OnDays;
                    l.Minutes.Dispose();
                    l.Days.Dispose();
                }
                catch (Exception) { }
            }

            /// Send what changed since the last time.
            public void Flush()
            {
                // A slow send must not let the next one overtake it: ticks go in order.
                if (!Monitor.TryEnter(flushing)) return;
                try { FlushAll(); }
                finally { Monitor.Exit(flushing); }
            }

            private void FlushAll()
            {
                KeyValuePair<string, Live>[] all;
                HashSet<string> wanted, wantTicks;
                lock (gate)
                {
                    all = live.ToArray();
                    wanted = new HashSet<string>(watched);
                    wantTicks = new HashSet<string>(ticked);
                }
                foreach (KeyValuePair<string, Live> pair in all)
                {
                    string quote = null, ticks = null;
                    Live l = pair.Value;
                    lock (l)
                    {
                        if (l.Ticks.Count > 0)
                        {
                            if (wantTicks.Contains(pair.Key)) ticks = "{\"ticker\":" + Json.Quote(pair.Key) + ",\"ticks\":[" + TickRows(l.Symbol, l.Ticks) + "]}";
                            l.Ticks.Clear();
                        }
                        if (l.Changed && wanted.Contains(pair.Key)) quote = Quote(pair.Key, l);
                        l.Changed = false;
                    }
                    if (ticks != null) notify("data.tick", ticks);
                    if (quote != null) notify("data.quote", quote);
                }
            }

            private static string Quote(string ticker, Live l)
            {
                double? price = (l.Minute != null ? l.Minute.Value.Close : (double?)null) ?? (l.Day != null ? l.Day.Value.Close : (double?)null);
                if (price == null) return null;
                int decimals = Prices.Decimals(l.Symbol.Master.TickSize);
                StringBuilder b = new StringBuilder("{\"ticker\":").Append(Json.Quote(ticker)).Append(",\"time\":").Append((long)(DateTime.UtcNow - Epoch).TotalSeconds)
                    .Append(",\"price\":").Append(Json.Number(Math.Round(price.Value, decimals)));
                if (l.PrevClose != null) b.Append(",\"prevClose\":").Append(Json.Number(Math.Round(l.PrevClose.Value, decimals)));
                if (l.Minute != null) { b.Append(",\"minute\":"); Json.Bar(b, Start(l.Symbol, l.Minute.Value, 1), l.Minute.Value, decimals); }
                if (l.Day != null) { b.Append(",\"day\":"); Json.Bar(b, Start(l.Symbol, l.Day.Value, 0), l.Day.Value, decimals); }
                return b.Append('}').ToString();
            }
        }

        // ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────

        internal static class Names
        {
            private const string Letters = "FGHJKMNQUVXZ";
            private static readonly Regex Form = new Regex("^([A-Z0-9.]+?)(1!|([FGHJKMNQUVXZ])([0-9]{4}))$");

            /// "ES1!" (month null) or "ESZ2026".
            public static bool Parse(string ticker, out string root, out DateTime? month)
            {
                root = null;
                month = null;
                Match m = Form.Match(ticker ?? "");
                if (!m.Success) return false;
                root = m.Groups[1].Value;
                if (!m.Groups[3].Success) return true;
                int year = int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture);
                if (year < 1990 || year > 2090) return false;
                month = new DateTime(year, Letters.IndexOf(m.Groups[3].Value[0]) + 1, 1);
                return true;
            }

            public static string Contract(string root, DateTime month)
            {
                return root + Letters[month.Month - 1] + month.Year.ToString(CultureInfo.InvariantCulture);
            }
        }

        internal static class Times
        {
            public static long ToUnixMs(DateTime local, TimeZoneInfo zone)
            {
                DateTime t = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
                if (zone.IsInvalidTime(t)) t = t.AddHours(1);
                return (TimeZoneInfo.ConvertTimeToUtc(t, zone).Ticks - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks) / TimeSpan.TicksPerMillisecond;
            }

            /// The start of the bar that ends at `end`: on the clock grid, for a bar the session's close cuts short too.
            public static long BarStart(long end, int step)
            {
                return (end - 1) / step * step;
            }
        }

        internal static class Prices
        {
            /// One tick is minmov / scale.
            public static void Scale(double tick, out long scale, out long minmov)
            {
                scale = 1;
                while (scale < 1000000000 && Math.Abs(tick * scale - Math.Round(tick * scale)) > 1e-6) scale *= 10;
                minmov = Math.Max(1, (long)Math.Round(tick * scale));
            }

            public static int Decimals(double tick)
            {
                long scale, minmov;
                Scale(tick, out scale, out minmov);
                return (int)Math.Round(Math.Log10(scale));
            }
        }

        internal static class Sessions
        {
            public struct Part { public int BeginDay, Begin, EndDay, End, Day; }

            /// Trading hours in the app's grammar: "1700-1600", "1900-0745,0830-1320", "0930-1600:23456|1000-1400:7".
            public static string Spec(IEnumerable<Part> parts)
            {
                string[] days = new string[7];
                foreach (Part p in parts)
                {
                    string s = Interval(p);
                    days[p.Day] = days[p.Day] == null ? s : days[p.Day] + "," + s;
                }
                List<IGrouping<string, int>> groups = Enumerable.Range(0, 7).Where(d => days[d] != null).GroupBy(d => days[d]).ToList();
                if (groups.Count == 0) return "24x7";
                return string.Join("|", groups.Select(g =>
                {
                    string list = string.Join("", g.OrderBy(d => d).Select(d => (d + 1).ToString(CultureInfo.InvariantCulture)));
                    return groups.Count == 1 && list == "23456" ? g.Key : g.Key + ":" + list;
                }));
            }

            private static string Interval(Part p)
            {
                // Days before the trading day; a close at the next day's midnight (0000) ends the trading day itself.
                int startBack = (p.Day - p.BeginDay + 7) % 7, endBack = (p.Day - p.EndDay + 7) % 7;
                if (endBack > 3) endBack = 0;
                if (startBack > 3) startBack = 0;
                string start = p.Begin.ToString("0000", CultureInfo.InvariantCulture), end = (p.End == 2400 ? 0 : p.End).ToString("0000", CultureInfo.InvariantCulture);
                bool overnight = startBack == 1 && endBack == 0 && p.End != 0 && p.End <= p.Begin;
                if (startBack > 0 && !overnight) start += "F" + startBack.ToString(CultureInfo.InvariantCulture);
                if (endBack > 0) end += "F" + endBack.ToString(CultureInfo.InvariantCulture);
                return start + "-" + end;
            }
        }

        internal static class Zones
        {
            /// The IANA name of a Windows time zone, for the ones NinjaTrader's trading hours use.
            public static string Iana(string windows)
            {
                switch (windows)
                {
                    case "Eastern Standard Time": return "America/New_York";
                    case "Central Standard Time": return "America/Chicago";
                    case "GMT Standard Time": return "Europe/London";
                    case "China Standard Time": return "Asia/Shanghai";
                    case "Central Europe Standard Time": return "Europe/Budapest";
                    case "W. Europe Standard Time": return "Europe/Berlin";
                    case "Romance Standard Time": return "Europe/Paris";
                    case "Tokyo Standard Time": return "Asia/Tokyo";
                    case "AUS Eastern Standard Time": return "Australia/Sydney";
                    case "India Standard Time": return "Asia/Kolkata";
                    case "E. South America Standard Time": return "America/Sao_Paulo";
                    case "Singapore Standard Time": return "Asia/Singapore";
                    case "Arab Standard Time": return "Asia/Riyadh";
                    case "UTC": return "Etc/UTC";
                    default: return null;
                }
            }

            public static string Currency(string name)
            {
                switch (name)
                {
                    case "AustralianDollar": return "AUD";
                    case "BritishPound": return "GBP";
                    case "CanadianDollar": return "CAD";
                    case "Euro": return "EUR";
                    case "HongKongDollar": return "HKD";
                    case "JapaneseYen": return "JPY";
                    case "SwissFranc": return "CHF";
                    case "KoreanWon": return "KRW";
                    case "IndianRupee": return "INR";
                    case "SwedishKrona": return "SEK";
                    case "MexicanPeso": return "MXN";
                    case "BrazilianReal": return "BRL";
                    case "SingaporeDollar": return "SGD";
                    case "ChinaYuan": return "CNY";
                    case "NewZealandDollar": return "NZD";
                    case "SouthAfricanRand": return "ZAR";
                    case "NorwayKrone": return "NOK";
                    case "DenmarkKrone": return "DKK";
                    default: return "USD";
                }
            }
        }

        internal static class Json
        {
            public static string Number(double v) { return v.ToString("R", CultureInfo.InvariantCulture); }

            public static string Quote(string s)
            {
                StringBuilder b = new StringBuilder("\"");
                foreach (char c in s ?? "")
                {
                    if (c == '"' || c == '\\') b.Append('\\').Append(c);
                    else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else b.Append(c);
                }
                return b.Append('"').ToString();
            }

            public static string Write(object v)
            {
                if (v == null) return "null";
                if (v is string) return Quote((string)v);
                return v is double ? Number((double)v) : "null";
            }

            public static void Bar(StringBuilder b, long time, Row row, int decimals)
            {
                b.Append('[').Append(time).Append(',').Append(Number(Math.Round(row.Open, decimals))).Append(',').Append(Number(Math.Round(row.High, decimals))).Append(',')
                    .Append(Number(Math.Round(row.Low, decimals))).Append(',').Append(Number(Math.Round(row.Close, decimals))).Append(',').Append(row.Volume).Append(']');
            }

            public static string Text(Dictionary<string, object> o, string key, string otherwise)
            {
                object v;
                return o != null && o.TryGetValue(key, out v) && v is string ? (string)v : otherwise;
            }

            public static double Number(Dictionary<string, object> o, string key, double otherwise)
            {
                object v;
                return o != null && o.TryGetValue(key, out v) && v is double ? (double)v : otherwise;
            }

            public static Dictionary<string, object> Object(Dictionary<string, object> o, string key)
            {
                object v;
                return (o != null && o.TryGetValue(key, out v) ? v as Dictionary<string, object> : null) ?? new Dictionary<string, object>();
            }

            public static List<string> Strings(Dictionary<string, object> o, string key)
            {
                object v;
                List<object> list = o.TryGetValue(key, out v) ? v as List<object> : null;
                return list == null ? new List<string>() : list.OfType<string>().ToList();
            }

            /// Objects are dictionaries, arrays lists, numbers doubles.
            public static object Parse(string s)
            {
                int i = 0;
                object v = Value(s, ref i);
                Space(s, ref i);
                if (i != s.Length) throw new FormatException("bad JSON");
                return v;
            }

            private static void Space(string s, ref int i)
            {
                while (i < s.Length && (char.IsWhiteSpace(s[i]) || s[i] == '﻿')) i++;
            }

            private static object Value(string s, ref int i)
            {
                Space(s, ref i);
                if (i >= s.Length) throw new FormatException("bad JSON");
                char c = s[i];
                if (c == '"') return StringValue(s, ref i);
                if (c == '{')
                {
                    Dictionary<string, object> o = new Dictionary<string, object>();
                    i++;
                    Space(s, ref i);
                    if (s[i] == '}') { i++; return o; }
                    while (true)
                    {
                        Space(s, ref i);
                        string key = StringValue(s, ref i);
                        Space(s, ref i);
                        if (s[i++] != ':') throw new FormatException("bad JSON");
                        o[key] = Value(s, ref i);
                        Space(s, ref i);
                        char n = s[i++];
                        if (n == '}') return o;
                        if (n != ',') throw new FormatException("bad JSON");
                    }
                }
                if (c == '[')
                {
                    List<object> a = new List<object>();
                    i++;
                    Space(s, ref i);
                    if (s[i] == ']') { i++; return a; }
                    while (true)
                    {
                        a.Add(Value(s, ref i));
                        Space(s, ref i);
                        char n = s[i++];
                        if (n == ']') return a;
                        if (n != ',') throw new FormatException("bad JSON");
                    }
                }
                if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
                if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
                if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
                int start = i;
                while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }

            private static string StringValue(string s, ref int i)
            {
                if (s[i++] != '"') throw new FormatException("bad JSON");
                StringBuilder b = new StringBuilder();
                while (s[i] != '"')
                {
                    char c = s[i++];
                    if (c != '\\') { b.Append(c); continue; }
                    char e = s[i++];
                    switch (e)
                    {
                        case 'n': b.Append('\n'); break;
                        case 'r': b.Append('\r'); break;
                        case 't': b.Append('\t'); break;
                        case 'b': b.Append('\b'); break;
                        case 'f': b.Append('\f'); break;
                        case 'u': b.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture)); i += 4; break;
                        default: b.Append(e); break;
                    }
                }
                i++;
                return b.ToString();
            }
        }
    }
}
