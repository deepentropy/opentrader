/*
 * The server clock (#422): the time of the servers the data comes from, which the app keeps
 * (src-tauri/crates/core/src/clock.rs), so a computer whose clock is wrong still shows the right countdown, market
 * status and session day. Read serverNow() wherever the market's time is meant; Date.now() stays for what is about
 * this computer (timers, caches, how long ago something happened here).
 *
 * The window measures its own offset from the app's reading and the round trip: in the web build the app is a server
 * on another computer. Between readings it runs on performance.now(), so a change of the computer's clock does not
 * move it. Without a server time (no answer yet, none given), it is the computer's clock.
 */
import { commands, events } from "../bindings";

/** Server milliseconds minus performance.now(); null: the computer's clock. */
let base: number | null = null;
let started = false;

/** How often the window reads the app's clock again (the app tells the desktop window of a change at once). */
const RESYNC_MS = 10 * 60_000;

/** The server time, UNIX milliseconds. */
export function serverNow(): number {
  start();
  return base === null ? Date.now() : base + performance.now();
}

/** The server time, UNIX seconds (with fractions). */
export function serverNowSec(): number {
  return serverNow() / 1000;
}

/** How far the computer's clock is behind the server's, in milliseconds (0 without a server time). */
export function serverClockOffset(): number {
  return base === null ? 0 : Math.round(base + performance.now() - Date.now());
}

/** The base a reading `now` (server ms, `source` null: none) gives, asked at `sent` and answered at `came`
 *  (performance.now()): the server's time is taken at the middle of the round trip. */
export function baseOf(now: number | null, source: string | null, sent: number, came: number): number | null {
  return source === null || now === null || !Number.isFinite(now) ? null : now + (came - sent) / 2 - came;
}

async function sync(): Promise<void> {
  try {
    const sent = performance.now();
    const r = await commands.serverClock();
    base = baseOf(r.now, r.source, sent, performance.now());
  } catch {
    // The last reading stands; without one, the computer's clock.
  }
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void sync();
  window.setInterval(() => void sync(), RESYNC_MS);
  if ("__TAURI_INTERNALS__" in window) void events.serverClockChanged.listen(() => void sync());
}
