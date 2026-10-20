/*
 * Broker connection state for the trading panel and the order ticket.
 *
 * The backend (Rust `broker_*` commands) owns the connection to the user's
 * IB Gateway / TWS and pushes the whole state as `broker-state` events; every
 * window mirrors it here. The connection settings (host / port / client id,
 * no secret) are kept in kv, and a session the user left connected is opened
 * again when the app starts (main window only).
 */
import { createRoot, createSignal } from "solid-js";
import {
  commands,
  events,
  type BrokerConfig,
  type BrokerQuote,
  type BrokerState,
  type OrderTicket,
} from "../bindings";
import * as kv from "./kv";

async function unwrap<T>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

/** The web build has no broker connection (it would run on the server). */
export const BROKER_AVAILABLE = import.meta.env.MODE !== "web";

export const IBKR_ID = "ibkr";
const CONFIG_KEY = "ot:broker:ibkr:config";
const SESSION_KEY = "ot:broker:session";

/** IB Gateway's live API port; TWS uses 7496 (7497 paper), the Gateway 4001
 *  (4002 paper). */
export const DEFAULT_CONFIG: BrokerConfig = { host: "127.0.0.1", port: 4001, clientId: 1 };

function readConfig(): BrokerConfig {
  try {
    const v = JSON.parse(kv.getItem(CONFIG_KEY) ?? "null") as Partial<BrokerConfig> | null;
    if (!v) return DEFAULT_CONFIG;
    return {
      host: typeof v.host === "string" && v.host.trim() ? v.host : DEFAULT_CONFIG.host,
      port: Number.isInteger(v.port) && v.port! > 0 && v.port! < 65536 ? v.port! : DEFAULT_CONFIG.port,
      clientId: Number.isInteger(v.clientId) ? v.clientId! : DEFAULT_CONFIG.clientId,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const EMPTY: BrokerState = {
  version: 0,
  broker: null,
  connection: "disconnected",
  config: null,
  error: null,
  accounts: [],
  account: null,
  summary: null,
  positions: [],
  orders: [],
  executions: [],
  notices: [],
};

export const broker = createRoot(() => {
  const [state, setState] = createSignal<BrokerState>(EMPTY);
  const [quote, setQuote] = createSignal<BrokerQuote | null>(null);
  const [config, setConfigRaw] = createSignal<BrokerConfig>(readConfig());
  let started = false;

  const apply = (s: BrokerState) => {
    // Events can overtake a command's answer: keep the newest.
    if (s.version >= state().version || s.connection !== state().connection) setState(s);
  };

  return {
    state,
    quote,
    config,
    connected: () => state().connection === "connected",
    /** Listen to the backend and read its state; `restore` reconnects a
     *  session the user left connected. Idempotent. */
    async start(restore: boolean) {
      if (started || !BROKER_AVAILABLE) return;
      started = true;
      await events.brokerState.listen((e) => apply(e.payload));
      await events.brokerQuote.listen((e) => setQuote(e.payload));
      try {
        apply(await unwrap(commands.brokerState()));
      } catch {
        /* backend without broker */
      }
      if (restore && kv.getItem(SESSION_KEY) === IBKR_ID && state().connection === "disconnected") {
        void this.connect(config()).catch(() => {});
      }
    },
    async connect(cfg: BrokerConfig): Promise<void> {
      setConfigRaw(cfg);
      kv.setItem(CONFIG_KEY, JSON.stringify(cfg));
      apply(await unwrap(commands.brokerConnect(cfg)));
      // Reopened at the next start, until the user logs out.
      kv.setItem(SESSION_KEY, IBKR_ID);
    },
    async disconnect(): Promise<void> {
      kv.removeItem(SESSION_KEY);
      setQuote(null);
      await unwrap(commands.brokerDisconnect());
    },
    selectAccount: (account: string) => unwrap(commands.brokerSelectAccount(account)),
    placeOrder: (ticket: OrderTicket) => unwrap(commands.brokerPlaceOrder(ticket)),
    modifyOrder: (id: string, ticket: OrderTicket) => unwrap(commands.brokerModifyOrder(id, ticket)),
    cancelOrder: (id: string) => unwrap(commands.brokerCancelOrder(id)),
    closePosition: (id: string) => unwrap(commands.brokerClosePosition(id)),
    /** Quote `symbol` for the order ticket (null stops). */
    async watchQuote(symbol: string | null): Promise<void> {
      if (quote()?.symbol !== symbol) setQuote(null);
      if (!this.connected() && symbol) return;
      await unwrap(commands.brokerWatchQuote(symbol)).catch(() => {});
    },
  };
});
