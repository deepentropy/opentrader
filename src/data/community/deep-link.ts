/*
 * `opentrader://` links (#233, src-tauri/src/deep_link.rs): "Open in
 * OpenTrader" on the Community website gives `opentrader://post/<id>`; the
 * app opens the post in the Community panel and its shared chart on the
 * active chart. The window a link is for takes it from the app's queue when
 * told; main also takes the ones the app was started with.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, events } from "../../bindings";
import { requestOpenPost } from "./notifications";

/** The post of a link: `opentrader://post/<id>`; null for anything else. */
export function linkedPost(url: string): string | null {
  const m = /^opentrader:\/\/(?:post|p)\/([a-z0-9]{4,20})\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Starts taking this window's links; returns the stop. */
export async function startDeepLinks(openPanel: () => void): Promise<() => void> {
  const label = getCurrentWindow().label;
  const take = async () => {
    for (const url of await commands.deepLinkTake()) {
      const id = linkedPost(url);
      if (!id) continue;
      openPanel();
      requestOpenPost(id, { openChart: true });
    }
  };
  const stop = await events.deepLinkOpened.listen((e) => {
    if (e.payload.window === label) void take();
  });
  if (label === "main") void take();
  return stop;
}
