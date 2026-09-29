/*
 * Working state + helpers for the chart Settings dialog.  The dialog edits a
 * *draft* (a deep clone of a pane's committed settings); Cancel discards it,
 * Ok commits it back onto the focused pane and "Apply to all" onto every pane
 * in the layout (see App's per-pane `PaneChart.settings`).  `appearanceFrom`
 * folds a committed draft into the values the live chart honours; ChartView
 * reads its own pane's appearance via that, prop-driven.
 *
 * Draft keys are `${tab}:${rowId}` (row id = FormRow.id ?? label), so adding
 * or moving a row keeps every other saved value. Drafts written before
 * 25/09/2026 were keyed by row INDEX under fingerprint "pil70i"; they are
 * converted by {@link LEGACY_PIL70I} instead of being discarded.
 */
import {
  STYLE_FORMS,
  TAB_FORMS,
  rowIdOf,
  styleTab,
  type Control,
  type FormItem,
  type StyleGroup,
} from '../../data/chart-properties';
import * as kv from '../../data/kv';

/** Editable value for one control, by kind. */
export type CtrlValue =
  | { kind: 'select'; value: string }
  | { kind: 'color'; color: string; width?: number; style?: number }
  | { kind: 'colorPair'; up: string; down: string }
  | { kind: 'lineColor'; type: 'Solid' | 'Gradient'; color: string; start: string; end: string; width: number; style: number }
  | { kind: 'input'; value: string }
  | { kind: 'slider'; value: number }
  // Check-list dropdown (price-label rows): the set of checked options.
  | { kind: 'multicheck'; on: string[] };

/** The three navigation-button behaviours, in the same order as the
 *  dialog's select. */
export type NavButtonsBehavior = 'visibleOnMouseOver' | 'alwaysOn' | 'alwaysOff';

export type RowState = { checked: boolean | null; controls: CtrlValue[] };
/** Keyed by `${tabId}:${rowId}` (only row items, not section headers). */
export type Draft = Record<string, RowState>;

function ctrlDefault(c: Control): CtrlValue {
  switch (c.c) {
    case 'select': return { kind: 'select', value: c.value };
    case 'color': {
      const v: CtrlValue = { kind: 'color', color: c.color };
      if (c.width !== undefined) v.width = c.width;
      if (c.style !== undefined) v.style = c.style;
      return v;
    }
    case 'colorPair': return { kind: 'colorPair', up: c.up, down: c.down };
    case 'lineColor': return { kind: 'lineColor', type: c.type, color: c.color, start: c.start, end: c.end, width: c.width, style: c.style };
    case 'input': return { kind: 'input', value: c.value };
    case 'slider': return { kind: 'slider', value: c.value };
    case 'multicheck': return { kind: 'multicheck', on: [...c.on] };
  }
}

/** Draft key of a row by id. */
export const keyOf = (tab: string, id: string) => `${tab}:${id}`;
/** Draft key of the form item at index `i` of `tab` (dialog iteration). */
export function rowKey(tab: string, i: number): string {
  const it = TAB_FORMS[tab]?.[i];
  return keyOf(tab, it && it.kind === 'row' ? rowIdOf(it) : `#${i}`);
}

/** Build a fresh draft from the factory defaults. */
export function makeDefaultDraft(): Draft {
  const d: Draft = {};
  for (const [tab, items] of Object.entries(TAB_FORMS)) {
    items.forEach((it: FormItem) => {
      if (it.kind !== 'row') return;
      d[keyOf(tab, rowIdOf(it))] = {
        checked: it.cb ? !!it.checked : null,
        controls: (it.controls ?? []).map(ctrlDefault),
      };
    });
  }
  return d;
}

// ── Persistence ──────────────────────────────────────────────────────────────
/** Format stamp of drafts keyed by row id. Stored as `settingsFp` (field name
 *  kept for the layout / template records). */
export const SETTINGS_FINGERPRINT = 'ids-1';
/** Pre-25/09/2026 format: TAB_FORMS row INDEX keys, fingerprint of that form. */
const LEGACY_FP = 'pil70i';

/** Coerce one stored control back to a valid CtrlValue, falling back to the
 *  current default if the kind or field types don't match. */
function reviveCtrl(raw: unknown, def: CtrlValue): CtrlValue {
  if (!raw || typeof raw !== 'object') return def;
  const s = raw as Record<string, unknown>;
  if (s.kind !== def.kind) return def;
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const numv = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  switch (def.kind) {
    case 'select': return { kind: 'select', value: str(s.value, def.value) };
    case 'color': {
      const v: CtrlValue = { kind: 'color', color: str(s.color, def.color) };
      if (def.width !== undefined) v.width = numv(s.width, def.width);
      if (def.style !== undefined) v.style = numv(s.style, def.style);
      return v;
    }
    case 'colorPair': return { kind: 'colorPair', up: str(s.up, def.up), down: str(s.down, def.down) };
    case 'lineColor':
      return {
        kind: 'lineColor',
        type: s.type === 'Solid' || s.type === 'Gradient' ? s.type : def.type,
        color: str(s.color, def.color), start: str(s.start, def.start), end: str(s.end, def.end),
        width: numv(s.width, def.width), style: numv(s.style, def.style),
      };
    case 'input': return { kind: 'input', value: str(s.value, def.value) };
    case 'slider': return { kind: 'slider', value: numv(s.value, def.value) };
    case 'multicheck':
      return Array.isArray(s.on) && (s.on as unknown[]).every((x) => typeof x === 'string')
        ? { kind: 'multicheck', on: [...(s.on as string[])] } : def;
  }
}

/** Revision of the draft VALUES. Rev 3 (25/09/2026) = first id-keyed format;
 *  older revisions only exist in legacy (index-keyed) drafts. Rev 4
 *  (26/09/2026): Events → Latest news default is ON (factory value);
 *  earlier drafts stored OFF only because the row was inert. */
export const SETTINGS_REV = 4;

function migrateValues(rows: Record<string, StoredRow>, rev: number): Record<string, StoredRow> {
  if (rev >= 4) return rows;
  const out = { ...rows };
  const news = out['events:Latest news'];
  out['events:Latest news'] = { ...(news ?? {}), checked: true };
  return out;
}

type StoredRow = { checked?: unknown; controls?: unknown };

/** Merge stored rows (id-keyed) over fresh defaults, shape-validated. */
function mergeRows(stored: Record<string, StoredRow>): Draft {
  const def = makeDefaultDraft();
  for (const key of Object.keys(def)) {
    const s = stored[key];
    if (!s || typeof s !== 'object') continue;
    const row = def[key];
    if (row.checked !== null && typeof s.checked === 'boolean') row.checked = s.checked;
    if (Array.isArray(s.controls)) {
      const sc = s.controls as unknown[];
      row.controls = row.controls.map((dc, i) => reviveCtrl(sc[i], dc));
    }
  }
  return def;
}

/* ── Legacy "pil70i" drafts ───────────────────────────────────────────────
 * Row labels by index of the form that wrote them (frozen from the build of
 * 4af95b9; '#' = section header, null = label-less continuation row). */
const LEGACY_LAYOUT: Record<string, (string | null)[]> = {
  symbol: ['#', 'Color bars based on previous close', 'Body', 'Borders', 'Wick', '#', 'Adjust data for dividends', 'Precision', 'Timezone'],
  legend: ['#', 'Logo', 'Title', 'Chart values', 'Bar change values', 'Volume', 'Last day change values', '#', 'Titles', 'Inputs', 'Values', 'Background'],
  scales: ['#', 'Currency and Unit', 'Scale modes (A and L)', 'Lock price to bar ratio', 'Scales placement', '#', 'No overlapping labels', 'Plus button', 'Countdown to bar close', 'Symbol', null, 'Previous day close', 'Indicators and financials', 'Pre/post/night market', 'High and low', 'Bid and ask', '#', 'Day of week on labels', 'Date format', 'Time hours format', 'Save chart left edge position when changing interval'],
  canvas: ['#', 'Background', 'Vertical grid lines', 'Horizontal grid lines', 'Crosshair', 'Watermark', 'Symbol ticker', 'Interval', 'Symbol description', '#', 'Text', 'Lines', '#', 'Navigation', 'Pane', '#', 'Top', 'Bottom', 'Right'],
  trading: ['#', 'Buy/sell buttons', 'One-click trading', 'Execution sound', null, 'Show only rejection notifications', '#', 'Positions and orders', 'Reverse position button', 'Project order for market orders', 'Profit and loss value', 'Positions', 'Brackets', 'Execution marks', 'Execution labels', 'Extended price lines across the entire chart width', 'Order and position alignment', 'Orders, executions, and positions in chart snapshots'],
  alerts: ['#', 'Alert lines', 'Only active alerts', '#', 'Automatically hide toasts'],
  events: ['#', 'Ideas', 'Dividends', 'Splits', 'Session breaks', 'Latest news', 'News notification'],
};

type Raw = Record<string, unknown> | undefined;
const asObj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

/** Convert a legacy index-keyed draft into id-keyed stored rows. Rows whose
 *  control list changed shape are translated field by field. */
function convertLegacy(raw: Record<string, StoredRow>, rev: number): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {};
  const get = (tab: string, label: string | null, nth = 0): StoredRow | undefined => {
    const idx = LEGACY_LAYOUT[tab]?.findIndex((l, i) => l === label && LEGACY_LAYOUT[tab].slice(0, i).filter((x) => x === label).length === nth);
    return idx !== undefined && idx >= 0 ? raw[`${tab}:${idx}`] : undefined;
  };
  const ctrls = (r: StoredRow | undefined): unknown[] => (r && Array.isArray(r.controls) ? r.controls : []);
  const lineStyleOf = (c: unknown): number | undefined => {
    const o = asObj(c);
    return o && o.kind === 'line' && typeof o.style === 'number' ? o.style : undefined;
  };
  const colorOf = (c: unknown): string | undefined => {
    const o = asObj(c);
    return o && o.kind === 'color' && typeof o.color === 'string' ? o.color : undefined;
  };
  // 1. Rows whose id and control kinds are unchanged: copy verbatim.
  for (const [tab, labels] of Object.entries(LEGACY_LAYOUT)) {
    labels.forEach((label, i) => {
      if (label === '#' || label === null) return;
      const r = raw[`${tab}:${i}`];
      if (r) out[`${tab}:${label}`] = r;
    });
  }
  // 2. Symbol tab: candle rows moved to the Candles style form.
  for (const l of ['Color bars based on previous close', 'Body', 'Borders', 'Wick']) {
    const r = get('symbol', l);
    if (r) out[`${styleTab('candle')}:${l}`] = r;
    delete out[`symbol:${l}`];
  }
  // 3. Status line: Title wording, background slider = transparency now.
  const title = get('legend', 'Title');
  if (title) {
    const c = asObj(ctrls(title)[0]);
    const v = c && typeof c.value === 'string' ? c.value : undefined;
    const map: Record<string, string> = { Ticker: 'Symbol', 'Ticker and name': 'Symbol and name' };
    out['legend:Title'] = { checked: title.checked, controls: [{ kind: 'select', value: (v && map[v]) || v || 'Name' }] };
  }
  const bg = get('legend', 'Background');
  if (bg) {
    const c = asObj(ctrls(bg)[0]);
    const op = c && typeof c.value === 'number' ? c.value : 50;
    out['legend:Background'] = { checked: bg.checked, controls: [{ kind: 'slider', value: 100 - op }] };
  }
  // 4. Scales: Symbol / High and low / Previous day close now carry one
  //    colour + width instead of colour(s) + line style; the value-mode
  //    select got an id; the lock-ratio field is live (not stored).
  const sym = get('scales', 'Symbol');
  if (sym) out['scales:Symbol'] = { checked: null, controls: [ctrls(sym)[0]] };
  const mode = get('scales', null);
  if (mode) out['scales:Symbol value mode'] = mode;
  const hl = get('scales', 'High and low');
  if (hl) out['scales:High and low'] = { checked: null, controls: [ctrls(hl)[0]] };
  const pc = get('scales', 'Previous day close');
  if (pc) out['scales:Previous day close'] = { checked: null, controls: [ctrls(pc)[0], { kind: 'color', color: colorOf(ctrls(pc)[1]) ?? '#555555', width: 1 }] };
  const lock = get('scales', 'Lock price to bar ratio');
  if (lock) out['scales:Lock price to bar ratio'] = { checked: lock.checked };
  // 5. Canvas: grid / crosshair merge the old line-style picker into the colour.
  for (const l of ['Vertical grid lines', 'Horizontal grid lines', 'Crosshair']) {
    const r = get('canvas', l);
    if (!r) continue;
    const c = colorOf(ctrls(r)[0]);
    const st = lineStyleOf(ctrls(r)[1]);
    const v: Record<string, unknown> = { kind: 'color' };
    if (c) v.color = c;
    if (st !== undefined) v.style = st;
    if (l === 'Crosshair') v.width = 1;
    out[`canvas:${l}`] = { checked: r.checked, controls: [v] };
  }
  //    Watermark: three indented checkboxes → one check list.
  const wm = get('canvas', 'Watermark');
  const on: string[] = [];
  if (get('canvas', 'Symbol ticker')?.checked === true) on.push('Ticker');
  if (get('canvas', 'Interval')?.checked === true) on.push('Interval');
  if (get('canvas', 'Symbol description')?.checked === true) on.push('Description');
  out['canvas:Watermark'] = { checked: null, controls: [{ kind: 'multicheck', on }, ctrls(wm)[0]] };
  for (const l of ['Symbol ticker', 'Interval', 'Symbol description']) delete out[`canvas:${l}`];
  // 6. Alerts: one line colour (the old pair's "active" colour).
  const al = get('alerts', 'Alert lines');
  if (al) {
    const p = asObj(ctrls(al)[0]);
    out['alerts:Alert lines'] = { checked: al.checked, controls: [{ kind: 'color', color: p && typeof p.up === 'string' ? p.up : undefined }] };
  }
  // 7. Events: session-break style merges into the colour control.
  const sb = get('events', 'Session breaks');
  if (sb) {
    const c = colorOf(ctrls(sb)[0]);
    const st = lineStyleOf(ctrls(sb)[1]);
    const v: Record<string, unknown> = { kind: 'color', width: 1 };
    if (c) v.color = c;
    if (st !== undefined) v.style = st;
    out['events:Session breaks'] = { checked: sb.checked, controls: [v] };
  }
  // Value migration of the legacy revisions (rev 2, 23/09/2026): the
  // Pre/post/night check list's old default ['Line'] becomes ['Value', 'Line'].
  if (rev < 2) {
    const pp = asObj(ctrls(out['scales:Pre/post/night market'])[0]);
    if (pp && Array.isArray(pp.on) && pp.on.length === 1 && pp.on[0] === 'Line') pp.on = ['Value', 'Line'];
  }
  return out;
}

/** Restore a persisted draft. Always returns a draft conforming to the
 *  current forms (stored values merged over fresh defaults, shape-validated),
 *  or undefined when the stamp is unknown / the blob is unusable. */
export function reviveDraft(raw: unknown, fp: unknown, rev?: unknown): Draft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const stored = raw as Record<string, StoredRow>;
  if (fp === SETTINGS_FINGERPRINT) return mergeRows(migrateValues(stored, typeof rev === 'number' ? rev : 3));
  if (fp === LEGACY_FP) return mergeRows(migrateValues(convertLegacy(stored, typeof rev === 'number' ? rev : 1), 1));
  return undefined;
}

export function cloneDraft(d: Draft): Draft {
  const out: Draft = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = {
      checked: v.checked,
      controls: v.controls.map((c) => (c.kind === 'multicheck' ? { ...c, on: [...c.on] } : { ...c })),
    };
  }
  return out;
}

// ── Row readers ──────────────────────────────────────────────────────────────
type Reader = {
  checked: (id: string) => boolean;
  sel: (id: string, i?: number) => string | undefined;
  color: (id: string, i?: number) => string | undefined;
  colorCtl: (id: string, i?: number) => { color: string; width?: number; style?: number } | undefined;
  pair: (id: string, i?: number) => { up: string; down: string } | undefined;
  line: (id: string, i?: number) => Extract<CtrlValue, { kind: 'lineColor' }> | undefined;
  num: (id: string, i?: number) => number | undefined;
  slider: (id: string, i?: number) => number | undefined;
  member: (id: string, opt: string, i?: number) => boolean | undefined;
};
function reader(d: Draft, tab: string): Reader {
  const at = (id: string, i = 0) => d[keyOf(tab, id)]?.controls?.[i];
  return {
    checked: (id) => !!d[keyOf(tab, id)]?.checked,
    sel: (id, i) => { const c = at(id, i); return c?.kind === 'select' ? c.value : undefined; },
    color: (id, i) => { const c = at(id, i); return c?.kind === 'color' ? c.color : undefined; },
    colorCtl: (id, i) => { const c = at(id, i); return c?.kind === 'color' ? c : undefined; },
    pair: (id, i) => { const c = at(id, i); return c?.kind === 'colorPair' ? c : undefined; },
    line: (id, i) => { const c = at(id, i); return c?.kind === 'lineColor' ? c : undefined; },
    num: (id, i) => {
      const c = at(id, i);
      if (c?.kind !== 'input') return undefined;
      const n = parseFloat(c.value);
      return Number.isFinite(n) ? n : undefined;
    },
    slider: (id, i) => { const c = at(id, i); return c?.kind === 'slider' ? c.value : undefined; },
    member: (id, opt, i) => { const c = at(id, i); return c?.kind === 'multicheck' ? c.on.includes(opt) : undefined; },
  };
}

/**
 * Canvas → Margins → Right, read out of the default form.
 *
 * A pane with no committed draft gets `appearanceFrom(undefined) === {}`, so
 * `readChartTokens` has to supply its own default. The right margin has no
 * theme token, so its fallback has to agree with this row or a chart silently
 * has no right margin until the dialog is OK'd once.
 */
export const DEFAULT_RIGHT_OFFSET: number = (() => {
  const n = reader(makeDefaultDraft(), 'canvas').num('Right');
  return n !== undefined ? n : 10;
})();

/** Canvas → Navigation / Pane select label → behaviour id. */
const NAV_BEHAVIOR: Record<string, NavButtonsBehavior | undefined> = {
  'Visible on mouse over': 'visibleOnMouseOver',
  'Always visible': 'alwaysOn',
  'Always invisible': 'alwaysOff',
};

/* ── Per-chart-type series styles ─────────────────────────────────────────── */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';
const SOURCE_IDS: Record<string, PriceSource> = {
  Open: 'open', High: 'high', Low: 'low', Close: 'close',
  '(H + L)/2': 'hl2', '(H + L + C)/3': 'hlc3', '(O + H + L + C)/4': 'ohlc4',
};
export type BoxMethod = 'ATR' | 'Traditional' | 'Percentage LTP';
export type LineSpec = { color: string; width: number; style: number };
export type CandleStyleS = {
  prevClose: boolean;
  body: boolean; bodyUp: string; bodyDown: string;
  border: boolean; borderUp: string; borderDown: string;
  wick: boolean; wickUp: string; wickDown: string;
};
export type FillBorder = { fill: string; border: string };
export type SeriesStyles = {
  bar: { prevClose: boolean; hlc: boolean; up: string; down: string; thin: boolean };
  candle: CandleStyleS;
  volCandles: CandleStyleS;
  hollowCandle: CandleStyleS;
  ha: CandleStyleS & { realPrices: boolean };
  line: LineFamily;
  lineWithMarkers: LineFamily;
  stepline: LineFamily;
  area: { source: PriceSource; line: LineSpec; top: string; bottom: string };
  hlcArea: { high: LineSpec & { on: boolean }; low: LineSpec & { on: boolean }; close: LineSpec; fillTop: string; fillBottom: string };
  baseline: { source: PriceSource; top: LineSpec; bottom: LineSpec; topFill1: string; topFill2: string; bottomFill1: string; bottomFill2: string; level: number };
  column: { source: PriceSource; prevClose: boolean; up: string; down: string };
  hilo: { body: boolean; bodyColor: string; border: boolean; borderColor: string; labels: boolean; labelColor: string };
  renko: BarSet & { wick: boolean; wickUp: string; wickDown: string; source: 'Close' | 'OHLC'; box: BoxInputs };
  pb: BarSet & { lines: number };
  kagi: BarSetColors & { box: BoxInputs };
  pnf: BarSetColors & { source: 'HL' | 'Close'; box: BoxInputs; reversal: number; oneStepBack: boolean };
  range: {
    style: 'Bars' | 'Candles';
    up: string; down: string; projUp: string; projDown: string; thin: boolean;
    body: { up: string; down: string }; border: { up: string; down: string }; wick: { up: string; down: string };
    projCandles: { up: string; down: string };
    phantom: boolean;
  };
  /** Footprint candles follow the Candles rows (no page of their own). */
  volFootprint: CandleStyleS;
  svp: SvpStyle;
};
export type SvpLine = LineSpec & { on: boolean; extend: boolean };
export type SvpStyle = {
  showValues: boolean; valuesColor: string; width: number; placement: 'Left' | 'Right';
  upVolume: string; downVolume: string; vaUp: string; vaDown: string; histBox: string;
  vah: SvpLine; val: SvpLine; poc: SvpLine; devPoc: SvpLine; devVa: SvpLine;
  sessions: string; customSession: string; volume: 'Up/Down' | 'Total' | 'Delta';
  vaPercent: number; rowsLayout: 'Number Of Rows' | 'Ticks Per Row'; rows: number;
};
export type LineFamily = { source: PriceSource; type: 'Solid' | 'Gradient'; color: string; start: string; end: string; width: number; style: number };
export type BarSet = { up: FillBorder; down: FillBorder; projUp: FillBorder; projDown: FillBorder };
export type BarSetColors = { up: string; down: string; projUp: string; projDown: string };
/** Box size inputs (Renko box, Kagi reversal, P&F box). `size` is the
 *  Traditional value (Renko/P&F "Box size", Kagi "Reversal amount"). */
export type BoxInputs = { method: BoxMethod; size: number; atrLength: number; percentage: number };

function seriesStylesFrom(d: Draft): SeriesStyles {
  const R = (g: StyleGroup) => reader(d, styleTab(g));
  const def = (g: StyleGroup) => reader(DEFAULTS, styleTab(g));
  // Read with a per-field fallback to the factory default (always defined).
  const pick = <T>(g: StyleGroup, f: (r: Reader) => T | undefined): T => (f(R(g)) ?? f(def(g))) as T;
  const src = (g: StyleGroup, id = 'Price source'): PriceSource => SOURCE_IDS[pick(g, (r) => r.sel(id)) ?? 'Close'] ?? 'close';
  const spec = (g: StyleGroup, id: string): LineSpec => {
    const c = pick(g, (r) => r.colorCtl(id));
    return { color: c.color, width: c.width ?? 1, style: c.style ?? 0 };
  };
  const candle = (g: StyleGroup): CandleStyleS => {
    const r = R(g);
    const body = pick(g, (x) => x.pair('Body'));
    const border = pick(g, (x) => x.pair('Borders'));
    const wick = pick(g, (x) => x.pair('Wick'));
    return {
      prevClose: STYLE_FORMS[g].some((it) => it.kind === 'row' && rowIdOf(it) === 'Color bars based on previous close') && r.checked('Color bars based on previous close'),
      body: r.checked('Body'), bodyUp: body.up, bodyDown: body.down,
      border: r.checked('Borders'), borderUp: border.up, borderDown: border.down,
      wick: r.checked('Wick'), wickUp: wick.up, wickDown: wick.down,
    };
  };
  const lineFam = (g: StyleGroup): LineFamily => {
    const l = pick(g, (r) => r.line('Line'));
    return { source: src(g), type: l.type, color: l.color, start: l.start, end: l.end, width: l.width, style: l.style };
  };
  const fb = (g: StyleGroup, id: string): FillBorder => { const p = pick(g, (r) => r.pair(id)); return { fill: p.up, border: p.down }; };
  const barSet = (g: StyleGroup): BarSet => ({ up: fb(g, 'Up bars'), down: fb(g, 'Down bars'), projUp: fb(g, 'Projection up bars'), projDown: fb(g, 'Projection down bars') });
  const colors = (g: StyleGroup): BarSetColors => ({
    up: pick(g, (r) => r.color('Up bars')), down: pick(g, (r) => r.color('Down bars')),
    projUp: pick(g, (r) => r.color('Projection up bars')), projDown: pick(g, (r) => r.color('Projection down bars')),
  });
  const box = (g: StyleGroup, sizeId: string): BoxInputs => ({
    method: (pick(g, (r) => r.sel('Style')) as BoxMethod) ?? 'ATR',
    size: pick(g, (r) => r.num(sizeId)),
    atrLength: pick(g, (r) => r.num('ATR length')),
    percentage: pick(g, (r) => r.num('Percentage')),
  });
  const pair = (g: StyleGroup, id: string) => pick(g, (r) => r.pair(id));
  const svpLine = (id: string, extendId?: string): SvpLine => ({
    ...spec('svp', id), on: R('svp').checked(id), extend: extendId ? R('svp').checked(extendId) : false,
  });
  const svpStyle = (): SvpStyle => ({
    showValues: R('svp').checked('Values'), valuesColor: pick('svp', (r) => r.color('Values')),
    width: pick('svp', (r) => r.num('Width')), placement: pick('svp', (r) => r.sel('Placement')) === 'Right' ? 'Right' : 'Left',
    upVolume: pick('svp', (r) => r.color('Up volume')), downVolume: pick('svp', (r) => r.color('Down volume')),
    vaUp: pick('svp', (r) => r.color('Value area up')), vaDown: pick('svp', (r) => r.color('Value area down')),
    histBox: pick('svp', (r) => r.color('Histogram box')),
    vah: svpLine('VAH', 'Extend VAH right'), val: svpLine('VAL', 'Extend VAL right'), poc: svpLine('POC', 'Extend POC right'),
    devPoc: svpLine('Developing POC'), devVa: svpLine('Developing VA'),
    sessions: pick('svp', (r) => r.sel('Sessions')), customSession: (() => { const c = d[keyOf(styleTab('svp'), 'Custom session')]?.controls?.[0]; return c?.kind === 'input' ? c.value : '0930-1600'; })(),
    volume: (pick('svp', (r) => r.sel('Volume')) as SvpStyle['volume']) ?? 'Up/Down',
    vaPercent: pick('svp', (r) => r.num('Value area volume')),
    rowsLayout: pick('svp', (r) => r.sel('Rows layout')) === 'Ticks Per Row' ? 'Ticks Per Row' : 'Number Of Rows',
    rows: pick('svp', (r) => r.num('Row size')),
  });
  const hlc = R('hlcArea');
  const hilo = R('hilo');
  return {
    bar: {
      prevClose: R('bar').checked('Color bars based on previous close'), hlc: R('bar').checked('HLC bars'),
      up: pick('bar', (r) => r.color('Up color')), down: pick('bar', (r) => r.color('Down color')), thin: R('bar').checked('Thin bars'),
    },
    candle: candle('candle'),
    volCandles: candle('volCandles'),
    hollowCandle: candle('hollowCandle'),
    ha: { ...candle('ha'), realPrices: R('ha').checked('Real prices on price scale (instead of Heikin-Ashi price)') },
    line: lineFam('line'),
    lineWithMarkers: lineFam('lineWithMarkers'),
    stepline: lineFam('stepline'),
    area: { source: src('area'), line: spec('area', 'Line'), top: pair('area', 'Fill').up, bottom: pair('area', 'Fill').down },
    hlcArea: {
      high: { ...spec('hlcArea', 'High line'), on: hlc.checked('High line') },
      low: { ...spec('hlcArea', 'Low line'), on: hlc.checked('Low line') },
      close: spec('hlcArea', 'Close line'),
      fillTop: pair('hlcArea', 'Fill').up, fillBottom: pair('hlcArea', 'Fill').down,
    },
    baseline: {
      source: src('baseline'), top: spec('baseline', 'Top line'), bottom: spec('baseline', 'Bottom line'),
      topFill1: pair('baseline', 'Fill top area').up, topFill2: pair('baseline', 'Fill top area').down,
      bottomFill1: pair('baseline', 'Fill bottom area').up, bottomFill2: pair('baseline', 'Fill bottom area').down,
      level: pick('baseline', (r) => r.num('Base level')),
    },
    column: {
      source: src('column'), prevClose: R('column').checked('Color bars based on previous close'),
      up: pick('column', (r) => r.color('Up color')), down: pick('column', (r) => r.color('Down color')),
    },
    hilo: {
      body: hilo.checked('Body'), bodyColor: pick('hilo', (r) => r.color('Body')),
      border: hilo.checked('Borders'), borderColor: pick('hilo', (r) => r.color('Borders')),
      labels: hilo.checked('Labels'), labelColor: pick('hilo', (r) => r.color('Labels')),
    },
    renko: {
      ...barSet('renko'),
      wick: R('renko').checked('Wick'), wickUp: pair('renko', 'Wick').up, wickDown: pair('renko', 'Wick').down,
      source: (pick('renko', (r) => r.sel('Source')) === 'OHLC' ? 'OHLC' : 'Close'),
      box: box('renko', 'Box size'),
    },
    pb: { ...barSet('pb'), lines: pick('pb', (r) => r.num('Number of line')) },
    kagi: { ...colors('kagi'), box: box('kagi', 'Reversal amount') },
    pnf: {
      ...colors('pnf'), source: pick('pnf', (r) => r.sel('Source')) === 'HL' ? 'HL' : 'Close',
      box: box('pnf', 'Box size'), reversal: pick('pnf', (r) => r.num('Reversal')), oneStepBack: R('pnf').checked('One step back building'),
    },
    range: {
      style: pick('range', (r) => r.sel('Style')) === 'Candles' ? 'Candles' : 'Bars',
      up: pick('range', (r) => r.color('Up bars')), down: pick('range', (r) => r.color('Down bars')),
      projUp: pick('range', (r) => r.color('Projection up bars')), projDown: pick('range', (r) => r.color('Projection down bars')),
      thin: R('range').checked('Thin bars'),
      body: pair('range', 'Body'), border: pair('range', 'Borders'), wick: pair('range', 'Wick'), projCandles: pair('range', 'Projection candles'),
      phantom: R('range').checked('Phantom bars'),
    },
    volFootprint: candle('candle'),
    svp: svpStyle(),
  };
}

/** Default draft, built once (read-only use). */
const DEFAULTS: Draft = makeDefaultDraft();
/** Series styles of an uncommitted pane (factory values). */
export const DEFAULT_SERIES_STYLES: SeriesStyles = seriesStylesFrom(DEFAULTS);

export type ChartAppearance = {
  up?: string;
  down?: string;
  bg?: string;
  bgGradient?: boolean;
  bgBottom?: string;
  grid?: string;
  bodyVisible?: boolean;
  borderUpColor?: string;
  borderDownColor?: string;
  borderVisible?: boolean;
  wickUpColor?: string;
  wickDownColor?: string;
  wickVisible?: boolean;
  gridVertColor?: string;
  gridHorzColor?: string;
  gridVertVisible?: boolean;
  gridHorzVisible?: boolean;
  gridVertStyle?: number; // 0 solid, 1 dashed, 2 dotted
  gridHorzStyle?: number;
  crosshairColor?: string;
  crosshairStyle?: number;
  crosshairWidth?: number;
  scaleTextColor?: string;
  scaleFontSize?: number;
  scaleLinesColor?: string;
  marginTop?: number;
  marginBottom?: number;
  rightOffset?: number;
  scalesPlacement?: 'left' | 'right';
  precision?: string;
  /** Canvas → Buttons → Navigation / Pane. */
  navButtons?: NavButtonsBehavior;
  paneButtons?: NavButtonsBehavior;
  // Status-line (legend) part visibility.
  legendLogo?: boolean;
  legendTitle?: boolean;
  legendMarketStatus?: boolean;
  legendChartValues?: boolean;
  legendBarChange?: boolean;
  legendVolume?: boolean;
  legendLastDayChange?: boolean;
  // Indicator (studies) legend.
  legendIndTitles?: boolean;
  legendIndInputs?: boolean;
  legendIndValues?: boolean;
  /** Indicator legend background opacity 0..100 (0 = off). */
  legendIndBgOpacity?: number;
  // Time-axis formatting.
  dateFormat?: string;
  timeFormat?: string;
  dayOfWeek?: boolean;
  saveLeftEdge?: boolean;
  sessionBreaksVisible?: boolean;
  sessionBreaksColor?: string;
  sessionBreaksStyle?: number;
  sessionBreaksWidth?: number;
  // Events markers.
  eventsDividends?: boolean;
  eventsSplits?: boolean;
  latestNews?: boolean;
  newsNotification?: boolean;
  // Symbol tab extras.
  colorBarsOnPrevClose?: boolean;
  /** Display-timezone label (data/timezones.ts). Applied by App onto the
   *  global timezone signal at commit — it is NOT a per-pane chart token. */
  timezone?: string;
  /** "Adjust data for dividends" — the same app-wide flag as the bottom-bar
   *  ADJ toggle (kv tv:adjusted). Applied by App at commit. */
  adjustDividends?: boolean;
  /** Symbol → Session: "Regular" | "Extended" (the pane's RTH/ETH session,
   *  applied by App at commit). */
  session?: string;
  preMarketBgColor?: string;
  postMarketBgColor?: string;
  // Scales → Price Scale.
  currencyUnit?: NavButtonsBehavior;
  scaleModes?: NavButtonsBehavior;
  lockRatio?: boolean;
  /** The ratio typed / shown in the lock row (price units per bar). */
  lockRatioValue?: number;
  alignLabels?: boolean;
  plusButton?: boolean;
  // Scales → Price labels → Symbol (check list): "Value" = last-value label,
  // "Line" = price line, "Name" = the ticker inside the price-scale label.
  symbolLastValue?: boolean;
  symbolPriceLine?: boolean;
  symbolNameLabel?: boolean;
  /** "" = bar direction. */
  symbolPriceLineColor?: string;
  symbolPriceLineWidth?: number;
  /** Symbol last-value label mode: true = "Price and percentage value". */
  symbolValuePercent?: boolean;
  countdown?: boolean;
  prevCloseLabel?: boolean;
  prevCloseLine?: boolean;
  prevCloseColor?: string;
  prevCloseWidth?: number;
  prePostLabel?: boolean;
  prePostLine?: boolean;
  preMarketColor?: string;
  postMarketColor?: string;
  highLowLabels?: boolean;
  highLowLines?: boolean;
  /** "" = automatic (label colour of the bar direction). */
  highLowColor?: string;
  highLowWidth?: number;
  watermarkColor?: string;
  watermarkTicker?: boolean;
  watermarkInterval?: boolean;
  watermarkDescription?: boolean;
  /** Status line → Title select: "Name" | "Symbol" | "Symbol and name". */
  legendTitleMode?: string;
  indLastValue?: boolean;
  indNameLabel?: boolean;
  alertLines?: boolean;
  alertLinesOnlyActive?: boolean;
  alertLineColor?: string;
  autoHideToasts?: boolean;
  /** Per-chart-type style rows (Symbol tab). */
  styles?: SeriesStyles;
};

/** Appearance of a chart with no stored settings = the dialog's defaults
 *  (factory values), so pressing Ok on an untouched dialog changes
 *  nothing on the chart. */
let defaultAppearance: ChartAppearance | null = null;

export function appearanceFrom(d: Draft | undefined): ChartAppearance {
  if (!d) return (defaultAppearance ??= appearanceFrom(makeDefaultDraft()));
  const S = reader(d, 'symbol');
  const L = reader(d, 'legend');
  const Sc = reader(d, 'scales');
  const C = reader(d, 'canvas');
  const A = reader(d, 'alerts');
  const E = reader(d, 'events');
  const styles = seriesStylesFrom(d);
  const cs = styles.candle;
  const vg = C.colorCtl('Vertical grid lines');
  const hg = C.colorCtl('Horizontal grid lines');
  const cross = C.colorCtl('Crosshair');
  const sess = E.colorCtl('Session breaks');
  const symLine = Sc.colorCtl('Symbol', 1);
  const pc = Sc.colorCtl('Previous day close', 1);
  const hl = Sc.colorCtl('High and low', 1);
  const fontSize = parseInt(C.sel('Text', 1) ?? '', 10);
  const mTop = C.num('Top');
  const mBottom = C.num('Bottom');
  const bgTransparency = L.slider('Background');
  return {
    up: cs.bodyUp,
    down: cs.bodyDown,
    bodyVisible: cs.body,
    borderUpColor: cs.borderUp,
    borderDownColor: cs.borderDown,
    borderVisible: cs.border,
    wickUpColor: cs.wickUp,
    wickDownColor: cs.wickDown,
    wickVisible: cs.wick,
    colorBarsOnPrevClose: cs.prevClose,
    bg: C.color('Background', 1),
    bgGradient: C.sel('Background') === 'Gradient',
    bgBottom: C.color('Background', 2),
    grid: vg?.color,
    gridVertColor: vg?.color,
    gridHorzColor: hg?.color,
    gridVertVisible: C.checked('Vertical grid lines'),
    gridHorzVisible: C.checked('Horizontal grid lines'),
    gridVertStyle: vg?.style,
    gridHorzStyle: hg?.style,
    crosshairColor: cross?.color,
    crosshairStyle: cross?.style,
    crosshairWidth: cross?.width,
    scaleTextColor: C.color('Text'),
    scaleFontSize: Number.isFinite(fontSize) ? fontSize : undefined,
    scaleLinesColor: C.color('Lines'),
    marginTop: mTop !== undefined ? mTop / 100 : undefined,
    marginBottom: mBottom !== undefined ? mBottom / 100 : undefined,
    rightOffset: C.num('Right'),
    navButtons: NAV_BEHAVIOR[C.sel('Navigation') ?? ''],
    paneButtons: NAV_BEHAVIOR[C.sel('Pane') ?? ''],
    scalesPlacement: Sc.sel('Scales placement') === 'Stack on the left' ? 'left' : 'right',
    precision: S.sel('Precision'),
    legendLogo: L.checked('Logo'),
    legendTitle: L.checked('Title'),
    legendMarketStatus: L.checked('Open market status'),
    legendChartValues: L.checked('Chart values'),
    legendBarChange: L.checked('Bar change values'),
    legendVolume: L.checked('Volume'),
    legendLastDayChange: L.checked('Last day change values'),
    legendIndTitles: L.checked('Titles'),
    legendIndInputs: L.checked('Inputs'),
    legendIndValues: L.checked('Values'),
    legendIndBgOpacity: L.checked('Background') ? 100 - (bgTransparency ?? 50) : 0,
    dateFormat: Sc.sel('Date format'),
    timeFormat: Sc.sel('Time hours format'),
    dayOfWeek: Sc.checked('Day of week on labels'),
    saveLeftEdge: Sc.checked('Save chart left edge position when changing interval'),
    sessionBreaksVisible: E.checked('Session breaks'),
    sessionBreaksColor: sess?.color,
    sessionBreaksStyle: sess?.style,
    sessionBreaksWidth: sess?.width,
    eventsDividends: E.checked('Dividends'),
    eventsSplits: E.checked('Splits'),
    latestNews: E.checked('Latest news'),
    newsNotification: E.checked('News notification'),
    timezone: S.sel('Timezone'),
    adjustDividends: S.checked('Adjust data for dividends'),
    session: S.sel('Session'),
    preMarketBgColor: S.color('Pre/post market hours background', 0),
    postMarketBgColor: S.color('Pre/post market hours background', 1),
    currencyUnit: NAV_BEHAVIOR[Sc.sel('Currency and Unit') ?? ''],
    scaleModes: NAV_BEHAVIOR[Sc.sel('Scale modes (A and L)') ?? ''],
    lockRatio: Sc.checked('Lock price to bar ratio'),
    lockRatioValue: Sc.num('Lock price to bar ratio'),
    alignLabels: Sc.checked('No overlapping labels'),
    plusButton: Sc.checked('Plus button'),
    symbolLastValue: Sc.member('Symbol', 'Value'),
    symbolPriceLine: Sc.member('Symbol', 'Line'),
    symbolNameLabel: Sc.member('Symbol', 'Name'),
    symbolPriceLineColor: symLine?.color,
    symbolPriceLineWidth: symLine?.width,
    symbolValuePercent: Sc.sel('Symbol value mode') === 'Price and percentage value',
    countdown: Sc.checked('Countdown to bar close'),
    prevCloseLabel: Sc.member('Previous day close', 'Value'),
    prevCloseLine: Sc.member('Previous day close', 'Line'),
    prevCloseColor: pc?.color,
    prevCloseWidth: pc?.width,
    prePostLabel: Sc.member('Pre/post/night market', 'Value'),
    prePostLine: Sc.member('Pre/post/night market', 'Line'),
    preMarketColor: Sc.color('Pre/post/night market', 1),
    postMarketColor: Sc.color('Pre/post/night market', 2),
    highLowLabels: Sc.member('High and low', 'Value'),
    highLowLines: Sc.member('High and low', 'Line'),
    highLowColor: hl?.color,
    highLowWidth: hl?.width,
    watermarkColor: C.color('Watermark', 1),
    watermarkTicker: C.member('Watermark', 'Ticker'),
    watermarkInterval: C.member('Watermark', 'Interval'),
    watermarkDescription: C.member('Watermark', 'Description'),
    legendTitleMode: L.sel('Title'),
    indLastValue: Sc.member('Indicators and financials', 'Value'),
    indNameLabel: Sc.member('Indicators and financials', 'Name'),
    alertLines: A.checked('Alert lines'),
    alertLinesOnlyActive: A.checked('Only active alerts'),
    alertLineColor: A.color('Alert lines'),
    autoHideToasts: A.checked('Automatically hide toasts'),
    styles,
  };
}

/** Field patch coming from the price-scale context menu (right-click on the
 *  price axis) — the checkable Labels/Lines rows and "Move scale to left".
 *  Each field maps onto the SAME dialog rows appearanceFrom reads, so the
 *  menu and the Settings dialog stay one source of truth. */
export type ScaleMenuPatch = {
  symbolLastValue?: boolean;
  symbolPriceLine?: boolean;
  symbolNameLabel?: boolean;
  prevCloseLabel?: boolean;
  prevCloseLine?: boolean;
  prePostLabel?: boolean;
  prePostLine?: boolean;
  highLowLabels?: boolean;
  highLowLines?: boolean;
  countdown?: boolean;
  indLastValue?: boolean;
  scalesPlacement?: 'left' | 'right';
  lockRatio?: boolean;
  lockRatioValue?: number;
  alignLabels?: boolean;
  plusButton?: boolean;
  /** Time-axis menu "Session breaks" = the Events tab row. */
  sessionBreaks?: boolean;
};

/** Clone `d` (or the factory defaults) with the given scale-menu fields
 *  folded into their dialog rows. The price-label rows are check lists, so
 *  label and line are independent memberships. */
export function patchDraftScales(d: Draft | undefined, p: ScaleMenuPatch): Draft {
  const next = cloneDraft(d ?? makeDefaultDraft());
  const setSelect = (id: string, value: string) => {
    const c = next[keyOf('scales', id)]?.controls?.[0];
    if (c && c.kind === 'select') c.value = value;
  };
  const setChecked = (id: string, on: boolean | undefined) => {
    const row = next[keyOf('scales', id)];
    if (row && on !== undefined) row.checked = on;
  };
  const setMember = (id: string, opt: string, on?: boolean) => {
    if (on === undefined) return;
    const c = next[keyOf('scales', id)]?.controls?.[0];
    if (!c || c.kind !== 'multicheck') return;
    c.on = on ? (c.on.includes(opt) ? c.on : [...c.on, opt]) : c.on.filter((x) => x !== opt);
  };
  setMember('Symbol', 'Value', p.symbolLastValue);
  setMember('Symbol', 'Line', p.symbolPriceLine);
  setMember('Symbol', 'Name', p.symbolNameLabel);
  setMember('Previous day close', 'Value', p.prevCloseLabel);
  setMember('Previous day close', 'Line', p.prevCloseLine);
  setMember('Pre/post/night market', 'Value', p.prePostLabel);
  setMember('Pre/post/night market', 'Line', p.prePostLine);
  setMember('High and low', 'Value', p.highLowLabels);
  setMember('High and low', 'Line', p.highLowLines);
  setMember('Indicators and financials', 'Value', p.indLastValue);
  setChecked('Countdown to bar close', p.countdown);
  setChecked('Lock price to bar ratio', p.lockRatio);
  if (p.lockRatioValue !== undefined) {
    const c = next[keyOf('scales', 'Lock price to bar ratio')]?.controls?.[0];
    if (c && c.kind === 'input') c.value = formatRatio(p.lockRatioValue);
  }
  setChecked('No overlapping labels', p.alignLabels);
  setChecked('Plus button', p.plusButton);
  if (p.scalesPlacement !== undefined)
    setSelect('Scales placement', p.scalesPlacement === 'left' ? 'Stack on the left' : 'Auto');
  const sb = next[keyOf('events', 'Session breaks')];
  if (sb && p.sessionBreaks !== undefined) sb.checked = p.sessionBreaks;
  return next;
}

/** Live values the dialog shows but the draft does not own: the app-wide
 *  timezone / ADJ flag, the pane's session and its current price/bar ratio. */
export type DialogSeed = { timezone: string; adjusted: boolean; session: 'RTH' | 'ETH'; scaleRatio?: number };

/** Clone `d` (or the factory defaults) with the live values folded in, so the
 *  dialog opens in sync with the bottom bar and the chart. */
export function seedDraft(d: Draft | undefined, s: DialogSeed): Draft {
  const base = d ? cloneDraft(d) : makeDefaultDraft();
  const tz = base[keyOf('symbol', 'Timezone')]?.controls?.[0];
  if (tz && tz.kind === 'select') tz.value = s.timezone;
  const adj = base[keyOf('symbol', 'Adjust data for dividends')];
  if (adj) adj.checked = s.adjusted;
  const ses = base[keyOf('symbol', 'Session')]?.controls?.[0];
  if (ses && ses.kind === 'select') ses.value = s.session === 'ETH' ? 'Extended' : 'Regular';
  const lock = base[keyOf('scales', 'Lock price to bar ratio')]?.controls?.[0];
  if (lock && lock.kind === 'input') lock.value = s.scaleRatio !== undefined && Number.isFinite(s.scaleRatio) ? formatRatio(s.scaleRatio) : '';
  return base;
}

/** The ratio shows with up to 7 decimals. */
export function formatRatio(v: number): string {
  return String(Number(v.toFixed(7)));
}

/* ── Chart settings defaults ──────────────────────────────────────────────
 * The chart properties are saved as the user's defaults on every edit, and a
 * NEW chart starts with them; charts that already exist keep their own
 * settings. The draft committed with Ok / Apply to all is stored here, and a
 * new tab's panes are seeded from it (tabs.ts makeTab). */
const DEFAULTS_KEY = 'tv:chart-settings-defaults';

export function saveChartSettingsDefaults(d: Draft): void {
  kv.setItem(DEFAULTS_KEY, JSON.stringify({ fingerprint: SETTINGS_FINGERPRINT, rev: SETTINGS_REV, draft: cloneDraft(d) }));
}

/** The saved chart settings defaults, revived for this build, or undefined. */
export function loadChartSettingsDefaults(): Draft | undefined {
  try {
    const raw = kv.getItem(DEFAULTS_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { fingerprint?: unknown; rev?: unknown; draft?: unknown };
    return reviveDraft(v.draft, v.fingerprint, v.rev);
  } catch {
    return undefined;
  }
}

