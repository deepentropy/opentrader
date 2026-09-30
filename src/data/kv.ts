/*
 * kv — a synchronous, localStorage-shaped facade over durable persistence.
 *
 * Why: the app seeds module-level Solid signals/stores from storage at import
 * time (synchronously), but tauri-plugin-store is async. kv bridges the two:
 * hydrateKv() loads the whole store into an in-memory Map once at boot — before
 * App and its module graph import — then getItem/setItem/removeItem run
 * synchronously against that Map while writes flush to the file store in the
 * background (autoSave debounce). This keeps every caller's existing synchronous
 * signal/store init unchanged.
 *
 * Outside the Tauri shell (vite dev / the headless verify harness) there is no
 * store, so the facade delegates straight to window.localStorage — behaviour is
 * identical to the pre-migration code, keeping tests unaffected.
 *
 * Values are JSON strings, exactly like localStorage: callers keep doing their
 * own JSON.parse/stringify and their schema validation/migration is untouched.
 *
 * Out of scope (still on raw localStorage): the per-window-label coordination
 * keys (ot:tabs:*, ot:active-tab:*, ot:detach:*) which rely on synchronous,
 * shared-origin cross-window semantics an async file store would race on — see
 * window-bridge.ts / tabs.ts.
 */

/** Backing file under the app's config dir (e.g. %APPDATA%\<id>\opentrader.json). */
const STORE_FILE = "opentrader.json";
/** Set once the first localStorage→store import has run, so it never repeats. */
const MIGRATED_SENTINEL = "ot:_migrated:v1";
/** Keys that intentionally stay on raw localStorage (window coordination). */
const SKIP_PREFIXES = ["ot:tabs:", "ot:active-tab:", "ot:detach:"];
/** Key prefix used before 0.1.0. Entries still under it are moved to `ot:` at
 *  boot (see renameLegacyLocalStorage / renameLegacyStoreKeys). */
const LEGACY_PREFIX = "tv:";
const PREFIX = "ot:";

/** Minimal structural view of the tauri-plugin-store Store we depend on. */
type StoreLike = {
  entries(): Promise<[string, unknown][]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** App-global Tauri event carrying one key change to every window. We use our
 *  own channel rather than the plugin's `Store.onChange`, which filters by the
 *  emitting Store's `resourceId` and therefore only fires in the SAME window —
 *  no use for cross-window sync. `emit`/`listen` are genuinely app-wide. */
const CHANGE_EVENT = "kv://change";
type ChangePayload = { key: string; value: string | null };

/** External-change subscribers. On any window's write, the writer broadcasts a
 *  CHANGE_EVENT; every window applies it to `mem` and notifies the owner of that
 *  key here, so the owning signal/store re-seeds itself. `raw` is the new JSON
 *  string, or null when the key was removed. */
type ChangeCb = (raw: string | null) => void;
type PrefixCb = (key: string, raw: string | null) => void;
const keySubs = new Map<string, Set<ChangeCb>>();
const prefixSubs = new Map<string, Set<PrefixCb>>();

/** Subscribe to external changes of one exact key. Returns an unsubscribe fn. */
export function onExternalChange(key: string, cb: ChangeCb): () => void {
  let s = keySubs.get(key);
  if (!s) keySubs.set(key, (s = new Set()));
  s.add(cb);
  return () => s!.delete(cb);
}

/** Subscribe to external changes of any key under `prefix` (e.g. per-symbol
 *  drawings, `ot:drawings:`). The callback gets the full key + fresh value. */
export function onExternalChangePrefix(prefix: string, cb: PrefixCb): () => void {
  let s = prefixSubs.get(prefix);
  if (!s) prefixSubs.set(prefix, (s = new Set()));
  s.add(cb);
  return () => s!.delete(cb);
}

function notifyExternal(key: string, raw: string | null): void {
  const exact = keySubs.get(key);
  if (exact) for (const cb of [...exact]) {
    try { cb(raw); } catch (e) { console.error(`[kv] subscriber error for ${key}`, e); }
  }
  for (const [prefix, set] of prefixSubs) {
    if (!key.startsWith(prefix)) continue;
    for (const cb of [...set]) {
      try { cb(key, raw); } catch (e) { console.error(`[kv] prefix subscriber error for ${key}`, e); }
    }
  }
}

/** True inside the Tauri shell (where the store plugin is wired up). Inlined to
 *  keep this module dependency-free so it can load before anything else. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// In-memory mirror of the store, kept in sync so reads stay synchronous.
const mem = new Map<string, string>();
let store: StoreLike | null = null;
// When false the facade delegates straight to localStorage (browser / verify).
let useStore = false;
// Broadcasts a key change to all windows; set at hydrate (Tauri only).
let broadcast: ((payload: ChangePayload) => void) | null = null;

/** Apply an inbound key change from another window (or our own echo). Updates
 *  `mem` and notifies the key's owner. Value-equality against `mem` drops the
 *  echo of our own writes (setItem already updated `mem` before broadcasting),
 *  so only genuine remote changes reach subscribers. The shared (by-path) store
 *  keeps the on-disk file consistent; this only propagates the in-memory view. */
function applyRemoteChange(payload: ChangePayload): void {
  const { key, value } = payload;
  if (key === MIGRATED_SENTINEL) return;
  if (value === null) {
    if (!mem.has(key)) return; // already absent → our own delete echo
    mem.delete(key);
  } else {
    if (mem.get(key) === value) return; // unchanged → our own set echo
    mem.set(key, value);
  }
  notifyExternal(key, value);
}

// ── Write coalescing ────────────────────────────────────────────────────────
// `mem` updates synchronously (reads stay instant), but the durable store write
// and the cross-window broadcast are coalesced behind a short trailing debounce
// so a high-frequency writer (e.g. a panel-resize drag) can't emit per frame to
// every window. FLUSH_MAX_WAIT bounds staleness during a sustained burst, and
// pending writes are flushed on window close so the last value isn't lost.
const FLUSH_DELAY = 120; // ms trailing debounce
const FLUSH_MAX_WAIT = 600; // ms hard cap measured from the first queued write
const pending = new Map<string, string | null>(); // latest value per key; null = delete
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let firstQueuedAt = 0;

function scheduleFlush(): void {
  const now = Date.now();
  if (flushTimer === null) firstQueuedAt = now;
  else clearTimeout(flushTimer);
  const wait = Math.min(FLUSH_DELAY, Math.max(0, FLUSH_MAX_WAIT - (now - firstQueuedAt)));
  flushTimer = setTimeout(flushPending, wait);
}

function flushPending(): Promise<void> {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  const writes: Promise<unknown>[] = [];
  for (const [key, value] of pending) {
    if (value === null) {
      if (store) writes.push(store.delete(key).catch((e) => console.error(`[kv] remove failed for ${key}`, e)));
      broadcast?.({ key, value: null });
    } else {
      if (store) writes.push(store.set(key, value).catch((e) => console.error(`[kv] persist failed for ${key}`, e)));
      broadcast?.({ key, value });
    }
  }
  pending.clear();
  return Promise.all(writes).then(() => undefined);
}

/** Write every pending change to the store now; resolves once the store has
 *  them (before an update install, see data/app-update.ts). */
export function flushKv(): Promise<void> {
  return flushPending();
}

/**
 * One-time boot hydration. In Tauri: open the store file, mirror it into `mem`,
 * and run the one-time localStorage import. Anywhere else: stay on localStorage.
 * Always resolves (a store failure falls back to localStorage rather than
 * blocking the app from rendering).
 */
export async function hydrateKv(): Promise<void> {
  renameLegacyLocalStorage();
  if (!isTauri()) {
    useStore = false;
    return;
  }
  try {
    const { load } = await import("@tauri-apps/plugin-store");
    // autoSave debounces writes to disk so setItem stays non-blocking.
    store = (await load(STORE_FILE, { defaults: {}, autoSave: 300 })) as unknown as StoreLike;
    for (const [k, v] of await store.entries()) {
      if (typeof v === "string") mem.set(k, v);
    }
    useStore = true;
    renameLegacyStoreKeys();
    await migrateFromLocalStorage();
    // Live cross-window sync over an app-global Tauri event (see CHANGE_EVENT).
    const { emit, listen } = await import("@tauri-apps/api/event");
    broadcast = (payload) => void emit(CHANGE_EVENT, payload);
    await listen<ChangePayload>(CHANGE_EVENT, (e) => applyRemoteChange(e.payload));
    // Don't lose a trailing-debounced write if the window closes mid-wait.
    if (typeof window !== "undefined") window.addEventListener("beforeunload", flushPending);
  } catch (e) {
    console.error("[kv] store hydration failed; falling back to localStorage", e);
    useStore = false;
    store = null;
  }
}

/** Move every `tv:*` localStorage entry to `ot:*`. A value already stored under
 *  the new key wins. Runs at every boot; once nothing is left under the legacy
 *  prefix it only scans the keys. */
function renameLegacyLocalStorage(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }
    for (const key of legacy) {
      const next = PREFIX + key.slice(LEGACY_PREFIX.length);
      const val = localStorage.getItem(key);
      if (val != null && localStorage.getItem(next) == null) localStorage.setItem(next, val);
      localStorage.removeItem(key);
    }
  } catch (e) {
    console.error("[kv] localStorage key rename failed", e);
  }
}

/** Move every `tv:*` store entry to `ot:*` (same rule as the localStorage
 *  rename). Runs after the store is mirrored into `mem`, before any read. */
function renameLegacyStoreKeys(): void {
  if (!store) return;
  for (const key of [...mem.keys()]) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    const val = mem.get(key) as string;
    if (!mem.has(next)) {
      mem.set(next, val);
      store.set(next, val).catch((e) => console.error(`[kv] persist failed for ${next}`, e));
    }
    mem.delete(key);
    store.delete(key).catch((e) => console.error(`[kv] remove failed for ${key}`, e));
  }
}

/** Copy existing `ot:*` localStorage state into the store exactly once, so
 *  upgrading users keep their drawings/layouts/alerts/watchlists/prefs. The
 *  window-coordination keys are skipped (they stay on localStorage); old
 *  localStorage entries are left in place as a harmless backup. */
async function migrateFromLocalStorage(): Promise<void> {
  if (!store || mem.has(MIGRATED_SENTINEL)) return;
  try {
    if (typeof localStorage !== "undefined") {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PREFIX)) continue;
        if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;
        if (mem.has(key)) continue; // store already owns a value — store wins
        const val = localStorage.getItem(key);
        if (val == null) continue;
        mem.set(key, val);
        void store.set(key, val);
      }
    }
    mem.set(MIGRATED_SENTINEL, "1");
    void store.set(MIGRATED_SENTINEL, "1");
  } catch (e) {
    console.error("[kv] localStorage migration failed", e);
  }
}

/** Synchronous read — mirrors localStorage.getItem. */
export function getItem(key: string): string | null {
  if (useStore) return mem.has(key) ? (mem.get(key) as string) : null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Synchronous write — mirrors localStorage.setItem; flushes durably in Tauri.
 *  Failures are logged, not silently swallowed (the old `catch {}` hid quota
 *  data-loss; the store has no quota, so a failure here is genuinely abnormal). */
export function setItem(key: string, value: string): void {
  if (useStore) {
    if (mem.get(key) === value) return; // idempotent: skip redundant write + broadcast
    mem.set(key, value); // synchronous: reads see it immediately
    pending.set(key, value); // durable write + broadcast are coalesced (see flushPending)
    scheduleFlush();
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.error(`[kv] persist failed for ${key}`, e);
  }
}

/** Synchronous delete — mirrors localStorage.removeItem. */
export function removeItem(key: string): void {
  if (useStore) {
    if (!mem.has(key)) return; // idempotent: nothing to remove
    mem.delete(key);
    pending.set(key, null); // coalesced delete + broadcast (see flushPending)
    scheduleFlush();
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.error(`[kv] remove failed for ${key}`, e);
  }
}
