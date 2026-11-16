/*
 * App errors in the usage statistics (event `app_error`): uncaught errors, unhandled promise
 * rejections and crashed workers, so the failures nobody reports still show up. The listeners
 * start with the page; what happens before the statistics start (src/data/analytics.ts) waits in
 * a short buffer, and is dropped with the rest when statistics are off.
 *
 * A report holds the error's kind and type, its message and the top of its stack, cleaned:
 * quoted text (names, symbols, what the user wrote), e-mail addresses, the folders of file paths
 * and everything after a web address's host go, only the code's file names and lines stay.
 * One report per distinct error and at most MAX_PER_RUN per run.
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
  const message = cleanText(raw);
  const key = [kind, at.where ?? "", name, message, stack.split("\n")[0] ?? ""].join("|");
  if (seen.has(key) || reported >= MAX_PER_RUN) return;
  seen.add(key);
  reported++;
  const report: Report = { kind, name, message, stack, run_seconds: Math.round(performance.now() / 1000) };
  if (at.where) report.where = at.where;
  if (at.source) report.source = cleanAddress(at.source);
  if (at.line) report.line = at.line;
  if (at.column) report.column = at.column;
  deliver(report);
}

/** A worker's `error` event (the worker crashed). */
export function reportWorkerError(where: string, ev: Event): void {
  const e = ev as ErrorEvent;
  reportError("worker", e.error ?? e.message ?? "", { where, source: e.filename || undefined, line: e.lineno || undefined, column: e.colno || undefined });
}

/** Listen for uncaught errors and unhandled rejections, from page start. */
export function installErrorReports(): void {
  window.addEventListener("error", (e: ErrorEvent) => {
    // Failed loads of images and scripts come here too, without an error: not code errors.
    if (!(e instanceof ErrorEvent)) return;
    reportError("uncaught", e.error ?? e.message, { source: e.filename || undefined, line: e.lineno || undefined, column: e.colno || undefined });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => reportError("rejection", e.reason));
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
  reported = 0;
}
