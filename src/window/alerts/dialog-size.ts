/*
 * Size and place of the alert dialog, the reference dialog's rule:
 *  - the height is the content's (header + body + footer), at least the
 *    header and footer plus a soft minimum for the body (so a short view,
 *    e.g. the alert name alone, keeps a usual dialog height), at most the
 *    window less a guard above and below; then within the body's hard
 *    minimum / maximum when set;
 *  - on open the dialog is centred in the window;
 *  - when the content changes (another view, a row shown or hidden) the
 *    height follows it at once; a dialog that grows is moved back into the
 *    window if it would cross an edge, one that shrinks stays where it is
 *    (top left kept).
 * The soft minimum, hard minimum / maximum and the guards are CSS custom
 * properties of the dialog element (see alert-dialog.css).
 */

export type DialogLimits = {
  /** Soft minimum of the body (the window can make the dialog smaller). */
  softMinBody: number | null;
  minBody: number | null;
  maxBody: number | null;
  /** Space kept free between the dialog and the window edges. */
  guardX: number;
  guardY: number;
};

export type DialogBox = { x: number; y: number; width: number; height: number };

const clamp = (v: number, lo: number | null, hi: number | null) => {
  let r = v;
  if (lo !== null) r = Math.max(r, lo);
  if (hi !== null) r = Math.min(r, hi);
  return r;
};

/** Height of a dialog whose header + footer measure `chrome` and whose
 *  content (all three parts) measures `full`. */
export function fitHeight(full: number, chrome: number, lim: DialogLimits, winH: number): number {
  const room = winH - 2 * lim.guardY;
  const h = clamp(full, lim.softMinBody !== null ? chrome + lim.softMinBody : null, room);
  return clamp(h, lim.minBody !== null ? chrome + lim.minBody : null, lim.maxBody !== null ? chrome + lim.maxBody : null);
}

/** The dialog centred in the window (on open). */
export function centredBox(width: number, height: number, lim: DialogLimits, winW: number, winH: number): DialogBox {
  const roomW = winW - 2 * lim.guardX;
  const roomH = winH - 2 * lim.guardY;
  return { x: (roomW - width) / 2 + lim.guardX, y: (roomH - height) / 2 + lim.guardY, width, height };
}

/** A grown dialog moved back into the window (its top left otherwise kept). */
export function keepInWindow(box: DialogBox, lim: DialogLimits, winW: number, winH: number): DialogBox {
  const maxX = Math.max(winW - box.width - lim.guardX, lim.guardX);
  const maxY = Math.max(winH - box.height - lim.guardY, lim.guardY);
  return { ...box, x: clamp(box.x, lim.guardX, maxX), y: clamp(box.y, lim.guardY, maxY) };
}

function cssPx(style: CSSStyleDeclaration, name: string): number | null {
  const v = style.getPropertyValue(name).trim();
  if (v === "" || v === "none") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Keep `dialog` sized and placed by the rule above. Its children are the
 *  current view's header (`.ad-header`), body (`.ad-body`) and footer
 *  (`.ad-footer`). Returns the cleanup. */
export function attachDialogSize(dialog: HTMLElement): () => void {
  let box: DialogBox | null = null;
  let lastFull = 0;
  let frame = 0;

  const limits = (): DialogLimits => {
    const s = getComputedStyle(dialog);
    return {
      softMinBody: cssPx(s, "--ad-body-soft-min-height"),
      minBody: cssPx(s, "--ad-body-min-height"),
      maxBody: cssPx(s, "--ad-body-max-height"),
      guardX: cssPx(s, "--ad-horizontal-guard") ?? 0,
      guardY: cssPx(s, "--ad-vertical-guard") ?? 0,
    };
  };
  const part = (sel: string) => dialog.querySelector<HTMLElement>(`:scope > ${sel}`);
  /** Header + footer, and the whole content at its natural height. */
  const measure = () => {
    const header = Math.ceil(part(".ad-header")?.getBoundingClientRect().height ?? 0);
    const footer = Math.ceil(part(".ad-footer")?.getBoundingClientRect().height ?? 0);
    const body = part(".ad-body");
    let content = 0;
    if (body) {
      // Its natural height: not shrunk to the dialog (a capped dialog scrolls it). Its scroll height
      // would count the open dropdowns, which overflow it.
      const shrink = body.style.flexShrink;
      body.style.flexShrink = "0";
      content = Math.ceil(body.getBoundingClientRect().height);
      body.style.flexShrink = shrink;
    }
    return { chrome: header + footer, full: header + footer + content };
  };
  const apply = (b: DialogBox, capped: boolean) => {
    box = b;
    dialog.style.left = "0px";
    dialog.style.top = "0px";
    dialog.style.height = `${Math.ceil(b.height)}px`;
    dialog.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    dialog.classList.toggle("is-capped", capped);
  };
  const layout = () => {
    const { chrome, full } = measure();
    const lim = limits();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const height = fitHeight(full, chrome, lim, winH);
    const capped = height < full;
    const width = dialog.getBoundingClientRect().width;
    if (!box) apply(keepInWindow(centredBox(width, height, lim, winW, winH), lim, winW, winH), capped);
    else if (full > lastFull) apply(keepInWindow({ ...box, width, height }, lim, winW, winH), capped);
    else if (full < lastFull || height !== box.height) apply({ ...box, width, height }, capped);
    lastFull = full;
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  };

  // The parts of the current view (they change with the view) and the rows of its body.
  const ro = new ResizeObserver(schedule);
  const observeParts = () => {
    ro.disconnect();
    for (const el of [part(".ad-header"), part(".ad-body"), part(".ad-footer")]) if (el) ro.observe(el);
    for (const el of part(".ad-body")?.children ?? []) ro.observe(el);
  };
  const mo = new MutationObserver(() => {
    observeParts();
    schedule();
  });
  mo.observe(dialog, { childList: true, subtree: true });
  observeParts();
  layout();
  window.addEventListener("resize", schedule);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    ro.disconnect();
    mo.disconnect();
    window.removeEventListener("resize", schedule);
  };
}
