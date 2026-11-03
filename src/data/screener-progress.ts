/*
 * The screener's loading wheel text: the share downloaded when every pending download tells its size, else the
 * megabytes read; under it, what is downloading.
 */
import type { ScreenerProgress } from "../bindings";

/** Names of the backend's downloads. */
const NAMES: Record<string, string> = {
  market: "market data",
  tickers: "ticker list",
  state: "daily data",
  closes: "price history",
};

export type WheelText = { label: string; caption: string };

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

export function wheelText(p: ScreenerProgress | null): WheelText {
  const received = p?.receivedBytes ?? 0;
  if (!p || (received <= 0 && !p.downloading.length)) return { label: "", caption: "" };
  const total = p.totalBytes;
  // 100% only once the table is in: the wheel goes away then.
  const label = total ? `${Math.min(99, Math.floor((received / total) * 100))}%` : received > 0 ? `${mb(received)} MB` : "";
  const names = p.downloading.map((d) => NAMES[d] ?? d);
  const what = names.length ? `Downloading ${names.join(", ")}` : "Preparing the table";
  const caption = total ? `${what} · ${mb(received)} of ${mb(total)} MB` : what;
  return { label, caption };
}
