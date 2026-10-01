/*
 * WatchlistDetail — the "Details" widget below the watchlist. Feature 6a
 * port of the mock's 319-LOC panel.
 *
 * Data sources (all per-ticker, light):
 *   • reference info → get_ticker_info  (Massive /v3/reference/tickers)
 *   • live snapshot  → get_ticker_snapshot (Massive /v2/snapshot)
 *   • 52w / perf / avg vol → computed client-side from daily candles
 *     (datafeed.getBars(sym, "1D"), the same series the chart uses)
 *
 * No static fallback — each field shows Massive's value or `—` while the
 * fetch is in flight / failed. A single createResource keyed on the bare
 * ticker handles staleness, so a late reply for a previously-selected row
 * can't overwrite the current one.
 */
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  exchangeName,
  getBars,
  getTickerInfo,
  getTickerSnapshot,
  type Snapshot,
  type TickerInfo,
} from "../../data/datafeed";
import { computeYearRange, type YearRange } from "./ticker-stats";
import * as kv from "../../data/kv";
import { marketSession as marketSessionOf, type MarketSession } from "../../data/market-session";

const DASH = "—";

/** Pre/post-market crescent-moon glyph, shown left of the
 *  "Pre-market"/"Post-market" label. */
const MOON_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="14" height="14">' +
  '<path fill="currentColor" d="M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5z"></path></svg>';

/** Pre-market sun glyph (core disc + 8 rays) — a sun for the morning
 *  pre-market session, vs the moon for after-hours. */
const SUN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="14" height="14">' +
  '<circle cx="9" cy="9" r="3" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="1.3" stroke-linecap="round">' +
  '<line x1="9" y1="1.5" x2="9" y2="3.5"/><line x1="9" y1="14.5" x2="9" y2="16.5"/>' +
  '<line x1="1.5" y1="9" x2="3.5" y2="9"/><line x1="14.5" y1="9" x2="16.5" y2="9"/>' +
  '<line x1="3.7" y1="3.7" x2="5.1" y2="5.1"/><line x1="12.9" y1="12.9" x2="14.3" y2="14.3"/>' +
  '<line x1="3.7" y1="14.3" x2="5.1" y2="12.9"/><line x1="12.9" y1="5.1" x2="14.3" y2="3.7"/>' +
  '</g></svg>';

/** Title-case a SCREAMING or lower-case label (Massive's sector/industry come
 *  through upper-cased, e.g. "ELECTRONIC TECHNOLOGY" → "Electronic Technology").
 *  Small connectives stay lower-case; "&" and tokens with digits pass through. */
function toTitleCase(s: string | null | undefined): string {
  if (!s) return DASH;
  const small = new Set(["and", "or", "the", "of", "for", "to", "in", "on", "a", "an"]);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (/\d/.test(w) || w === "&") return w;
      if (i > 0 && small.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n.toFixed(2);
}
function fmtSignedPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  if (n === 0) return "0.00";
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `−${abs}` : abs;
}
function fmtSignedPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  if (n === 0) return "0.00%";
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `−${abs}%` : `${abs}%`;
}
function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  let scaled: number;
  let suffix: string;
  if (abs >= 1e12) { scaled = abs / 1e12; suffix = "T"; }
  else if (abs >= 1e9) { scaled = abs / 1e9; suffix = "B"; }
  else if (abs >= 1e6) { scaled = abs / 1e6; suffix = "M"; }
  else if (abs >= 1e3) { scaled = abs / 1e3; suffix = "K"; }
  else return `${sign}${abs.toFixed(2)}`;
  return `${sign}${scaled.toFixed(2)} ${suffix}`;
}
function fmtDomain(url: string | null | undefined): string {
  if (!url) return DASH;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}
function shortFromSymbol(symbol: string | undefined): string {
  if (!symbol) return "";
  const head = symbol.split(",")[0].trim();
  const tail = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
  return tail.trim().toUpperCase();
}

type Props = {
  /** Active chart symbol — "NASDAQ:INTC" or bare "INTC". */
  activeSymbol?: string;
  /** Panel height in px (driven by the rail's drag-to-resize divider).
   *  Overrides the CSS default; the body scrolls internally. */
  height?: number;
  /** The details render as an accordion widget under the list — a 48px
   *  header (chevron + logo + symbol) that collapses the body away. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

type QuoteData = {
  info: TickerInfo | null;
  snap: Snapshot | null;
};

const PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const;

// ── Detail-panel preferences (Settings header button) ──
// Settings toggles which sections show.
// Persists to localStorage, alongside per-symbol notes (the "Add note" button).
const PREFS_KEY = "ot:watchlist:detail-prefs:v1";
const NOTES_KEY = "ot:watchlist:notes:v1";

type DetailPrefs = {
  sections: { keyStats: boolean; performance: boolean; profile: boolean };
};
const DEFAULT_PREFS: DetailPrefs = {
  sections: { keyStats: true, performance: true, profile: true },
};

function loadPrefs(): DetailPrefs {
  try {
    const raw = kv.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DetailPrefs>;
      return {
        sections: { ...DEFAULT_PREFS.sections, ...(p.sections ?? {}) },
      };
    }
  } catch {
    /* malformed — fall back to defaults */
  }
  return { sections: { ...DEFAULT_PREFS.sections } };
}
function loadNotes(): Record<string, string> {
  try {
    const raw = kv.getItem(NOTES_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* malformed — start empty */
  }
  return {};
}

export function WatchlistDetail(props: Props) {
  const short = () => shortFromSymbol(props.activeSymbol);

  // Header-button state: persisted prefs + per-symbol notes, and which header
  // popover (if any) is open.
  const [prefs, setPrefs] = createSignal<DetailPrefs>(loadPrefs());
  const [notes, setNotes] = createSignal<Record<string, string>>(loadNotes());
  const [openPanel, setOpenPanel] = createSignal<"note" | "settings" | null>(null);
  createEffect(() => {
    try {
      kv.setItem(PREFS_KEY, JSON.stringify(prefs()));
    } catch {
      /* best-effort */
    }
  });
  createEffect(() => {
    try {
      kv.setItem(NOTES_KEY, JSON.stringify(notes()));
    } catch {
      /* best-effort */
    }
  });
  // Live cross-window sync for prefs + per-symbol notes (raw signal setters; the
  // persist effects above then re-write identical strings, which kv dedups).
  onCleanup(kv.onExternalChange(PREFS_KEY, () => setPrefs(loadPrefs())));
  onCleanup(kv.onExternalChange(NOTES_KEY, () => setNotes(loadNotes())));

  const note = () => notes()[short()] ?? "";
  const setNote = (text: string) =>
    setNotes((prev) => {
      const next = { ...prev };
      if (text.trim()) next[short()] = text;
      else delete next[short()];
      return next;
    });
  const togglePanel = (p: "note" | "settings") => {
    const opening = openPanel() !== p;
    setOpenPanel(opening ? p : null);
    // Header popovers drop BELOW the 48px header; while collapsed the pane clips
    // them (overflow:hidden), so expand first. Collapse state lives in RightRail
    // — we only ever expand here (guarded on props.collapsed), never collapse.
    if (opening && props.collapsed) props.onToggleCollapse?.();
  };
  const toggleSection = (k: keyof DetailPrefs["sections"]) =>
    setPrefs((p) => ({ ...p, sections: { ...p.sections, [k]: !p.sections[k] } }));

  // Outside-click / Esc closes any open header popover.
  let actionsEl: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (openPanel() && actionsEl && !actionsEl.contains(e.target as Node)) setOpenPanel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenPanel(null); };
    // Watchlist's row context menu ("Add note for …") selects the row, then
    // asks this pane to open its note editor.
    const onOpenNote = () => {
      // The context-menu "Add note for X" can fire while the pane is collapsed —
      // expand it first so the note popover (and its auto-focused textarea)
      // isn't rendered into the clipped 48px header.
      if (props.collapsed) props.onToggleCollapse?.();
      setOpenPanel("note");
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wl-open-note", onOpenNote);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wl-open-note", onOpenNote);
    });
  });

  // Fast path: reference info + live snapshot, in parallel — these populate the
  // header, price, company, range and key-stats almost immediately. (An empty
  // `short` is falsy, so the resource simply doesn't fetch.)
  const [quote] = createResource<QuoteData, string>(short, async (sym) => {
    const [info, snap] = await Promise.allSettled([
      getTickerInfo(sym),
      getTickerSnapshot(sym),
    ]);
    return {
      info: info.status === "fulfilled" ? info.value : null,
      snap: snap.status === "fulfilled" ? snap.value : null,
    };
  });

  // Slow path: a separate resource for the 52w range / performance / avg volume
  // derived from daily candles (S3 flat files — cold-cache slow). Kept apart so
  // the rest of the panel never waits on it; these fields fill in when it lands.
  const [yr] = createResource<YearRange | null, string>(short, async (sym) => {
    try {
      const { bars } = await getBars(sym, "1D");
      return computeYearRange(bars);
    } catch {
      return null;
    }
  });

  const i = () => quote()?.info ?? null;
  const s = () => quote()?.snap ?? null;
  const y = () => yr() ?? null;

  const changeSign = () => {
    const snap = s();
    if (!snap) return "";
    return snap.change < 0 ? " down" : snap.change > 0 ? " up" : "";
  };

  // Extended-hours (pre/post-market) price, derived from the regular close +
  // the ext move %: `last` is the regular close, `extChangePercent` is the
  // latest extended trade vs that close. price = close·(1+ext%); change = the
  // absolute delta. Used for the secondary pre/post-market price line.
  const extPrice = () => {
    const snap = s();
    if (!snap || snap.last == null || snap.extChangePercent == null) return null;
    return snap.last * (1 + snap.extChangePercent / 100);
  };
  const extChange = () => {
    const snap = s();
    if (!snap || snap.last == null || snap.extChangePercent == null) return null;
    return snap.last * (snap.extChangePercent / 100);
  };
  const extSign = () => {
    const e = s()?.extChangePercent;
    return e == null ? "" : e < 0 ? " down" : e > 0 ? " up" : "";
  };

  // Live clock tick (60s) so the session label flips at session boundaries
  // without a symbol change — the detail panel updates the label in place.
  const [now, setNow] = createSignal(new Date());
  onMount(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    onCleanup(() => window.clearInterval(id));
  });

  // Current session of the symbol's own market, matching the detail-panel
  // states. Pre/Post render in accent-blue; Open/Closed in grey
  // ("Post-market" = rgb(41,98,255); "Market closed" = rgb(140,140,140)).
  const marketSession = (): MarketSession | null => marketSessionOf(props.activeSymbol ?? "", now());
  const SESSION_LABEL: Record<MarketSession, string> = {
    open: "Market open",
    pre: "Pre-market",
    post: "Post-market",
    closed: "Market closed",
  };
  const marketState = () => {
    const sx = marketSession();
    return s() && sx ? SESSION_LABEL[sx] : "";
  };
  /** Pre/Post are the "extended" sessions — rendered in accent blue. */
  const sessionActive = () => {
    const sx = marketSession();
    return sx === "pre" || sx === "post";
  };

  const lastUpdate = () => {
    const snap = s();
    if (!snap || snap.updatedNs <= 0) return "";
    // Local time + the GMT offset (e.g. "21:59 GMT+2"), as in
    // "Last update at HH:MM GMT±X".
    const parts = new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(snap.updatedNs / 1e6));
    const hh = parts.find((p) => p.type === "hour")?.value ?? "";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "";
    // "GMT+2" — strip the ":00" some platforms append.
    const tz = (parts.find((p) => p.type === "timeZoneName")?.value ?? "").replace(/:00$/, "");
    return `Last update at ${hh}:${mm} ${tz}`.trimEnd();
  };

  return (
    <aside
      class="watchlist-detail"
      classList={{ "is-collapsed": !!props.collapsed }}
      aria-label="Ticker details"
      data-test-id-widget-type="detail"
      style={props.collapsed ? undefined : props.height != null ? { height: `${props.height}px` } : undefined}
    >
      <header
        class="watchlist-detail-header"
        onClick={() => props.onToggleCollapse?.()}
      >
        <Show when={props.onToggleCollapse}>
          <button
            type="button"
            class="watchlist-detail-collapse"
            aria-label={props.collapsed ? "Expand details" : "Collapse details"}
            aria-expanded={!props.collapsed}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style={{ transform: props.collapsed ? "rotate(-90deg)" : undefined }}>
              <path fill="currentColor" d="M3 5.5 8 10.5 13 5.5z" />
            </svg>
          </button>
        </Show>
        <Show
          when={quote()?.info?.iconUrl}
          fallback={
            <span class="ot-ticker-logo ot-ticker-logo--md watchlist-detail-logo" aria-hidden="true">
              {short().charAt(0) || DASH}
            </span>
          }
        >
          {(url) => (
            <img class="watchlist-detail-logo-img" src={url()} alt="" width="24" height="24" loading="lazy" />
          )}
        </Show>
        <span class="watchlist-detail-title" data-qa-id="details-element-symbol">
          {short() || DASH}
        </span>
        <div class="watchlist-detail-actions" ref={actionsEl} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            class="watchlist-detail-action"
            classList={{ "is-active": openPanel() === "note" || note().trim() !== "" }}
            data-name="details-add-note-button"
            title={note().trim() ? "Edit note" : "Add note"}
            aria-label="Add note"
            aria-haspopup="dialog"
            aria-expanded={openPanel() === "note"}
            onClick={() => togglePanel("note")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M15 6H7.5C6.67 6 6 6.67 6 7.5v13c0 .83.67 1.5 1.5 1.5h13c.83 0 1.5-.67 1.5-1.5V16h1v4.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 5 20.5v-13A2.5 2.5 0 0 1 7.5 5H15v1Z" />
              <path fill="currentColor" d="M22.41 5.7a2 2 0 0 0-2.82 0L11 14.3V18h3.7l8.6-8.59a2 2 0 0 0 0-2.82l-.89-.88Zm-2.12.71a1 1 0 0 1 1.42 0l.88.88a1 1 0 0 1 0 1.42l-.59.58L19.7 7l.6-.59Zm1 3.59-7 7H12v-2.3l7-7 2.3 2.3Z" />
            </svg>
          </button>
          <button
            type="button"
            class="watchlist-detail-action"
            classList={{ "is-active": openPanel() === "settings" }}
            data-name="details-settings-button"
            title="Settings"
            aria-label="Settings"
            aria-haspopup="menu"
            aria-expanded={openPanel() === "settings"}
            onClick={() => togglePanel("settings")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M7.5 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 14.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0zm9.5-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 14.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0zm9.5-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM19 14.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0z" />
            </svg>
          </button>

          {/* Settings popover — choose which sections appear. */}
          <Show when={openPanel() === "settings"}>
            <div class="watchlist-detail-popover" role="menu">
              <div class="watchlist-detail-popover-title">Sections</div>
              <label class="watchlist-detail-check">
                <input type="checkbox" checked={prefs().sections.keyStats} onChange={() => toggleSection("keyStats")} />
                <span>Key stats</span>
              </label>
              <label class="watchlist-detail-check">
                <input type="checkbox" checked={prefs().sections.performance} onChange={() => toggleSection("performance")} />
                <span>Performance</span>
              </label>
              <label class="watchlist-detail-check">
                <input type="checkbox" checked={prefs().sections.profile} onChange={() => toggleSection("profile")} />
                <span>Profile</span>
              </label>
            </div>
          </Show>

          {/* Add-note popover — a per-symbol note, persisted locally. */}
          <Show when={openPanel() === "note"}>
            <div class="watchlist-detail-popover watchlist-detail-note-popover" role="dialog" aria-label="Note">
              <div class="watchlist-detail-popover-title">Note · {short() || DASH}</div>
              <textarea
                class="watchlist-detail-note-input"
                placeholder="Write a note for this symbol…"
                value={note()}
                onInput={(e) => setNote(e.currentTarget.value)}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
            </div>
          </Show>
        </div>
      </header>

      <Show when={!props.collapsed}>
      <div class="watchlist-detail-body">
        {/* Company name · exchange — inline, dot-separated, with the MIC mapped
            to its common name (XNAS → NASDAQ): name link · dot · exchange
            span. */}
        <div class="watchlist-detail-row">
          <span class="watchlist-detail-company">{i()?.name ?? DASH}</span>
          <Show when={i()?.exchange}>
            <span class="watchlist-detail-dot" aria-hidden="true">·</span>
            <span class="watchlist-detail-exchange">{exchangeName(i()?.exchange)}</span>
          </Show>
        </div>
        {/* Sector / industry — no screener to navigate to in this port, so they
            render as greyed-out, non-interactive labels rather than dead links. */}
        <div class="watchlist-detail-row watchlist-detail-tags">
          <span class="watchlist-detail-link watchlist-detail-link--disabled" aria-disabled="true" title="Sector screener not available">{toTitleCase(i()?.sector)}</span>
          <span class="watchlist-detail-link watchlist-detail-link--disabled" aria-disabled="true" title="Industry screener not available">{toTitleCase(i()?.industry)}</span>
        </div>

        {/* Price line — big 28px price, then currency, ±change and ±change% all
            inline and left-packed at the price's baseline. (No realtime "R"
            badge: our data is delayed.) */}
        <div class="watchlist-detail-price-row">
          <span class="watchlist-detail-price">{fmtPrice(s()?.last)}</span>
          <span class="watchlist-detail-currency">{i()?.currency ?? ""}</span>
          <span class={`watchlist-detail-change${changeSign()}`}>{fmtSignedPrice(s()?.change)}</span>
          <span class={`watchlist-detail-change${changeSign()}`}>{fmtSignedPercent(s()?.changePercent)}</span>
        </div>

        {/* Session state + last update on ONE row, in this order:
            "— Market closed  Last update at …". Closed gets a dash glyph;
            pre/post keep their sun/moon icons. */}
        <Show when={marketState() || lastUpdate()}>
          <div class="watchlist-detail-market-state">
            <span
              class="watchlist-detail-state"
              classList={{ "is-extended": sessionActive(), "is-pre": marketSession() === "pre" }}
            >
              <Show when={sessionActive()}>
                <span
                  class="watchlist-detail-state-icon"
                  aria-hidden="true"
                  innerHTML={marketSession() === "pre" ? SUN_ICON : MOON_ICON}
                />
              </Show>
              <Show when={marketState() === "Market closed"}>
                <span class="watchlist-detail-state-dash" aria-hidden="true">—</span>
              </Show>
              {marketState()}
            </span>
            <Show when={lastUpdate()}>
              <span class="watchlist-detail-regular-update">{lastUpdate()}</span>
            </Show>
          </div>
        </Show>

        {/* Secondary pre/post-market price line — only during an extended
            session: the extended price + currency + its move (no icon; the
            session icon lives on the state row above). */}
        <Show when={sessionActive() && extPrice() != null}>
          <div class="watchlist-detail-ext-row">
            <span class="watchlist-detail-ext-price">{fmtPrice(extPrice())}</span>
            <span class="watchlist-detail-currency">{i()?.currency ?? ""}</span>
            <span class={`watchlist-detail-change${extSign()}`}>{fmtSignedPrice(extChange())}</span>
            <span class={`watchlist-detail-change${extSign()}`}>{fmtSignedPercent(s()?.extChangePercent)}</span>
          </div>
        </Show>

        <Show when={note().trim()}>
          <div class="watchlist-detail-note" onClick={() => setOpenPanel("note")}>{note()}</div>
        </Show>

        <div class="watchlist-detail-range">
          <span class="watchlist-detail-range-low">{fmtPrice(s()?.dayLow)}</span>
          <span class="watchlist-detail-range-label">Day's Range</span>
          <span class="watchlist-detail-range-high">{fmtPrice(s()?.dayHigh)}</span>
        </div>
        <div class="watchlist-detail-range">
          <span class="watchlist-detail-range-low">{fmtPrice(y()?.low)}</span>
          <span class="watchlist-detail-range-label">52wk Range</span>
          <span class="watchlist-detail-range-high">{fmtPrice(y()?.high)}</span>
        </div>

        <Show when={prefs().sections.keyStats}>
          <div class="watchlist-detail-section-heading">Key stats</div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">Volume</span>
            <span class="watchlist-detail-stat-value">{fmtCompact(s()?.dayVolume)}</span>
          </div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">Average Volume (30D)</span>
            <span class="watchlist-detail-stat-value">{fmtCompact(y()?.avgVolume30d)}</span>
          </div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">Market capitalization</span>
            <span class="watchlist-detail-stat-value">{fmtCompact(i()?.marketCap)}</span>
          </div>
        </Show>

        <Show when={prefs().sections.performance}>
          <div class="watchlist-detail-section-heading">Performance</div>
          <div class="watchlist-detail-perf-grid">
            <For each={PERIODS}>
              {(period) => {
                const value = () => y()?.performance[period] ?? null;
                const cls = () => {
                  const v = value();
                  return v == null ? "" : v < 0 ? " down" : v > 0 ? " up" : "";
                };
                return (
                  <div class="watchlist-detail-perf-cell">
                    <span class={`watchlist-detail-perf-value${cls()}`}>
                      {value() == null ? DASH : fmtSignedPercent(value())}
                    </span>
                    <span class="watchlist-detail-perf-period">{period}</span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={prefs().sections.profile}>
          <div class="watchlist-detail-section-heading">Profile</div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">Website</span>
            <Show
              when={i()?.homepageUrl}
              fallback={<span class="watchlist-detail-stat-value">{DASH}</span>}
            >
              <a
                class="watchlist-detail-stat-value watchlist-detail-link-strong"
                href={i()!.homepageUrl!}
                target="_blank"
                rel="noreferrer"
              >
                {fmtDomain(i()!.homepageUrl)}
              </a>
            </Show>
          </div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">Employees (FY)</span>
            <span class="watchlist-detail-stat-value">{fmtCompact(i()?.totalEmployees)}</span>
          </div>
          <div class="watchlist-detail-stat-row">
            <span class="watchlist-detail-stat-label">FIGI</span>
            <span class="watchlist-detail-stat-value watchlist-detail-mono">
              {i()?.figi ?? DASH}
              <Show when={i()?.figi}>
                <button
                  type="button"
                  class="watchlist-detail-copy"
                  title="Copy FIGI"
                  aria-label="Copy FIGI"
                  onClick={() => void navigator.clipboard?.writeText(i()!.figi!).catch(() => {})}
                >
                  <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M6 3.5C6 2.67 6.67 2 7.5 2H13c.83 0 1.5.67 1.5 1.5V11c0 .83-.67 1.5-1.5 1.5h-1V14c0 .83-.67 1.5-1.5 1.5H5c-.83 0-1.5-.67-1.5-1.5V6.5C3.5 5.67 4.17 5 5 5h1V3.5ZM7 5h3.5c.83 0 1.5.67 1.5 1.5v5h1a.5.5 0 0 0 .5-.5V3.5a.5.5 0 0 0-.5-.5H7.5a.5.5 0 0 0-.5.5V5Zm-2 1.5V14a.5.5 0 0 0 .5.5h5.5a.5.5 0 0 0 .5-.5V6.5a.5.5 0 0 0-.5-.5H5.5a.5.5 0 0 0-.5.5Z" />
                  </svg>
                </button>
              </Show>
            </span>
          </div>
          <Show when={i()?.description}>
            <p class="watchlist-detail-description">{i()!.description}</p>
          </Show>
        </Show>
      </div>
      </Show>
    </aside>
  );
}
