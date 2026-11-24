/*
 * Diagnostic info for a bug report: what a fix needs to reproduce the problem and reporters leave out (the version,
 * the computer, the window, the focused chart with its data source and studies, Bar Replay, the plugins and the last
 * errors). Settings > About copies it; the get_diagnostics agent tool gives it to an agent writing an issue.
 *
 * Plain Markdown in English (it is pasted into a GitHub issue). Nothing leaves the computer unless the user pastes it.
 */
import { commands, type PluginInfo, type SystemInfo } from "../bindings";
import { chartBars } from "./chart-state-registry";
import { isEconomicSymbol } from "./datafeed";
import { recentErrors, type LoggedError } from "./error-reports";
import { replayStarted, replayTiming, replayUpdateInterval } from "./replay";
import { appUpdateStatus } from "./app-update";
import { zoom } from "./app-zoom";
import { currentLanguage } from "../i18n/language";
import { getIndicatorEntry, indicatorName, loadIndicatorLibrary } from "../window/chart/indicators/registry";
import type { AppTabs } from "../window/shell/app-tabs";
import type { DrawingStore } from "../window/drawings/drawing-store";
import type { PaneChart } from "../window/shell/tabs";

/** What App hands the report: the tabs and the drawings. */
export type DiagnosticsHost = {
  tabs: Pick<AppTabs, "activeTab" | "tabs">;
  drawings: Pick<DrawingStore, "drawingKeyFor" | "drawingsFor">;
};

let host: DiagnosticsHost | null = null;
export function setDiagnosticsHost(h: DiagnosticsHost | null): void {
  host = h;
}

export type StudyInfo = { name: string; changed: Record<string, unknown>; hidden?: boolean };
export type ChartInfo = {
  index: number;
  focused: boolean;
  symbol: string;
  interval: string;
  chartType: string;
  session: string;
  source: string;
  bars: number | null;
  studies: StudyInfo[];
  drawings: Record<string, number>;
  compares: string[];
};
export type Diagnostics = {
  app: { version: string; buildDate?: string; desktop: boolean };
  system: SystemInfo | null;
  browser: string;
  window: { width: number; height: number; scaling: number; screenWidth: number; screenHeight: number; zoom: number };
  language: string;
  tabs: { count: number; layout: string; charts: number };
  charts: ChartInfo[];
  replay: { on: boolean; timing?: string; update?: string };
  plugins: { name: string; version: string; provides: string[]; enabled: boolean; connected: boolean }[];
  /** Desktop: the proxy's type only (no server or credentials) and the update state with its error. */
  network?: { proxy: string; update: string };
  errors: LoggedError[];
  at: number;
};

/** Bar Replay's start modes, as its menu names them. */
const TIMING_NAMES: Record<string, string> = { bar: "Select bar", date: "Select date", first: "First available date", random: "Random bar" };

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The plugins serving a symbol's exchange (`MT5:EURUSD`, `NSE:RELIANCE`). */
function sourceOf(symbol: string, plugins: PluginInfo[]): string {
  const exchange = symbol.includes(":") ? symbol.slice(0, symbol.indexOf(":")).toUpperCase() : "";
  if (exchange === "LOCAL") return "imported series (LOCAL)";
  if (isEconomicSymbol(symbol)) return "economic series";
  const plugin = plugins.find(
    (p) => p.enabled && p.manifest.provides.includes("datafeed") && (p.manifest.exchange?.toUpperCase() === exchange || (p.manifest.exchanges ?? []).some((e) => e.toUpperCase() === exchange)),
  );
  if (plugin) return `plugin ${plugin.manifest.name} ${plugin.connectedVersion ?? plugin.manifest.version}${plugin.connected ? "" : " (not connected)"}`;
  return "built-in data";
}

/** The inputs a study has away from their defaults (all of them when the defaults are unknown). */
function changedInputs(id: string, inputs: Record<string, unknown>): Record<string, unknown> {
  const config = getIndicatorEntry(id)?.inputConfig as { id: string; defval?: unknown }[] | undefined;
  if (!config) return inputs;
  const defaults = new Map(config.map((c) => [c.id, c.defval]));
  return Object.fromEntries(Object.entries(inputs).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults.get(k))));
}

function chartInfo(p: PaneChart, index: number, focused: boolean, tabId: string, plugins: PluginInfo[]): ChartInfo {
  const drawings: Record<string, number> = {};
  if (host) for (const d of host.drawings.drawingsFor(host.drawings.drawingKeyFor(p, tabId))) drawings[d.kind] = (drawings[d.kind] ?? 0) + 1;
  return {
    index: index + 1,
    focused,
    symbol: p.symbol,
    interval: p.interval,
    chartType: p.chartType,
    session: p.session,
    source: sourceOf(p.symbol, plugins),
    bars: chartBars(p.symbol, p.interval, p.session)?.length ?? null,
    studies: p.indicators.map((id) => ({
      name: getIndicatorEntry(id)?.name ?? indicatorName(id) ?? id,
      changed: changedInputs(id, (p.indicatorSettings?.[id]?.inputs ?? {}) as Record<string, unknown>),
      ...(p.indicatorSettings?.[id]?.hidden ? { hidden: true } : {}),
    })),
    drawings,
    compares: (p.compare ?? []).map((c) => c.symbol),
  };
}

/** Everything the report holds, read now. */
export async function collectDiagnostics(): Promise<Diagnostics> {
  const desktop = isTauri();
  const [build, system, status] = desktop
    ? await Promise.all([
        commands.appBuildInfo().catch(() => null),
        commands.appSystemInfo().catch(() => null),
        commands.pluginsStatus().catch(() => null),
      ])
    : [null, null, null];
  const proxy = desktop ? await commands.getProxySettings().catch(() => null) : null;
  const update = appUpdateStatus();
  const plugins = status?.plugins ?? [];
  await loadIndicatorLibrary().catch(() => undefined);
  const tab = host?.tabs.activeTab();
  const charts = tab ? tab.panes.map((p, i) => chartInfo(p, i, i === tab.activePane, tab.id, plugins)) : [];
  const on = replayStarted();
  return {
    app: { version: build?.version ?? (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "unknown", buildDate: build?.buildDate, desktop },
    system,
    browser: navigator.userAgent,
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      scaling: Math.round(window.devicePixelRatio * 100),
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      zoom: Math.round(zoom() * 100),
    },
    language: currentLanguage(),
    tabs: { count: host?.tabs.tabs().length ?? 0, layout: tab?.layout ?? "", charts: tab?.panes.length ?? 0 },
    charts,
    replay: on ? { on, timing: TIMING_NAMES[replayTiming()] ?? replayTiming(), update: replayUpdateInterval() } : { on },
    plugins: plugins.map((p) => ({
      name: p.manifest.name,
      version: p.connectedVersion ?? p.manifest.version,
      provides: p.manifest.provides,
      enabled: p.enabled,
      connected: p.connected,
    })),
    ...(desktop
      ? {
          network: {
            proxy: proxy?.enabled && proxy.host?.trim() ? (proxy.protocol ?? "http") : "none",
            update: update.state + (update.state === "error" && update.error ? ` (${update.error.reason}: ${update.error.detail})` : ""),
          },
        }
      : {}),
    errors: recentErrors(),
    at: Date.now(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** dd/mm/yyyy hh:mm:ss, local time. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const isoToDate = (iso: string) => iso.split("-").reverse().join("/");

function studyLine(s: StudyInfo): string {
  const inputs = Object.entries(s.changed).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${s.name}${inputs.length ? ` (${inputs.join(", ")})` : ""}${s.hidden ? " [hidden]" : ""}`;
}

/** The report as Markdown, ready to paste in an issue. */
export function formatDiagnostics(d: Diagnostics): string {
  const lines: string[] = ["### Diagnostic info", ""];
  lines.push(`- App: OpenTrader ${d.app.version}${d.app.buildDate ? ` (built ${isoToDate(d.app.buildDate)})` : ""}, ${d.app.desktop ? "desktop" : "web"}`);
  if (d.system) {
    const s = d.system;
    lines.push(`- System: ${[s.os, s.arch, s.cpu && `${s.cpu} (${s.threads} threads)`, s.memoryGb && `${s.memoryGb} GB RAM`, s.webview && `web view ${s.webview}`].filter(Boolean).join(", ")}`);
  } else {
    lines.push(`- Browser: ${d.browser}`);
  }
  const w = d.window;
  lines.push(`- Window: ${w.width}×${w.height} at ${w.scaling}% scaling (screen ${w.screenWidth}×${w.screenHeight}), app zoom ${w.zoom}%, language ${d.language}`);
  lines.push(`- Tabs: ${d.tabs.count} open; this tab: layout ${d.tabs.layout}, ${d.tabs.charts} chart${d.tabs.charts === 1 ? "" : "s"}`);
  for (const c of d.charts) {
    const drawings = Object.entries(c.drawings).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    lines.push(
      `- Chart ${c.index}${c.focused ? " (focused)" : ""}: ${c.symbol}, ${c.interval}, ${c.chartType}, ${c.session} session, ${c.source}, ` +
        `${c.bars === null ? "bars not loaded" : `${c.bars} bars loaded`}${drawings.length ? `, drawings: ${drawings.join(", ")}` : ""}`,
    );
    if (c.compares.length) lines.push(`  - Compared: ${c.compares.join(", ")}`);
    if (c.studies.length) lines.push(`  - Studies: ${c.studies.map(studyLine).join("; ")}`);
  }
  lines.push(`- Bar Replay: ${d.replay.on ? `on (start: ${d.replay.timing}, update interval ${d.replay.update || "auto"})` : "off"}`);
  if (d.app.desktop) {
    lines.push(
      `- Plugins: ${
        d.plugins.length
          ? d.plugins.map((p) => `${p.name} ${p.version} (${p.provides.join(", ")}; ${!p.enabled ? "disabled" : p.connected ? "connected" : "not connected"})`).join("; ")
          : "none"
      }`,
    );
  }
  if (d.network) lines.push(`- Proxy: ${d.network.proxy}; app update: ${d.network.update.replace(/\n/g, " ")}`);
  if (d.errors.length) {
    lines.push(`- Recent errors (oldest first):`);
    for (const e of d.errors) lines.push(`  - ${stamp(e.at)} ${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}: ${e.text.replace(/\n/g, " ")}`);
  } else {
    lines.push("- Recent errors: none");
  }
  lines.push(`- Taken: ${stamp(d.at)}`);
  return lines.join("\n");
}

/** The report, read now, as Markdown. */
export async function diagnosticsText(): Promise<string> {
  return formatDiagnostics(await collectDiagnostics());
}
