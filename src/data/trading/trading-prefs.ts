/*
 * Trading settings that are not per chart in the reference app (Buy/sell
 * buttons aside): one-click trading, the execution sound and "Show only
 * rejection notifications". They are kept in each chart's Trading tab here;
 * the focused chart's values apply (its trading lines part sets them).
 */
import { createRoot, createSignal } from "solid-js";
import { tradingAppearance, type TradingAppearance } from "../../window/header/chart-settings";

export const tradingPrefs = createRoot(() => {
  const [prefs, setPrefs] = createSignal<TradingAppearance>(tradingAppearance(undefined));
  return { prefs, setPrefs };
});
