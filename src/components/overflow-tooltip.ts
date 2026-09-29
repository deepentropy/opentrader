/*
 * Overflow tooltip — `apply-overflow-tooltip`. One document-level
 * `mouseenter` listener (capture): an element with the class shows the common
 * tooltip ONLY when its text is cut (`offsetWidth < scrollWidth`), so menu
 * labels that fit show nothing. The standard menu-row labels carry the class
 * (interval, chart type, favorite indicators, snapshot, Manage layouts,
 * template actions, drawing flyouts and option menus, watchlist menus);
 * context menus do not have it.
 *
 * Modifiers:
 *   --check-children               a direct child is cut
 *   --check-children-recursively   any descendant is cut
 *   --allow-text                   tooltip text = textContent (else: own text nodes)
 *   --direction_y / --direction_both   check the height too
 *   data-overflow-tooltip-text     explicit tooltip text
 *
 * Tooltip placement:
 * horizontal, above the element when there is room (10 px + tooltip height),
 * else below; centred, kept 10 px inside the window; 8 px from the element
 * when it is under 20 px tall (`--farther`), else 4 px; 500 ms delay; hidden
 * on mouseleave / mousedown, or when the element leaves the document. Drawn
 * with the `<Tooltip>` classes (styles/tooltip.css). Plain DOM, no reactive
 * work on hover.
 */

type Dir = "x" | "y" | "both";

const isCut = (e: HTMLElement, d: Dir): boolean =>
  ((d === "x" || d === "both") && e.offsetWidth < e.scrollWidth) ||
  ((d === "y" || d === "both") && e.offsetHeight < e.scrollHeight);

const childCut = (e: HTMLElement, d: Dir): boolean =>
  Array.from(e.children).some((c) => c instanceof HTMLElement && isCut(c, d));

const deepCut = (e: HTMLElement, d: Dir): boolean =>
  Array.from(e.children).some((c) => c instanceof HTMLElement && (isCut(c, d) || deepCut(c, d)));

const dirOf = (e: HTMLElement): Dir =>
  e.matches(".apply-overflow-tooltip--direction_both") ? "both" : e.matches(".apply-overflow-tooltip--direction_y") ? "y" : "x";

function overflowed(e: HTMLElement): boolean {
  const d = dirOf(e);
  if (e.matches(".apply-overflow-tooltip--check-children-recursively")) return deepCut(e, d);
  if (e.matches(".apply-overflow-tooltip--check-children")) return childCut(e, d);
  return isCut(e, d);
}

function textOf(e: HTMLElement): string {
  const explicit = e.getAttribute("data-overflow-tooltip-text");
  if (explicit) return explicit;
  if (e.matches(".apply-overflow-tooltip--allow-text")) return e.textContent ?? "";
  return Array.from(e.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

let tip: HTMLDivElement | null = null;
let timer: number | null = null;
let target: HTMLElement | null = null;
const observer = new MutationObserver(() => {
  if (target && !target.isConnected) hide();
});

function hide() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  tip?.remove();
  tip = null;
  observer.disconnect();
  if (target) {
    target.removeEventListener("mouseleave", hide);
    target.removeEventListener("mousedown", hide);
  }
  target = null;
}

function place(el: HTMLElement, text: string) {
  const r = el.getBoundingClientRect();
  const t = document.createElement("div");
  t.setAttribute("role", "tooltip");
  t.className = "ot-tooltip ot-tooltip-normal ot-overflow-tooltip";
  const label = document.createElement("span");
  label.className = "ot-tooltip-label";
  label.textContent = text;
  t.append(label);
  // Measure first (no side class = no transform), then place.
  t.style.left = "0px";
  t.style.top = "0px";
  t.style.visibility = "hidden";
  document.body.append(t);
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const W = document.body.clientWidth;
  const gap = r.height < 20 ? 8 : 4;
  const above = 10 + h < r.top;
  const margin = W - w - 20 <= 0 ? (W - w) / 2 : 10;
  const left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, W - margin - w));
  // The side classes translate by -50% / -100%: give them the centre / edge.
  t.classList.add(above ? "ot-tooltip-top" : "ot-tooltip-bottom");
  t.style.left = `${Math.floor(left + w / 2)}px`;
  t.style.top = `${Math.floor(above ? r.top - gap : r.bottom + gap)}px`;
  t.style.visibility = "";
  tip = t;
}

function onEnter(e: Event) {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !el.matches(".apply-overflow-tooltip")) return;
  if (!overflowed(el)) return;
  const text = textOf(el);
  if (!text) return;
  hide();
  target = el;
  el.addEventListener("mouseleave", hide);
  el.addEventListener("mousedown", hide);
  observer.observe(document, { childList: true, subtree: true });
  timer = window.setTimeout(() => {
    timer = null;
    if (target === el && el.isConnected) place(el, text);
  }, 500);
}

let installed = false;
/** Install the document listener once per window. */
export function installOverflowTooltip(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("mouseenter", onEnter, true);
}
