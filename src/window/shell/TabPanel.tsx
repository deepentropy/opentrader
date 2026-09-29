/*
 * TabPanel — the chart-tab strip. Solid port of the reference mock's TabPanel,
 * trimmed to the in-app behaviours (no Electron tear-off-to-new-window, no link
 * channels, no live snapshot prices, no title customization).
 *
 * Interactions kept from the mock:
 *   - click a tab → activate it
 *   - double-click the active tab → duplicate it
 *   - middle-click / close button → close
 *   - drag a tab horizontally → reorder (siblings slide out of the way, the
 *     dragged tab follows the cursor; commit on pointerup)
 *   - drag a tab down past the header band → tear it off into a new window
 *     (Tauri WebviewWindow via window-bridge; a floating ghost previews it)
 *   - right-click → context menu
 *   - progressive size variants (normal → small → xsmall → xxsmall) as the
 *     strip gets crowded (getTabSize, verbatim thresholds)
 *   - new-tab "+" button
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { TvIcon } from "../../components/TvIcon";
import { quoteFor } from "../../data/quotes";
import { setSubscription, clearSubscription } from "../../data/subscriptions";
import { TabContextMenu, type TabMenuAnchor } from "./TabContextMenu";
import { linkColorHex, type LinkChannel, type LinkColor } from "./tab-linking";
import { groupChannels } from "../../data/link-groups";
import { activePaneOf, clampMoveIndex, layoutNameFromInterval, tabTitle, tickerInitial, type TabChart } from "./tabs";
import { DEFAULT_TAB_TITLE_PARTS, type TabTitlePartState } from "./tab-title";

const PRICE_PARTS = new Set(["priceChangeIcon", "lastPrice", "priceChange"]);
const fmtTabPrice = (n: number): string => n.toFixed(2);
const fmtTabPct = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

type Props = {
  tabs: TabChart[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onReorder: (from: number, to: number) => void;
  onDuplicate: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCopySymbol: (id: string) => void;
  /** Open App Settings → Tabs to customise the tab title. */
  onCustomizeTitle: () => void;
  /** Tab-title parts (order + visibility) from App Settings → Tabs. */
  titleParts?: TabTitlePartState[];
  /** Tear-off: the tab was dragged below the header band and released.
   *  screenX/screenY are global cursor coords for placing the new window. */
  onDetach: (id: string, screenX: number, screenY: number) => void;
  /** Drop outside this window: move the tab to the window whose tab strip is
   *  under the cursor (TV merge). Resolves true when it moved. */
  onDropOnWindow?: (id: string, screenX: number, screenY: number) => Promise<boolean>;
  /** TV "Reload tab". */
  onReload: (id: string) => void;
  /** TV "Pin tab" / "Unpin tab". */
  onTogglePin: (id: string) => void;
  /** TV "Developer tools" (shown when the menu opens with Shift held). */
  onDevTools: () => void;
  /** Whether detach is possible (Tauri shell). When false the drag stays a
   *  pure reorder — no ghost, no tear-off. */
  canDetach: boolean;
  /** Tab-syncing (colour link) handlers, driven from the right-click menu. */
  onLink: (id: string, color: LinkColor) => void;
  onUnlink: (id: string) => void;
  onToggleChannel: (id: string, channel: LinkChannel) => void;
};

const TAB_FLEX_BASIS = 250;
// Drag below this window-relative Y becomes a tear-off (35px header + 30px guard).
const DETACH_THRESHOLD = 65;

type TabSize = "normal" | "small" | "xsmall" | "xxsmall";

/** getTabSize — verbatim thresholds from the mock (tab-panel.tsx). */
function getTabSize(count: number, panelWidth: number): TabSize {
  if (count === 0) return "normal";
  const spaceForTab = panelWidth / count;
  if (spaceForTab <= 44) return "xxsmall";
  if (spaceForTab <= 75) return "xsmall";
  if (spaceForTab <= 110) return "small";
  return "normal";
}

type DragState = {
  tabId: string;
  fromIndex: number;
  startClientX: number;
  tabWidth: number;
  clientX: number;
  clientY: number;
  targetIndex: number;
  detaching: boolean;
};

export function TabPanel(props: Props) {
  const tabEls = new Map<string, HTMLDivElement>();
  let panel!: HTMLDivElement;
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [menu, setMenu] = createSignal<TabMenuAnchor | null>(null);
  const [panelWidth, setPanelWidth] = createSignal(0);
  let lastClicked = "";

  onMount(() => {
    const measure = () => setPanelWidth(panel.scrollWidth);
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
  });

  const tabSize = createMemo<TabSize>(() => getTabSize(props.tabs.length, panelWidth()));

  // Price parts read the background quote store, which only carries symbols on
  // the live subscription union. Contribute every tab's active symbol while at
  // least one price part is visible (background tabs aren't polled otherwise).
  createEffect(() => {
    const parts = props.titleParts ?? DEFAULT_TAB_TITLE_PARTS;
    const wantsQuotes = parts.some((p) => p.visible && PRICE_PARTS.has(p.id));
    setSubscription("tab-titles", wantsQuotes ? props.tabs.map((t) => activePaneOf(t).symbol) : []);
  });
  onCleanup(() => clearSubscription("tab-titles"));

  function computeTargetIndex(cursorX: number, fromIndex: number, draggedId: string): number {
    let target = fromIndex;
    for (let i = 0; i < props.tabs.length; i++) {
      if (props.tabs[i].id === draggedId) continue;
      const el = tabEls.get(props.tabs[i].id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const center = r.left + r.width / 2;
      if (i < fromIndex && cursorX < center) { target = i; break; }
      if (i > fromIndex && cursorX > center) target = i;
    }
    return clampMoveIndex(props.tabs, fromIndex, target);
  }

  function onPointerDown(e: PointerEvent, tab: TabChart, idx: number) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close-btn")) return;
    if (tab.id !== props.activeId) props.onActivate(tab.id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    setDrag({
      tabId: tab.id, fromIndex: idx, startClientX: e.clientX,
      tabWidth: r.width, clientX: e.clientX, clientY: e.clientY, targetIndex: idx,
      detaching: false,
    });
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag();
    if (!d) return;
    // Tear-off only when a detach target exists and there's more than one tab.
    const detaching = props.canDetach && props.tabs.length > 1 && e.clientY > DETACH_THRESHOLD;
    const targetIndex = detaching ? d.fromIndex : computeTargetIndex(e.clientX, d.fromIndex, d.tabId);
    setDrag({ ...d, clientX: e.clientX, clientY: e.clientY, targetIndex, detaching });
  }

  function finishDrag(e: PointerEvent, cancelled: boolean) {
    const d = drag();
    if (!d) return;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* released */ }
    setDrag(null);
    if (cancelled) return;
    const local = () => {
      if (d.detaching && props.tabs.length > 1) {
        props.onDetach(d.tabId, e.screenX, e.screenY);
        return;
      }
      if (d.targetIndex !== d.fromIndex) props.onReorder(d.fromIndex, d.targetIndex);
    };
    // Released outside this window: another window's tab strip takes the tab
    // (merge); anywhere else, the usual tear-off / reorder.
    const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    if (outside && props.canDetach && props.onDropOnWindow) {
      const { screenX, screenY } = e;
      void props.onDropOnWindow(d.tabId, screenX, screenY).then((moved) => { if (!moved) local(); });
      return;
    }
    local();
  }

  function onTabClick(e: MouseEvent, tab: TabChart) {
    if (e.detail === 2 && lastClicked === tab.id) {
      props.onDuplicate(tab.id);
      return;
    }
    lastClicked = tab.id;
  }

  /** Per-tab transform offset given the current drag (sibling shuffle). */
  function offsetFor(idx: number, tabId: string): number {
    const d = drag();
    if (!d || d.detaching) return 0;
    if (tabId === d.tabId) return d.clientX - d.startClientX;
    const { fromIndex: f, targetIndex: t, tabWidth: w } = d;
    if (f < t && idx > f && idx <= t) return -w;
    if (f > t && idx < f && idx >= t) return w;
    return 0;
  }

  /** The tab being torn off — used for the floating detach ghost. */
  const draggedTab = () => {
    const d = drag();
    return d?.detaching ? props.tabs.find((t) => t.id === d.tabId) ?? null : null;
  };

  return (
    <div class="tabs" ref={panel}>
      <div class="tabs-container" style={{ "flex-basis": `${props.tabs.length * TAB_FLEX_BASIS}px` }}>
        <For each={props.tabs}>
          {(tab, idx) => {
            const isActive = () => tab.id === props.activeId;
            const isDragged = () => drag()?.tabId === tab.id;
            const showClose = () => isActive() || tabSize() === "normal";
            const quote = () => quoteFor(activePaneOf(tab).symbol);
            const quoteDir = () => ((quote()?.change ?? 0) >= 0 ? "up" : "down");
            return (
              <div
                id={tab.id}
                ref={(el) => tabEls.set(tab.id, el)}
                class={`tab ${tabSize()} ${isActive() ? "active" : ""} ${isDragged() ? "dragging" : ""}`}
                style={{
                  transform: `translateX(${Math.round(offsetFor(idx(), tab.id))}px)`,
                  transition: isDragged() ? "none" : "transform 0.2s ease-out",
                  visibility: isDragged() && drag()?.detaching ? "hidden" : undefined,
                }}
                onPointerDown={(e) => onPointerDown(e, tab, idx())}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => finishDrag(e, false)}
                onPointerCancel={(e) => finishDrag(e, true)}
                onClick={(e) => onTabClick(e, tab)}
                onAuxClick={(e) => { if (e.button === 1) props.onClose(tab.id); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (tab.id !== props.activeId) props.onActivate(tab.id);
                  setMenu({
                    tabId: tab.id,
                    x: e.clientX,
                    y: e.clientY,
                    isChart: tab.isChart,
                    // TV with-menu.ts visibility rules (pinned tabs are kept).
                    isCloseOtherVisible: props.tabs.length > 1 && props.tabs.some((t) => t.id !== tab.id && !t.pinned),
                    isCloseToRightVisible:
                      props.tabs.length > 1 && idx() < props.tabs.length - 1 && props.tabs.some((t) => !t.pinned),
                    isDetachVisible: props.canDetach && props.tabs.length > 1,
                    pinned: !!tab.pinned,
                    hasShiftKey: e.shiftKey,
                  });
                }}
              >
                <div
                  class="tab-link-indicator"
                  style={tab.link ? { "background-color": linkColorHex(tab.link.color) } : undefined}
                />
                <div class={`tab-title ${tabSize()}`}>
                  <div class="title-container">
                    <For each={(props.titleParts ?? DEFAULT_TAB_TITLE_PARTS).filter((p) => p.visible)}>
                      {(part) => {
                        // Price parts come from the live quote store and stay
                        // hidden until a tick arrives (matches TV with no
                        // quote). Logo / ticker / layout-name derive from the tab.
                        switch (part.id) {
                          case "symbolLogo":
                            return <span class="empty-logo"><span class="empty-logo-symbol">{tickerInitial(activePaneOf(tab).symbol)}</span></span>;
                          case "ticker":
                            return <span class="tab-part tab-part-ticker">{activePaneOf(tab).symbol}</span>;
                          case "priceChangeIcon":
                            return (
                              <Show when={quote()}>
                                <span class={`tab-part tab-part-icon ${quoteDir()}`} aria-hidden="true">{quoteDir() === "up" ? "▲" : "▼"}</span>
                              </Show>
                            );
                          case "lastPrice":
                            return (
                              <Show when={quote()}>
                                {(q) => <span class="tab-part tab-part-last">{fmtTabPrice(q().last)}</span>}
                              </Show>
                            );
                          case "priceChange":
                            return (
                              <Show when={quote()?.changePercent != null}>
                                <span class={`tab-part tab-part-change ${quoteDir()}`}>{fmtTabPct(quote()!.changePercent!)}</span>
                              </Show>
                            );
                          case "layoutName":
                            // TV shows the SAVED layout's name; unsaved charts
                            // fall back to the interval-derived label.
                            return <span class="tab-part tab-part-layout">/ {tab.savedLayoutName ?? layoutNameFromInterval(activePaneOf(tab).interval)}</span>;
                          default:
                            return null;
                        }
                      }}
                    </For>
                  </div>
                </div>
                <div class="tab-close-button-container">
                  <div class="fadeout" />
                  <Show when={showClose() && !tab.pinned}>
                    <button
                      class="tab-close-btn"
                      aria-label="close-tab-button"
                      tabIndex={-1}
                      title="Close"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); props.onClose(tab.id); }}
                    >
                      <TvIcon name="tab-close" size={12} />
                    </button>
                  </Show>
                </div>
                <div class="tab-panel-divider" />
                <div class="extenders">
                  <div class="extender left"><TvIcon name="tab-extender" size={6} /></div>
                  <div class="extender right"><TvIcon name="tab-extender" size={6} /></div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <button class="create-new-tab-button" title="New tab" onClick={props.onNewTab}>
        <TvIcon name="tab-new" size={14} />
      </button>
      <div class="draggable-area" data-tauri-drag-region />

      {/* Floating tear-off ghost while dragging below the header band. */}
      <Show when={draggedTab()}>
        {(t) => (
          <div
            class="tab-detach-ghost"
            style={{
              left: `${drag()!.clientX - 100}px`,
              top: `${drag()!.clientY - 17}px`,
              width: `${Math.min(drag()!.tabWidth, TAB_FLEX_BASIS)}px`,
            }}
          >
            <span class="tab-detach-ghost-title">
              <span class="empty-logo"><span class="empty-logo-symbol">{tickerInitial(activePaneOf(t()).symbol)}</span></span>
              <span class="title">{tabTitle(t())}</span>
            </span>
          </div>
        )}
      </Show>

      <Show when={menu()}>
        {(m) => (
          <TabContextMenu
            anchor={m()}
            onClose={() => setMenu(null)}
            onDuplicate={props.onDuplicate}
            onReload={props.onReload}
            onTogglePin={props.onTogglePin}
            onDevTools={props.onDevTools}
            onCopySymbol={props.onCopySymbol}
            onDetach={props.onDetach}
            onCustomizeTitle={props.onCustomizeTitle}
            onCloseTab={props.onClose}
            onCloseOthers={props.onCloseOthers}
            onCloseToRight={props.onCloseToRight}
            linking={() => {
              const link = props.tabs.find((t) => t.id === m().tabId)?.link;
              return link ? { color: link.color, channels: groupChannels(link.color) } : null;
            }}
            onLink={props.onLink}
            onUnlink={props.onUnlink}
            onToggleChannel={props.onToggleChannel}
          />
        )}
      </Show>
    </div>
  );
}
