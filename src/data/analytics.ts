/*
 * Usage statistics (PostHog, US cloud): which features are used, by how many
 * installs (desktop) or visits (web), and from where. No cookies, no account,
 * no symbols; one random id per desktop install, one per browser tab session
 * on the web. Users can switch it off (Settings > Service > Privacy).
 *
 * Both versions send through the web version's relay (`/ingest`, the
 * Cloudflare Worker), which adds the city, region and country Cloudflare
 * reports. The IP address itself is added only for users who agreed to it
 * (`ipConsent`, asked once by the consent card); for the others it never
 * reaches the analytics service. See https://opentrader.markets/privacy.html.
 *
 * Off in development builds and when the build has no project key
 * (`VITE_POSTHOG_KEY`).
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

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

type Props = Record<string, string | number | boolean | null>;
type Queued = { event: string; properties: Props; timestamp: string };

const [enabled, setEnabledSignal] = createSignal(kv.getItem(ENABLED_KEY) !== "false");

type IpConsent = "granted" | "denied" | null;
function readConsent(): IpConsent {
  const v = kv.getItem(IP_CONSENT_KEY);
  return v === "granted" || v === "denied" ? v : null;
}
const [ipConsent, setIpConsentSignal] = createSignal<IpConsent>(readConsent());

/** The user's answer about sharing their IP address (null: not asked yet). */
export const analyticsIpConsent = ipConsent;

/** Record the answer about sharing the IP address. */
export function setAnalyticsIpConsent(granted: boolean): void {
  kv.setItem(IP_CONSENT_KEY, granted ? "granted" : "denied");
  setIpConsentSignal(granted ? "granted" : "denied");
  track(granted ? "ip_consent_granted" : "ip_consent_denied");
}

/** Whether to ask for the IP consent now (statistics on, not answered yet). */
export const shouldAskIpConsent = (): boolean => analyticsAvailable() && enabled() && ipConsent() === null;

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

/** Record one usage event. Properties must not carry personal data or symbols. */
export function track(event: string, props: Props = {}): void {
  if (!analyticsAvailable() || !enabled()) return;
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
      ip_consent: ipConsent() === "granted",
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
  void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

/** Start: the "app opened" event, and a last flush when the page hides. */
export function initAnalytics(): void {
  if (!analyticsAvailable()) return;
  track("app_opened", { screen_width: Math.round(window.screen.width / 100) * 100 });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
