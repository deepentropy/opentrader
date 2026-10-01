/*
 * Right-click context menu for a tab, in this order:
 * Duplicate tab, Reload tab, Pin / Unpin
 * tab, Detach tab, Customize tab title..., Close, Close other tabs, Close tabs
 * to the right, Developer tools (Shift held), then the "Tab linking" section
 * (9-colour picker + per-channel switches). Copy symbol is an opentrader row.
 * Not shown: "Copy link" (opentrader layouts are local, there is no hosted
 * page to link to) and "Go back" / "Go forward" (opentrader tabs do not
 * navigate, so there is no navigation history).
 */
import { onCleanup, onMount, For, Show, createSignal } from "solid-js";
import { Icon, type IconName } from "../../components/Icon";
import { LINK_PALETTE, type LinkChannel, type LinkColor, type TabLinkingState } from "./tab-linking";

export type TabMenuAnchor = {
  tabId: string;
  x: number;
  y: number;
  isChart: boolean;
  isCloseOtherVisible: boolean;
  isCloseToRightVisible: boolean;
  /** Detach is offered only inside Tauri and when >1 tab exists. */
  isDetachVisible: boolean;
  pinned: boolean;
  /** Shift held when the menu opened: shows "Developer tools". */
  hasShiftKey: boolean;
};

type Row =
  | { kind: "item"; label: string; icon?: IconName; iconSize?: number | null; hotkey?: string; onClick: () => void }
  | { kind: "separator" }
  | { kind: "section"; label: string };

type Props = {
  anchor: TabMenuAnchor;
  onClose: () => void;
  onDuplicate: (id: string) => void;
  onReload: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDevTools: () => void;
  onCopySymbol: (id: string) => void;
  onDetach: (id: string, screenX: number, screenY: number) => void;
  onCustomizeTitle: () => void;
  onCloseTab: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  /** Live link state of THIS tab (reactive) — drives the syncing widget. */
  linking: () => TabLinkingState | null;
  onLink: (id: string, color: LinkColor) => void;
  onUnlink: (id: string) => void;
  onToggleChannel: (id: string, channel: LinkChannel) => void;
};

export function TabContextMenu(props: Props) {
  const a = props.anchor;
  const [pos, setPos] = createSignal({ left: a.x, top: a.y });
  let root!: HTMLDivElement;

  onMount(() => {
    // Clamp into the viewport after first paint.
    const r = root.getBoundingClientRect();
    let left = a.x;
    let top = a.y;
    if (left + r.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - r.width - 4);
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left, top });

    const onDown = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) props.onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    });
  });

  const id = a.tabId;
  const rows = (): Row[] => [
    { kind: "item", label: "Duplicate tab", icon: "tab-chart", hotkey: "Ctrl+U", onClick: () => props.onDuplicate(id) },
    { kind: "item", label: "Reload tab", icon: "tab-menu-reload", hotkey: "Ctrl+R", onClick: () => props.onReload(id) },
    {
      kind: "item",
      label: a.pinned ? "Unpin tab" : "Pin tab",
      // The pin glyphs draw at their own size (15x20 / 20x21).
      icon: a.pinned ? "tab-menu-unpin" : "tab-menu-pin",
      iconSize: null,
      onClick: () => props.onTogglePin(id),
    },
    ...(a.isChart
      ? [{ kind: "item" as const, label: "Copy symbol", onClick: () => props.onCopySymbol(id) }]
      : []),
    ...(a.isDetachVisible
      ? [{
          kind: "item" as const,
          label: "Detach tab",
          icon: "tab-new" as IconName,
          onClick: () => props.onDetach(id, a.x + window.screenX, a.y + window.screenY),
        }]
      : []),
    { kind: "separator" as const },
    { kind: "item", label: "Customize tab title…", icon: "settings-tabs", onClick: () => props.onCustomizeTitle() },
    { kind: "separator" as const },
    { kind: "item", label: "Close", hotkey: "Ctrl+W", onClick: () => props.onCloseTab(id) },
    ...(a.isCloseOtherVisible
      ? [{ kind: "item" as const, label: "Close other tabs", onClick: () => props.onCloseOthers(id) }]
      : []),
    ...(a.isCloseToRightVisible
      ? [{ kind: "item" as const, label: "Close tabs to the right", onClick: () => props.onCloseToRight(id) }]
      : []),
    // Developer tools: debug builds only (the open_devtools command is a
    // debug-build feature).
    ...(a.hasShiftKey && import.meta.env.DEV
      ? [{ kind: "item" as const, label: "Developer tools", onClick: () => props.onDevTools() }]
      : []),
    ...(a.isChart
      ? [{ kind: "separator" as const }, { kind: "section" as const, label: "Tab linking" }]
      : []),
  ];

  return (
    <div
      ref={root}
      class="ot-popover tab-context-menu"
      role="menu"
      style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "z-index": 9000 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div class="tab-menu-list">
        <For each={rows()}>
          {(row) => (
            <Show
              when={row.kind === "item" ? row : null}
              fallback={
                row.kind === "section" ? (
                  <div class="tab-menu-section-label">{(row as { label: string }).label}</div>
                ) : (
                  <div class="tab-menu-separator" />
                )
              }
            >
              {(item) => (
                <div
                  class="tab-menu-item"
                  role="menuitem"
                  onClick={() => { item().onClick(); props.onClose(); }}
                >
                  <span class="tab-menu-item-icon">
                    <Show when={item().icon}>
                      {(ic) => <Icon name={ic()} size={item().iconSize === null ? undefined : (item().iconSize ?? 18)} />}
                    </Show>
                  </span>
                  <span class="tab-menu-item-title">{item().label}</span>
                  <span class="tab-menu-item-hotkey">{item().hotkey ?? ""}</span>
                </div>
              )}
            </Show>
          )}
        </For>

        <Show when={a.isChart}>
          <LinkingSection
            state={props.linking}
            onColorClick={(color) =>
              props.linking()?.color === color ? props.onUnlink(id) : props.onLink(id, color)
            }
            onChannelToggle={(ch) => props.onToggleChannel(id, ch)}
          />
        </Show>
      </div>
    </div>
  );
}

/*
 * Tab syncing widget — 9-colour picker (clicking the active colour unlinks),
 * then per-channel switches that appear once a colour is active. Clicks here do
 * NOT close the menu, so the user can chain colour + channel changes.
 */
const CHANNELS: { key: LinkChannel; label: string }[] = [
  { key: "symbol", label: "Symbol" },
  { key: "interval", label: "Interval" },
  { key: "time", label: "Time" },
  { key: "dateRange", label: "Date range" },
];

function LinkingSection(props: {
  state: () => TabLinkingState | null;
  onColorClick: (color: LinkColor) => void;
  onChannelToggle: (channel: LinkChannel) => void;
}) {
  const active = () => props.state();
  return (
    <>
      <ul class="linking-color-picker" role="radiogroup" aria-label="Tab link color">
        <For each={LINK_PALETTE}>
          {({ color, backgroundColor }) => {
            const isActive = () => active()?.color === color;
            return (
              <li>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive()}
                  aria-label={color}
                  class={"linking-color-button" + (isActive() ? " active" : "")}
                  style={{ "background-color": backgroundColor }}
                  onClick={() => props.onColorClick(color)}
                >
                  <Show when={isActive()}>
                    <span class="linking-color-button-icon" aria-hidden="true">
                      <svg viewBox="0 0 18 18" width="14" height="14">
                        <path d="M14.5 5.6 7 13l-3.4-3.4 1.1-1.1L7 10.8l6.4-6.3 1.1 1.1z" fill="currentColor" />
                      </svg>
                    </span>
                  </Show>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={active()}>
        {(st) => (
          <For each={CHANNELS}>
            {(ch) => {
              const checked = () => st().channels[ch.key];
              return (
                <div
                  class="tab-menu-item linking-channel-switch"
                  role="menuitemcheckbox"
                  aria-checked={checked()}
                  onClick={() => props.onChannelToggle(ch.key)}
                >
                  <span class="tab-menu-item-icon" />
                  <span class="tab-menu-item-title">{ch.label}</span>
                  <span class={"switch-view" + (checked() ? " checked" : "")} role="switch" aria-checked={checked()}>
                    <span class="switch-thumb" />
                  </span>
                </div>
              );
            }}
          </For>
        )}
      </Show>
    </>
  );
}
