/*
 * Usage statistics (PostHog, US cloud): which features are used, by how many
 * installs (desktop) or visits (web), and from where, the app's errors
 * (src/data/error-reports.ts) and the AI assistant's conversations
 * (src/data/assistant/telemetry.ts). No cookies, no account; one
 * random id per desktop install, one per browser tab session on the web. Users
 * can switch it off (Settings > Service > Privacy).
 *
 * Both versions send through the web version's relay (`/ingest`, the
 * Cloudflare Worker), which adds the city, region and country Cloudflare
 * reports, and the IP address. One switch covers it all (Settings > Service >
 * Privacy > Send usage statistics, on by default).
 * See https://opentrader.markets/privacy.html.
 *
 * Off in development builds and when the build has no project key
 * (`VITE_POSTHOG_KEY`).
 *
 * A chart or widget embedded in another website (#339) sends one event when it
 * loads, `embed_view`: which embed and the site's address, without the IP
 * address (its visitors have no switch to turn it off) and nothing else.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";
import { commands } from "../bindings";
import { startErrorReports } from "./error-reports";
import { embedConfig } from "../embed/config";

const KEY = (import.meta.env.VITE_POSTHOG_KEY as string | undefined) ?? "";
const WEB = import.meta.env.MODE === "web";
const VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "";
/** The relay: same origin on the web, the web version's address on the desktop. */
const HOST = WEB ? "/ingest" : "https://demo.opentrader.markets/ingest";

export const PRIVACY_URL = "https://opentrader.markets/privacy.html";

const ID_KEY = "ot:analytics-id";
const ENABLED_KEY = "ot:analytics-enabled";
const IP_CONSENT_KEY = "ot:analytics-ip-consent";
const FLUSH_MS = 15_000;
const MAX_QUEUE = 200;

/** Event properties: values, or JSON for the assistant's conversation events (PostHog LLM analytics). */
type Props = Record<string, unknown>;
type Queued = { event: string; properties: Props; timestamp: string };

const EMBED = embedConfig();

const [enabled, setEnabledSignal] = createSignal(kv.getItem(ENABLED_KEY) !== "false");

/** Users who declined the IP address on the former consent card (before
 *  0.4.12) keep that answer: their events still go without it. */
const IP_DECLINED = kv.getItem(IP_CONSENT_KEY) === "denied";

/** Whether usage statistics are sent (the Settings switch). */
export const analyticsEnabled = enabled;

/** Switch usage statistics on or off; off drops what is waiting. */
export function setAnalyticsEnabled(on: boolean): void {
  if (!on) track("analytics_disabled");
  flush();
  kv.setItem(ENABLED_KEY, on ? "true" : "false");
  setEnabledSignal(on);
  if (!on) queue.length = 0;
}

/** Whether this build sends statistics at all. */
export const analyticsAvailable = (): boolean => KEY !== "" && !import.meta.env.DEV;

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Desktop: one id per install. Web: one per tab session (nothing kept across visits). */
function anonymousId(): string {
  try {
    const store = WEB ? sessionStorage : null;
    const existing = store ? store.getItem(ID_KEY) : kv.getItem(ID_KEY);
    if (existing) return existing;
    const id = randomId();
    if (store) store.setItem(ID_KEY, id);
    else kv.setItem(ID_KEY, id);
    return id;
  } catch {
    return randomId();
  }
}

function os(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

let id: string | null = null;
const queue: Queued[] = [];
let timer: number | undefined;

/** Record one usage event. Properties must not carry personal data (the assistant's conversations, which the
 *  privacy policy names, aside). */
export function track(event: string, props: Props = {}): void {
  if (!analyticsAvailable() || !enabled()) return;
  if (EMBED && event !== "embed_view") return;
  id ??= anonymousId();
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ...props,
      distinct_id: id,
      // Anonymous events: no person profiles.
      $process_person_profile: false,
      app: WEB ? "web" : "desktop",
      app_version: VERSION,
      os: os(),
      // The relay adds the IP address only when this is true.
      ip_consent: !IP_DECLINED && !EMBED,
    },
  });
  timer ??= window.setTimeout(flush, FLUSH_MS);
}

/** Send what is waiting. */
export function flush(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0) return;
  const body = JSON.stringify({ api_key: KEY, batch: queue.splice(0) });
  const url = `${HOST}/batch/`;
  // A beacon still leaves when the page is closing.
  if (WEB && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
  // Desktop: from the backend, through the proxy of Settings > Network when there is one.
  if (!WEB) {
    void commands.postWebhook(url, body).catch(() => {});
    return;
  }
  void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

/** The address (host name) of the site an embed is shown on, "" when unknown. */
function embeddingSite(): string {
  const origin = location.ancestorOrigins?.[0] ?? document.referrer;
  try {
    return origin ? new URL(origin).hostname : "";
  } catch {
    return "";
  }
}

/** Start: the "app opened" event, and a last flush when the page hides.
 *  Desktop: `first_launch` when no settings of an earlier run were found (a
 *  new install, not an update), to compare installs with the web version's
 *  download link clicks. */
export function initAnalytics(): void {
  if (!analyticsAvailable()) return;
  if (EMBED) {
    track("embed_view", { widget: EMBED.widget, site: embeddingSite() });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    return;
  }
  const props: Props = { screen_width: Math.round(window.screen.width / 100) * 100 };
  if (!WEB) props.first_launch = kv.startedEmpty();
  track("app_opened", props);
  // App errors (src/data/error-reports.ts), from now on through the same switch.
  startErrorReports(track);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
