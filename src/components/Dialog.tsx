/*
 * Dialog shell: the layer under a dialog, the dialog box, its title bar with the close button, and Escape (plus an
 * optional Enter). Each family of dialogs keeps its own look through `look` (the class names of its title bar). The
 * title bar carries `data-dialog-title`, by which dialog-drag moves the dialog.
 *
 * `createDialogKeys` and `DialogClose` are the same pieces for a dialog whose frame does not fit the shell.
 */
import { Show, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";

type CloseIcon = "x18" | "x24" | "x16" | "x14";

/** Close button glyphs, one per family. */
const CLOSE_ICONS: Record<CloseIcon, () => JSX.Element> = {
  x18: () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
    </svg>
  ),
  x24: () => (
    <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
      <path fill="currentColor" d="M19.78 8.22 14 14l5.78 5.78-1.06 1.06L13 15.06l-5.78 5.78-1.06-1.06L11.94 14 6.16 8.22l1.06-1.06L13 12.94l5.72-5.78 1.06 1.06Z" />
    </svg>
  ),
  x16: () => (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.5" d="m3 3 10 10M13 3 3 13" />
    </svg>
  ),
  x14: () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 11 11m0-11-11 11" />
    </svg>
  ),
};

type Look = {
  /** Title bar around the title and the close button; none: the title is the bar, the close button sits after it. */
  header?: string;
  headerTag?: "header" | "div";
  title: string;
  titleTag?: "span" | "div";
  close: string;
  closeLabel: string;
  icon: CloseIcon;
};

/** Title bars of the dialog families. */
const LOOKS = {
  /** Settings dialogs (chart, screener). */
  settings: { header: "cp3-header", title: "cp3-header-title", close: "cp3-close", closeLabel: "Close menu", icon: "x18" },
  /** Prompts and small forms (confirm, rename, import). */
  prompt: { title: "ot-dlg-title", close: "ot-dlg-close", closeLabel: "close", icon: "x18" },
  watchlist: { header: "wl-dialog-header", title: "wl-dialog-title", titleTag: "span", close: "wl-dialog-close", closeLabel: "Close", icon: "x18" },
  /** Layout name, custom interval, chart data download. */
  form: { header: "layout-name-titlebar", headerTag: "div", title: "layout-name-title", close: "layout-name-close", closeLabel: "Close", icon: "x24" },
  "layout-browser": { header: "layout-browser-header", title: "layout-browser-title", titleTag: "span", close: "layout-browser-close", closeLabel: "Close", icon: "x18" },
  "screen-browser": { header: "scr-open-header", title: "scr-open-title", titleTag: "span", close: "scr-open-close", closeLabel: "Close menu", icon: "x14" },
  indicators: { header: "indicators-header", title: "indicators-title", close: "indicators-close", closeLabel: "Close menu", icon: "x18" },
  /** Drawing Settings and Image: their own frame (a rename field in the title bar), only the close button here. */
  drawing: { header: "drawing-settings-header", title: "drawing-settings-title", close: "drawing-settings-close", closeLabel: "Close menu", icon: "x18" },
  "symbol-search": { header: "symbol-search-header", title: "symbol-search-title", titleTag: "span", close: "symbol-search-close", closeLabel: "Close menu", icon: "x18" },
  "app-settings": { header: "app-settings-header", headerTag: "div", title: "app-settings-dialog-title", titleTag: "span", close: "app-settings-close", closeLabel: "Close", icon: "x16" },
} satisfies Record<string, Look>;

export type DialogLook = keyof typeof LOOKS;

/** Where the dialog's keys are heard. Default: the window, capture phase (before the chart's own keys). A dialog
 *  whose popovers must take Escape first listens in the bubble phase. */
export type DialogKeyTarget = { target?: "window" | "document"; capture?: boolean };

/** Escape (and Enter) for a dialog. `onEscape` returning false leaves the key alone (a nested menu takes it);
 *  otherwise it is stopped there. */
export function createDialogKeys(opts: {
  onEscape?: (e: KeyboardEvent) => boolean | void;
  onEnter?: (e: KeyboardEvent) => void;
} & DialogKeyTarget) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && opts.onEscape) {
        if (opts.onEscape(e) === false) return;
        e.stopPropagation();
      } else if (e.key === "Enter" && opts.onEnter) {
        e.stopPropagation();
        opts.onEnter(e);
      }
    };
    const target = opts.target === "document" ? document : window;
    const capture = opts.capture ?? true;
    target.addEventListener("keydown", onKey as EventListener, capture);
    onCleanup(() => target.removeEventListener("keydown", onKey as EventListener, capture));
  });
}

/** The close button of a dialog family. */
export function DialogClose(props: { look: DialogLook; onClick: () => void; label?: string }) {
  const look = (): Look => LOOKS[props.look];
  return (
    <button type="button" class={look().close} data-qa-id="close" aria-label={props.label ?? look().closeLabel} onClick={() => props.onClick()}>
      {CLOSE_ICONS[look().icon]()}
    </button>
  );
}

type DialogProps = {
  look: DialogLook;
  title: JSX.Element;
  /** Accessible name (default: the title when it is text). */
  label?: string;
  onClose: () => void;
  /** Title class when the dialog's title differs from its family's. */
  titleClass?: string;
  /** Between the title and the close button. */
  headerExtra?: JSX.Element;
  /** The title bar moves the dialog (default true). */
  draggable?: boolean;
  /** Layer under the dialog and what a press on it does: "close" (mouse down on it closes), "close-self" (a
   *  pointer down on the layer itself closes) or "block" (presses stop there, nothing closes). */
  layerClass: string;
  backdrop: "close" | "close-self" | "block";
  /** Render in place instead of at the end of the document. */
  inline?: boolean;
  /** Escape: default closes; return false to leave the key to a nested menu. `false`: the dialog handles it. */
  onEscape?: ((e: KeyboardEvent) => boolean | void) | false;
  onEnter?: (e: KeyboardEvent) => void;
  keys?: DialogKeyTarget;
  class: string;
  children: JSX.Element;
} & Omit<JSX.HTMLAttributes<HTMLDivElement>, "title" | "class" | "children">;

export function Dialog(props: DialogProps) {
  const [own, box] = splitProps(props, [
    "look", "title", "label", "onClose", "titleClass", "headerExtra", "draggable", "layerClass", "backdrop", "inline",
    "onEscape", "onEnter", "keys", "class", "children",
  ]);
  const look = (): Look => LOOKS[own.look];
  createDialogKeys({
    onEscape: own.onEscape === false ? undefined : (e) => (own.onEscape ? own.onEscape(e) : own.onClose()),
    onEnter: own.onEnter,
    ...own.keys,
  });
  const dragAttr = () => (own.draggable === false ? undefined : "");
  const title = () => (
    <Dynamic component={look().titleTag ?? "div"} class={own.titleClass ?? look().title} data-dialog-title={look().header ? undefined : dragAttr()}>
      {own.title}
    </Dynamic>
  );
  const bar = () => (
    <Show
      when={look().header}
      fallback={<>{title()}{own.headerExtra}<DialogClose look={own.look} onClick={own.onClose} /></>}
    >
      {(cls) => (
        <Dynamic component={look().headerTag ?? "header"} class={cls()} data-dialog-title={dragAttr()}>
          {title()}
          {own.headerExtra}
          <DialogClose look={own.look} onClick={own.onClose} />
        </Dynamic>
      )}
    </Show>
  );
  const layer = () => (
    <div
      class={own.layerClass}
      role="presentation"
      onMouseDown={(e) => { if (own.backdrop === "close") own.onClose(); else if (own.backdrop === "block") e.stopPropagation(); }}
      onPointerDown={(e) => {
        if (own.backdrop === "close-self" && e.target === e.currentTarget) own.onClose();
        else if (own.backdrop === "block") e.stopPropagation();
      }}
    >
      <div
        {...box}
        class={own.class}
        role="dialog"
        aria-label={own.label ?? (typeof own.title === "string" ? own.title : undefined)}
        onMouseDown={own.backdrop === "close" ? (e) => e.stopPropagation() : undefined}
      >
        {bar()}
        {own.children}
      </div>
    </div>
  );
  return own.inline ? layer() : <Portal mount={document.body}>{layer()}</Portal>;
}
