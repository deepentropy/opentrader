/*
 * Bar Replay: the state shared by the header button, the replay toolbar and
 * the charts (one replay per tab).
 *
 * The reference app runs replay on its servers (a session that steps a cursor
 * over the bars); here every chart pane replays its own loaded bars and
 * registers a handle, and this module is the cursor: it picks the start point,
 * steps all the panes in replay to the next update time, plays on a timer and
 * stops at the end of the data.
 *
 * States: off (no toolbar) → open (toolbar, no point) → selecting (the chart
 * picks a bar) → paused / playing (charts cut at the replay time).
 */
import { createSignal, untrack } from "solid-js";
import * as kv from "./kv";
import { oneOf, persisted } from "./persisted";
import { intervalSeconds, isDailyInterval, parseInterval } from "./interval";
import type { WallDate, WallTime } from "../window/chart/day-key";

/** Which charts a replay covers (the header "Replay mode" menu). */
export type ReplayMode = "ActiveChart" | "AllCharts";
/** How the start point is picked (the toolbar split button). */
export type TimingMode = "bar" | "date" | "first" | "random";

/** Autoplay speeds: label, delay between updates (ms), menu description. */
export const REPLAY_SPEEDS: readonly { label: string; delay: number; desc: string }[] = [
  { label: "10x", delay: 100, desc: "10 upd per 1 sec" },
  { label: "7x", delay: 143, desc: "7 upd per 1 sec" },
  { label: "5x", delay: 200, desc: "5 upd per 1 sec" },
  { label: "3x", delay: 300, desc: "3 upd per 1 sec" },
  { label: "1x", delay: 1000, desc: "1 upd per 1 sec" },
  { label: "0.5x", delay: 2000, desc: "1 upd per 2 sec" },
  { label: "0.3x", delay: 3000, desc: "1 upd per 3 sec" },
  { label: "0.2x", delay: 5000, desc: "1 upd per 5 sec" },
  { label: "0.1x", delay: 10000, desc: "1 upd per 10 sec" },
];
export const DEFAULT_REPLAY_DELAY = 1000;

const MODE_KEY = "ot:replay-mode";
const TIMING_KEY = "ot:replay-timing-mode";
const DELAY_KEY = "ot:replay-delay";

/** Nearest speed of a stored delay (an unknown value clamps to the closest). */
export function clampDelay(ms: number): number {
  let best = DEFAULT_REPLAY_DELAY;
  for (const s of REPLAY_SPEEDS) if (Math.abs(s.delay - ms) < Math.abs(best - ms)) best = s.delay;
  return best;
}

// The last mode, start mode and speed used, in any window: a new tab's replay starts with them.
const [lastMode, saveMode] = persisted<ReplayMode>(MODE_KEY, {
  parse: oneOf("ActiveChart", "AllCharts"),
  format: String,
  default: "ActiveChart",
  sync: true,
});
const [lastTiming, saveTiming] = persisted<TimingMode>(TIMING_KEY, {
  parse: oneOf("bar", "date", "first", "random"),
  format: String,
  default: "bar",
  sync: true,
});
const [lastDelay, saveDelay] = persisted<number>(DELAY_KEY, {
  parse: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? clampDelay(n) : undefined;
  },
  format: String,
  default: DEFAULT_REPLAY_DELAY,
  sync: true,
});

// ── Update intervals ─────────────────────────────────────────────────────────

/** Seconds of an interval id (a month counts 30 days, as in the reference app);
 *  NaN for an id that is no interval, so it compares false and is left out. */
const seconds = (id: string): number => intervalSeconds(id) ?? NaN;

/** The unit of an interval id, null when it is no interval. */
const unitOf = (id: string) => parseInterval(id)?.unit ?? null;

/** Candidate update intervals by chart interval kind (the reference app list, without
 *  ticks: the data has no trades). */
function candidatesFor(chart: string): string[] {
  const unit = unitOf(chart);
  if (unit === "second") return ["1S", "5S", "10S", "15S", "30S", "45S"];
  if (unit === "day") return ["60", "120", "180", "240", "1D"];
  if (unit === "week" || unit === "month") return ["1D"];
  const small = ["1S", "1", "3", "5", "10", "15", "30", "45"];
  return seconds(chart) >= 3600 ? [...small, "60", "120", "180", "240"] : small;
}

/** The interval every chart steps on at least (the reference app common divisor):
 *  the chart interval itself, "1D" for a daily, weekly or monthly chart. */
function baseOf(chart: string): string {
  const iv = parseInterval(chart);
  return iv && isDailyInterval(iv) ? "1D" : chart;
}

/** Update intervals offered for the charts in replay (`intervals`, one per
 *  chart, the first being the main one): the candidates of the main chart and
 *  its base interval, each no longer than the base and dividing every chart
 *  interval; ascending. `available(id)` drops those without data at the
 *  replay point. */
export function updateIntervals(intervals: string[], available: (id: string) => boolean = () => true): string[] {
  if (intervals.length === 0) return [];
  const main = intervals[0];
  const base = baseOf(main);
  const baseSec = seconds(base);
  const divides = (id: string) => {
    const s = seconds(id);
    return intervals.every((iv) => {
      const unit = unitOf(iv);
      if (unit === "week" || unit === "month") return id === "1D";
      const t = seconds(iv);
      return Number.isFinite(t) && t % s === 0;
    });
  };
  const all = [...new Set([...candidatesFor(main), base])].filter((id) => {
    const s = seconds(id);
    return Number.isFinite(s) && s <= baseSec && divides(id);
  });
  all.sort((a, b) => seconds(a) - seconds(b));
  return all.filter(available);
}

/** The Auto update interval: the coarsest one offered (normally the chart
 *  interval itself), else the chart's base interval. */
export function autoUpdateInterval(list: string[], chart: string): string {
  return list.length > 0 ? list[list.length - 1] : baseOf(chart);
}

/** A fixed update interval no longer offered (the chart interval changed):
 *  the largest offered one shorter than it, else the first. */
export function fallbackUpdateInterval(list: string[], current: string): string | null {
  if (list.includes(current)) return current;
  const cur = seconds(current);
  const shorter = list.filter((id) => seconds(id) < cur);
  return shorter.length > 0 ? shorter[shorter.length - 1] : list[0] ?? null;
}


// ── Pane handles ─────────────────────────────────────────────────────────────

/** Why a chart cannot be replayed (the reference app "Caution!" hints), or null. */
export type ReplayUnavailable = "chartType" | "interval" | "symbol" | null;

/** What a chart pane gives the replay. */
export type ReplayPane = {
  paneId: number;
  /** The tab the pane is on: its replay is that tab's. */
  tab: string;
  /** Chart interval id. */
  interval: () => string;
  /** Why it cannot be replayed now, or null. */
  unavailable: () => ReplayUnavailable;
  /** First time (s) with data on the chart interval, null while unknown. */
  firstAvailable: () => number | null;
  /** Earliest time (s) the data plan serves an interval. */
  depthOf: (interval: string) => number;
  /** Cut the chart at `point` (data after it hidden) on update interval
   *  `update`; false when there is no data at the point. */
  start: (point: number, update: string) => Promise<boolean>;
  /** Time of the next update after the replay time, null at the end of the
   *  data (loads ahead first). */
  next: () => Promise<number | null>;
  /** Show the data up to `time` (inclusive). */
  advanceTo: (time: number) => void;
  /** Back to the live chart. */
  stop: () => void;
  /** Daily, weekly or monthly chart (dates without a time). */
  dateOnly: () => boolean;
  /** A wall-clock date + time (minutes) in the chart's time zone, as UTC
   *  seconds (a date-only chart: the calendar date). */
  wallToTime: (date: WallDate, minutes: number) => number;
  /** UTC seconds as a wall-clock date + time of the chart. */
  timeToWall: (sec: number) => WallTime;
  /** A time inside a trading session of the chart's symbol. */
  inSession: (sec: number) => boolean;
  /** The chart's saved id (layout pane id), symbol and session: what a saved
   *  replay is matched and restored with. */
  uid: () => string | undefined;
  symbol: () => string;
  session: () => string;
};

/** A replay saved to be continued later ("Save this replay", reference app):
 *  the replay time and mode, and per chart its symbol, interval, session and
 *  trading account. */
export type SavedReplay = {
  time: number;
  mode: ReplayMode;
  charts: { uid: string; symbol: string; interval: string; session: string; trading?: unknown }[];
};

/** Where the saved replay of a tab is kept (App: on the tab), and how the
 *  shown tab's charts get their symbol, interval and session back (the first
 *  becomes the focused chart). */
export type ReplaySessionStore = {
  load: (tab: string) => SavedReplay | null;
  save: (tab: string, s: SavedReplay | null) => void;
  restoreCharts: (s: SavedReplay) => void;
};
let sessionStore: ReplaySessionStore | null = null;
export function setReplaySessionStore(store: ReplaySessionStore | null) {
  sessionStore = store;
}

/** The trading account of a chart, saved and put back with the replay
 *  (data/trading/replay-broker.ts). */
let tradingSave: { snapshot: (paneId: number) => unknown; restore: (paneId: number, snap: unknown) => void } | null = null;
export function setReplayTradingSave(hooks: typeof tradingSave) {
  tradingSave = hooks;
}

/** Replay trading starts over on the charts of a tab: a new start point, the
 *  replay starting or stopping, and (`closed`) the toolbar closed. */
let resetHook: ((paneIds: number[], closed: boolean) => void) | null = null;
export function setReplayResetHook(fn: typeof resetHook) {
  resetHook = fn;
}

// ── First-use hints (reference app) ─────────────────────────────────────────
const HIGHLIGHT_KEY = "ot:replay-highlight-counter";
const JUMP_HINT_KEY = "ot:replay-jump-hint-closed";

/** The toolbar is highlighted the first 3 times it opens; a click on it ends
 *  that. Returns whether this opening is highlighted (counted). */
export function takeReplayToolbarHighlight(): boolean {
  const n = Number(kv.getItem(HIGHLIGHT_KEY)) || 0;
  if (n >= 3) return false;
  kv.setItem(HIGHLIGHT_KEY, String(n + 1));
  return true;
}
export function stopReplayToolbarHighlight() {
  if ((Number(kv.getItem(HIGHLIGHT_KEY)) || 0) < 3) kv.setItem(HIGHLIGHT_KEY, "4");
}

// Closed in one window: closed in all (stored "true").
const [jumpHintClosed, setJumpHintClosed] = persisted(JUMP_HINT_KEY, { parse: (raw) => raw === "true", default: false, sync: true });
/** "Click to select the starting point." while a bar is picked, until it is
 *  closed once. */
export const replayJumpHintShown = () => cur().selecting() && !jumpHintClosed();
export function closeReplayJumpHint() {
  setJumpHintClosed(true);
}

const SAVE_SESSION_KEY = "ot:replay-save-session";
/** "Save this replay" (leave dialog), on by default; stored "true" / "false". */
export const [replaySaveSession, setReplaySaveSession] = persisted(SAVE_SESSION_KEY, {
  parse: (raw) => raw !== "false",
  default: true,
  sync: true,
});

// ── Sessions: one replay per tab ─────────────────────────────────────────────
// The reference app runs each tab as its own page, so each has its own
// replay: turning it on, the start point and playback stay on their tab, and
// a tab left while playing keeps playing. The header button, the toolbar and
// the dialogs act on the shown tab's.

function createSession(tab: string) {
  const [enabled, setEnabled] = createSignal(false);
  const [selecting, setSelecting] = createSignal(false);
  const [playing, setPlaying] = createSignal(false);
  /** Panes cut at the replay time (empty = not started). */
  const [inReplay, setInReplay] = createSignal<number[]>([]);
  /** Replay time (s): the data shown ends at it. */
  const [point, setPoint] = createSignal<number | null>(null);
  // Mode, start mode and speed: a new tab's replay starts with the last ones used.
  const [mode, setMode] = createSignal<ReplayMode>(untrack(lastMode));
  const [timing, setTiming] = createSignal<TimingMode>(untrack(lastTiming));
  const [delay, setDelay] = createSignal<number>(untrack(lastDelay));
  /** Fixed update interval; null = Auto. */
  const [fixedUpdate, setFixedUpdate] = createSignal<string | null>(null);
  const [dateDialog, setDateDialog] = createSignal(false);
  /** The focused chart pane of the tab (the charts keep it current). */
  const [activePane, setActivePane] = createSignal<number | null>(null);
  /** Time under the pointer while selecting (All charts: every chart draws it). */
  const [hoverTime, setHoverTime] = createSignal<number | null>(null);
  /** Bumped when the data a pane in replay can serve changed (interval list). */
  const [epoch, setEpoch] = createSignal(0);
  /** The session ended with trades (end of the data, or Jump to real-time): the
   *  bars stay, trading stops; Play / Forward / Jump go back to real time. */
  const [finished, setFinished] = createSignal(false);
  /** Charts a start point could not be replayed on: no data that far back
   *  (the reference app's "too far away" Caution hint). Cleared by the next
   *  start point and when the replay stops. */
  const [tooDeep, setTooDeep] = createSignal<number[]>([]);
  /** Bumped when a new start point is taken (replay trading starts over). */
  const [startSeq, setStartSeq] = createSignal(0);
  return {
    tab,
    enabled, setEnabled, selecting, setSelecting, playing, setPlaying, inReplay, setInReplay, point, setPoint,
    mode, setMode, timing, setTiming, delay, setDelay, fixedUpdate, setFixedUpdate, dateDialog, setDateDialog,
    activePane, setActivePane, hoverTime, setHoverTime, epoch, setEpoch, finished, setFinished,
    tooDeep, setTooDeep, startSeq, setStartSeq,
    timer: undefined as number | undefined,
    stepping: false,
  };
}
type Session = ReturnType<typeof createSession>;

const sessions = new Map<string, Session>();
function sessionOf(tab: string): Session {
  let s = sessions.get(tab);
  if (!s) {
    s = createSession(tab);
    sessions.set(tab, s);
  }
  return s;
}

const [tabSource, setTabSource] = createSignal<() => string>(() => "");
/** The shown tab's id (App). */
export function setReplayTabSource(fn: () => string) {
  setTabSource(() => fn);
}
/** The shown tab's replay. */
const cur = () => sessionOf(tabSource()());

const panes = new Map<number, ReplayPane>();
const paneSession = (paneId: number): Session | null => {
  const p = panes.get(paneId);
  return p ? sessionOf(p.tab) : null;
};
const tabPaneIds = (s: Session) => [...panes.values()].filter((p) => p.tab === s.tab).map((p) => p.paneId);

/** Set the panes in replay; replay trading starts over when the replay starts
 *  or stops. */
function setPanesInReplay(s: Session, ids: number[]) {
  const was = s.inReplay().length > 0;
  s.setInReplay(ids);
  if (was !== ids.length > 0) resetHook?.(tabPaneIds(s), false);
}

/** Register a chart pane; returns the unregister function. */
export function registerReplayPane(p: ReplayPane): () => void {
  panes.set(p.paneId, p);
  return () => {
    const s = sessionOf(p.tab);
    panes.delete(p.paneId);
    if (!s.inReplay().includes(p.paneId)) return;
    const rest = s.inReplay().filter((id) => id !== p.paneId);
    setPanesInReplay(s, rest);
    if (rest.length === 0) {
      setPlay(s, false);
      s.setPoint(null);
    }
  };
}

/** The replay of a tab, as its charts read it. */
export type TabReplay = {
  enabled: () => boolean;
  playing: () => boolean;
  selecting: () => boolean;
  mode: () => ReplayMode;
  point: () => number | null;
  hoverTime: () => number | null;
  setHoverTime: (t: number | null) => void;
};
export function replayOfTab(tab: string): TabReplay {
  const s = sessionOf(tab);
  return { enabled: s.enabled, playing: s.playing, selecting: s.selecting, mode: s.mode, point: s.point, hoverTime: s.hoverTime, setHoverTime: s.setHoverTime };
}

// ── The shown tab's replay ───────────────────────────────────────────────────

export const replayEnabled = () => cur().enabled();
export const replaySelecting = () => cur().selecting();
export const replayPlaying = () => cur().playing();
export const replayPanes = () => cur().inReplay();
export const replayPoint = () => cur().point();
export const replayMode = () => cur().mode();
export const replayTiming = () => cur().timing();
export const replayDelay = () => cur().delay();
export const replayFixedUpdate = () => cur().fixedUpdate();
export const replayDateDialog = () => cur().dateDialog();
export const replayActivePane = () => cur().activePane();
export const replayEpoch = () => cur().epoch();
export const replayFinished = () => cur().finished();
export const replayStartSeq = () => cur().startSeq();
/** The focused chart of the pane's tab is this pane. */
export const setReplayActivePane = (paneId: number) => paneSession(paneId)?.setActivePane(paneId);
/** The replay point is older than the data of this chart. */
export const isPaneTooDeep = (paneId: number) => paneSession(paneId)?.tooDeep().includes(paneId) ?? false;
/** The data a pane can serve changed (the update interval list of its tab). */
export const bumpReplayEpoch = (paneId: number) => paneSession(paneId)?.setEpoch((n) => n + 1);

/** Handle of the focused chart (the Select date dialog reads its time zone). */
export function activeReplayPane(): ReplayPane | null {
  const a = cur().activePane();
  return a === null ? null : panes.get(a) ?? null;
}

/** The toolbar shows while replay is on and the focused chart can be
 *  replayed (a Renko chart hides it; replay mode stays on). */
export function replayToolbarShown(): boolean {
  if (!cur().enabled()) return false;
  cur().epoch();
  const p = activeReplayPane();
  return !p || p.unavailable() === null;
}

/** The replay has a point (charts cut). */
export const replayStarted = () => cur().inReplay().length > 0;
/** A pane is cut at the replay time. */
export const isPaneInReplay = (paneId: number) => paneSession(paneId)?.inReplay().includes(paneId) ?? false;
/** The focused chart is in replay (Play / Forward / Jump are enabled). */
export const activeInReplay = () => {
  const s = cur();
  const a = s.activePane();
  return a !== null && s.inReplay().includes(a);
};

const started = (s: Session) => s.inReplay().length > 0;

/** Panes a new replay covers: the focused chart (Single chart), or every
 *  chart of the tab that can be replayed (All charts). */
function targetPanes(s: Session, clickedPane?: number): ReplayPane[] {
  const ok = (p: ReplayPane | undefined): p is ReplayPane => !!p && p.tab === s.tab && p.unavailable() === null;
  if (s.mode() === "AllCharts") return [...panes.values()].filter(ok);
  const id = clickedPane ?? s.activePane();
  const p = id !== null && id !== undefined ? panes.get(id) : undefined;
  return ok(p) ? [p] : [];
}

/** Charts the update interval list is built from: the panes in replay, else
 *  the ones a replay would cover. */
function intervalPanes(s: Session): ReplayPane[] {
  const ids = s.inReplay();
  if (ids.length > 0) return ids.map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
  return targetPanes(s);
}

/** Update intervals offered now (the menu rows). */
export function replayUpdateIntervals(): string[] {
  const s = cur();
  s.epoch();
  const ps = intervalPanes(s);
  if (ps.length === 0) return [];
  const pt = s.point();
  const depth = (id: string) => Math.max(...ps.map((p) => p.depthOf(id)));
  return updateIntervals(
    ps.map((p) => p.interval()),
    (id) => pt === null || depth(id) <= pt,
  );
}

/** Update interval in use: the fixed one when still offered, else Auto. */
export function replayUpdateInterval(): string {
  const s = cur();
  const list = replayUpdateIntervals();
  const main = intervalPanes(s)[0]?.interval() ?? "1D";
  const fixed = s.fixedUpdate();
  if (fixed !== null) {
    const f = fallbackUpdateInterval(list, fixed);
    if (f !== null) return f;
  }
  return autoUpdateInterval(list, main);
}

/** Earliest time a replay can start on (the reference app depth): the latest first
 *  available time of the charts it covers, null while unknown. */
function firstAvailableOf(s: Session): number | null {
  s.epoch();
  const ps = intervalPanes(s);
  if (ps.length === 0) return null;
  let out = -Infinity;
  for (const p of ps) {
    const f = p.firstAvailable();
    if (f === null) return null;
    out = Math.max(out, f, p.depthOf(p.interval()));
  }
  return Number.isFinite(out) ? out : null;
}
export const replayFirstAvailable = () => firstAvailableOf(cur());

// ── Saved replay ─────────────────────────────────────────────────────────────

/** Save the running replay when "Save this replay" is on, else forget the
 *  saved one (on leave and on Jump to real-time, reference app). */
function saveSession(s: Session) {
  if (!sessionStore) return;
  const pt = s.point();
  if (!replaySaveSession() || pt === null || !started(s) || s.finished()) {
    sessionStore.save(s.tab, null);
    return;
  }
  const charts: SavedReplay["charts"] = [];
  for (const id of s.inReplay()) {
    const p = panes.get(id);
    const uid = p?.uid();
    if (!p || !uid) continue;
    charts.push({ uid, symbol: p.symbol(), interval: p.interval(), session: p.session(), trading: tradingSave?.snapshot(id) ?? undefined });
  }
  sessionStore.save(s.tab, charts.length ? { time: pt, mode: s.mode(), charts } : null);
}
export const saveReplaySession = () => saveSession(cur());

/** The saved replay of the shown tab when one of its charts is on screen. */
export function savedReplay(): SavedReplay | null {
  const tab = cur().tab;
  const s = sessionStore?.load(tab) ?? null;
  if (!s) return null;
  const shown = [...panes.values()].filter((p) => p.tab === tab).map((p) => p.uid());
  return s.charts.some((c) => shown.includes(c.uid)) ? s : null;
}

export function forgetSavedReplay() {
  sessionStore?.save(cur().tab, null);
}

/** "Continue": the mode, each chart's symbol / interval / session, then the
 *  replay time and the trading accounts. */
export async function continueSavedReplay(saved: SavedReplay): Promise<void> {
  const s = cur();
  setMode(s, saved.mode);
  s.setEnabled(true);
  s.setSelecting(false);
  sessionStore?.restoreCharts(saved);
  // The charts load their symbol / interval first.
  const byUid = () => new Map([...panes.values()].filter((p) => p.tab === s.tab).map((p) => [p.uid(), p] as const));
  const ready = () =>
    saved.charts.every((c) => {
      const p = byUid().get(c.uid);
      return !p || (p.symbol() === c.symbol && p.interval() === c.interval && p.firstAvailable() !== null);
    });
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  const first = byUid().get(saved.charts[0].uid);
  if (first && saved.mode === "ActiveChart") s.setActivePane(first.paneId);
  await startAt(s, saved.time, saved.mode === "ActiveChart" ? first?.paneId : undefined);
  for (const c of saved.charts) {
    const p = byUid().get(c.uid);
    if (p && c.trading && s.inReplay().includes(p.paneId)) tradingSave?.restore(p.paneId, c.trading);
  }
  sessionStore?.save(s.tab, null);
}

// ── Autoplay ─────────────────────────────────────────────────────────────────

function stopTimer(s: Session) {
  if (s.timer !== undefined) window.clearInterval(s.timer);
  s.timer = undefined;
}
function startTimer(s: Session) {
  stopTimer(s);
  s.timer = window.setInterval(() => {
    if (!s.stepping) void stepSession(s);
  }, s.delay());
}

/** One update on every pane in replay: the earliest next update time across
 *  them; at the end of the data the replay stops (charts back to real time,
 *  toolbar kept). */
async function stepSession(s: Session): Promise<void> {
  if (s.finished()) {
    stopSession(s);
    return;
  }
  if (!started(s) || s.stepping) return;
  s.stepping = true;
  try {
    const ps = s.inReplay().map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
    const times = await Promise.all(ps.map((p) => p.next()));
    if (!started(s)) return;
    const valid = times.filter((t): t is number => t !== null);
    if (valid.length === 0) {
      jumpSession(s);
      return;
    }
    const t = Math.min(...valid);
    for (const p of ps) p.advanceTo(t);
    s.setPoint(t);
  } finally {
    s.stepping = false;
  }
}
export const step = () => stepSession(cur());

function setPlay(s: Session, on: boolean) {
  if (on && s.finished()) {
    stopSession(s);
    return;
  }
  if (on && !started(s)) return;
  s.setPlaying(on);
  if (on) startTimer(s);
  else stopTimer(s);
}

/** Play / Pause (Shift+↓): a selection in progress is cancelled first. */
export function togglePlay() {
  const s = cur();
  if (s.finished()) {
    stopSession(s);
    return;
  }
  if (!started(s)) return;
  if (s.selecting()) s.setSelecting(false);
  setPlay(s, !s.playing());
}

export function setReplayDelay(ms: number) {
  const s = cur();
  const d = clampDelay(ms);
  s.setDelay(d);
  saveDelay(d);
  // Playing: restart at the new speed.
  if (s.playing()) startTimer(s);
}

export function setReplayUpdateInterval(id: string | null) {
  const s = cur();
  s.setFixedUpdate(id);
  restartPanes(s);
}

// ── Start point ──────────────────────────────────────────────────────────────

/** Cut the panes at `pt` (seconds; the data shown ends at it). */
async function startAt(s: Session, pt: number, clickedPane?: number): Promise<void> {
  setPlay(s, false);
  s.setSelecting(false);
  s.setFinished(false);
  s.setStartSeq((n) => n + 1);
  resetHook?.(tabPaneIds(s), false);
  // Single chart: a replay on another chart moves to this one.
  const targets = targetPanes(s, clickedPane);
  for (const id of s.inReplay()) if (!targets.some((p) => p.paneId === id)) panes.get(id)?.stop();
  if (targets.length === 0) {
    setPanesInReplay(s, []);
    s.setPoint(null);
    return;
  }
  if (clickedPane !== undefined && s.mode() === "ActiveChart") s.setActivePane(clickedPane);
  s.setPoint(pt);
  // The update interval list depends on the replay point.
  s.setEpoch((n) => n + 1);
  const update = updateIntervalFor(s, targets, pt);
  const ok = await Promise.all(targets.map((p) => p.start(pt, update)));
  const ran = targets.filter((_, i) => ok[i]);
  for (const p of targets) if (!ran.includes(p)) p.stop();
  s.setTooDeep(targets.filter((p) => !ran.includes(p) && p.unavailable() === null).map((p) => p.paneId));
  setPanesInReplay(s, ran.map((p) => p.paneId));
  if (ran.length === 0) s.setPoint(null);
}

function updateIntervalFor(s: Session, ps: ReplayPane[], pt: number): string {
  const depth = (id: string) => Math.max(...ps.map((p) => p.depthOf(id)));
  const list = updateIntervals(ps.map((p) => p.interval()), (id) => depth(id) <= pt);
  const fixed = s.fixedUpdate();
  if (fixed !== null) {
    const f = fallbackUpdateInterval(list, fixed);
    if (f !== null) return f;
  }
  return autoUpdateInterval(list, ps[0].interval());
}

/** Re-cut the panes in replay at the current point (update interval or
 *  chart data changed). Autoplay resumes after. */
function restartPanes(s: Session) {
  const pt = s.point();
  if (pt === null || !started(s)) return;
  const wasPlaying = s.playing();
  setPlay(s, false);
  const ps = s.inReplay().map((id) => panes.get(id)).filter((p): p is ReplayPane => !!p);
  const update = updateIntervalFor(s, ps, pt);
  void Promise.all(ps.map((p) => p.start(pt, update))).then(() => {
    if (wasPlaying && started(s)) setPlay(s, true);
  });
}

/** A chart in replay loaded new data (interval, symbol, session, reload):
 *  it continues at the same replay time. */
export function replayPaneReloaded(paneId: number) {
  const s = paneSession(paneId);
  const p = panes.get(paneId);
  const pt = s?.point() ?? null;
  if (!s || pt === null || !p || !s.inReplay().includes(paneId)) return;
  s.setEpoch((n) => n + 1);
  const update = updateIntervalFor(s, [p], pt);
  void p.start(pt, update).then((ok) => {
    if (!ok) {
      if (p.unavailable() === null) s.setTooDeep((l) => (l.includes(paneId) ? l : [...l, paneId]));
      leavePane(paneId);
    }
  });
}

/** A chart leaves the replay (its style can't be replayed, …); the replay
 *  stops when no chart is left. */
export function leavePane(paneId: number) {
  const s = paneSession(paneId);
  if (!s || !s.inReplay().includes(paneId)) return;
  panes.get(paneId)?.stop();
  const rest = s.inReplay().filter((id) => id !== paneId);
  setPanesInReplay(s, rest);
  if (rest.length === 0) {
    setPlay(s, false);
    s.setPoint(null);
  }
}

/** A bar was clicked while selecting: it becomes the first hidden bar. */
export function selectBar(paneId: number, barTime: number) {
  const s = paneSession(paneId);
  if (!s) return;
  const first = firstAvailableOf(s);
  const pt = Math.max(first ?? -Infinity, barTime - 1);
  void startAt(s, pt, paneId);
}

/** A date from the Select date dialog (UTC seconds): the bar opening at it
 *  is the first hidden one. Returns false (and starts at the first available
 *  point) when the date is older than the data. */
export function selectDate(sec: number): boolean {
  const s = cur();
  const first = firstAvailableOf(s);
  const early = first !== null && sec - 1 < first;
  void startAt(s, early ? first! : sec - 1);
  return !early;
}

export function selectFirstAvailable() {
  const s = cur();
  const first = firstAvailableOf(s);
  if (first !== null) void startAt(s, first);
}

/** A random time between the first available point and now (up to 10 draws
 *  to land in a session: `inSession`). */
export function selectRandom(inSession: (sec: number) => boolean = () => true) {
  const s = cur();
  const first = firstAvailableOf(s);
  if (first === null) return;
  const now = Date.now() / 1000;
  let t = first;
  for (let i = 0; i < 10; i++) {
    t = first + Math.round((now - first) * Math.random());
    if (inSession(t)) break;
  }
  void startAt(s, t);
}

// ── Toolbar / header actions ─────────────────────────────────────────────────

export function setTimingMode(m: TimingMode) {
  cur().setTiming(m);
  saveTiming(m);
}

/** Run the start-point action of the current timing mode. */
export function runTimingMode() {
  const s = cur();
  switch (s.timing()) {
    case "bar":
      toggleSelect();
      break;
    case "date":
      s.setSelecting(false);
      s.setDateDialog(true);
      break;
    case "first":
      s.setSelecting(false);
      selectFirstAvailable();
      break;
    case "random": {
      s.setSelecting(false);
      const p = activeReplayPane();
      selectRandom(p ? p.inSession : undefined);
      break;
    }
  }
}

/** "Select bar": start / cancel the bar selection (autoplay stops). */
export function toggleSelect() {
  const s = cur();
  if (s.selecting()) {
    s.setSelecting(false);
    return;
  }
  setPlay(s, false);
  s.setSelecting(true);
}

export function cancelSelect() {
  const s = cur();
  s.setSelecting(false);
  s.setHoverTime(null);
}

export function closeDateDialog() {
  cur().setDateDialog(false);
}

/** Header button: open the toolbar and run the start mode (Bar: select a
 *  bar; Date: the dialog; First / Random wait for a click). */
export function openReplay() {
  const s = cur();
  if (s.enabled()) return;
  s.setEnabled(true);
  if (targetPanes(s).length === 0) return;
  if (s.timing() === "bar") s.setSelecting(true);
  else if (s.timing() === "date") s.setDateDialog(true);
}

/** Open the toolbar and start at `sec` on the active chart (trade journal
 *  "Replay from entry"): no bar selection, no date dialog. */
export function startReplayAt(sec: number) {
  const s = cur();
  s.setEnabled(true);
  s.setSelecting(false);
  s.setDateDialog(false);
  selectDate(sec);
}

/** What replay trading does at the end of a session (see jumpToRealtime):
 *  true when it had trades on the given charts. */
let finishHook: ((paneIds: number[]) => boolean) | null = null;
export function setReplayFinishHook(fn: typeof finishHook) {
  finishHook = fn;
}

/** Jump to real-time chart (and the end of the data): a session with trades
 *  ends (positions closed, results shown) and the bars stay; otherwise the
 *  charts go back to live data. Again once ended: back to live data. */
function jumpSession(s: Session) {
  if (s.finished() || !started(s)) {
    stopSession(s);
    return;
  }
  // Saved first (reference app: on Jump to real-time too).
  saveSession(s);
  if (finishHook?.(s.inReplay())) {
    setPlay(s, false);
    s.setFinished(true);
    return;
  }
  stopSession(s);
}
export const jumpToRealtime = () => jumpSession(cur());

/** The charts go back to live data, the toolbar stays. */
function stopSession(s: Session) {
  s.setFinished(false);
  s.setTooDeep([]);
  setPlay(s, false);
  for (const id of s.inReplay()) panes.get(id)?.stop();
  setPanesInReplay(s, []);
  s.setPoint(null);
  s.setEpoch((n) => n + 1);
}
export const stopReplay = () => stopSession(cur());

/** Close the toolbar (Exit Bar Replay / header button). */
export function closeReplay() {
  const s = cur();
  stopSession(s);
  s.setSelecting(false);
  s.setDateDialog(false);
  s.setHoverTime(null);
  s.setFixedUpdate(null);
  s.setEnabled(false);
  resetHook?.(tabPaneIds(s), true);
}

function setMode(s: Session, m: ReplayMode) {
  s.setMode(m);
  saveMode(m);
}
export const setReplayMode = (m: ReplayMode) => setMode(cur(), m);
