import { translateWith } from "../../i18n/translator";
/*
 * Screener Heatmap view (the reference app 3.5): every result as a tile, its
 * area by the "Size by" column, its colour by the "Color by" column, grouped
 * by sector ("Group by"), drawn on a canvas (a screen can hold thousands).
 *
 * Layout and text follow the reference rules (./screener-heatmap): a
 * squarified treemap, groups largest first with a 12 px title over them
 * (14 px from 1440 px wide), tiles 2 px apart, logo / title / value sized by
 * the tile. A group title opens the group alone ("All" goes back); a tile
 * shows its symbol on the chart. The legend under the map shows the 7 colour
 * buckets (a click hides or shows a bucket's tiles) and the colour depth.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { ScanRow } from "../../bindings";
import { Icon } from "../../components/Icon";
import { LoadingWheel } from "../../components/LoadingWheel";
import type { WheelText } from "../../data/screener-progress";
import { screenerScan } from "../../data/screener-api";
import { COLUMN_BY_ID, fieldOf } from "../../data/screener-catalog";
import { displayCell } from "../../data/screener-display";
import {
  COLOR_DEPTHS,
  SCHEME_COLORS,
  bucketOf,
  colorScale,
  heatColors,
  heatGroup,
  heatGroups,
  heatOption,
  heatSizes,
  legendLabel,
  squarify,
  type HeatOption,
  type Placed,
  type Rect,
} from "../../data/screener-heatmap";
import { screenerStore } from "../../data/screener-store";
import type { Plan } from "../../data/screener-query";
import { screenerSettings, setScreenerSettings } from "../../data/screener-settings";
import { PopDivider, PopItem, PopSectionTitle, Popover } from "./Popover";

/** The reference heatmap scan's row limit. */
const MAX_TILES = 16_000;
const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const LIGHT_CLASSIC = ["#991F29", "#F23645", "#F77C80", "#C9C9C9", "#42BD7F", "#089950", "#056636"];

type Tile = { ticker: string; name: string | null; size: number; color: number | null; group: string; currency: string | null; sizeRaw: number | null };
type Group = { name: string; rect: Rect; header: Rect | null; tiles: Placed<Tile>[] };

/** Logo / text sizes of a tile (the reference rule sets A–D). */
function tileText(w: number, h: number, logo: boolean, title: boolean, value: boolean) {
  const at = (rows: [number, number, number][], dflt: number) => rows.find(([tw, th]) => w >= tw && h >= th)?.[2] ?? dflt;
  const logoGap: Record<number, number> = { 64: 24, 56: 18, 48: 13, 32: 7, 24: 5, 18: 4, 12: 2 };
  const textGap: Record<number, number> = { 24: 12, 20: 10, 18: 10, 14: 5, 12: 4, 11: 0 };
  let logoPx = 0;
  let textPx = 11;
  let showTitle = false;
  let showValue = false;
  let showLogo = false;
  if (logo && !title && !value) {
    showLogo = true;
    const m = Math.min(w, h);
    logoPx = [[128, 64], [96, 56], [64, 48], [48, 32], [40, 24], [32, 18]].find(([t]) => m >= t)?.[1] ?? 12;
  } else if (logo && title !== value) {
    showLogo = w >= 18 && h >= 18;
    logoPx = at([[160, 192, 64], [128, 160, 56], [64, 96, 48], [48, 64, 32], [48, 48, 24], [32, 40, 18]], 12);
    textPx = at([[160, 192, 24], [128, 160, 20], [64, 96, 18], [48, 48, 14], [40, 40, 12]], 11);
    // The only text uses the value's rule.
    const shows = w >= 40 && h >= 32;
    showTitle = title && shows;
    showValue = value && shows;
  } else if (!logo && (title || value)) {
    textPx = at([[128, 128, 24], [96, 96, 18], [96, 40, 14], [40, 40, 12]], 11);
    showValue = value && w >= 40 && h >= 18;
    showTitle = title && (value ? w >= 48 && h >= 64 : w >= 40 && h >= 18);
  } else if (logo) {
    showLogo = w >= 18 && h >= 18;
    logoPx = at([[128, 192, 64], [128, 160, 56], [96, 128, 48], [64, 96, 32], [48, 64, 24], [32, 40, 18]], 12);
    textPx = at([[128, 192, 24], [128, 160, 20], [96, 128, 18], [64, 96, 14], [40, 48, 12]], 11);
    showTitle = w >= 48 && h >= 64;
    showValue = w >= 40 && h >= 32;
  }
  return { showLogo, logoPx, logoGap: logoGap[logoPx] ?? 2, showTitle, showValue, textPx, textGap: textGap[textPx] ?? 0 };
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

type Props = {
  plan: Plan;
  /** No market table yet: the loading wheel instead of "no symbols". */
  loading: boolean;
  /** The wheel's text: the download progress. */
  wheel: WheelText;
  has: (field: string) => boolean;
  onPick: (ticker: string) => void;
  refreshTick: number;
  /** The shown count ("N total" in the control panel). */
  onTotal: (n: number | null) => void;
};

export function ScreenerHeatmap(props: Props) {
  let box!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [rows, setRows] = createSignal<ScanRow[] | null>(null);
  const [zoom, setZoom] = createSignal<string | null>(null);
  const [hidden, setHidden] = createSignal<Set<number>>(new Set());
  const [hoverGroup, setHoverGroup] = createSignal<string | null>(null);
  const [depthOpen, setDepthOpen] = createSignal(false);
  let depthBtn!: HTMLButtonElement;
  const st = screenerSettings;

  const sizeOpt = () => heatOption("size", st().heatSize, screenerStore.type());
  const colorOpt = () => heatOption("color", st().heatColor, screenerStore.type());
  const groupOpt = () => heatGroup(st().heatGroup, screenerStore.type());
  const sizeField = () => fieldOf(sizeOpt().column);
  const colorField = () => fieldOf(colorOpt().column);
  const groupField = () => (groupOpt().column ? fieldOf(groupOpt().column!) : null);
  const request = createMemo(() => {
    const sf = sizeField();
    const cf = colorField();
    if (!sf || !cf || !props.has(sf) || !props.has(cf)) return null;
    const gf = groupField();
    const columns = [sf, cf, ...(gf && props.has(gf) ? [gf] : []), ...["description", "currency"].filter(props.has)];
    return { columns, filter: props.plan.filter, sort: { sortBy: sf, sortOrder: "desc" as const }, range: [0, MAX_TILES] as [number, number], tickers: props.plan.tickers };
  });

  let seq = 0;
  const scan = async () => {
    const req = request();
    if (!req) return;
    const my = ++seq;
    try {
      const res = await screenerScan(req);
      if (my !== seq) return;
      setRows(res.rows);
      props.onTotal(res.totalCount);
    } catch (e) {
      console.warn("[screener] heatmap scan", e);
    }
  };
  createEffect(on(() => JSON.stringify(request()), () => { setRows(null); setZoom(null); void scan(); }));
  createEffect(on(() => props.refreshTick, () => void scan(), { defer: true }));
  onCleanup(() => props.onTotal(null));

  const tiles = createMemo<Tile[]>(() => {
    const r = rows();
    const req = request();
    if (!r || !req) return [];
    const ix = (f: string) => req.columns.indexOf(f);
    const si = ix(sizeField()!);
    const ci = ix(colorField()!);
    const gi = groupField() ? ix(groupField()!) : -1;
    const di = ix("description");
    const ki = ix("currency");
    const out: Tile[] = [];
    for (const row of r) {
      const sv = row.d[si];
      const size = sizeOpt().mono ? 1 : typeof sv === "number" ? sv : 0;
      if (!(size > 0)) continue;
      const cv = row.d[ci];
      out.push({
        ticker: row.s,
        name: di >= 0 && typeof row.d[di] === "string" ? (row.d[di] as string) : null,
        size,
        sizeRaw: typeof sv === "number" ? sv : null,
        color: typeof cv === "number" ? cv : null,
        group: gi >= 0 && typeof row.d[gi] === "string" && row.d[gi] ? (row.d[gi] as string) : "—",
        currency: ki >= 0 && typeof row.d[ki] === "string" ? (row.d[ki] as string) : null,
      });
    }
    return out;
  });
  const scale = createMemo(() => colorScale(colorOpt().scale ?? "signed", tiles().map((t) => t.color ?? 0), st().heatDepth));
  const palette = () => {
    const sc = scale();
    if (sc.positive) return SCHEME_COLORS.positive;
    if (st().heatScheme === "classic" && document.documentElement.classList.contains("theme-light")) return LIGHT_CLASSIC;
    return SCHEME_COLORS[st().heatScheme];
  };
  const wide = () => size().w >= 1440;

  const layout = createMemo<Group[]>(() => {
    const { w, h } = size();
    if (!w || !h) return [];
    const sc = scale();
    const hide = hidden();
    const shown = tiles().filter((t) => !hide.has(bucketOf(sc, t.color)));
    const z = zoom();
    const grouped = groupOpt().column !== null;
    const byGroup = new Map<string, Tile[]>();
    for (const t of shown) {
      if (z !== null && t.group !== z) continue;
      const k = grouped ? t.group : "";
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(t);
    }
    const outer: Rect = { x: 2, y: 2, w: w - 4, h: h - 4 };
    const mono = !!sizeOpt().mono;
    const groupWeight = (list: Tile[]) => (mono ? 1 / byGroup.size : list.reduce((s, t) => s + t.size, 0));
    const placedGroups = grouped && z === null
      ? squarify([...byGroup].map(([name, list]) => ({ weight: groupWeight(list), item: name })), outer)
      : [{ ...outer, item: [...byGroup.keys()][0] ?? "" }];
    const padTop = grouped && z === null ? (wide() ? 24 : 18) : 0;
    const pad = grouped && z === null ? 3 : 0;
    return placedGroups.map((g) => {
      const list = byGroup.get(g.item) ?? [];
      const inner: Rect = { x: g.x + pad, y: g.y + padTop, w: g.w - 2 * pad, h: g.h - padTop - pad };
      let placed: Placed<Tile>[];
      if (mono) {
        // A near-square grid, highest colour value first.
        const sorted = [...list].sort((a, b) => (b.color ?? 0) - (a.color ?? 0));
        const cols = Math.max(1, Math.ceil(Math.sqrt((sorted.length * inner.w) / Math.max(1, inner.h))));
        const rowsN = Math.max(1, Math.ceil(sorted.length / cols));
        const cw = inner.w / cols;
        const ch = inner.h / rowsN;
        placed = sorted.map((t, i) => ({ x: inner.x + (i % cols) * cw, y: inner.y + Math.floor(i / cols) * ch, w: cw, h: ch, item: t }));
      } else placed = squarify(list.map((t) => ({ weight: t.size, item: t })), inner);
      return { name: g.item, rect: { x: g.x, y: g.y, w: g.w, h: g.h }, header: padTop ? { x: g.x, y: g.y, w: g.w, h: padTop } : null, tiles: placed };
    });
  });

  const draw = () => {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const { w, h } = size();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sc = scale();
    const colors = palette();
    const s = st();
    const inset = Math.max(Math.round(0.5 * dpr), 1) / dpr;
    const valueOpt = s.heatValue === "size" ? sizeOpt() : colorOpt();
    const valueDef = COLUMN_BY_ID[valueOpt.column.id];
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const g of layout()) {
      for (const p of g.tiles) {
        const t = p.item;
        const fill = colors[bucketOf(sc, t.color)] ?? colors[3];
        const x = p.x + inset;
        const y = p.y + inset;
        const tw = p.w - 2 * inset;
        const th = p.h - 2 * inset;
        if (tw <= 0 || th <= 0) continue;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, tw, th);
        const tx = tileText(tw, th, s.heatLogo, s.heatTitleOn, s.heatValueOn);
        const title = s.heatTitle === "name" ? t.name ?? t.ticker : t.ticker;
        const raw = s.heatValue === "size" ? t.sizeRaw : t.color;
        const cell = displayCell(valueDef, raw, t.currency);
        const value = cell.unit ? `${cell.text} ${cell.unit}` : cell.text;
        const blocks: ["logo" | "title" | "value", number, number][] = [];
        if (tx.showLogo) blocks.push(["logo", tx.logoPx, tx.logoGap]);
        if (tx.showTitle) blocks.push(["title", tx.textPx, tx.textGap]);
        if (tx.showValue) blocks.push(["value", tx.textPx, tx.textGap]);
        if (!blocks.length) continue;
        const total = blocks.reduce((sum, b, i) => sum + b[1] + (i < blocks.length - 1 ? b[2] : 0), 0);
        if (total > th) continue;
        let cy = y + (th - total) / 2;
        const padX = tw > 200 ? 8 : 4;
        const textColor = s.heatScheme === "mono" && !sc.positive && luminance(fill) >= 140 ? "#0f0f0f" : "#ffffff";
        for (const [kind, px, gap] of blocks) {
          if (kind === "logo") {
            const r = px / 2;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(x + tw / 2, cy + r, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#131722";
            ctx.font = `600 ${Math.round(px * 0.5)}px ${FONT}`;
            ctx.textBaseline = "middle";
            ctx.fillText(t.ticker.charAt(0), x + tw / 2, cy + r + 0.5);
            ctx.textBaseline = "top";
          } else {
            ctx.fillStyle = textColor;
            ctx.font = `${px}px ${FONT}`;
            ctx.fillText(ellipsize(ctx, kind === "title" ? title : value, tw - 2 * padX), x + tw / 2, cy);
          }
          cy += px + gap;
        }
      }
      // Group title over its tiles.
      if (g.header) {
        const hover = hoverGroup() === g.name;
        const fs = wide() ? 14 : 12;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.font = `${fs}px ${FONT}`;
        ctx.fillStyle = hover ? "#ffffff" : "#dbdbdb";
        const label = ellipsize(ctx, g.name, g.rect.w - 5 - 20);
        const by = g.header.y + g.header.h - (wide() ? 4 : 2);
        ctx.fillText(label, g.rect.x + 5, by);
        // Open arrow after the title.
        const ax = g.rect.x + 5 + ctx.measureText(label).width + 5;
        const as = wide() ? 10 : 8;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(ax + as * 0.3, by - as * 0.95);
        ctx.lineTo(ax + as * 0.7, by - as * 0.55);
        ctx.lineTo(ax + as * 0.3, by - as * 0.15);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (hover) {
          ctx.strokeStyle = "#3179F5";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(g.rect.x + 1, g.rect.y + 1, g.rect.w - 2, g.rect.h - 2, 4);
          ctx.stroke();
        }
      }
    }
  };
  createEffect(() => {
    layout();
    hoverGroup();
    palette();
    st();
    draw();
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });

  const at = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const g of layout()) {
      if (x < g.rect.x || x > g.rect.x + g.rect.w || y < g.rect.y || y > g.rect.y + g.rect.h) continue;
      if (g.header && y < g.header.y + g.header.h) return { group: g.name, tile: null, onHeader: true };
      const tile = g.tiles.find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)?.item ?? null;
      return { group: g.name, tile, onHeader: false };
    }
    return null;
  };

  const depthLabel = (d: number) => {
    const sc = colorScale(colorOpt().scale ?? "signed", [], d);
    return translateWith("{0} to {1}", legendLabel(sc.centres[0], sc.percent), legendLabel(sc.centres[sc.centres.length - 1], sc.percent));
  };

  return (
    <div class="scr-heatmap">
      <Show when={zoom() !== null}>
        <div class="scr-heat-crumbs">
          <button type="button" class="scr-heat-crumb" onClick={() => setZoom(null)}>
            <Icon name="scr-back" size={18} class="ot-flip-rtl" />
            All
          </button>
          <span class="scr-heat-crumb-sep">•</span>
          <span>{zoom()}</span>
        </div>
      </Show>
      <div class="scr-heat-box" ref={box}>
        <canvas
          ref={canvas}
          class="scr-heat-canvas"
          classList={{ "is-pointer": hoverGroup() !== null }}
          onMouseMove={(e) => {
            const hit = at(e);
            setHoverGroup(groupOpt().column && zoom() === null && hit ? hit.group : null);
            canvas.style.cursor = hit && (hit.tile || hit.onHeader) ? "pointer" : "default";
          }}
          onMouseLeave={() => setHoverGroup(null)}
          onClick={(e) => {
            const hit = at(e);
            if (!hit) return;
            if (hit.onHeader && groupOpt().column && zoom() === null) setZoom(hit.group);
            else if (hit.tile) props.onPick(hit.tile.ticker);
          }}
        />
        <Show when={!props.loading} fallback={<LoadingWheel label={props.wheel.label} caption={props.wheel.caption} />}>
          <Show when={rows() !== null && tiles().length === 0}>
            <div class="scr-empty">No symbols match your filters</div>
          </Show>
        </Show>
      </div>
      <div class="scr-heat-legend">
        <For each={scale().centres}>
          {(c, i) => (
            <button
              type="button"
              class="scr-heat-legend-item"
              classList={{ "is-hidden": hidden().has(i()) }}
              title={(() => {
                const [lo, hi] = scale().ranges[i()];
                const p = scale().percent;
                return `${Number.isFinite(lo) ? legendLabel(lo, p) : ""} – ${Number.isFinite(hi) ? legendLabel(hi, p) : ""}`;
              })()}
              onClick={() => {
                const next = new Set(hidden());
                if (next.has(i())) next.delete(i());
                else next.add(i());
                setHidden(next);
              }}
            >
              <span class="scr-heat-legend-label">{legendLabel(c, scale().percent)}</span>
              <span class="scr-heat-legend-swatch" style={{ background: palette()[i()] }} />
            </button>
          )}
        </For>
        <button ref={depthBtn} type="button" class="scr-light-btn scr-light-btn--ghost is-icon-only is-small-icon scr-heat-depth" title="Color depth" aria-label="Color depth" onClick={() => setDepthOpen(!depthOpen())}>
          <Icon name="scr-heat-depth" size={18} />
        </button>
      </div>
      <Show when={depthOpen()}>
        <Popover anchor={depthBtn} onClose={() => setDepthOpen(false)} width={150}>
          <PopSectionTitle title="Color depth" />
          <PopItem title="Auto" selected={st().heatDepth === null} onClick={() => { setScreenerSettings({ heatDepth: null }); setDepthOpen(false); }} />
          <For each={COLOR_DEPTHS}>
            {(d) => <PopItem title={depthLabel(d)} selected={st().heatDepth === d} onClick={() => { setScreenerSettings({ heatDepth: d }); setDepthOpen(false); }} />}
          </For>
        </Popover>
      </Show>
    </div>
  );
}

/** The Heatmap view's toolbar (control panel, after the view button): Size by, Color by, Group by. */
export function HeatmapToolbar(props: { has: (field: string) => boolean }) {
  const [open, setOpen] = createSignal<"size" | "color" | "group" | null>(null);
  const refs: Partial<Record<"size" | "color" | "group", HTMLButtonElement>> = {};
  const st = screenerSettings;
  const offered = (list: HeatOption[]) => list.filter((o) => {
    const f = fieldOf(o.column);
    return f !== null && props.has(f);
  });
  const Btn = (p: { k: "size" | "color" | "group"; icon: string; title: string }) => (
    <button
      ref={(el) => (refs[p.k] = el)}
      type="button"
      class="scr-light-btn scr-light-btn--ghost is-icon-only scr-view-tool"
      classList={{ "is-open": open() === p.k }}
      title={p.title}
      aria-label={p.title}
      onClick={() => setOpen(open() === p.k ? null : p.k)}
    >
      <Icon name={p.icon} size={28} />
    </button>
  );
  const Menu = (p: { k: "size" | "color"; title: string; list: HeatOption[]; value: string; pick: (id: string) => void }) => (
    <Show when={open() === p.k}>
      <Popover anchor={refs[p.k]!} onClose={() => setOpen(null)} width={180}>
        <PopSectionTitle title={p.title} />
        <For each={offered(p.list)}>
          {(o, i) => (
            <>
              <Show when={i() > 0 && offered(p.list)[i() - 1].group !== o.group}>
                <PopDivider />
              </Show>
              <PopItem title={o.short} selected={p.value === o.id} onClick={() => { p.pick(o.id); setOpen(null); }} />
            </>
          )}
        </For>
      </Popover>
    </Show>
  );
  return (
    <>
      <Btn k="size" icon="scr-heat-size" title="Size by" />
      <Btn k="color" icon="scr-heat-color" title="Color by" />
      <Btn k="group" icon="scr-heat-group" title="Group by" />
      <Menu k="size" title="Size by" list={heatSizes(screenerStore.type())} value={heatOption("size", st().heatSize, screenerStore.type()).id} pick={(id) => setScreenerSettings({ heatSize: id })} />
      <Menu k="color" title="Color by" list={heatColors(screenerStore.type())} value={heatOption("color", st().heatColor, screenerStore.type()).id} pick={(id) => setScreenerSettings({ heatColor: id, heatDepth: null })} />
      <Show when={open() === "group"}>
        <Popover anchor={refs.group!} onClose={() => setOpen(null)} width={150}>
          <PopSectionTitle title="Group by" />
          <For each={heatGroups(screenerStore.type())}>
            {(g) => <PopItem title={g.short} selected={heatGroup(st().heatGroup, screenerStore.type()).id === g.id} onClick={() => { setScreenerSettings({ heatGroup: g.id }); setOpen(null); }} />}
          </For>
        </Popover>
      </Show>
    </>
  );
}
