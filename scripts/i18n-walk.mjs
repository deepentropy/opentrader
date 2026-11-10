// The screen walk (#289): drives the running development app over CDP through its screens, menus, dialogs and
// panels in the pseudo-language, and reports for each state
//   - the text left in English: visible text and title / placeholder attributes outside the pseudo markers ⟦…⟧,
//   - the text cut by its box: clipped by an ancestor that hides its overflow (ellipsis reported apart), or wider
//     than its own box,
//   - the development build's miss list (window.__i18nMisses()).
// It writes .tmp/i18n-walk/report.json, report.md and a screenshot of each state with a problem (the problems
// outlined), then restores the app: dialogs closed, the panels as they were, the study, strategy, drawing and alert
// it added removed by id, the language put back.
//
//   npm run i18n:walk -- [cdp-port=9231] [--only=name,name] [--keep-language] [--no-shots] [--ignore=<regexp>]
//
// The dev app with CDP: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 npx tauri dev. The study,
// strategy, drawing and alert are added through the app's agent tools (Settings > Coding agents), switched on for
// the walk when they are off. Visible text is translated, so the walk finds elements by data-name, data-qa-id,
// aria-label and class, never by their text.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".tmp", "i18n-walk");
const PSEUDO = "Pseudo";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => flag(name)?.split("=").slice(1).join("=");
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 9231);
const ONLY = flagValue("only")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const KEEP_LANGUAGE = !!flag("keep-language");
const SHOTS = !flag("no-shots");
const IGNORE = flagValue("ignore") ? new RegExp(flagValue("ignore")) : null;

const CATALOG = JSON.parse(readFileSync(join(ROOT, "src", "i18n", "catalog.json"), "utf8"));
const ENDING = /(\s*(?:…|\.\.\.|:|：))$/;
const inCatalog = (text) => {
  const t = text.trim();
  return t in CATALOG || (ENDING.test(t) && t.replace(ENDING, "") in CATALOG);
};

// ── CDP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

let ws;
let seq = 0;
const pending = new Map();

async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    throw new Error(`No CDP endpoint on port ${PORT}: start the dev app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT}.`);
  }
  const pages = targets.filter((t) => t.type === "page" && !/[?&]view=screener/.test(t.url));
  const page = pages.find((t) => /localhost:1420|127\.0\.0\.1:1420/.test(t.url)) ?? pages[0];
  if (!page) throw new Error("No page target.");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return page.url;
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluates an expression in the page (awaited), its value returned. */
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);

const exists = (sel) => ev(`!!document.querySelector(${q(sel)})`);

async function waitFor(sel, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await exists(sel)) return true;
    await sleep(100);
  }
  throw new Error(`not shown: ${sel}`);
}

async function waitGone(sel, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await exists(sel))) return true;
    await sleep(100);
  }
  return false;
}

/** element.click() on the nth match. */
async function click(sel, nth = 0) {
  const ok = await ev(`(() => { const el = document.querySelectorAll(${q(sel)})[${nth}]; if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`nothing to click: ${sel}${nth ? ` #${nth}` : ""}`);
  await sleep(250);
}

const count = (sel) => ev(`document.querySelectorAll(${q(sel)}).length`);

async function centerOf(sel) {
  const r = await ev(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })()`);
  if (!r) throw new Error(`not found: ${sel}`);
  return r;
}

/** A real mouse click at a point (pointer events, hit testing). */
async function mouseAt(x, y, { button = "left", clickCount = 1 } = {}) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
  await sleep(300);
}

const KEYS = { Escape: ["Escape", 27], ",": ["Comma", 188], Enter: ["Enter", 13] };

async function key(k, { ctrl = false, shift = false, alt = false } = {}) {
  const [code, vk] = KEYS[k] ?? [`Key${k.toUpperCase()}`, k.toUpperCase().charCodeAt(0)];
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(250);
}

/** A press outside every popover (they close on pointerdown / mousedown outside). */
async function outside() {
  await ev(`(() => { for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) document.body.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { bubbles: true, clientX: 1, clientY: 1 })); })()`);
  await sleep(200);
}

/** Escape until the selector is gone, then a press outside. */
async function dismiss(sel) {
  for (let i = 0; i < 3 && (await exists(sel)); i++) await key("Escape");
  if (await exists(sel)) await outside();
}

async function screenshot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
}

// ── In the page: what is left in English, what is cut ──────────────────────────────────────────────────────────

const PAGE_HELPER = String.raw`(() => {
  const MARKED = /⟦[^⟦⟧]*⟧/g;
  /** Words that are not interface text: dates written by the language's formats, units, ids. */
  const NOT_WORDS = new Set("Jan Feb Mar Apr May Jun Jul Aug Sep Sept Oct Nov Dec January February March April June July August September October November December Mon Tue Wed Thu Fri Sat Sun Monday Tuesday Wednesday Thursday Friday Saturday Sunday am pm px ms".split(" "));
  const SKIP = "script,style,noscript,textarea,input,[contenteditable=''],[contenteditable=true],.cm-editor,[data-no-translate],svg title,[data-i18n-walk-ignore]";

  function leftover(text) {
    let t = text, before;
    do { before = t; t = t.replace(MARKED, " "); } while (t !== before);
    return t;
  }
  /** The English words of a text outside the markers. */
  function english(text) {
    const t = leftover(text);
    if (/^\s*(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/.test(t)) return [];
    return (t.match(/[A-Za-z][A-Za-z'’]+/g) || []).filter((w) => /[a-z]/.test(w) && !NOT_WORDS.has(w));
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const box = el.closest("select") || el;
    if (box.checkVisibility && !box.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = box.getBoundingClientRect();
    // A one-pixel box: text for screen readers.
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function pathOf(el) {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/)[0] : "";
      const name = e.getAttribute("data-name") || e.getAttribute("data-qa-id");
      parts.unshift(e.tagName.toLowerCase() + (cls ? "." + cls : "") + (name ? '[' + name + ']' : ""));
    }
    return parts.join(" > ");
  }
  const scrolls = (v) => v === "auto" || v === "scroll";
  const clips = (v) => v === "hidden" || v === "clip";

  /** How a text node is cut: clipped (or ellipsis) by an ancestor hiding its overflow, or overflowing its box. */
  function cutOf(node) {
    const el = node.parentElement;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (!rects.length) return null;
    const t = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    for (let a = el, depth = 0; a && a !== document.body && depth < 8; a = a.parentElement, depth++) {
      const cs = getComputedStyle(a);
      // A scroll container: text scrolled out of view is not cut.
      if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) break;
      if (!clips(cs.overflowX) && !clips(cs.overflowY)) continue;
      if (a.clientWidth <= 2 || a.clientHeight <= 2) return null; // visually hidden on purpose
      const b = a.getBoundingClientRect();
      const left = b.left + a.clientLeft, top = b.top + a.clientTop;
      const cutX = clips(cs.overflowX) && (t.right > left + a.clientWidth + 1 || t.left < left - 1);
      const cutY = clips(cs.overflowY) && (t.bottom > top + a.clientHeight + 2 || t.top < top - 2);
      if (cutX || cutY) return { kind: cs.textOverflow === "ellipsis" ? "ellipsis" : "clipped", axis: cutX ? "x" : "y", by: a === el ? "" : pathOf(a), el: a };
    }
    const cs = getComputedStyle(el);
    if (cs.display !== "inline" && el.clientWidth > 0 && cs.overflowX === "visible" && el.scrollWidth > el.clientWidth + 1) return { kind: "overflows", axis: "x", by: "", el };
    return null;
  }

  function collect(scopes) {
    const roots = scopes && scopes.length ? scopes.flatMap((s) => [...document.querySelectorAll(s)]) : [document.body];
    const untranslated = [], cut = [], seenText = new Set(), seenCut = new Set();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = root; n; n = walker.nextNode()) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.closest(SKIP) || !visible(n)) continue;
          for (const attr of ["title", "placeholder"]) {
            const v = n.getAttribute(attr);
            if (v && english(v).length && !seenText.has(attr + v)) {
              seenText.add(attr + v);
              untranslated.push({ text: v.trim(), attr, path: pathOf(n) });
              n.setAttribute("data-i18n-walk", "untranslated");
            }
          }
          continue;
        }
        const el = n.parentElement;
        const text = n.data.replace(/\s+/g, " ").trim();
        if (text.length < 2 || !el || el.closest(SKIP) || !visible(el)) continue;
        if (english(text).length && !seenText.has(text + "|" + pathOf(el))) {
          seenText.add(text + "|" + pathOf(el));
          untranslated.push({ text, path: pathOf(el) });
          el.setAttribute("data-i18n-walk", "untranslated");
        }
        const c = cutOf(n);
        if (c && !seenCut.has(c.el)) {
          seenCut.add(c.el);
          cut.push({ text: text.slice(0, 120), kind: c.kind, axis: c.axis, path: pathOf(el), ...(c.by ? { clippedBy: c.by } : {}) });
          if (c.kind !== "ellipsis") c.el.setAttribute("data-i18n-walk", "cut");
        }
      }
    }
    return { untranslated, cut };
  }

  function misses() {
    const list = typeof window.__i18nMisses === "function" ? window.__i18nMisses() : [];
    // A filled template holding a value ("⟦…⟧ AAPL") is looked up again by the page: not a miss.
    return list.filter((m) => !m.text.includes("⟦"));
  }

  function unmark() {
    for (const el of document.querySelectorAll("[data-i18n-walk]")) el.removeAttribute("data-i18n-walk");
  }
  function outline(on) {
    let style = document.getElementById("i18n-walk-style");
    if (on && !style) {
      style = document.createElement("style");
      style.id = "i18n-walk-style";
      style.textContent = '[data-i18n-walk="untranslated"]{outline:2px solid #f23645!important;outline-offset:-1px}[data-i18n-walk="cut"]{outline:2px dashed #ff9800!important;outline-offset:-1px}';
      document.head.appendChild(style);
    } else if (!on && style) style.remove();
  }

  /** A point on a drawing's stroke, in page coordinates. */
  function drawingPoint(id) {
    const g = document.querySelector('[data-drawing-id="' + id + '"]');
    if (!g) return null;
    const shape = g.querySelector("path, line, polyline, rect");
    if (!shape) { const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
    let p;
    if (shape.tagName === "line") p = { x: (shape.x1.baseVal.value + shape.x2.baseVal.value) / 2, y: (shape.y1.baseVal.value + shape.y2.baseVal.value) / 2 };
    else if (shape.getTotalLength) { const l = shape.getTotalLength(); const pt = shape.getPointAtLength(l / 2); p = { x: pt.x, y: pt.y }; }
    const m = shape.getScreenCTM();
    if (!p || !m) { const b = shape.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  window.__i18nWalk = { collect, misses, unmark, outline, drawingPoint };
})()`;

const inject = () => ev(PAGE_HELPER);

// ── The app's agent tools (study, strategy, drawing and alert added for the walk) ───────────────────────────────

let agent = null;
let agentWasOff = false;

async function startAgent() {
  const hasTauri = await ev(`!!window.__TAURI_INTERNALS__`);
  if (!hasTauri) return console.warn("Not the desktop app: the states needing a study, a strategy, a drawing or an alert are skipped.");
  let status = await ev(`window.__TAURI_INTERNALS__.invoke("agent_server_status")`);
  if (!status.enabled) {
    agentWasOff = true;
    status = await ev(`window.__TAURI_INTERNALS__.invoke("agent_server_set_enabled", { enabled: true })`);
    await sleep(800);
  }
  if (!status.url || !status.token) return console.warn("The agent endpoint is not available: the states needing it are skipped.");
  agent = status;
}

async function stopAgent() {
  if (agentWasOff) await ev(`window.__TAURI_INTERNALS__.invoke("agent_server_set_enabled", { enabled: false })`).catch(() => {});
}

async function tool(name, argsObj = {}) {
  if (!agent) throw new Error("agent tools unavailable");
  const r = await fetch(agent.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agent.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: argsObj } }),
  });
  const body = await r.text();
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    throw new Error(`${name}: HTTP ${r.status} ${body.slice(0, 200)}`);
  }
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const text = j.result?.content?.[0]?.text ?? "";
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What the walk added, removed at the end by id. */
const added = { studies: [], drawings: [], alerts: [] };

async function addStudy(id) {
  const r = await tool("add_indicator", { id });
  added.studies.push(r.studyId);
  await sleep(1200);
  return r.studyId;
}

/** The first row of a list a tool answers, wherever the tool puts it. */
const rowsOf = (r) => (Array.isArray(r) ? r : (Object.values(r ?? {}).find(Array.isArray) ?? []));

// ── The states ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A state: `open` brings it on screen and gives the selectors to check (none: the whole page), `close` puts the app
 * back. `tabs`: a selector of tab buttons inside the state, each tab checked as a state of its own.
 */
const STATES = [];
const state = (name, def) => STATES.push({ name, ...def });

const RAIL = (id) => `nav.right-rail-tabs button[data-name="${id}"]`;
const railOn = (id) => ev(`document.querySelector(${q(RAIL(id))})?.getAttribute("aria-pressed") === "true"`);

/** A header dropdown: opened and closed by its button. */
function headerMenu(name, id) {
  state(name, {
    open: async () => {
      await click(`[data-name="${id}"]`);
      await waitFor(`[data-menu-id="${id}"]`);
      return [`[data-menu-id="${id}"]`];
    },
    close: () => dismiss(`[data-menu-id="${id}"]`),
  });
}

/** A popover or menu opened by a click on `opener`. */
function popover(name, opener, root, extra = {}) {
  state(name, {
    ...extra,
    open: async () => {
      if (extra.before) await extra.before();
      await click(opener);
      await waitFor(root);
      return [root];
    },
    close: async () => {
      await dismiss(root);
      if (extra.after) await extra.after();
    },
  });
}

/** A right-rail panel: its button toggles it. */
async function openRail(id, root) {
  if (!(await exists(RAIL(id)))) throw new Error(`skip: no ${id} button`);
  if (!(await railOn(id)) || !(await exists(root))) await click(RAIL(id));
  await waitFor(root, 6000);
}
async function closeRail(id) {
  if (await railOn(id)) await click(RAIL(id));
}

// Main window.
state("main window", { open: async () => [] });

// Header.
headerMenu("header › interval menu", "chart-interval");
headerMenu("header › chart type menu", "candles");
headerMenu("header › layout setup menu", "layout-setup");
headerMenu("header › layouts menu", "save-load-menu");
headerMenu("header › snapshot menu", "take-a-snapshot");
headerMenu("header › favorite indicators menu", "show-favorite-indicators");
headerMenu("header › indicator templates menu", "indicator-templates");
state("header › symbol search", {
  open: async () => {
    await click('[data-name="symbol-search"]');
    await waitFor('[data-name="symbol-search-items-dialog"]');
    return ['[data-name="symbol-search-items-dialog"]'];
  },
  tabs: ".symbol-search-tabs .symbol-search-tab",
  close: () => dismiss('[data-name="symbol-search-items-dialog"]'),
});
state("header › compare", {
  open: async () => {
    await click('[data-name="compare-symbols"]');
    await waitFor('[data-name="compare-dialog"]');
    return ['[data-name="compare-dialog"]'];
  },
  close: () => dismiss('[data-name="compare-dialog"]'),
});
state("header › indicators", {
  open: async () => {
    await click('[data-name="open-indicators-dialog"]');
    await waitFor('[data-name="indicators-dialog"]');
    return ['[data-name="indicators-dialog"]'];
  },
  tabs: ['[data-qa-id^="indicator-sidebar-item-"]', '[data-qa-id="indicators-type-tabs"] [data-filter]'],
  close: () => dismiss('[data-name="indicators-dialog"]'),
});
state("header › create alert", {
  open: async () => {
    await click('[data-name="create-alert"]');
    await waitFor(".ad[role=dialog]");
    return [".ad[role=dialog]"];
  },
  close: async () => {
    if (await exists('.ad [data-name="cancel"]')) await click('.ad [data-name="cancel"]');
    await dismiss(".ad[role=dialog]");
  },
});
state("header › replay", {
  open: async () => {
    await click('[data-name="header-toolbar-replay"]');
    await sleep(600);
    // A saved replay asks first: that question is a state too, then a new start.
    if (await exists(".ot-dlg")) {
      const confirm = await collectState([".ot-dlg"]);
      if (await exists(".ot-dlg .ot-dlg-btn.is-secondary")) await click(".ot-dlg .ot-dlg-btn.is-secondary");
      extraStates.push({ name: "header › replay › resume question", ...confirm });
    }
    await waitFor('[data-name="replay-bottom-toolbar"]', 6000);
    return ['[data-name="replay-bottom-toolbar"]', '[data-name="replay-trading-tab"]'];
  },
  close: async () => {
    if (await exists('[data-name="replay-bottom-toolbar"]')) await click('[data-name="header-toolbar-replay"]');
    await waitGone('[data-name="replay-bottom-toolbar"]');
  },
});
state("header › load layout", {
  open: async () => {
    await click('[data-name="save-load-menu"]');
    await waitFor('[data-name="save-load-menu-item-load"]');
    await click('[data-name="save-load-menu-item-load"]');
    await waitFor(".layout-browser");
    return [".layout-browser"];
  },
  close: async () => {
    if (await exists(".layout-browser-close")) await click(".layout-browser-close");
    await dismiss(".layout-browser");
    await dismiss('[data-menu-id="save-load-menu"]');
  },
});
state("header › chart settings", {
  open: async () => {
    await click('[data-name="header-toolbar-properties"]');
    await waitFor('[data-qa-id="series-properties-dialog"]');
    return ['[data-qa-id="series-properties-dialog"]'];
  },
  tabs: ".cp3-tabs [data-qa-id]",
  close: async () => {
    if (await exists(".cp3-close")) await click(".cp3-close");
    await dismiss('[data-qa-id="series-properties-dialog"]');
  },
});
popover("header › profile menu", '[data-qa-id="main-menu-button"]', ".profile-menu");
state("header › app settings", {
  open: async () => {
    await key(",", { ctrl: true });
    if (!(await exists(".app-settings-dialog"))) {
      await click('[data-qa-id="main-menu-button"]');
      await click(".profile-menu .profile-menu-row", 0);
    }
    await waitFor(".app-settings-dialog");
    return [".app-settings-dialog"];
  },
  tabs: ".app-settings-tab",
  close: async () => {
    if (await exists(".app-settings-close")) await click(".app-settings-close");
    await dismiss(".app-settings-dialog");
    await dismiss(".profile-menu");
  },
});

// Bottom bar.
state("bottom bar › go to", {
  open: async () => {
    await click('[data-name="go-to-date"]');
    await waitFor('[data-name="go-to-date-dialog"]');
    return ['[data-name="go-to-date-dialog"]'];
  },
  tabs: ".goto-dialog-tab",
  close: async () => {
    if (await exists(".goto-dialog-close")) await click(".goto-dialog-close");
    await dismiss('[data-name="go-to-date-dialog"]');
  },
});
popover("bottom bar › time zone menu", '[data-name="time-zone-menu"]', ".tz-menu-wrap");
popover("bottom bar › session menu", '[data-name="session-menu"]', ".session-menu");

// Right rail: watchlist.
state("watchlist", { open: async () => (await openRail("base", "aside.watchlist"), ["aside.watchlist"]) });
popover("watchlist › lists menu", '[data-name="watchlists-button"]', ".watchlist-menu", { before: () => openRail("base", "aside.watchlist") });
popover("watchlist › settings menu", 'aside.watchlist [data-name="settings-button"]', ".watchlist-settings", { before: () => openRail("base", "aside.watchlist") });
popover("watchlist › details menu", '[data-name="details-settings-button"]', ".watchlist-detail-popover", { before: () => openRail("base", "aside.watchlist") });
state("watchlist › add symbol", {
  open: async () => {
    await openRail("base", "aside.watchlist");
    await click('[data-name="add-symbol-button"]');
    await waitFor('[data-name="watchlist-symbol-search-dialog"]');
    return ['[data-name="watchlist-symbol-search-dialog"]'];
  },
  close: () => dismiss('[data-name="watchlist-symbol-search-dialog"]'),
});
state("watchlist › row menu", {
  open: async () => {
    await openRail("base", "aside.watchlist");
    const row = ".watchlist-rows [role=row][data-item-id]";
    await waitFor(row);
    await ev(`(() => { const el = document.querySelector(${q(row)}); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + 20, clientY: b.top + b.height / 2 })); })()`);
    await waitFor(".watchlist-ctx-menu");
    return [".watchlist-ctx-menu"];
  },
  close: () => dismiss(".watchlist-ctx-menu"),
});

// Right rail: alerts (an alert added to see a row and edit it).
state("alerts", {
  open: async () => (await openRail("alerts", "aside.alerts-panel"), ["aside.alerts-panel"]),
  tabs: ".alerts-panel-tabs [role=tab]",
  close: () => click(".alerts-panel-tabs [role=tab]", 0).catch(() => {}),
});
popover("alerts › sort menu", '[data-name="alert-sort-button"]', ".alerts-panel-menu--sort", { before: () => openRail("alerts", "aside.alerts-panel") });
popover("alerts › settings menu", '[data-name="alerts-settings-button"]', ".alerts-panel-menu", { before: () => openRail("alerts", "aside.alerts-panel") });
state("alerts › edit alert", {
  needsAgent: true,
  open: async () => {
    await openRail("alerts", "aside.alerts-panel");
    await click(".alerts-panel-tabs [role=tab]", 0);
    // An alert to edit: one added (and deleted at the end) when there is none.
    if (!(await exists('[data-name="alert-rule-item"]'))) {
      const bars = await tool("get_bars", { limit: 1 });
      const last = bars.rows?.at(-1)?.[4] ?? 100;
      const r = await tool("create_alert", { condition: "crossing", value: Math.round(last * 150) / 100, name: "i18n walk" });
      const id = r.id ?? r.alert?.id ?? r.alertId;
      if (id) added.alerts.push(id);
      await openRail("alerts", "aside.alerts-panel");
    }
    await waitFor('[data-name="alert-rule-item"]');
    await click('[data-name="alert-rule-item"] [data-name="alert-edit-button"]');
    await waitFor(".ad[role=dialog]");
    return [".ad[role=dialog]"];
  },
  close: async () => {
    if (await exists('.ad [data-name="cancel"]')) await click('.ad [data-name="cancel"]');
    await dismiss(".ad[role=dialog]");
  },
});

// Right rail: object tree and data window.
state("object tree", {
  open: async () => (await openRail("object_tree", "aside.object-tree-panel"), ["aside.object-tree-panel"]),
  tabs: ".object-tree-panel .ot-segmented-control__segment",
  close: () => click(".object-tree-panel .ot-segmented-control__segment", 0).catch(() => {}),
});

// Screener.
const SCREENER = "section.scr-panel:not(.asst-panel)";
const openScreener = () => openRail("screener-dialog-button", SCREENER);
state("screener", { open: async () => (await openScreener(), [SCREENER]) });
popover("screener › screen menu", '[data-name="screener-topbar-screen-title"]', ".scr-screen-menu", { before: openScreener });
popover("screener › add filter", ".scr-pills-controls button:first-child", ".scr-category-menu", { before: openScreener });
popover("screener › market", ".scr-pill--market .scr-pill-main", ".scr-market-pop", { before: openScreener });
popover("screener › first filter", '[data-name^="screener-filter-pill-"]', ".scr-popover", { before: openScreener });
popover("screener › column sets", ".scr-column-sets-btn", ".scr-sets-menu", { before: openScreener });
popover("screener › view type", ".scr-view-type-btn", ".scr-popover", { before: openScreener });
popover("screener › add column", ".scr-setup-btn", ".scr-category-menu", { before: openScreener });
popover("screener › column menu", "th.scr-th[data-field]", ".scr-popover", { before: openScreener });
state("screener › close", { open: async () => (await closeRail("screener-dialog-button"), []), check: false });

// Community, assistant.
state("community", { open: async () => (await openRail("community", "aside.cm-panel"), ["aside.cm-panel"]) });
popover("community › more menu", 'aside.cm-panel .ot-icon-button[aria-label="More"]', ".cm-menu", { before: () => openRail("community", "aside.cm-panel") });
state("assistant", {
  open: async () => (await openRail("assistant-button", "section.asst-panel"), ["section.asst-panel"]),
  close: () => closeRail("assistant-button"),
});
popover("assistant › chat menu", ".asst-chat-title", ".asst-chat-menu", {
  before: () => openRail("assistant-button", "section.asst-panel"),
  after: () => closeRail("assistant-button"),
});

// Bottom panels.
state("trade journal", {
  open: async () => (await openRail("trade-journal-button", '[data-name="trade-journal"]'), ['[data-name="trade-journal"]', '[data-name="strategy-tester"]']),
  close: () => closeRail("trade-journal-button"),
});
state("script editor", {
  open: async () => (await openRail("pine-dialog-button", "section.oak-panel"), ["section.oak-panel"]),
  close: () => closeRail("pine-dialog-button"),
});
popover("script editor › script menu", ".oak-panel__name-btn", ".oak-script-menu", {
  before: () => openRail("pine-dialog-button", "section.oak-panel"),
  after: () => closeRail("pine-dialog-button"),
});

const TESTER = 'section[data-name="strategy-tester"]';
state("strategy tester", {
  needsAgent: true,
  open: async () => {
    const strategy = rowsOf(await tool("list_indicators", { query: "strategy", limit: 100 })).find((r) => r.group === "strategy");
    if (!strategy) throw new Error("skip: no built-in strategy");
    await addStudy(strategy.id);
    await waitFor(TESTER, 8000);
    if (await ev(`document.querySelector(${q(TESTER)}).classList.contains("is-collapsed")`)) await click(`${TESTER} .st-tab:not([data-name]) .st-tab-btn`);
    await sleep(1500);
    return [TESTER];
  },
  // The metrics' own tabs first: the trades view replaces them.
  tabs: [`${TESTER} [data-name="metrics-view"] .st-round-tab`, `${TESTER} [data-name^="light-tab-"]`],
});
state("strategy tester › properties", {
  needsAgent: true,
  open: async () => {
    await click(`${TESTER} .st-icon-btn[aria-label="Settings"]`);
    await waitFor('[data-qa-id="indicator-properties-dialog"]');
    return ['[data-qa-id="indicator-properties-dialog"]'];
  },
  tabs: ".ind3-tabs .ind3-tab",
  close: () => closeStudyDialog(),
});

// The chart.
async function closeStudyDialog() {
  const cancel = '[data-qa-id="indicator-properties-dialog"] .cp3-footer-actions .cp3-btn:not(.is-primary)';
  if (await exists(cancel)) await click(cancel);
  await dismiss('[data-qa-id="indicator-properties-dialog"]');
}

const CELL = ".chart-grid-cell.is-active";
async function chartMenu(name, where) {
  state(name, {
    open: async () => {
      const c = await centerOf(CELL).catch(() => centerOf(".chart-grid-cell"));
      const [x, y] = where(c);
      await mouseAt(x, y, { button: "right" });
      await waitFor(".ot-chart-ctx-menu");
      return [".ot-chart-ctx-menu"];
    },
    close: () => dismiss(".ot-chart-ctx-menu"),
  });
}
chartMenu("chart › pane menu", (c) => [c.left + c.w * 0.35, c.top + c.h * 0.35]);
chartMenu("chart › price scale menu", (c) => [c.right - 20, c.top + c.h * 0.3]);
chartMenu("chart › time scale menu", (c) => [c.left + c.w * 0.35, c.bottom - 12]);

let studyId = null;
const LEGEND_ROW = () => `[data-qa-id="legend-source-item"][data-entity-id="${studyId}"]`;
state("chart › study legend", {
  needsAgent: true,
  open: async () => {
    studyId = await addStudy("rsi").catch(async () => {
      const first = rowsOf(await tool("list_indicators", { query: "relative strength", limit: 5 }))[0];
      return addStudy(first.id);
    });
    await waitFor(LEGEND_ROW(), 6000);
    return ['[data-name="legend-sources"]', ".ot-legend"];
  },
});
state("chart › study more menu", {
  needsAgent: true,
  open: async () => {
    await click(`${LEGEND_ROW()} [data-qa-id="legend-more-action"]`);
    await waitFor(".ot-chart-ctx-menu");
    return [".ot-chart-ctx-menu"];
  },
  close: () => dismiss(".ot-chart-ctx-menu"),
});
state("chart › study settings", {
  needsAgent: true,
  open: async () => {
    await click(`${LEGEND_ROW()} [data-qa-id="legend-settings-action"]`);
    await waitFor('[data-qa-id="indicator-properties-dialog"]');
    return ['[data-qa-id="indicator-properties-dialog"]'];
  },
  tabs: ".ind3-tabs .ind3-tab",
  close: () => closeStudyDialog(),
});

// Drawings.
state("drawing toolbar", { open: async () => ["aside.drawing-toolbar"] });
state("drawing toolbar › flyouts", {
  open: async () => {
    const n = await count("aside.drawing-toolbar .drawing-tool-arrow");
    const found = { untranslated: [], cut: [] };
    for (let i = 0; i < n; i++) {
      await click("aside.drawing-toolbar .drawing-tool-arrow", i);
      if (!(await exists(".drawing-tool-submenu"))) continue;
      const r = await collectState([".drawing-tool-submenu"]);
      found.untranslated.push(...r.untranslated);
      found.cut.push(...r.cut);
      await dismiss(".drawing-tool-submenu");
    }
    return { result: found };
  },
});

let drawingId = null;
const pointOfDrawing = async () => {
  const p = await ev(`window.__i18nWalk.drawingPoint(${q(drawingId)})`);
  if (!p) throw new Error("drawing not on screen");
  return p;
};
state("drawing › selected", {
  needsAgent: true,
  open: async () => {
    const bars = await tool("get_bars", { limit: 60 });
    const rows = bars.rows ?? [];
    if (rows.length < 20) throw new Error("skip: no bars");
    const [a, b] = [rows[rows.length - 40] ?? rows[0], rows[rows.length - 10]];
    const r = await tool("add_drawing", { kind: "trend-line", points: [{ time: a[0], price: a[3] }, { time: b[0], price: b[2] }] });
    drawingId = r.drawingId;
    added.drawings.push(drawingId);
    await sleep(600);
    const p = await pointOfDrawing();
    await mouseAt(p.x, p.y);
    await waitFor('.selected-toolbar[data-name="drawing-toolbar"]');
    return ['.selected-toolbar[data-name="drawing-toolbar"]'];
  },
});
state("drawing › settings", {
  needsAgent: true,
  open: async () => {
    if (!(await exists('.selected-toolbar[data-name="drawing-toolbar"] [data-name="settings"]'))) {
      const p = await pointOfDrawing();
      await mouseAt(p.x, p.y);
    }
    await click('.selected-toolbar[data-name="drawing-toolbar"] [data-name="settings"]');
    await waitFor('[data-name="source-properties-editor"]');
    return ['[data-name="source-properties-editor"]'];
  },
  tabs: ".drawing-settings-tab",
  close: async () => {
    if (await exists(".drawing-settings-btn.secondary")) await click(".drawing-settings-btn.secondary");
    await dismiss('[data-name="source-properties-editor"]');
  },
});
state("drawing › context menu", {
  needsAgent: true,
  open: async () => {
    const p = await pointOfDrawing();
    await mouseAt(p.x, p.y, { button: "right" });
    await waitFor('[data-qa-id="drawing-context-menu"]');
    return ['[data-qa-id="drawing-context-menu"]'];
  },
  close: async () => {
    await dismiss('[data-qa-id="drawing-context-menu"]');
    await key("Escape");
  },
});

// ── Walking ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** States found on the way (the replay's question). */
let extraStates = [];

async function collectState(scopes) {
  const r = await ev(`window.__i18nWalk.collect(${q(scopes)})`);
  const keep = (u) => !IGNORE || !IGNORE.test(u.text);
  return { untranslated: r.untranslated.filter(keep).map((u) => ({ ...u, inCatalog: inCatalog(u.text) })), cut: r.cut };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const results = [];
let shot = 0;

async function record(name, r, misses) {
  const item = { name, untranslated: r.untranslated, cut: r.cut, misses };
  const problems = r.untranslated.length + r.cut.filter((c) => c.kind !== "ellipsis").length + misses.length;
  if (SHOTS && problems) {
    await ev(`window.__i18nWalk.outline(true)`);
    item.screenshot = `${String(++shot).padStart(2, "0")}-${slug(name)}.png`;
    await screenshot(join(OUT, item.screenshot)).catch(() => delete item.screenshot);
    await ev(`window.__i18nWalk.outline(false)`);
  }
  await ev(`window.__i18nWalk.unmark()`);
  results.push(item);
  const n = (k) => item[k].length;
  console.log(`  ${name}: ${n("untranslated")} untranslated, ${item.cut.filter((c) => c.kind !== "ellipsis").length} cut, ${item.cut.filter((c) => c.kind === "ellipsis").length} ellipsis, ${n("misses")} misses`);
}

let missesBefore = new Set();
async function newMisses() {
  const all = await ev(`window.__i18nWalk.misses()`);
  const fresh = all.filter((m) => !missesBefore.has(m.text));
  for (const m of fresh) missesBefore.add(m.text);
  return fresh;
}

async function walkState(s) {
  if (s.needsAgent && !agent) {
    results.push({ name: s.name, skipped: "agent tools unavailable" });
    return;
  }
  extraStates = [];
  let opened;
  try {
    opened = await s.open();
    await sleep(400);
    for (const e of extraStates) await record(e.name, e, await newMisses());
    if (s.check !== false) {
      if (opened && !Array.isArray(opened) && opened.result) await record(s.name, opened.result, await newMisses());
      else await record(s.name, await collectState(opened ?? []), await newMisses());
      for (const tabs of s.tabs ? [s.tabs].flat() : []) {
        const n = await count(tabs);
        for (let i = 0; i < n; i++) {
          const label = await ev(`(() => { const t = document.querySelectorAll(${q(tabs)})[${i}]; return t?.getAttribute("data-qa-id") || t?.getAttribute("data-filter") || t?.getAttribute("data-name") || String(${i + 1}); })()`);
          try {
            await click(tabs, i);
            await sleep(500);
            await record(`${s.name} › ${label}`, await collectState(opened ?? []), await newMisses());
          } catch (e) {
            results.push({ name: `${s.name} › ${label}`, skipped: String(e.message ?? e) });
          }
        }
      }
    }
  } catch (e) {
    const msg = String(e.message ?? e);
    results.push({ name: s.name, skipped: msg.replace(/^skip: /, "") });
    console.log(`  ${s.name}: skipped (${msg.replace(/^skip: /, "")})`);
  } finally {
    try {
      if (s.close) await s.close();
    } catch (e) {
      console.warn(`  ${s.name}: close failed (${e.message ?? e})`);
    }
  }
}

// ── Language ────────────────────────────────────────────────────────────────────────────────────────────────────

const languageName = () =>
  ev(`(async () => {
    document.querySelector('[data-qa-id="main-menu-button"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const rows = document.querySelectorAll(".profile-menu .profile-menu-row");
    const row = rows[rows.length - 1];
    row.dispatchEvent(new MouseEvent("mouseenter"));
    row.click();
    await new Promise((r) => setTimeout(r, 300));
    const current = document.querySelector(".profile-menu-language.is-current")?.textContent.trim() ?? null;
    const names = [...document.querySelectorAll(".profile-menu-language")].map((b) => b.textContent.trim());
    return { current, names };
  })()`);

async function waitForApp() {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      if (await ev(`!!document.querySelector(".header-toolbar") && document.readyState === "complete"`)) {
        await sleep(2500);
        return;
      }
    } catch {
      // The page is reloading.
    }
    await sleep(500);
  }
  throw new Error("The app did not come back after the language change.");
}

/** Picks a language in the profile menu (the page restarts); returns once the app is back. */
async function chooseLanguage(name) {
  const { current, names } = await languageName();
  if (current === name) {
    await dismiss(".profile-menu");
    return;
  }
  if (!names.includes(name)) {
    await dismiss(".profile-menu");
    throw new Error(`No "${name}" in the language menu (${names.join(", ")}): a development build lists the pseudo-language.`);
  }
  await ev(`[...document.querySelectorAll(".profile-menu-language")].find((b) => b.textContent.trim() === ${q(name)}).click()`);
  await sleep(1500);
  await waitForApp();
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────────

function markdown(report) {
  const lines = [`# Screen walk, ${report.date}`, "", `${report.url} — language ${report.language}`, ""];
  const s = report.summary;
  lines.push(`- States: ${s.states} checked, ${s.skipped} skipped`);
  lines.push(`- Untranslated texts: ${s.untranslated.length} (${s.untranslated.filter((u) => u.inCatalog).length} in the catalog)`);
  lines.push(`- Cut texts: ${s.cut.length}; with an ellipsis: ${s.ellipsis.length}`);
  lines.push(`- Misses (__i18nMisses): ${s.misses.length}`, "");
  const table = (title, head, rows) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
    for (const r of rows) lines.push(`| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
    lines.push("");
  };
  table("Untranslated", ["Text", "Attribute", "In catalog", "States", "Element"], s.untranslated.map((u) => [u.text, u.attr ?? "", u.inCatalog ? "yes" : "no", u.states.join(", "), `\`${u.path}\``]));
  table("Cut", ["Text", "How", "States", "Element", "Clipped by"], s.cut.map((c) => [c.text, `${c.kind} (${c.axis})`, c.states.join(", "), `\`${c.path}\``, c.clippedBy ? `\`${c.clippedBy}\`` : ""]));
  table("Misses", ["Text", "Where", "States"], s.misses.map((m) => [m.text, m.where, m.states.join(", ")]));
  table("Ellipsis (cut with an ellipsis)", ["Text", "States", "Element"], s.ellipsis.map((c) => [c.text, c.states.join(", "), `\`${c.path}\``]));
  table("Skipped", ["State", "Why"], report.states.filter((x) => x.skipped).map((x) => [x.name, x.skipped]));
  table("Screenshots", ["State", "File"], report.states.filter((x) => x.screenshot).map((x) => [x.name, x.screenshot]));
  return lines.join("\n") + "\n";
}

function summarize() {
  const group = (items, keyOf) => {
    const map = new Map();
    for (const { state: name, item } of items) {
      const k = keyOf(item);
      const e = map.get(k) ?? { ...item, states: [] };
      if (!e.states.includes(name)) e.states.push(name);
      map.set(k, e);
    }
    return [...map.values()];
  };
  const each = (field, filter = () => true) => results.flatMap((r) => (r[field] ?? []).filter(filter).map((item) => ({ state: r.name, item })));
  return {
    states: results.filter((r) => !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    untranslated: group(each("untranslated"), (u) => `${u.attr ?? ""}|${u.text}`),
    cut: group(each("cut", (c) => c.kind !== "ellipsis"), (c) => `${c.path}|${c.text}`),
    ellipsis: group(each("cut", (c) => c.kind === "ellipsis"), (c) => `${c.path}|${c.text}`),
    misses: group(each("misses"), (m) => m.text),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const url = await connect();
  await send("Runtime.enable");
  await send("Page.enable");
  console.log(`Connected: ${url}`);
  await waitForApp();

  const before = await languageName();
  await dismiss(".profile-menu");
  console.log(`Language: ${before.current}${before.current === PSEUDO ? "" : ` → ${PSEUDO}`}`);
  await chooseLanguage(PSEUDO);
  await inject();
  missesBefore = new Set();

  const rail = await ev(`[...document.querySelectorAll("nav.right-rail-tabs button[data-name]")].map((b) => [b.dataset.name, b.getAttribute("aria-pressed")])`);
  await startAgent();

  const selected = ONLY ? STATES.filter((s) => ONLY.some((o) => s.name.toLowerCase().includes(o))) : STATES;
  console.log(`Walking ${selected.length} states…`);
  try {
    for (const s of selected) {
      await inject();
      await walkState(s);
    }
  } finally {
    // Put the app back: what was added, the panels, the language.
    await dismiss('[data-qa-id="indicator-properties-dialog"], [data-name="source-properties-editor"], [role=dialog], [role=menu]').catch(() => {});
    for (const id of added.drawings) await tool("remove_drawing", { drawingId: id }).catch((e) => console.warn(`  drawing ${id}: ${e.message}`));
    for (const id of added.studies.reverse()) await tool("remove_indicator", { studyId: id }).catch((e) => console.warn(`  study ${id}: ${e.message}`));
    for (const id of added.alerts) await tool("delete_alert", { id }).catch((e) => console.warn(`  alert ${id}: ${e.message}`));
    const now = await ev(`Object.fromEntries([...document.querySelectorAll("nav.right-rail-tabs button[data-name]")].map((b) => [b.dataset.name, b.getAttribute("aria-pressed")]))`).catch(() => ({}));
    for (const [id, pressed] of rail) {
      if (now[id] !== undefined && now[id] !== pressed) await click(RAIL(id)).catch(() => {});
    }
    await stopAgent();
  }

  const report = { date: new Date().toLocaleDateString("en-GB"), url, language: PSEUDO, states: results, summary: summarize() };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(OUT, "report.md"), markdown(report));
  const s = report.summary;
  console.log(`\n${s.states} states, ${s.skipped} skipped: ${s.untranslated.length} untranslated, ${s.cut.length} cut, ${s.ellipsis.length} with an ellipsis, ${s.misses.length} misses.`);
  console.log(`Report: ${join(OUT, "report.md")}`);

  if (!KEEP_LANGUAGE && before.current && before.current !== PSEUDO) {
    console.log(`Language back to ${before.current}`);
    await chooseLanguage(before.current);
  }
  ws.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  ws?.close();
  process.exit(1);
});
