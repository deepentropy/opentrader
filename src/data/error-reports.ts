/*
 * App errors in the usage statistics (event `app_error`): uncaught errors, unhandled promise
 * rejections, crashed workers and workers that did not start, so the failures nobody reports still show up. The listeners
 * start with the page; what happens before the statistics start (src/data/analytics.ts) waits in
 * a short buffer, and is dropped with the rest when statistics are off.
 *
 * A report holds the error's kind and type, its message and the top of its stack, cleaned:
 * quoted text (names, symbols, what the user wrote), e-mail addresses, the folders of file paths
 * and everything after a web address's host go, only the code's file names and lines stay.
 * One report per distinct error and at most MAX_PER_RUN per run.
 *
 * The same cleaned errors, and the console's errors, are also kept in this window for a bug report (Settings > About >
 * Copy diagnostic info, the get_diagnostics agent tool): the last LOG_SIZE, whether statistics are on or off. They
 * never leave the computer unless the user pastes them.
 */

type Report = Record<string, string | number>;
type Send = (event: string, props: Report) => void;

const MAX_PER_RUN = 20;
const MAX_BUFFER = 10;
const STACK_FRAMES = 6;

/** Browser noise with nothing to fix, and errors of other origins (their text is hidden). */
const IGNORED = [/ResizeObserver loop/, /^Script error\.?$/];
/** Browser extensions' scripts, on the web version. */
const FOREIGN = /^(chrome|moz|safari)(-web)?-extension:/;

let send: Send | null = null;
const buffer: Report[] = [];
const seen = new Set<string>();
let reported = 0;

const LOG_SIZE = 10;
/** An error of this run, for a bug report: when it last happened and how many times. */
export type LoggedError = { at: number; kind: string; text: string; count: number };
const log: LoggedError[] = [];

function remember(kind: string, text: string): void {
  const same = log.findIndex((e) => e.kind === kind && e.text === text);
  const entry = same >= 0 ? log.splice(same, 1)[0] : { at: 0, kind, text, count: 0 };
  entry.at = Date.now();
  entry.count++;
  log.push(entry);
  if (log.length > LOG_SIZE) log.shift();
}

/** The last errors of this run, oldest first. */
export const recentErrors = (): LoggedError[] => log.map((e) => ({ ...e }));

/** An address: the file name for the app's code, the host alone for anything else. */
function cleanAddress(url: string): string {
  const bare = url.replace(/[?#].*$/, "");
  const file = /^(.*\/)?([^/]+\.(?:m?js|ts|tsx|wasm))(:\d+(?::\d+)?)?$/.exec(bare);
  if (file) return file[2] + (file[3] ?? "");
  const host = /^[a-z-]+:\/\/([^/?#]+)/i.exec(url);
  return host ? `${host[1]}/…` : "…";
}

/** Text of an error with nothing personal left in it (see the top of the file). */
export function cleanText(text: string, max = 300): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)'"`]+/gi, cleanAddress)
    .replace(/(["'`])[^"'`\n]{1,200}\1/g, "$1…$1")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "…@…")
    .replace(/(?:\b[A-Za-z]:)?(?:[\\/][^\\/\s:)'"`]+)+[\\/]([^\\/\s:)'"`]+)/g, (_m, last: string) => `…/${last}`)
    .slice(0, max);
}

/** The first frames of a stack, cleaned, one per line. */
function cleanStack(stack: string | undefined): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^at |@/.test(l))
    .slice(0, STACK_FRAMES)
    .map((l) => cleanText(l, 160))
    .join("\n");
}

function deliver(report: Report): void {
  if (send) send("app_error", report);
  else if (buffer.length < MAX_BUFFER) buffer.push(report);
}

/**
 * Report one error. `kind`: uncaught, rejection, worker. `where` names the part of the app
 * (a worker), `source` the code file when the error event gives one.
 */
export function reportError(kind: string, error: unknown, at: { where?: string; source?: string; line?: number; column?: number } = {}): void {
  const err = error instanceof Error ? error : null;
  const name = err?.name || (error === undefined || error === null ? "" : typeof error === "object" ? "Object" : typeof error);
  const carried = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  const raw = err ? err.message : typeof error === "string" ? error : typeof carried === "string" ? carried : "";
  if (IGNORED.some((r) => r.test(raw))) return;
  if (at.source && FOREIGN.test(at.source)) return;
  const stack = cleanStack(err?.stack);
  if (/(chrome|moz|safari)(-web)?-extension:/.test(err?.stack ?? "")) return;
  submit(kind, name, cleanText(raw), stack, at);
}

/** Log, then send once per distinct error. `detail`: the report's message, cleaned already. */
function submit(kind: string, name: string, detail: string, stack: string, at: { where?: string; source?: string; line?: number; column?: number }, extra: Report = {}): void {
  const top = stack.split("\n")[0] ?? "";
  remember(at.where ? `${kind} (${at.where})` : kind, [name && `${name}:`, detail, top && `(${top})`].filter(Boolean).join(" "));
  const key = [kind, at.where ?? "", name, detail, top, ...Object.values(extra)].join("|");
  if (seen.has(key) || reported >= MAX_PER_RUN) return;
  seen.add(key);
  reported++;
  const report: Report = { kind, name, message: detail, stack, run_seconds: Math.round(performance.now() / 1000), ...extra };
  if (at.where) report.where = at.where;
  if (at.source) report.source = cleanAddress(at.source);
  if (at.line) report.line = at.line;
  if (at.column) report.column = at.column;
  deliver(report);
}

/** A worker's `error` event. A crash carries its error; an event with nothing in it is a script that did not load. */
export function reportWorkerError(where: string, ev: Event): void {
  const e = ev as ErrorEvent;
  if (e.error == null && !e.message) {
    reportWorkerLoad(where, "", "unknown", 1);
    return;
  }
  reportError("worker", e.error ?? e.message, { where, source: e.filename || undefined, line: e.lineno || undefined, column: e.colno || undefined });
}

/**
 * A worker whose script did not load (src/data/worker-start.ts), counted apart from the crashes: `url` its script,
 * `cause` what the check after the failure found, `attempt` 1 for the first start, 2 for the start again.
 */
export function reportWorkerLoad(where: string, url: string, cause: string, attempt: number): void {
  submit("worker_load", "WorkerLoadError", `worker failed to start (${cause})`, "", { where, source: url || undefined }, { attempt });
}

const unorderedSeen = new Set<string>();

/**
 * A study output whose points were not in ascending time order: the indicators' renderer put them in order (the chart
 * library throws "Value is null" at paint on them, #360). Sent once per study and output, with what locates the cause.
 */
export function reportUnorderedData(
  study: string,
  info: { output: string; seriesType: string; points: number; dropped: number; index: number; time: number; previous: number },
  live: boolean,
): void {
  const key = `${study}|${info.output}`;
  if (unorderedSeen.has(key)) return;
  unorderedSeen.add(key);
  const { seriesType, ...rest } = info;
  submit("study_data", "UnorderedData", `${seriesType} points out of time order`, "", { where: `study ${study}` }, { ...rest, live: live ? 1 : 0 });
}

/** Listen for uncaught errors and unhandled rejections, from page start. */
export function installErrorReports(): void {
  window.addEventListener("error", (e: ErrorEvent) => {
    // Failed loads of images and scripts come here too, without an error: not code errors.
    if (!(e instanceof ErrorEvent)) return;
    reportError("uncaught", e.error ?? e.message, { source: e.filename || undefined, line: e.lineno || undefined, column: e.colno || undefined });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => reportError("rejection", e.reason));
  // Errors the code caught and logged: often the only trace of a feature that silently failed.
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleError(...args);
    logConsoleError(args);
  };
}

/** A console.error call in the bug-report log (not in the statistics). */
export function logConsoleError(args: unknown[]): void {
  const text = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
  if (IGNORED.some((r) => r.test(text))) return;
  remember("console", cleanText(text));
}

/** The statistics have started: send what waited, then each report as it comes. */
export function startErrorReports(to: Send): void {
  send = to;
  for (const r of buffer.splice(0)) to("app_error", r);
}

/** Tests: back to a fresh run. */
export function resetErrorReports(): void {
  send = null;
  buffer.length = 0;
  seen.clear();
  unorderedSeen.clear();
  reported = 0;
  log.length = 0;
}
