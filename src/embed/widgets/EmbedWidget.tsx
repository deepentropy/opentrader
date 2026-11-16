/*
 * The page of an embedded widget (#339): a ticker tape, mini chart or quote
 * in place of the app, in the embed's theme.
 */
import { Match, onCleanup, onMount, Switch } from "solid-js";
import type { EmbedConfig } from "../config";
import { installWidgetHost } from "../host";
import { createAppTheme } from "../../window/shell/app-theme";
import { TickerTape } from "./TickerTape";
import { MiniChart } from "./MiniChart";
import { QuoteCard } from "./QuoteCard";

export function EmbedWidget(props: { config: EmbedConfig }) {
  const { theme, setThemeSetting, observeTheme } = createAppTheme();
  onMount(() => {
    observeTheme();
    onCleanup(installWidgetHost(setThemeSetting));
  });
  return (
    <div class="ot-w" data-widget={props.config.widget}>
      <Switch>
        <Match when={props.config.widget === "ticker-tape"}>
          <TickerTape config={props.config} />
        </Match>
        <Match when={props.config.widget === "mini-chart"}>
          <MiniChart config={props.config} theme={theme} />
        </Match>
        <Match when={props.config.widget === "quote"}>
          <QuoteCard config={props.config} />
        </Match>
      </Switch>
    </div>
  );
}
