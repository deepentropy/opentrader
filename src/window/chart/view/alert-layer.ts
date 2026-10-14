/*
 * Alert labels of a chart view: the level / channel alerts drawn on the series
 * they read, their hover / selection / drag and their menu.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { type ISeriesApi, type SeriesType } from "lightweight-charts";
import { crosshairLockTime } from "../crosshair-lock";
import { uiTheme } from "../../header/chart-settings";
import { alertStore, type AlertRule, type AlertStopReason } from "../../../data/alert-store";
import { LEVEL_OPERATORS, defaultAlertMessage, isBandOperator } from "../../../data/alert-condition";
import { resetRuleEvalState, setAlertWebhook } from "../../../data/alert-engine";
import { ALERT_STATUS_COLORS, AlertLabelsPrimitive, alertLabelTheme, type AlertLabelHit, type AlertLabelSpec } from "../alert-labels";
import { CtxIcons, type CtxNode } from "../ChartContextMenu";
import { roundedOnSeries } from "./helpers";
import { type ChartCx } from "./context";
import type { Setter } from "solid-js";
import { emitAppEvent } from "../../../data/app-events";

export type AlertLabelTarget = { series: ISeriesApi<SeriesType>; spec: AlertLabelSpec; rule: AlertRule };

/** What createAlertLayer adds to the chart context. */
export interface AlertLayerApi {
  alertLabelAt: (clientX: number, clientY: number) => {
    series: ISeriesApi<SeriesType>;
    prim: AlertLabelsPrimitive;
    hit: AlertLabelHit;
    paneTop: number;
  } | null;
  alertLabelPrims: Map<ISeriesApi<SeriesType>, AlertLabelsPrimitive>;
  installAlertPointer: () => void;
  openAlertLabelMenu: (id: string, x: number, y: number) => void;
  setAlertSelected: Setter<{
    id: string;
    level: number;
  } | null>;
  setAlertSeriesEpoch: Setter<number>;
}

export function createAlertLayer(cx: ChartCx): AlertLayerApi {
  const { appearance, chartReady, currentTokens, props, setCtxMenu } = cx;
  // ── Alert labels (Settings → Alerts tab) ────────────────────────────────
  // An alert on one level or on a channel between two values draws its
  // label (line, scale tab, hover / selection label) on the series it reads:
  // the main series, or the study's plot in its own pane and scale. A
  // study's alert only on the chart of its interval. See alert-labels.ts.
  const alertLabelPrims = new Map<ISeriesApi<SeriesType>, AlertLabelsPrimitive>();
  const [alertHover, setAlertHover] = createSignal<AlertLabelHit | null>(null);
  const [alertSelected, setAlertSelected] = createSignal<{ id: string; level: number } | null>(null);
  const [alertMoving, setAlertMoving] = createSignal<{ id: string; levels: number[] } | null>(null);
  const [alertBlinks, setAlertBlinks] = createSignal<Record<string, number>>({});
  /** Bumped when a series the labels sit on is replaced. */
  const [alertSeriesEpoch, setAlertSeriesEpoch] = createSignal(0);
  const ALERT_STOP_TEXT: Record<AlertStopReason, string> = { triggered: "Triggered", manual: "Manually", expired: "Expired" };


  /** The labels of this chart and the series each one sits on. Reads the rule
   *  fields, so a tracking caller re-runs on edits. */
  function alertLabelTargets(): AlertLabelTarget[] {
    const key = (props.symbol ?? "").toUpperCase();
    const out: AlertLabelTarget[] = [];
    if (!key || !cx.series || !cx.controller) return out;
    const t = currentTokens();
    const theme = alertLabelTheme(uiTheme() !== "light");
    for (const r of alertStore.rules()) {
      if (r.symbol !== key) continue;
      let levels: number[];
      if (LEVEL_OPERATORS.includes(r.op) && r.right.kind === "value") levels = [r.right.value];
      else if (isBandOperator(r.op) && r.right.kind === "value" && r.right2?.kind === "value") levels = [r.right.value, r.right2.value];
      else continue;
      if (!r.enabled && t.alertLinesOnlyActive) continue;
      let target: ISeriesApi<SeriesType> | null = null;
      if (r.left.kind === "price") target = cx.series;
      else if (r.left.kind === "indicator") {
        // A study's alert reads its own interval: drawn on the chart of that interval only.
        if (r.resolution !== props.interval || cx.controller.isHidden(r.left.indicatorId)) continue;
        target = cx.controller.studySeries(r.left.indicatorId);
      }
      if (!target) continue;
      const reason = r.stopReason ?? "manual";
      out.push({
        series: target,
        rule: r,
        spec: {
          id: r.id,
          levels,
          text: r.name?.trim() || r.message?.trim() || defaultAlertMessage(r),
          status: r.enabled ? null : `Stopped — ${ALERT_STOP_TEXT[reason]}`,
          statusColor: r.enabled ? null : ALERT_STATUS_COLORS[reason],
          color: r.enabled ? t.alertLineColor : theme.inactive,
          inactive: !r.enabled,
        },
      });
    }
    return out;
  }

  /** Put the labels on their series (a primitive per series). */
  function syncAlertLabels(targets: AlertLabelTarget[]) {
    const t = currentTokens();
    const bySeries = new Map<ISeriesApi<SeriesType>, AlertLabelSpec[]>();
    for (const x of targets) bySeries.set(x.series, [...(bySeries.get(x.series) ?? []), x.spec]);
    for (const [s, prim] of alertLabelPrims) {
      if (bySeries.has(s)) continue;
      try { s.detachPrimitive(prim); } catch { /* series gone */ }
      alertLabelPrims.delete(s);
    }
    const ids = new Set(targets.map((x) => x.spec.id));
    const hover = alertHover();
    const sel = alertSelected();
    const moving = alertMoving();
    for (const [s, labels] of bySeries) {
      let prim = alertLabelPrims.get(s);
      if (!prim) {
        prim = new AlertLabelsPrimitive();
        s.attachPrimitive(prim);
        alertLabelPrims.set(s, prim);
      }
      const mine = new Set(labels.map((l) => l.id));
      const scaleId = s === cx.series ? t.scalesPlacement : (s.options() as { priceScaleId?: string }).priceScaleId;
      prim.setState({
        labels,
        lineVisible: t.alertLinesVisible,
        hovered: hover && mine.has(hover.id) ? hover : null,
        selected: sel && mine.has(sel.id) ? sel : null,
        moving: moving && mine.has(moving.id) ? moving : null,
        blinks: alertBlinks(),
        dark: uiTheme() !== "light",
        fontFamily: t.fontFamily,
        side: scaleId === "left" ? "left" : "right",
      });
    }
    if (sel && !ids.has(sel.id)) setAlertSelected(null);
    if (hover && !ids.has(hover.id)) setAlertHover(null);
  }

  createEffect(() => {
    chartReady();
    appearance();
    alertSeriesEpoch();
    void props.interval;
    alertHover();
    alertSelected();
    alertMoving();
    alertBlinks();
    const targets = alertLabelTargets();
    untrack(() => syncAlertLabels(targets));
  });

  // A fire makes its label blink for 2.4 s.
  let lastFireSeen: string | null = alertStore.fires()[0]?.fireId ?? null;
  createEffect(() => {
    const fires = alertStore.fires();
    const fresh: string[] = [];
    for (const f of fires) {
      if (f.fireId === lastFireSeen) break;
      if (!f.offline) fresh.push(f.alertId);
    }
    lastFireSeen = fires[0]?.fireId ?? lastFireSeen;
    if (!fresh.length) return;
    const now = performance.now();
    setAlertBlinks((b) => ({ ...b, ...Object.fromEntries(fresh.map((id) => [id, now])) }));
    const tick = () => {
      for (const prim of alertLabelPrims.values()) prim.update();
      if (performance.now() - now < 2400) requestAnimationFrame(tick);
      else setAlertBlinks((b) => Object.fromEntries(Object.entries(b).filter(([, t0]) => performance.now() - t0 < 2400)));
    };
    requestAnimationFrame(tick);
  });

  /** The label part under a client point: the series, its primitive and the hit. */
  function alertLabelAt(clientX: number, clientY: number): { series: ISeriesApi<SeriesType>; prim: AlertLabelsPrimitive; hit: AlertLabelHit; paneTop: number } | null {
    if (!cx.chart || !cx.host || alertLabelPrims.size === 0) return null;
    const hostRect = cx.host.getBoundingClientRect();
    const plotLeft = hostRect.left + cx.chart.priceScale("left").width();
    const plotW = cx.chart.timeScale().width();
    for (const [s, prim] of alertLabelPrims) {
      let paneEl: HTMLElement;
      try { paneEl = s.getPane().getHTMLElement() as HTMLElement; } catch { continue; }
      const r = paneEl.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const y = clientY - r.top;
      const side = prim.state().side;
      let hit: AlertLabelHit | null = null;
      if (clientX >= plotLeft && clientX <= plotLeft + plotW) hit = prim.labelAt(clientX - plotLeft, y, plotW);
      else if (side === "right" ? clientX > plotLeft + plotW : clientX < plotLeft) hit = prim.axisHitTest(y);
      if (hit) return { series: s, prim, hit, paneTop: r.top };
    }
    return null;
  }

  /** Menu of an alert label (reference): Pause / Restart, Edit…, Delete, then "Alert lines" (the chart setting)
   *  and "Change alerts color…" (the chart settings, Alerts tab). */
  function openAlertLabelMenu(id: string, x: number, y: number) {
    const rule = alertStore.rule(id);
    if (!rule) return;
    const t = currentTokens();
    const nodes: CtxNode[] = [
      rule.enabled
        ? { kind: "item", id: "alert-pause", label: "Pause", icon: CtxIcons.pause, onSelect: () => alertStore.setEnabled(id, false) }
        : { kind: "item", id: "alert-restart", label: "Restart", icon: CtxIcons.restart, onSelect: () => { resetRuleEvalState(id); alertStore.setEnabled(id, true); } },
      { kind: "item", id: "alert-edit", label: "Edit…", icon: CtxIcons.edit,
        onSelect: () => emitAppEvent("chart-open-alert-dialog", { editId: id }) },
      { kind: "item", id: "alert-delete", label: "Delete", icon: CtxIcons.remove,
        onSelect: () => { resetRuleEvalState(id); setAlertWebhook(id, null); alertStore.remove(id); } },
      { kind: "separator" },
      { kind: "item", id: "alert-lines", label: "Alert lines", checked: t.alertLinesVisible,
        onSelect: () => emitAppEvent("chart-patch-scale-settings", { patch: { alertLines: !t.alertLinesVisible } }) },
      { kind: "item", id: "alert-color", label: "Change alerts color…",
        onSelect: () => emitAppEvent("chart-open-settings", { tab: "alerts" }) },
    ];
    setCtxMenu({ x, y, nodes });
  }


  function installAlertPointer() {
    // Alert labels: hover (label, handles, price label on the scale; the
    // crosshair lines hide), a press selects, the button deletes the alert
    // (a stopped one restarts), a drag moves the level (a stopped alert
    // restarts); a press elsewhere clears the selection.
    let alertDrag: { series: ISeriesApi<SeriesType>; id: string; level: number; paneTop: number; startY: number; moved: boolean; levels: number[] } | null = null;
    let alertCrosshairHidden = false;
    const setAlertCrosshair = (hide: boolean) => {
      if (hide === alertCrosshairHidden || !cx.chart) return;
      alertCrosshairHidden = hide;
      cx.chart.applyOptions({ crosshair: { vertLine: { visible: !hide && crosshairLockTime() === null }, horzLine: { visible: !hide } } });
    };
    const sameHit = (a: AlertLabelHit | null, b: AlertLabelHit | null) => a?.id === b?.id && a?.level === b?.level && a?.area === b?.area;
    const onAlertMove = (e: PointerEvent) => {
      if (alertDrag) return;
      const at = e.buttons === 0 ? alertLabelAt(e.clientX, e.clientY) : null;
      const hit = at?.hit ?? null;
      if (!sameHit(hit, alertHover())) setAlertHover(hit);
      cx.host.classList.toggle("alert-label-hover", !!hit && hit.area !== "button");
      setAlertCrosshair(!!hit);
    };
    const onAlertLeave = () => {
      if (alertDrag) return;
      setAlertHover(null);
      cx.host.classList.remove("alert-label-hover");
      setAlertCrosshair(false);
    };
    const onAlertDown = (e: PointerEvent) => {
      if (e.button !== 0 || props.armedTool) return;
      const at = alertLabelAt(e.clientX, e.clientY);
      if (!at) {
        if (alertSelected()) setAlertSelected(null);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const rule = alertStore.rule(at.hit.id);
      if (!rule) return;
      setAlertSelected({ id: at.hit.id, level: at.hit.level });
      if (at.hit.area === "button") {
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointerup", up, true);
          const again = alertLabelAt(ev.clientX, ev.clientY);
          if (again?.hit.id !== rule.id || again.hit.area !== "button") return;
          resetRuleEvalState(rule.id);
          if (!rule.enabled) alertStore.setEnabled(rule.id, true);
          else {
            setAlertWebhook(rule.id, null);
            alertStore.remove(rule.id);
          }
        };
        window.addEventListener("pointerup", up, true);
        return;
      }
      const levels = rule.right.kind === "value" ? [rule.right.value, ...(rule.right2?.kind === "value" ? [rule.right2.value] : [])] : [];
      alertDrag = { series: at.series, id: rule.id, level: at.hit.level, paneTop: at.paneTop, startY: e.clientY, moved: false, levels };
      const move = (ev: PointerEvent) => {
        const d = alertDrag;
        if (!d) return;
        if (!d.moved && Math.abs(ev.clientY - d.startY) < 2) return;
        d.moved = true;
        const p = d.series.coordinateToPrice(ev.clientY - d.paneTop);
        if (p == null) return;
        const price = roundedOnSeries(d.series, p as number);
        const next = [...d.levels];
        if (next.length === 1) next[0] = price;
        else if (d.level === 0) {
          // Moved under the lower bound: the bounds swap.
          if (price < next[1]) { next[0] = next[1]; next[1] = price; d.level = 1; } else next[0] = price;
        } else if (price > next[0]) { next[1] = next[0]; next[0] = price; d.level = 0; } else next[1] = price;
        d.levels = next;
        setAlertMoving({ id: d.id, levels: next });
        setAlertSelected({ id: d.id, level: d.level });
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        const d = alertDrag;
        alertDrag = null;
        setAlertMoving(null);
        if (!d?.moved) return;
        const r = alertStore.rule(d.id);
        if (!r) return;
        resetRuleEvalState(r.id);
        alertStore.update(r.id, {
          right: { kind: "value", value: d.levels[0] },
          ...(d.levels.length > 1 ? { right2: { kind: "value", value: d.levels[1] } } : {}),
          enabled: true,
        });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    };
    cx.host.addEventListener("pointermove", onAlertMove, true);
    cx.host.addEventListener("pointerleave", onAlertLeave);
    cx.host.addEventListener("pointerdown", onAlertDown, true);
    onCleanup(() => {
      cx.host.removeEventListener("pointermove", onAlertMove, true);
      cx.host.removeEventListener("pointerleave", onAlertLeave);
      cx.host.removeEventListener("pointerdown", onAlertDown, true);
    });
  }

  return {
    alertLabelAt,
    alertLabelPrims,
    installAlertPointer,
    openAlertLabelMenu,
    setAlertSelected,
    setAlertSeriesEpoch,
  };
}
