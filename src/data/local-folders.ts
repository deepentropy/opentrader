/*
 * Synced folders of CSV files (#267), desktop app only: Settings > Local data.
 * Each folder's bar files are imported series ("LOCAL:<NAME>", see
 * local-series) that follow the files: a sync lists the folder, reads again
 * only the files whose size or modification time changed (a series remembers
 * them in `source`) and leaves the others alone, so an unchanged folder of
 * thousands of files costs one directory listing. One file at a time is read,
 * parsed and stored, with the same reader as the Import CSV dialog.
 *
 * A file's series is the one whose source is that file (so a renamed series
 * keeps following it), else the series named after the file: one imported by
 * hand of that name is taken over, one another file feeds is an error. Series
 * of deleted files stay unless the folder's "remove" option is on.
 *
 * The main window syncs every folder once the app has started, then every few
 * minutes; Settings syncs one on demand.
 */
import { createSignal } from "solid-js";
import { commands, type LocalSeries } from "../bindings";
import { getItem, onExternalChange, setItem } from "./kv";
import { parseSeedSymbolInfo, seriesNameFromFile } from "./local-series-csv";
import { deleteLocalSeries, importLocalSeries, localSeriesChanged } from "./local-series";
import { translate, translateWith } from "../i18n/translator";

/** A file a sync could not import, with its size and time then (it is not
 *  read again until they change). */
export type FolderSyncError = { file: string; message: string; mtime?: number | null; size?: number | null };

export type FolderSyncStatus = {
  /** When the sync ended (UNIX ms). */
  at: number;
  /** Bar files found. */
  scanned: number;
  /** Series stored (new or updated), and their bars. */
  imported: number;
  bars: number;
  /** Files unchanged since their last import. */
  unchanged: number;
  /** Series removed with their file. */
  removed: number;
  errors: FolderSyncError[];
  /** Why the folder itself could not be read. */
  failed?: string;
};

export type LocalFolder = {
  path: string;
  /** IANA zone of the files' times written without an offset. */
  timeZone: string;
  /** Remove a series when its file leaves the folder. */
  removeDeleted: boolean;
  status?: FolderSyncStatus;
};

const KEY = "ot:local-folders";

function load(): LocalFolder[] {
  try {
    const v = JSON.parse(getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((f) => f && typeof f.path === "string" && typeof f.timeZone === "string") : [];
  } catch {
    return [];
  }
}

const [folders, setFolders] = createSignal<LocalFolder[]>(load());
onExternalChange(KEY, () => setFolders(load()));

/** The synced folders (reactive). */
export function localFolders(): LocalFolder[] {
  return folders();
}

function save(next: LocalFolder[]): void {
  setFolders(next);
  setItem(KEY, JSON.stringify(next));
}

function patch(path: string, p: Partial<LocalFolder>): void {
  save(folders().map((f) => (f.path === path ? { ...f, ...p } : f)));
}

/** Add a folder (no sync: the caller starts one). False when it is there already. */
export function addLocalFolder(path: string, timeZone: string): boolean {
  if (folders().some((f) => samePath(f.path, path))) return false;
  save([...folders(), { path, timeZone, removeDeleted: false }]);
  return true;
}

/** Stop syncing a folder; its series stay. */
export function removeLocalFolder(path: string): void {
  save(folders().filter((f) => f.path !== path));
}

export function setLocalFolderOptions(path: string, p: Partial<Pick<LocalFolder, "timeZone" | "removeDeleted">>): void {
  const f = folders().find((x) => x.path === path);
  // In another zone, the files that failed are read again.
  const status = f?.status && p.timeZone && p.timeZone !== f.timeZone ? { ...f.status, errors: f.status.errors.map(({ file, message }) => ({ file, message })) } : f?.status;
  patch(path, { ...p, status });
}

/** Windows paths ignore case and the trailing separator. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The sync running in this window: the folder and the files done. */
const [progress, setProgress] = createSignal<{ path: string; done: number; total: number } | null>(null);
export const localFolderProgress = progress;

let queue: Promise<unknown> = Promise.resolve();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isInfoFile = (file: string) => /\.json$/i.test(file);

/** Sync one folder (after the syncs already asked for in this window). */
export function syncLocalFolder(path: string): Promise<FolderSyncStatus> {
  const run = queue.then(() => doSync(path));
  queue = run.catch(() => {});
  return run;
}

/** Sync every folder, one after the other. */
export async function syncLocalFolders(): Promise<{ folder: LocalFolder; status: FolderSyncStatus }[]> {
  const out: { folder: LocalFolder; status: FolderSyncStatus }[] = [];
  for (const folder of folders()) {
    out.push({ folder, status: await syncLocalFolder(folder.path) });
  }
  return out;
}

async function doSync(path: string): Promise<FolderSyncStatus> {
  const folder = folders().find((f) => f.path === path);
  if (!folder) throw new Error(`${path} is not a synced folder.`);
  const status: FolderSyncStatus = { at: 0, scanned: 0, imported: 0, bars: 0, unchanged: 0, removed: 0, errors: [] };
  const changed: string[] = [];
  try {
    const scan = await commands.localFolderScan(path);
    if (scan.status === "error") throw new Error(scan.error);
    const listed = await commands.localSeriesList();
    if (listed.status === "error") throw new Error(listed.error);
    const files = scan.data.filter((f) => !isInfoFile(f.file));
    status.scanned = files.length;
    setProgress({ path, done: 0, total: files.length });

    // Descriptions and price grids of the folder's symbol_info files.
    const info = new Map<string, { description?: string; pricescale?: number }>();
    for (const f of scan.data.filter((f) => isInfoFile(f.file))) {
      const r = await commands.localFolderRead(path, f.file);
      try {
        if (r.status === "error") throw new Error(r.error);
        for (const [k, v] of parseSeedSymbolInfo(r.data)) info.set(k, v);
      } catch (e) {
        status.errors.push({ file: f.file, message: r.status === "error" ? message(e) : "Not a symbol_info file." });
      }
    }

    const byFile = new Map<string, LocalSeries>();
    const byName = new Map<string, LocalSeries>();
    for (const s of listed.data) {
      byName.set(s.name, s);
      if (s.source && s.source.folder === path) byFile.set(s.source.file, s);
    }
    const before = new Map((folder.status?.errors ?? []).map((e) => [e.file, e]));
    const taken = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (i % 25 === 0) setProgress({ path, done: i, total: files.length });
      const own = byFile.get(f.file);
      const name = own?.name ?? seriesNameFromFile(f.file);
      if (taken.has(name)) {
        status.errors.push({ file: f.file, message: `Another file of the folder is LOCAL:${name}.` });
        continue;
      }
      taken.add(name);
      const other = own ? undefined : byName.get(name);
      if (other?.source) {
        status.errors.push({ file: f.file, message: `LOCAL:${name} comes from ${other.source.file} in ${other.source.folder}.` });
        continue;
      }
      const seed = info.get(seriesNameFromFile(f.file)) ?? info.get(name);
      const description = seed?.description ?? (own ?? other)?.description ?? "";
      if (
        own?.source &&
        own.source.mtime === f.mtime &&
        own.source.size === f.size &&
        own.timezone === folder.timeZone &&
        description === own.description &&
        (seed?.pricescale === undefined || seed.pricescale === own.pricescale)
      ) {
        status.unchanged++;
        continue;
      }
      // A file that failed as it is now fails again: not read.
      const failed = before.get(f.file);
      if (failed && failed.mtime === f.mtime && failed.size === f.size) {
        status.errors.push(failed);
        continue;
      }
      try {
        const text = await commands.localFolderRead(path, f.file);
        if (text.status === "error") throw new Error(text.error);
        const r = await importLocalSeries({
          name,
          csv: text.data,
          timeZone: folder.timeZone,
          description,
          pricescale: seed?.pricescale,
          source: { folder: path, file: f.file, mtime: f.mtime, size: f.size },
          deferRefresh: true,
        });
        status.imported++;
        status.bars += r.series.bars;
        changed.push(name);
      } catch (e) {
        status.errors.push({ file: f.file, message: message(e), mtime: f.mtime, size: f.size });
      }
    }

    if (folder.removeDeleted) {
      const present = new Set(files.map((f) => f.file));
      for (const [file, s] of byFile) {
        if (present.has(file)) continue;
        try {
          await deleteLocalSeries(s.name, true);
          status.removed++;
          changed.push(s.name);
        } catch (e) {
          status.errors.push({ file, message: message(e) });
        }
      }
    }
  } catch (e) {
    status.failed = message(e);
  } finally {
    setProgress(null);
    await localSeriesChanged(changed).catch(() => {});
  }
  status.at = Date.now();
  // The folder may have been removed meanwhile: then nothing to record.
  patch(path, { status });
  return status;
}

/** One line on a sync for a notice ("D:\data: 12 series updated, 2 files not imported"). */
export function syncSummary(folder: LocalFolder, s: FolderSyncStatus): string {
  if (s.failed) return `${folder.path}: ${s.failed}`;
  const parts: string[] = [];
  if (s.imported) parts.push(translateWith("{0} series updated", s.imported.toLocaleString("en-US")));
  if (s.removed) parts.push(translateWith("{0} removed", s.removed.toLocaleString("en-US")));
  const n = s.errors.length;
  if (n) parts.push(translateWith(n === 1 ? "{0} file not imported (Settings > Local data)" : "{0} files not imported (Settings > Local data)", n.toLocaleString("en-US")));
  return `${folder.path}: ${parts.join(", ") || translate("no change")}.`;
}

/** Minutes between two background syncs. */
const SYNC_EVERY_MIN = 5;

/** The main window's background syncs: once the app has settled after its
 *  start, then every few minutes. `notify` gets what a sync changed (the
 *  first) or the files that newly failed (every one). */
export function startLocalFolderSync(notify: (text: string) => void): () => void {
  let first = true;
  let stopped = false;
  let timer: number | undefined;
  const run = async () => {
    const previous = new Map(folders().map((f) => [f.path, new Set((f.status?.errors ?? []).map((e) => `${e.file}\n${e.message}`))]));
    const lines: string[] = [];
    for (const { folder, status } of await syncLocalFolders().catch(() => [])) {
      const seen = previous.get(folder.path) ?? new Set();
      const newErrors = status.failed ? !folder.status?.failed : status.errors.some((e) => !seen.has(`${e.file}\n${e.message}`));
      if (newErrors || (first && (status.imported || status.removed))) lines.push(syncSummary(folder, status));
    }
    first = false;
    if (stopped) return;
    if (lines.length) notify(lines.join(" "));
    timer = window.setTimeout(() => void run(), SYNC_EVERY_MIN * 60_000);
  };
  // After the charts' first loads.
  const start = window.setTimeout(() => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(() => void run(), { timeout: 10_000 });
    else void run();
  }, 3000);
  return () => {
    stopped = true;
    window.clearTimeout(start);
    window.clearTimeout(timer);
  };
}
