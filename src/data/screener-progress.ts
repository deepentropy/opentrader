import { translate, translateWith } from "../i18n/translator";
import { listText, numberText } from "../i18n/format";
/*
 * The screener's loading wheel text: the share downloaded when every pending download tells its size, else the
 * megabytes read; under it, what is downloading.
 */
import type { ScreenerProgress } from "../bindings";

/** Names of the backend's downloads, in the interface language. */
const NAMES: Record<string, () => string> = {
  market: () => translate("market data"),
  tickers: () => translate("ticker list"),
  state: () => translate("daily data"),
  closes: () => translate("price history"),
};

export type WheelText = { label: string; caption: string };

const mb = (bytes: number) => numberText(bytes / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function wheelText(p: ScreenerProgress | null): WheelText {
  const received = p?.receivedBytes ?? 0;
  if (!p || (received <= 0 && !p.downloading.length)) return { label: "", caption: "" };
  const total = p.totalBytes;
  // 100% only once the table is in: the wheel goes away then.
  const label = total ? `${Math.min(99, Math.floor((received / total) * 100))}%` : received > 0 ? translateWith("{0} MB", mb(received)) : "";
  const names = p.downloading.map((d) => NAMES[d]?.() ?? d);
  const what = names.length ? translateWith("Downloading {0}", listText(names)) : translate("Preparing the table");
  const caption = total ? translateWith("{0} · {1} of {2} MB", what, mb(received), mb(total)) : what;
  return { label, caption };
}
