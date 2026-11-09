import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  onExternalChange: () => () => undefined,
}));
// The autoplay timer is the window's.
vi.stubGlobal("window", globalThis);
import { createSignal } from "solid-js";
import {
  closeReplay,
  isPaneInReplay,
  openReplay,
  registerReplayPane,
  replayEnabled,
  replayOfTab,
  replayPlaying,
  replayPoint,
  replaySelecting,
  selectBar,
  setReplayActivePane,
  setReplayResetHook,
  setReplayTabSource,
  togglePlay,
  type ReplayPane,
} from "../replay";

const DAY = 86400;
const T0 = 1_700_000_000;

/** A chart whose bars are one day apart. */
function pane(paneId: number, tab: string): ReplayPane & { cut: number | null } {
  const p: ReplayPane & { cut: number | null } = {
    paneId,
    tab,
    cut: null,
    interval: () => "1D",
    unavailable: () => null,
    firstAvailable: () => 0,
    depthOf: () => 0,
    start: async (pt) => {
      p.cut = pt;
      return true;
    },
    next: async () => (p.cut === null ? null : p.cut + DAY),
    advanceTo: (t) => {
      p.cut = t;
    },
    stop: () => {
      p.cut = null;
    },
    dateOnly: () => true,
    wallToTime: () => 0,
    timeToWall: () => ({ y: 2024, m: 0, d: 1, minutes: 0 }),
    inSession: () => true,
    uid: () => `uid-${paneId}`,
    symbol: () => "AAA",
    session: () => "RTH",
  };
  return p;
}

const [tab, setTab] = createSignal("A");
setReplayTabSource(tab);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Bar Replay per tab", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const t of ["A", "B"]) {
      setTab(t);
      closeReplay();
    }
    setReplayResetHook(null);
    while (cleanups.length) cleanups.pop()!();
    vi.useRealTimers();
    setTab("A");
  });

  const setup = () => {
    const a = pane(1, "A");
    const b = pane(2, "B");
    cleanups.push(registerReplayPane(a), registerReplayPane(b));
    setReplayActivePane(1);
    setReplayActivePane(2);
    return { a, b };
  };

  it("turning replay on in one tab leaves the other tab off", async () => {
    setup();
    setTab("A");
    openReplay();
    expect(replayEnabled()).toBe(true);
    expect(replaySelecting()).toBe(true);
    setTab("B");
    expect(replayEnabled()).toBe(false);
    expect(replaySelecting()).toBe(false);
    setTab("A");
    expect(replayEnabled()).toBe(true);
  });

  it("each tab keeps its own start point and charts in replay", async () => {
    const { a, b } = setup();
    setTab("A");
    openReplay();
    selectBar(1, T0);
    await flush();
    setTab("B");
    openReplay();
    selectBar(2, T0 + 10 * DAY);
    await flush();
    expect(a.cut).toBe(T0 - 1);
    expect(b.cut).toBe(T0 + 10 * DAY - 1);
    expect(isPaneInReplay(1) && isPaneInReplay(2)).toBe(true);
    expect(replayPoint()).toBe(T0 + 10 * DAY - 1);
    setTab("A");
    expect(replayPoint()).toBe(T0 - 1);
    // Closing tab A's replay leaves tab B's running.
    closeReplay();
    expect(a.cut).toBeNull();
    expect(isPaneInReplay(1)).toBe(false);
    expect(isPaneInReplay(2)).toBe(true);
    expect(replayOfTab("B").point()).toBe(T0 + 10 * DAY - 1);
  });

  it("play / pause act on the shown tab only, and a tab left while playing keeps playing", async () => {
    vi.useFakeTimers();
    const { a, b } = setup();
    setTab("A");
    openReplay();
    selectBar(1, T0);
    await vi.advanceTimersByTimeAsync(0);
    setTab("B");
    openReplay();
    selectBar(2, T0);
    await vi.advanceTimersByTimeAsync(0);
    setTab("A");
    togglePlay();
    expect(replayPlaying()).toBe(true);
    setTab("B");
    expect(replayPlaying()).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    // Tab A stepped while hidden; tab B stayed paused.
    expect(a.cut).toBeGreaterThan(T0);
    expect(b.cut).toBe(T0 - 1);
    expect(replayOfTab("A").playing()).toBe(true);
  });

  it("replay trading starts over on the charts of the tab that changed only", async () => {
    const resets: number[][] = [];
    setReplayResetHook((ids) => resets.push(ids));
    setup();
    setTab("B");
    openReplay();
    selectBar(2, T0);
    await flush();
    expect(resets.length).toBeGreaterThan(0);
    expect(resets.every((ids) => ids.length === 1 && ids[0] === 2)).toBe(true);
  });
});
