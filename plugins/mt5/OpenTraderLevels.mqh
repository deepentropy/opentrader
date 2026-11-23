//+------------------------------------------------------------------+
//| OpenTraderLevels.mqh: exit levels (plugins/PROTOCOL.md, "Exit     |
//| levels"): an order or a position closed in parts, each part with |
//| its own take profit and stop loss.                                |
//|                                                                  |
//| MetaTrader keeps one take profit / stop loss per position, so:    |
//|  - hedging accounts: each level is an order, then a position, of  |
//|    its own, with the level's take profit and stop loss. The parts |
//|    share a magic number (the group) and are reported as one order |
//|    or one position whose levels are the parts (id = ticket).      |
//|  - netting accounts: each level is a pair of pending orders the   |
//|    EA keeps on the position (a limit at the take profit, a stop   |
//|    at the stop loss) sharing a magic number: when one fills, the  |
//|    other goes; when the position closes, all go; together they    |
//|    never cover more than the position, so leftover orders cannot  |
//|    reverse it. The levels of an order still waiting to fill are   |
//|    kept in a file until it fills.                                 |
//+------------------------------------------------------------------+
#property strict

//--- The magic numbers of the parts and levels: a range no hand-placed order uses (they have 0).
#define OT_MAGIC 7310000000000000
#define OT_MAGIC_SPAN 1000000000000000
#define MAX_LEVELS 8

bool IsOt(const long magic) { return magic >= OT_MAGIC && magic < OT_MAGIC + OT_MAGIC_SPAN; }

long g_lastMagic = 0;
bool g_levelsDirty = true;         // a trade happened: the netting levels are checked again
ulong g_lastLevels = 0;

//--- A magic number of its own for a group or a level: the time in seconds, then a count, so it stays unique across
//--- restarts of the EA.
long NewMagic(void)
  {
   long m = OT_MAGIC + (long)TimeGMT() * 1000;
   if(m <= g_lastMagic)
      m = g_lastMagic + 1;
   g_lastMagic = m;
   return m;
  }

//--- True when `magic` was listed already; else lists it.
bool Listed(long &list[], const long magic)
  {
   for(int i = 0; i < ArraySize(list); i++)
      if(list[i] == magic)
         return true;
   int n = ArraySize(list);
   ArrayResize(list, n + 1);
   list[n] = magic;
   return false;
  }

bool Hedging(void) { return (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING; }

//--- Volumes compared as whole volume steps: lots are doubles.
long Steps(const string t, const double lots)
  {
   double s = SymbolInfoDouble(t, SYMBOL_VOLUME_STEP);
   return s > 0 ? (long)MathRound(lots / s) : (long)MathRound(lots * 1e8);
  }

double FromSteps(const string t, const long n)
  {
   double s = SymbolInfoDouble(t, SYMBOL_VOLUME_STEP);
   return NormalizeDouble(s > 0 ? n * s : n / 1e8, 8);
  }

bool SamePrice(const string t, const double a, const double b) { return MathAbs(a - b) < SymbolInfoDouble(t, SYMBOL_POINT) / 2; }

string Units(const string t, const double lots) { return JN(lots * ContractSize(t), 2); }

//--- The levels of a request, in lots: the parts' quantities, take profits and stop losses (0: none).
class CLevels
  {
public:
   double            lots[];
   double            tp[];
   double            sl[];
   int               Size(void) { return ArraySize(lots); }
   void              Add(const double l, const double t, const double s)
     {
      int n = ArraySize(lots);
      ArrayResize(lots, n + 1);
      ArrayResize(tp, n + 1);
      ArrayResize(sl, n + 1);
      lots[n] = l;
      tp[n] = t;
      sl[n] = s;
     }
  };

//--- The request's `exitLevels`: false when it has none (its takeProfit / stopLoss then apply); `error` when a level
//--- cannot be traded. A level without prices protects nothing and is left out.
bool ReadLevels(CJ *p, const string t, CLevels &out, string &error)
  {
   CJ *list = p != NULL ? p.Get("exitLevels") : NULL;
   if(list == NULL || list.type != J_ARR)
      return false;
   if(list.Size() > MAX_LEVELS)
     {
      error = StringFormat("At most %d exit levels", MAX_LEVELS);
      return true;
     }
   for(int i = 0; i < list.Size(); i++)
     {
      CJ *l = list.At(i);
      double tp = Price(l, "takeProfit"), sl = Price(l, "stopLoss");
      if(tp <= 0 && sl <= 0)
         continue;
      string e = "";
      double lots = Lots(t, JNum(l, "qty"), e);
      if(lots <= 0)
        {
         error = "Exit level " + IntegerToString(i + 1) + ": " + e;
         return true;
        }
      out.Add(lots, tp, sl);
     }
   return true;
  }

//--- The exits of a buy position sit above `from` (take profit) and below it (stop loss), the other way for a sell:
//--- checked before any part is sent, so an order is not left half sent.
string ExitError(const string t, const bool buy, const double from, const double tp, const double sl)
  {
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   if(tp > 0 && (buy ? tp <= from : tp >= from))
      return StringFormat("The take profit %s must be %s %s", DoubleToString(tp, digits), buy ? "above" : "below", DoubleToString(from, digits));
   if(sl > 0 && (buy ? sl >= from : sl <= from))
      return StringFormat("The stop loss %s must be %s %s", DoubleToString(sl, digits), buy ? "below" : "above", DoubleToString(from, digits));
   return "";
  }

//--- The price an order's exits are measured from: the order's price, or the closing side of the market.
double EntryOf(const string t, const bool buy, const string type, const double limit, const double stop)
  {
   if(type == "limit" || type == "stopLimit")
      return limit;
   if(type == "stop")
      return stop;
   return SymbolInfoDouble(t, buy ? SYMBOL_BID : SYMBOL_ASK);
  }

//--- Sends one order. `magic` 0 for a plain order.
bool SendOrder(const string t, const bool buy, const string type, const double lots, const double limit, const double stop, const double sl, const double tp,
               const ENUM_ORDER_TYPE_TIME life, const long magic, ulong &ticket, string &error)
  {
   g_trade.SetExpertMagicNumber(magic);
   bool ok = false;
   if(type == "market")
      ok = buy ? g_trade.Buy(lots, t, 0, sl, tp, "OpenTrader") : g_trade.Sell(lots, t, 0, sl, tp, "OpenTrader");
   else
      if(type == "limit")
         ok = buy ? g_trade.BuyLimit(lots, limit, t, sl, tp, life, 0, "OpenTrader") : g_trade.SellLimit(lots, limit, t, sl, tp, life, 0, "OpenTrader");
      else
         if(type == "stop")
            ok = buy ? g_trade.BuyStop(lots, stop, t, sl, tp, life, 0, "OpenTrader") : g_trade.SellStop(lots, stop, t, sl, tp, life, 0, "OpenTrader");
         else
            if(type == "stopLimit")
               ok = g_trade.OrderOpen(t, buy ? ORDER_TYPE_BUY_STOP_LIMIT : ORDER_TYPE_SELL_STOP_LIMIT, lots, limit, stop, sl, tp, life, 0, "OpenTrader");
            else
               error = "Unknown order type " + type;
   g_trade.SetExpertMagicNumber(0);
   if(error != "")
      return false;
   error = Outcome();
   if(!ok && error == "")
      error = "The order was not sent (" + IntegerToString(GetLastError()) + ")";
   ticket = error == "" ? g_trade.ResultOrder() : 0;
   return error == "";
  }

//--- Order tickets whose notifications stay quiet: the other parts of a group, so one order gives one toast.
ulong g_quiet[];

void Quiet(const ulong ticket)
  {
   int n = ArraySize(g_quiet);
   if(n >= 200)
     {
      ArrayRemove(g_quiet, 0, 100);
      n = ArraySize(g_quiet);
     }
   ArrayResize(g_quiet, n + 1);
   g_quiet[n] = ticket;
  }

bool IsQuiet(const ulong ticket)
  {
   for(int i = 0; i < ArraySize(g_quiet); i++)
      if(g_quiet[i] == ticket)
         return true;
   return false;
  }

//+------------------------------------------------------------------+
//| Hedging: one order / position per level                           |
//+------------------------------------------------------------------+
//--- The working orders (positions) of a group, oldest ticket first.
int GroupOrders(const long magic, ulong &out[])
  {
   ArrayResize(out, 0);
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong k = OrderGetTicket(i);
      if(k > 0 && OrderGetInteger(ORDER_MAGIC) == magic)
        {
         int n = ArraySize(out);
         ArrayResize(out, n + 1);
         out[n] = k;
        }
     }
   ArraySort(out);
   return ArraySize(out);
  }

int GroupPositions(const long magic, ulong &out[])
  {
   ArrayResize(out, 0);
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong k = PositionGetTicket(i);
      if(k > 0 && PositionGetInteger(POSITION_MAGIC) == magic)
        {
         int n = ArraySize(out);
         ArrayResize(out, n + 1);
         out[n] = k;
        }
     }
   ArraySort(out);
   return ArraySize(out);
  }

//--- The position a market order opened (hedging: its identifier is the order's ticket).
ulong PositionOfOrder(const ulong order)
  {
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong k = PositionGetTicket(i);
      if(k > 0 && (ulong)PositionGetInteger(POSITION_IDENTIFIER) == order)
         return k;
     }
   return 0;
  }

//--- The parts of an order of `lots` with levels: each level, then the quantity no level protects (without exits).
string Parts(const string t, const double lots, CLevels &lv, CLevels &parts)
  {
   long rest = Steps(t, lots);
   for(int i = 0; i < lv.Size(); i++)
     {
      parts.Add(lv.lots[i], lv.tp[i], lv.sl[i]);
      rest -= Steps(t, lv.lots[i]);
     }
   if(rest < 0)
      return "The exit levels protect more than the order's quantity";
   if(rest > 0)
     {
      double r = FromSteps(t, rest);
      double min = SymbolInfoDouble(t, SYMBOL_VOLUME_MIN);
      if(r < min - 1e-12)
         return StringFormat("The part of the order without exits (%s units) is below the smallest order of %s (%s units): protect it with a level", Units(t, r), t, Units(t, min));
      parts.Add(r, 0, 0);
     }
   return "";
  }

//--- Matches each part to a member (an order or a position) of the same quantity: one already at the part's prices
//--- first, then one sharing a price with it (a dragged line), then any. False when a part finds none.
bool Assign(const string t, double &mLots[], double &mTp[], double &mSl[], CLevels &parts, int &out[])
  {
   int m = ArraySize(mLots), n = parts.Size();
   bool used[];
   ArrayResize(used, m);
   ArrayInitialize(used, false);
   ArrayResize(out, n);
   ArrayInitialize(out, -1);
   for(int pass = 0; pass < 3; pass++)
      for(int j = 0; j < n; j++)
        {
         if(out[j] >= 0)
            continue;
         for(int i = 0; i < m; i++)
           {
            if(used[i] || Steps(t, mLots[i]) != Steps(t, parts.lots[j]))
               continue;
            bool tpSame = SamePrice(t, mTp[i], parts.tp[j]), slSame = SamePrice(t, mSl[i], parts.sl[j]);
            if((pass == 0 && !(tpSame && slSame)) || (pass == 1 && !(tpSame || slSame)))
               continue;
            out[j] = i;
            used[i] = true;
            break;
           }
        }
   for(int j = 0; j < n; j++)
      if(out[j] < 0)
         return false;
   return true;
  }

//--- Takes back the parts already sent of a group that could not be sent whole.
void TakeBack(ulong &tickets[], const bool market)
  {
   for(int i = 0; i < ArraySize(tickets); i++)
     {
      Quiet(tickets[i]);
      if(!market)
         g_trade.OrderDelete(tickets[i]);
      else
        {
         ulong pos = PositionOfOrder(tickets[i]);
         if(pos > 0)
            g_trade.PositionClose(pos);
        }
     }
  }

//--- Sends a group's parts with its magic number; all or none.
string SendParts(const string t, const bool buy, const string type, CLevels &parts, const double limit, const double stop, const ENUM_ORDER_TYPE_TIME life,
                 const long magic, ulong &first)
  {
   ulong sent[];
   for(int i = 0; i < parts.Size(); i++)
     {
      ulong k = 0;
      string error = "";
      if(!SendOrder(t, buy, type, parts.lots[i], limit, stop, parts.sl[i], parts.tp[i], life, magic, k, error))
        {
         TakeBack(sent, type == "market");
         return ArraySize(sent) > 0 ? error + "; the parts already sent were taken back" : error;
        }
      if(i == 0)
         first = k;
      else
         Quiet(k);
      int n = ArraySize(sent);
      ArrayResize(sent, n + 1);
      sent[n] = k;
     }
   return "";
  }

//--- broker.place with levels on a hedging account: one order per level (its quantity, take profit and stop loss), and
//--- one for the rest without exits.
string PlaceGroup(CJ *p, const string t, const double lots, CLevels &lv, string &error)
  {
   bool buy = JStr(p, "side") == "buy";
   string type = JStr(p, "type");
   double limit = Price(p, "limitPrice"), stop = Price(p, "stopPrice");
   CLevels parts;
   error = Parts(t, lots, lv, parts);
   if(error != "")
      return "";
   double from = EntryOf(t, buy, type, limit, stop);
   for(int i = 0; i < parts.Size() && error == ""; i++)
      error = ExitError(t, buy, from, parts.tp[i], parts.sl[i]);
   if(error != "")
      return "";
   ulong first = 0;
   error = SendParts(t, buy, type, parts, limit, stop, Life(p, t), parts.Size() > 1 ? NewMagic() : 0, first);
   if(error != "")
      return "";
   g_stateDirty = true;
   return "{\"orderId\":" + JQ(IntegerToString(first)) + "}";
  }

//--- broker.modify of a hedging order, alone or a group's: the price for every part; the levels by part, each kept on
//--- an order of its quantity when there is one, else the order is sent again in its new parts.
string ModifyGroup(CJ *p, const ulong ticket, string &error)
  {
   long magic = OrderGetInteger(ORDER_MAGIC);
   ulong members[];
   if(IsOt(magic))
      GroupOrders(magic, members);
   else
     {
      ArrayResize(members, 1);
      members[0] = ticket;
     }
   int m = ArraySize(members);
   if(!OrderSelect(members[0]))
     {
      error = "No working order " + IntegerToString(ticket);
      return "";
     }
   string t = OrderGetString(ORDER_SYMBOL);
   ENUM_ORDER_TYPE otype = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
   string kind = OrderTypeOf(otype);
   bool buy = IsBuy(otype);
   ENUM_ORDER_TYPE_TIME life = JStr(p, "duration") != "" ? Life(p, t) : (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   datetime expiry = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
   double mLots[], mTp[], mSl[];
   ArrayResize(mLots, m);
   ArrayResize(mTp, m);
   ArrayResize(mSl, m);
   double total = 0;
   for(int i = 0; i < m; i++)
     {
      if(!OrderSelect(members[i]))
         continue;
      mLots[i] = OrderGetDouble(ORDER_VOLUME_CURRENT);
      mTp[i] = OrderGetDouble(ORDER_TP);
      mSl[i] = OrderGetDouble(ORDER_SL);
      total += mLots[i];
     }
   double size = ContractSize(t);
   if(JHasNum(p, "qty") && MathAbs(JNum(p, "qty") - total * size) > size * SymbolInfoDouble(t, SYMBOL_VOLUME_STEP) / 2)
     {
      error = "MetaTrader 5 cannot change an order's quantity: cancel it and place a new one";
      return "";
     }
   double price = kind == "limit" ? Price(p, "limitPrice") : Price(p, "stopPrice");
   double stoplimit = kind == "stopLimit" ? Price(p, "limitPrice") : 0;
   CLevels lv, parts;
   bool levels = ReadLevels(p, t, lv, error);
   if(error != "")
      return "";
   if(levels)
      error = Parts(t, total, lv, parts);
   else
      // One take profit / stop loss for the whole order: every part takes it.
      for(int i = 0; i < m; i++)
         parts.Add(mLots[i], Price(p, "takeProfit"), Price(p, "stopLoss"));
   if(error != "")
      return "";
   double from = kind == "stopLimit" ? stoplimit : price;
   for(int i = 0; i < parts.Size() && error == ""; i++)
      error = ExitError(t, buy, from, parts.tp[i], parts.sl[i]);
   if(error != "")
      return "";
   int assign[];
   if(Assign(t, mLots, mTp, mSl, parts, assign))
     {
      for(int j = 0; j < parts.Size(); j++)
        {
         ulong k = members[assign[j]];
         if(j > 0)
            Quiet(k);
         // A part left as it was is not sent: the server answers "no changes".
         if(OrderSelect(k) && SamePrice(t, OrderGetDouble(ORDER_PRICE_OPEN), price) && SamePrice(t, OrderGetDouble(ORDER_PRICE_STOPLIMIT), stoplimit) &&
            SamePrice(t, OrderGetDouble(ORDER_SL), parts.sl[j]) && SamePrice(t, OrderGetDouble(ORDER_TP), parts.tp[j]) &&
            (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME) == life)
            continue;
         if(!g_trade.OrderModify(k, price, parts.sl[j], parts.tp[j], life, expiry, stoplimit) && Outcome() != "")
           {
            error = Outcome();
            break;
           }
        }
      g_stateDirty = true;
      return error == "" ? "{}" : "";
     }
   // The parts' quantities changed: a pending order's quantity cannot, so the order goes and is sent again in its
   // new parts (the same group).
   for(int i = 0; i < m; i++)
     {
      Quiet(members[i]);
      if(!g_trade.OrderDelete(members[i]))
        {
         error = Outcome();
         if(error == "")
            error = "The order was not changed (" + IntegerToString(GetLastError()) + ")";
         g_stateDirty = true;
         return "";
        }
     }
   ulong first = 0;
   string type = kind;
   double lim = kind == "limit" ? price : stoplimit, stp = kind == "limit" ? 0 : price;
   error = SendParts(t, buy, type, parts, lim, stp, life, parts.Size() > 1 ? (IsOt(magic) ? magic : NewMagic()) : 0, first);
   if(error != "")
      error = "The order was cancelled and could not be sent again with its new levels: " + error;
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

//--- broker.cancel of a hedging group: all its parts.
bool CancelGroup(const ulong ticket, string &error)
  {
   if(!OrderSelect(ticket) || !IsOt(OrderGetInteger(ORDER_MAGIC)) || !Hedging())
      return false;
   ulong members[];
   int m = GroupOrders(OrderGetInteger(ORDER_MAGIC), members);
   for(int i = 0; i < m; i++)
     {
      if(members[i] != ticket)
         Quiet(members[i]);
      if(!g_trade.OrderDelete(members[i]) && error == "")
        {
         error = Outcome();
         if(error == "")
            error = "The order was not cancelled (" + IntegerToString(GetLastError()) + ")";
        }
     }
   g_stateDirty = true;
   return true;
  }

//--- The positions of a hedging position's group (itself alone when it has none), and its symbol. The position is
//--- selected first.
int Members(const ulong ticket, ulong &members[], string &t)
  {
   t = PositionGetString(POSITION_SYMBOL);
   long magic = PositionGetInteger(POSITION_MAGIC);
   if(Hedging() && IsOt(magic))
      return GroupPositions(magic, members);
   ArrayResize(members, 1);
   members[0] = ticket;
   return 1;
  }

bool ModifyPosition(const ulong k, const double sl, const double tp, string &error)
  {
   if(!PositionSelectByTicket(k))
      return true;
   string t = PositionGetString(POSITION_SYMBOL);
   if(SamePrice(t, PositionGetDouble(POSITION_SL), sl) && SamePrice(t, PositionGetDouble(POSITION_TP), tp))
      return true;
   if(g_trade.PositionModify(k, sl, tp) || Outcome() == "")
      return true;
   error = Outcome();
   return false;
  }

//--- broker.setPositionBrackets of a hedging position: one take profit / stop loss for each of its parts, or its levels
//--- on the parts of their quantities. A part's quantity cannot change: MetaTrader keeps one take profit / stop loss
//--- per position, and a level of an open position is a position of its own.
string GroupBrackets(CJ *p, const ulong ticket, string &error)
  {
   ulong members[];
   string t = "";
   int m = Members(ticket, members, t);
   CLevels lv;
   bool levels = ReadLevels(p, t, lv, error);
   if(error != "")
      return "";
   if(!levels)
     {
      for(int i = 0; i < m && error == ""; i++)
         ModifyPosition(members[i], Price(p, "stopLoss"), Price(p, "takeProfit"), error);
      g_stateDirty = true;
      return error == "" ? "{}" : "";
     }
   double mLots[], mTp[], mSl[];
   ArrayResize(mLots, m);
   ArrayResize(mTp, m);
   ArrayResize(mSl, m);
   long total = 0, protect = 0;
   for(int i = 0; i < m; i++)
     {
      PositionSelectByTicket(members[i]);
      mLots[i] = PositionGetDouble(POSITION_VOLUME);
      mTp[i] = PositionGetDouble(POSITION_TP);
      mSl[i] = PositionGetDouble(POSITION_SL);
      total += Steps(t, mLots[i]);
     }
   for(int j = 0; j < lv.Size(); j++)
      protect += Steps(t, lv.lots[j]);
   if(protect > total)
     {
      error = "The exit levels protect more than the position's quantity";
      return "";
     }
   int assign[];
   if(!Assign(t, mLots, mTp, mSl, lv, assign))
     {
      string sizes = "";
      for(int i = 0; i < m; i++)
         sizes += (sizes == "" ? "" : ", ") + Units(t, mLots[i]);
      error = "MetaTrader 5 keeps one take profit and stop loss per position: this position's levels can only protect its parts as they are (" + sizes +
              " units). Change a level's prices or remove it, close part of the position, or give the levels with the order";
      return "";
     }
   bool kept[];
   ArrayResize(kept, m);
   ArrayInitialize(kept, false);
   for(int j = 0; j < lv.Size() && error == ""; j++)
     {
      kept[assign[j]] = true;
      ModifyPosition(members[assign[j]], lv.sl[j], lv.tp[j], error);
     }
   // A part no level protects keeps no exits.
   for(int i = 0; i < m && error == ""; i++)
      if(!kept[i])
         ModifyPosition(members[i], 0, 0, error);
   g_stateDirty = true;
   return error == "" ? "{}" : "";
  }

//--- broker.closePosition of a hedging group: all of it, or `lots` taken from the part without exits first, then from
//--- the newest levels (a level's position closed in part).
string CloseGroup(const ulong ticket, const bool all, const double lots, string &error)
  {
   ulong members[];
   string t = "";
   int m = Members(ticket, members, t);
   long left = all ? LONG_MAX : Steps(t, lots);
   for(int pass = 0; pass < 2 && left > 0; pass++)
      for(int i = m - 1; i >= 0 && left > 0; i--)
        {
         if(!PositionSelectByTicket(members[i]))
            continue;
         bool bare = PositionGetDouble(POSITION_TP) <= 0 && PositionGetDouble(POSITION_SL) <= 0;
         if((pass == 0) != bare)
            continue;
         long vol = Steps(t, PositionGetDouble(POSITION_VOLUME));
         bool ok = vol <= left ? g_trade.PositionClose(members[i]) : g_trade.PositionClosePartial(members[i], FromSteps(t, left));
         if(!ok && Outcome() != "")
           {
            error = Outcome();
            g_stateDirty = true;
            return "";
           }
         left -= MathMin(vol, left);
        }
   g_stateDirty = true;
   return "{}";
  }

//--- The exits of a group's parts: the take profit / stop loss they share, else each protected part as a level.
string GroupExits(const string t, ulong &members[], double &tps[], double &sls[], double &lots[])
  {
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   int m = ArraySize(members);
   bool same = true;
   for(int i = 1; i < m; i++)
      if(!SamePrice(t, tps[i], tps[0]) || !SamePrice(t, sls[i], sls[0]))
         same = false;
   if(same)
      return "\"takeProfit\":" + JP(tps[0], digits) + ",\"stopLoss\":" + JP(sls[0], digits);
   string levels = "";
   for(int i = 0; i < m; i++)
      if(tps[i] > 0 || sls[i] > 0)
         levels += (levels == "" ? "" : ",") + "{\"id\":" + JQ(IntegerToString(members[i])) + ",\"qty\":" + JN(lots[i] * ContractSize(t), 4) +
                   ",\"takeProfit\":" + JP(tps[i], digits) + ",\"stopLoss\":" + JP(sls[i], digits) + "}";
   return "\"takeProfit\":null,\"stopLoss\":null,\"exitLevels\":[" + levels + "]";
  }

//--- A hedging group's working orders as one order.
string GroupOrderJson(const long magic)
  {
   ulong members[];
   int m = GroupOrders(magic, members);
   double tps[], sls[], lots[];
   ArrayResize(tps, m);
   ArrayResize(sls, m);
   ArrayResize(lots, m);
   double total = 0;
   string t = "";
   for(int i = 0; i < m; i++)
     {
      if(!OrderSelect(members[i]))
         continue;
      t = OrderGetString(ORDER_SYMBOL);
      tps[i] = OrderGetDouble(ORDER_TP);
      sls[i] = OrderGetDouble(ORDER_SL);
      lots[i] = OrderGetDouble(ORDER_VOLUME_CURRENT);
      total += lots[i];
     }
   string exits = GroupExits(t, members, tps, sls, lots);
   if(!OrderSelect(members[0]))
      return "";
   return OrderJson(members[0], false, total, exits);
  }

//--- A hedging group's positions as one position: its quantity, average price and P&L, and its parts' exits.
string GroupPositionJson(const long magic)
  {
   ulong members[];
   int m = GroupPositions(magic, members);
   double tps[], sls[], lots[];
   ArrayResize(tps, m);
   ArrayResize(sls, m);
   ArrayResize(lots, m);
   double total = 0, cost = 0, pnl = 0, last = 0;
   string t = "";
   bool buy = true;
   for(int i = 0; i < m; i++)
     {
      PositionSelectByTicket(members[i]);
      t = PositionGetString(POSITION_SYMBOL);
      buy = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      tps[i] = PositionGetDouble(POSITION_TP);
      sls[i] = PositionGetDouble(POSITION_SL);
      lots[i] = PositionGetDouble(POSITION_VOLUME);
      total += lots[i];
      cost += lots[i] * PositionGetDouble(POSITION_PRICE_OPEN);
      pnl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      last = PositionGetDouble(POSITION_PRICE_CURRENT);
     }
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   return "{\"id\":" + JQ(IntegerToString(members[0])) + ",\"ticker\":" + JQ(t) + ",\"side\":" + Side(buy) + ",\"qty\":" + JN(total * ContractSize(t), 4) +
          ",\"avgPrice\":" + JN(total > 0 ? cost / total : 0, digits) + ",\"last\":" + JN(last, digits) + ",\"unrealizedPnl\":" + JN(pnl, 2) + "," +
          GroupExits(t, members, tps, sls, lots) + "}";
  }

//+------------------------------------------------------------------+
//| Netting: levels as pending order pairs the EA keeps               |
//+------------------------------------------------------------------+
//--- A level of a netting position: its take profit leg (a limit) and stop loss leg (a stop), 0 when it has none.
struct SNetLevel
  {
   long              magic;
   bool              sell;       // the legs close a buy position
   ulong             tpTicket;
   double            tp;
   double            tpLots;
   long              tpSetup;    // when the leg was placed (server ms)
   ulong             slTicket;
   double            sl;
   double            slLots;
   long              slSetup;
  };

double LevelLots(const SNetLevel &l) { return MathMax(l.tpLots, l.slLots); }

//--- The levels on a symbol, oldest first.
int NetLevels(const string t, SNetLevel &out[])
  {
   ArrayResize(out, 0);
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong k = OrderGetTicket(i);
      if(k == 0 || OrderGetString(ORDER_SYMBOL) != t)
         continue;
      long magic = OrderGetInteger(ORDER_MAGIC);
      if(!IsOt(magic))
         continue;
      int n = ArraySize(out), at = -1;
      for(int j = 0; j < n; j++)
         if(out[j].magic == magic)
            at = j;
      if(at < 0)
        {
         ArrayResize(out, n + 1);
         at = n;
         ZeroMemory(out[at]);
         out[at].magic = magic;
        }
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      out[at].sell = !IsBuy(type);
      if(OrderTypeOf(type) == "limit")
        {
         out[at].tpTicket = k;
         out[at].tp = OrderGetDouble(ORDER_PRICE_OPEN);
         out[at].tpLots = OrderGetDouble(ORDER_VOLUME_CURRENT);
         out[at].tpSetup = OrderGetInteger(ORDER_TIME_SETUP_MSC);
        }
      else
        {
         out[at].slTicket = k;
         out[at].sl = OrderGetDouble(ORDER_PRICE_OPEN);
         out[at].slLots = OrderGetDouble(ORDER_VOLUME_CURRENT);
         out[at].slSetup = OrderGetInteger(ORDER_TIME_SETUP_MSC);
        }
     }
   // Oldest first: the order the levels were given in.
   int n = ArraySize(out);
   for(int i = 1; i < n; i++)
      for(int j = i; j > 0 && out[j].magic < out[j - 1].magic; j--)
        {
         SNetLevel x = out[j];
         out[j] = out[j - 1];
         out[j - 1] = x;
        }
   return n;
  }

ENUM_ORDER_TYPE_TIME LegLife(const string t) { return (SymbolInfoInteger(t, SYMBOL_EXPIRATION_MODE) & SYMBOL_EXPIRATION_GTC) != 0 ? ORDER_TIME_GTC : ORDER_TIME_DAY; }

//--- One leg: a limit at the take profit or a stop at the stop loss, closing (part of) the position.
bool PlaceLeg(const string t, const bool sell, const bool takeProfit, const double price, const double lots, const long magic, string &error)
  {
   g_trade.SetExpertMagicNumber(magic);
   ENUM_ORDER_TYPE_TIME life = LegLife(t);
   bool ok;
   if(takeProfit)
      ok = sell ? g_trade.SellLimit(lots, price, t, 0, 0, life, 0, "OpenTrader TP") : g_trade.BuyLimit(lots, price, t, 0, 0, life, 0, "OpenTrader TP");
   else
      ok = sell ? g_trade.SellStop(lots, price, t, 0, 0, life, 0, "OpenTrader SL") : g_trade.BuyStop(lots, price, t, 0, 0, life, 0, "OpenTrader SL");
   g_trade.SetExpertMagicNumber(0);
   error = Outcome();
   if(!ok && error == "")
      error = "The exit order was not sent (" + IntegerToString(GetLastError()) + ")";
   return error == "";
  }

//--- A level's two legs; none when one cannot be placed.
bool PlaceNetLevel(const string t, const bool buyPosition, const double lots, const double tp, const double sl, const long magic, string &error)
  {
   if(tp > 0 && !PlaceLeg(t, buyPosition, true, tp, lots, magic, error))
      return false;
   ulong tpTicket = tp > 0 ? g_trade.ResultOrder() : 0;
   if(sl > 0 && !PlaceLeg(t, buyPosition, false, sl, lots, magic, error))
     {
      if(tpTicket > 0)
         g_trade.OrderDelete(tpTicket);
      return false;
     }
   return true;
  }

void DeleteLegs(const SNetLevel &l)
  {
   if(l.tpTicket > 0)
      g_trade.OrderDelete(l.tpTicket);
   if(l.slTicket > 0)
      g_trade.OrderDelete(l.slTicket);
  }

//--- A level's legs again with `lots` (a pending order's volume cannot change): none when below the symbol's minimum.
void ResizeLevel(const string t, const SNetLevel &l, const double lots)
  {
   DeleteLegs(l);
   if(lots < SymbolInfoDouble(t, SYMBOL_VOLUME_MIN) - 1e-12)
      return;
   string error = "";
   if(!PlaceNetLevel(t, l.sell, lots, l.tpTicket > 0 ? l.tp : 0, l.slTicket > 0 ? l.sl : 0, l.magic, error))
      Notice("error", t + ": an exit level was not placed again: " + error);
  }

void Notice(const string level, const string message)
  {
   Print("OpenTrader: ", message);
   if(g_ready)
      Notify("broker.notice", "{\"level\":" + JQ(level) + ",\"message\":" + JQ(message) + "}");
  }

//--- The position's levels in broker.state: id = the level's magic number, which stays when its legs are sent again.
string NetExits(const string t, const bool buyPosition)
  {
   SNetLevel l[];
   int n = NetLevels(t, l);
   int digits = (int)SymbolInfoInteger(t, SYMBOL_DIGITS);
   string out = "";
   for(int i = 0; i < n; i++)
      if(l[i].sell == buyPosition)
         out += (out == "" ? "" : ",") + "{\"id\":" + JQ(IntegerToString(l[i].magic - OT_MAGIC)) + ",\"qty\":" + JN(LevelLots(l[i]) * ContractSize(t), 4) +
                ",\"takeProfit\":" + (l[i].tpTicket > 0 ? JN(l[i].tp, digits) : "null") + ",\"stopLoss\":" + (l[i].slTicket > 0 ? JN(l[i].sl, digits) : "null") + "}";
   return out;
  }

//--- broker.setPositionBrackets on a netting account: the levels (they replace the position's take profit / stop
//--- loss), or the position's own take profit / stop loss (they replace the levels). The position is selected.
string NetBrackets(CJ *p, const ulong ticket, string &error)
  {
   string t = PositionGetString(POSITION_SYMBOL);
   bool buy = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
   double posLots = PositionGetDouble(POSITION_VOLUME);
   double posTp = PositionGetDouble(POSITION_TP), posSl = PositionGetDouble(POSITION_SL);
   CLevels lv;
   bool levels = ReadLevels(p, t, lv, error);
   if(error != "")
      return "";
   SNetLevel cur[];
   int n = NetLevels(t, cur);
   if(!levels)
     {
      for(int i = 0; i < n; i++)
         DeleteLegs(cur[i]);
      ModifyPosition(ticket, Price(p, "stopLoss"), Price(p, "takeProfit"), error);
      g_stateDirty = true;
      return error == "" ? "{}" : "";
     }
   long protect = 0;
   double bid = SymbolInfoDouble(t, buy ? SYMBOL_BID : SYMBOL_ASK);
   for(int j = 0; j < lv.Size() && error == ""; j++)
     {
      protect += Steps(t, lv.lots[j]);
      error = ExitError(t, buy, bid, lv.tp[j], lv.sl[j]);
     }
   if(error != "")
      return "";
   if(protect > Steps(t, posLots))
     {
      error = "The exit levels protect more than the position's quantity";
      return "";
     }
   if(posTp > 0 || posSl > 0)
      ModifyPosition(ticket, 0, 0, error);
   // The levels that go or change quantity first: together the legs never cover more than the position.
   bool keep[];
   ArrayResize(keep, n);
   for(int i = 0; i < n; i++)
     {
      keep[i] = i < lv.Size() && cur[i].sell == buy && Steps(t, LevelLots(cur[i])) == Steps(t, lv.lots[i]);
      if(!keep[i])
         DeleteLegs(cur[i]);
     }
   for(int j = 0; j < lv.Size() && error == ""; j++)
     {
      if(j < n && keep[j])
        {
         // The same quantity: the legs move to the new prices, or come and go.
         SNetLevel c = cur[j];
         double lots = LevelLots(c);
         ENUM_ORDER_TYPE_TIME life = LegLife(t);
         if(lv.tp[j] > 0 && c.tpTicket > 0 && !SamePrice(t, c.tp, lv.tp[j]))
           {
            if(!g_trade.OrderModify(c.tpTicket, lv.tp[j], 0, 0, life, 0, 0))
               error = Outcome();
           }
         else
            if(lv.tp[j] > 0 && c.tpTicket == 0)
               PlaceLeg(t, buy, true, lv.tp[j], lots, c.magic, error);
            else
               if(lv.tp[j] <= 0 && c.tpTicket > 0)
                  g_trade.OrderDelete(c.tpTicket);
         if(error != "")
            break;
         if(lv.sl[j] > 0 && c.slTicket > 0 && !SamePrice(t, c.sl, lv.sl[j]))
           {
            if(!g_trade.OrderModify(c.slTicket, lv.sl[j], 0, 0, life, 0, 0))
               error = Outcome();
           }
         else
            if(lv.sl[j] > 0 && c.slTicket == 0)
               PlaceLeg(t, buy, false, lv.sl[j], lots, c.magic, error);
            else
               if(lv.sl[j] <= 0 && c.slTicket > 0)
                  g_trade.OrderDelete(c.slTicket);
        }
      else
         PlaceNetLevel(t, buy, lv.lots[j], lv.tp[j], lv.sl[j], j < n ? cur[j].magic : NewMagic(), error);
     }
   g_stateDirty = true;
   g_levelsDirty = true;
   return error == "" ? "{}" : "";
  }

//--- The levels of an order waiting to fill (netting): placed on the position as its order fills. Kept in a file, so a
//--- restart of the EA or the terminal does not lose them.
class CPlan
  {
public:
   ulong             order;
   string            symbol;
   bool              buy;
   int               placed;      // levels placed so far
   double            placedLots;  // their quantity
   ulong             born;        // GetTickCount64 when made (an order not found yet)
   CLevels           levels;
  };

CPlan   *g_plans[];
long     g_plansLogin = -1;

string PlanFile(void) { return "OpenTrader\\levels-" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ".json"; }

void ClearPlans(void)
  {
   for(int i = 0; i < ArraySize(g_plans); i++)
      delete g_plans[i];
   ArrayResize(g_plans, 0);
  }

void SavePlans(void)
  {
   string text = "{\"plans\":[";
   for(int i = 0; i < ArraySize(g_plans); i++)
     {
      CPlan *p = g_plans[i];
      string levels = "";
      for(int j = 0; j < p.levels.Size(); j++)
         levels += (j == 0 ? "" : ",") + "[" + JN(p.levels.lots[j]) + "," + JN(p.levels.tp[j], 10) + "," + JN(p.levels.sl[j], 10) + "]";
      text += (i == 0 ? "" : ",") + "{\"order\":" + JQ(IntegerToString(p.order)) + ",\"symbol\":" + JQ(p.symbol) + ",\"buy\":" + (p.buy ? "true" : "false") +
              ",\"placed\":" + IntegerToString(p.placed) + ",\"placedLots\":" + JN(p.placedLots) + ",\"levels\":[" + levels + "]}";
     }
   text += "]}";
   int f = FileOpen(PlanFile(), FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(f == INVALID_HANDLE)
     {
      Print("OpenTrader: the exit levels of the orders could not be saved (", GetLastError(), ")");
      return;
     }
   FileWriteString(f, text);
   FileClose(f);
  }

void LoadPlans(void)
  {
   ClearPlans();
   g_plansLogin = AccountInfoInteger(ACCOUNT_LOGIN);
   int f = FileOpen(PlanFile(), FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(f == INVALID_HANDLE)
      return;
   string text = "";
   while(!FileIsEnding(f))
      text += FileReadString(f);
   FileClose(f);
   CJReader r;
   CJ *o = r.Parse(text);
   if(o == NULL)
      return;
   CJ *list = o.Get("plans");
   for(int i = 0; list != NULL && i < list.Size(); i++)
     {
      CJ *x = list.At(i);
      CPlan *p = new CPlan;
      p.order = (ulong)StringToInteger(JStr(x, "order"));
      p.symbol = JStr(x, "symbol");
      CJ *b = x.Get("buy");
      p.buy = b != NULL && b.flag;
      p.placed = (int)JNum(x, "placed");
      p.placedLots = JNum(x, "placedLots");
      p.born = GetTickCount64();
      CJ *lv = x.Get("levels");
      for(int j = 0; lv != NULL && j < lv.Size(); j++)
        {
         CJ *l = lv.At(j);
         p.levels.Add(l.At(0).num, l.At(1).num, l.At(2).num);
        }
      int n = ArraySize(g_plans);
      ArrayResize(g_plans, n + 1);
      g_plans[n] = p;
     }
   delete o;
  }

//--- The saved plans of the account logged in, read before any change (writing first would lose them).
void EnsurePlans(void)
  {
   if(g_plansLogin != AccountInfoInteger(ACCOUNT_LOGIN))
      LoadPlans();
  }

int PlanOf(const ulong order)
  {
   EnsurePlans();
   for(int i = 0; i < ArraySize(g_plans); i++)
      if(g_plans[i].order == order)
         return i;
   return -1;
  }

void DropPlan(const int i)
  {
   delete g_plans[i];
   ArrayRemove(g_plans, i, 1);
  }

//--- An order's levels (netting), replacing those it had.
void SetPlan(const ulong order, const string t, const bool buy, CLevels &lv)
  {
   int i = PlanOf(order);
   if(i >= 0)
      DropPlan(i);
   CPlan *p = new CPlan;
   p.order = order;
   p.symbol = t;
   p.buy = buy;
   p.placed = 0;
   p.placedLots = 0;
   p.born = GetTickCount64();
   for(int j = 0; j < lv.Size(); j++)
      p.levels.Add(lv.lots[j], lv.tp[j], lv.sl[j]);
   int n = ArraySize(g_plans);
   ArrayResize(g_plans, n + 1);
   g_plans[n] = p;
   SavePlans();
  }

//--- An order's levels in broker.state (netting), ids by place.
string PlanExits(const int i)
  {
   CPlan *p = g_plans[i];
   int digits = (int)SymbolInfoInteger(p.symbol, SYMBOL_DIGITS);
   string out = "";
   for(int j = p.placed; j < p.levels.Size(); j++)
      out += (out == "" ? "" : ",") + "{\"id\":" + JQ(IntegerToString(j + 1)) + ",\"qty\":" + JN(p.levels.lots[j] * ContractSize(p.symbol), 4) +
             ",\"takeProfit\":" + JP(p.levels.tp[j], digits) + ",\"stopLoss\":" + JP(p.levels.sl[j], digits) + "}";
   return "\"takeProfit\":null,\"stopLoss\":null,\"exitLevels\":[" + out + "]";
  }

//--- Places the levels of the orders that filled: each level once the order filled its quantity; when the order is
//--- done (filled, or cancelled after a part filled) the next level takes what is left and the others are dropped.
void ProcessPlans(void)
  {
   EnsurePlans();
   bool changed = false;
   for(int i = ArraySize(g_plans) - 1; i >= 0; i--)
     {
      CPlan *p = g_plans[i];
      double filled = 0;
      bool done = false;
      if(OrderSelect(p.order))
         filled = OrderGetDouble(ORDER_VOLUME_INITIAL) - OrderGetDouble(ORDER_VOLUME_CURRENT);
      else
         if(HistoryOrderSelect(p.order))
           {
            filled = HistoryOrderGetDouble(p.order, ORDER_VOLUME_INITIAL) - HistoryOrderGetDouble(p.order, ORDER_VOLUME_CURRENT);
            done = true;
           }
         else
           {
            // Not in the terminal's lists yet (just sent), or not any more: given a minute.
            if(GetTickCount64() - p.born > 60000)
              {
               DropPlan(i);
               changed = true;
              }
            continue;
           }
      string t = p.symbol;
      long avail = Steps(t, filled) - Steps(t, p.placedLots);
      long min = Steps(t, SymbolInfoDouble(t, SYMBOL_VOLUME_MIN));
      while(p.placed < p.levels.Size())
        {
         long need = Steps(t, p.levels.lots[p.placed]);
         long take = need <= avail ? need : (done && avail >= min ? avail : 0);
         if(take <= 0)
            break;
         string error = "";
         double lots = FromSteps(t, take);
         if(!PlaceNetLevel(t, p.buy, lots, p.levels.tp[p.placed], p.levels.sl[p.placed], NewMagic(), error))
            Notice("error", t + ": the exit level " + IntegerToString(p.placed + 1) + " of order " + IntegerToString((long)p.order) + " was not placed: " + error);
         p.placed++;
         p.placedLots += lots;
         avail -= take;
         changed = true;
         g_stateDirty = true;
         if(take < need)
            break;
        }
      if(done)
        {
         DropPlan(i);
         changed = true;
        }
     }
   if(changed)
      SavePlans();
  }

//--- Keeps the netting levels right after any fill or change, also while OpenTrader is closed:
//--- 1. one cancels the other: what a leg filled comes off its other leg (gone when nothing is left);
//--- 2. no position, or one the other way: the levels go;
//--- 3. together the levels never cover more than the position: the newest give way.
void ReconcileNet(void)
  {
   if(Hedging())
      return;
   string symbols[];
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong k = OrderGetTicket(i);
      if(k == 0 || !IsOt(OrderGetInteger(ORDER_MAGIC)))
         continue;
      string t = OrderGetString(ORDER_SYMBOL);
      if(IndexOf(symbols, t) < 0)
        {
         int n = ArraySize(symbols);
         ArrayResize(symbols, n + 1);
         symbols[n] = t;
        }
     }
   for(int s = 0; s < ArraySize(symbols); s++)
     {
      string t = symbols[s];
      SNetLevel l[];
      int n = NetLevels(t, l);
      //--- 1. One cancels the other.
      long oldest = LONG_MAX;
      for(int i = 0; i < n; i++)
         oldest = MathMin(oldest, MathMin(l[i].tpTicket > 0 ? l[i].tpSetup : LONG_MAX, l[i].slTicket > 0 ? l[i].slSetup : LONG_MAX));
      bool changed = false;
      if(oldest < LONG_MAX && HistorySelect((datetime)(oldest / 1000) - 5, TimeCurrent() + 86400))
        {
         int deals = HistoryDealsTotal();
         for(int i = 0; i < n; i++)
            for(int leg = 0; leg < 2; leg++)
              {
               ulong k = leg == 0 ? l[i].tpTicket : l[i].slTicket;
               if(k == 0)
                  continue;
               long setup = leg == 0 ? l[i].tpSetup : l[i].slSetup;
               double filled = 0;
               for(int d = 0; d < deals; d++)
                 {
                  ulong deal = HistoryDealGetTicket(d);
                  if(deal > 0 && HistoryDealGetInteger(deal, DEAL_MAGIC) == l[i].magic && (ulong)HistoryDealGetInteger(deal, DEAL_ORDER) != k &&
                     HistoryDealGetInteger(deal, DEAL_TIME_MSC) >= setup)
                     filled += HistoryDealGetDouble(deal, DEAL_VOLUME);
                 }
               if(filled <= 0)
                  continue;
               double lots = (leg == 0 ? l[i].tpLots : l[i].slLots) - filled;
               g_trade.OrderDelete(k);
               string error = "";
               if(lots >= SymbolInfoDouble(t, SYMBOL_VOLUME_MIN) - 1e-12 &&
                  !PlaceLeg(t, l[i].sell, leg == 0, leg == 0 ? l[i].tp : l[i].sl, NormalizeDouble(lots, 8), l[i].magic, error))
                  Notice("error", t + ": an exit order was not placed again: " + error);
               changed = true;
              }
        }
      if(changed)
         n = NetLevels(t, l);
      //--- 2. and 3. Against the position.
      bool hasPos = PositionSelect(t);
      bool buy = hasPos && (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      long left = hasPos ? Steps(t, PositionGetDouble(POSITION_VOLUME)) : 0;
      long now = (long)TimeTradeServer() * 1000;
      for(int i = 0; i < n; i++)
        {
         // A level just placed while its position is not in the list yet waits a moment.
         long newest = MathMax(l[i].tpSetup, l[i].slSetup);
         if(!hasPos || l[i].sell != buy)
           {
            if(now - newest > 3000)
              {
               DeleteLegs(l[i]);
               changed = true;
              }
            continue;
           }
         long lots = Steps(t, LevelLots(l[i]));
         if(lots > left)
           {
            ResizeLevel(t, l[i], FromSteps(t, MathMax(left, 0)));
            changed = true;
            lots = left;
           }
         left -= MathMax(lots, 0);
        }
      if(changed)
         g_stateDirty = true;
     }
  }

//--- The exit levels' upkeep: after a trade, else every 2 seconds.
void KeepLevels(void)
  {
   ulong now = GetTickCount64();
   if(!g_levelsDirty && now - g_lastLevels < 2000)
      return;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || AccountInfoInteger(ACCOUNT_LOGIN) == 0)
      return;
   g_levelsDirty = false;
   g_lastLevels = now;
   if(Hedging())
      return;
   ProcessPlans();
   ReconcileNet();
  }
//+------------------------------------------------------------------+
