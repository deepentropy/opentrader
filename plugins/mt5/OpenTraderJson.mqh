//+------------------------------------------------------------------+
//| OpenTraderJson.mqh: the JSON the bridge reads and writes.         |
//| A small reader into a tree of CJ nodes, and helpers to write      |
//| values (JQ: a quoted string, JN: a number).                       |
//+------------------------------------------------------------------+
#property strict

enum ENUM_JTYPE { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

class CJ
  {
public:
   ENUM_JTYPE        type;
   double            num;
   bool              flag;
   string            str;
   string            keys[];
   CJ               *vals[];

                     CJ(void) { type = J_NULL; num = 0; flag = false; str = ""; }
                    ~CJ(void)
     {
      for(int i = 0; i < ArraySize(vals); i++)
         if(CheckPointer(vals[i]) == POINTER_DYNAMIC)
            delete vals[i];
     }
   int               Size(void) { return ArraySize(vals); }
   CJ               *At(int i) { return (i >= 0 && i < ArraySize(vals)) ? vals[i] : NULL; }
   CJ               *Get(const string key)
     {
      for(int i = 0; i < ArraySize(keys); i++)
         if(keys[i] == key)
            return vals[i];
      return NULL;
     }
   void              Add(const string key, CJ *v)
     {
      int n = ArraySize(vals);
      ArrayResize(vals, n + 1);
      ArrayResize(keys, n + 1);
      vals[n] = v;
      keys[n] = key;
     }
  };

class CJReader
  {
private:
   string            m_s;
   int               m_pos;
   int               m_len;

   ushort            Peek(void) { return m_pos < m_len ? StringGetCharacter(m_s, m_pos) : 0; }
   void              Skip(void)
     {
      while(m_pos < m_len)
        {
         ushort c = StringGetCharacter(m_s, m_pos);
         if(c == ' ' || c == '\t' || c == '\n' || c == '\r')
            m_pos++;
         else
            break;
        }
     }
   bool              ReadString(string &out)
     {
      out = "";
      if(Peek() != '"')
         return false;
      m_pos++;
      int start = m_pos;
      while(m_pos < m_len)
        {
         ushort c = StringGetCharacter(m_s, m_pos);
         if(c == '"')
           {
            out += StringSubstr(m_s, start, m_pos - start);
            m_pos++;
            return true;
           }
         if(c == '\\')
           {
            out += StringSubstr(m_s, start, m_pos - start);
            m_pos++;
            if(m_pos >= m_len)
               return false;
            ushort e = StringGetCharacter(m_s, m_pos);
            switch(e)
              {
               case 'n': out += "\n"; break;
               case 'r': out += "\r"; break;
               case 't': out += "\t"; break;
               case 'b': out += ShortToString(8); break;
               case 'f': out += ShortToString(12); break;
               case 'u':
                 {
                  if(m_pos + 4 >= m_len)
                     return false;
                  string hex = StringSubstr(m_s, m_pos + 1, 4);
                  out += ShortToString((ushort)StringToInteger("0x" + hex));
                  m_pos += 4;
                  break;
                 }
               default: out += ShortToString(e);
              }
            m_pos++;
            start = m_pos;
            continue;
           }
         m_pos++;
        }
      return false;
     }
   CJ               *ReadValue(void)
     {
      Skip();
      ushort c = Peek();
      CJ *v = new CJ();
      if(c == '{')
        {
         v.type = J_OBJ;
         m_pos++;
         Skip();
         if(Peek() == '}')
           {
            m_pos++;
            return v;
           }
         while(m_pos < m_len)
           {
            Skip();
            string key;
            if(!ReadString(key))
              {
               delete v;
               return NULL;
              }
            Skip();
            if(Peek() != ':')
              {
               delete v;
               return NULL;
              }
            m_pos++;
            CJ *child = ReadValue();
            if(child == NULL)
              {
               delete v;
               return NULL;
              }
            v.Add(key, child);
            Skip();
            if(Peek() == ',')
              {
               m_pos++;
               continue;
              }
            if(Peek() == '}')
              {
               m_pos++;
               return v;
              }
            delete v;
            return NULL;
           }
         delete v;
         return NULL;
        }
      if(c == '[')
        {
         v.type = J_ARR;
         m_pos++;
         Skip();
         if(Peek() == ']')
           {
            m_pos++;
            return v;
           }
         while(m_pos < m_len)
           {
            CJ *child = ReadValue();
            if(child == NULL)
              {
               delete v;
               return NULL;
              }
            v.Add("", child);
            Skip();
            if(Peek() == ',')
              {
               m_pos++;
               continue;
              }
            if(Peek() == ']')
              {
               m_pos++;
               return v;
              }
            delete v;
            return NULL;
           }
         delete v;
         return NULL;
        }
      if(c == '"')
        {
         v.type = J_STR;
         if(!ReadString(v.str))
           {
            delete v;
            return NULL;
           }
         return v;
        }
      if(StringSubstr(m_s, m_pos, 4) == "true")
        {
         v.type = J_BOOL;
         v.flag = true;
         m_pos += 4;
         return v;
        }
      if(StringSubstr(m_s, m_pos, 5) == "false")
        {
         v.type = J_BOOL;
         m_pos += 5;
         return v;
        }
      if(StringSubstr(m_s, m_pos, 4) == "null")
        {
         m_pos += 4;
         return v;
        }
      int start = m_pos;
      while(m_pos < m_len)
        {
         ushort d = StringGetCharacter(m_s, m_pos);
         if((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E')
            m_pos++;
         else
            break;
        }
      if(m_pos == start)
        {
         delete v;
         return NULL;
        }
      v.type = J_NUM;
      v.num = StringToDouble(StringSubstr(m_s, start, m_pos - start));
      return v;
     }

public:
   //--- The tree of `text`, NULL when it is not JSON. The caller deletes it.
   CJ               *Parse(const string text)
     {
      m_s = text;
      m_pos = 0;
      m_len = StringLen(text);
      return ReadValue();
     }
  };

//--- Reading helpers (a missing key or another type gives the default).
string JStr(CJ *o, const string key, const string def = "")
  {
   if(o == NULL)
      return def;
   CJ *v = o.Get(key);
   return (v != NULL && v.type == J_STR) ? v.str : def;
  }
double JNum(CJ *o, const string key, const double def = 0)
  {
   if(o == NULL)
      return def;
   CJ *v = o.Get(key);
   return (v != NULL && v.type == J_NUM) ? v.num : def;
  }
bool JHasNum(CJ *o, const string key)
  {
   if(o == NULL)
      return false;
   CJ *v = o.Get(key);
   return v != NULL && v.type == J_NUM;
  }

//--- Writing helpers.
string JQ(const string s)
  {
   string out = "\"";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"')
         out += "\\\"";
      else
         if(c == '\\')
            out += "\\\\";
         else
            if(c == '\n')
               out += "\\n";
            else
               if(c == '\r')
                  out += "\\r";
               else
                  if(c == '\t')
                     out += "\\t";
                  else
                     if(c < 32)
                        out += StringFormat("\\u%04x", c);
                     else
                        out += ShortToString(c);
     }
   return out + "\"";
  }

//--- A number, compact ("1.08115", "1000"); `digits` decimals at most.
string JN(const double v, const int digits = 8)
  {
   if(!MathIsValidNumber(v))
      return "null";
   string s = DoubleToString(v, digits);
   if(StringFind(s, ".") >= 0)
     {
      int n = StringLen(s);
      while(n > 0 && StringGetCharacter(s, n - 1) == '0')
         n--;
      if(n > 0 && StringGetCharacter(s, n - 1) == '.')
         n--;
      s = StringSubstr(s, 0, n);
     }
   if(s == "-0")
      s = "0";
   return s;
  }

//--- A price that may be unset (MT5 writes 0 for none): null then.
string JP(const double v, const int digits)
  {
   return v > 0 ? JN(v, digits) : "null";
  }
//+------------------------------------------------------------------+
