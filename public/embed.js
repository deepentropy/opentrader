/*
 * OpenTrader charts and widgets for other websites (#338, #339).
 *
 * Two ways to use it:
 *
 *   <div class="opentrader-embed" style="height: 500px">
 *     <script src="https://demo.opentrader.markets/embed.js" async>
 *     { "symbol": "NASDAQ:AAPL", "interval": "1D", "theme": "dark" }
 *     </script>
 *   </div>
 *
 *   <script src="https://demo.opentrader.markets/embed.js" async></script>
 *   <opentrader-chart symbol="NASDAQ:AAPL" interval="1D" theme="dark" style="height: 500px"></opentrader-chart>
 *
 * The widgets: <opentrader-ticker-tape symbols="…">, <opentrader-mini-chart
 * symbol="…">, <opentrader-quote symbol="…"> (or "widget": "ticker-tape",
 * "mini-chart", "quote" in the script tag's settings).
 *
 * Each is the web version in an iframe (`/?view=embed#<settings>`); the
 * settings are read and checked there (src/embed/config.ts). The page's
 * --opentrader-background, -text, -accent, -up, -down, -border and -font CSS
 * properties on the element (or inherited) become its colours and font. The
 * chart's symbol, interval, chart-type and any embed's theme change in place;
 * any other change reloads it. The element (or the script's container)
 * dispatches ot-ready, ot-symbol-change (detail.symbol) and ot-interval-change
 * (detail.interval) for the chart, ot-symbol-click (detail.symbol) for a
 * widget's symbol.
 */
(function () {
  "use strict";
  var script =
    document.currentScript ||
    Array.prototype.slice.call(document.querySelectorAll('script[src*="/embed.js"]')).pop();
  var ORIGIN = script && script.src ? new URL(script.src, location.href).origin : "https://demo.opentrader.markets";
  var FROM_CHART = "opentrader-embed";
  var FROM_PAGE = "opentrader-embed-host";
  // Each embed: its element, the height it takes when the page sets none, the settings changed in place, its credit.
  var WIDGETS = {
    chart: { tag: "opentrader-chart", height: "500px", live: ["symbol", "interval", "chartType", "theme"], credit: "Chart by OpenTrader" },
    "ticker-tape": { tag: "opentrader-ticker-tape", height: "70px", live: ["theme"], credit: "Quotes by OpenTrader" },
    "mini-chart": { tag: "opentrader-mini-chart", height: "244px", live: ["theme"], credit: "Chart by OpenTrader" },
    quote: { tag: "opentrader-quote", height: "96px", live: ["theme"], credit: "Quotes by OpenTrader" },
  };
  var ATTRIBUTES = [
    "symbol", "symbols", "direction", "hide-logos", "interval", "range", "chart-type", "theme", "locale", "timezone",
    "extended-hours", "studies", "hide-volume", "compare", "allow-symbol-change", "hide-top-toolbar",
    "drawing-toolbar", "date-ranges", "hide-legend", "hide-snapshot-button", "watchlist", "details", "movers",
    "popup-button", "popup-width", "popup-height",
  ];
  var LISTS = ["studies", "compare", "watchlist", "symbols"];
  var COLORS = ["background", "text", "accent", "up", "down", "border", "font"];
  var STYLE =
    ":host{display:block;position:relative}" +
    ".frame{display:block;width:100%;height:calc(100% - 24px);border:0;background:transparent}" +
    ".credit{height:24px;line-height:24px;font:12px/24px system-ui,sans-serif;text-align:center}" +
    ".credit a{color:var(--opentrader-accent,#2962ff);text-decoration:none}.credit a:hover{text-decoration:underline}";

  var camel = function (name) {
    return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  };
  var widgetOf = function (settings) {
    return WIDGETS[settings.widget] ? settings.widget : "chart";
  };

  /** The settings with the page's --opentrader-* properties on `el` as colours (the settings' own colours win). */
  function withColors(el, settings) {
    var css = getComputedStyle(el);
    var colors = {};
    for (var i = 0; i < COLORS.length; i++) {
      var v = css.getPropertyValue("--opentrader-" + COLORS[i]).trim();
      if (v) colors[COLORS[i]] = v;
    }
    var own = settings.colors && typeof settings.colors === "object" ? settings.colors : {};
    for (var k in own) colors[k] = own[k];
    var out = {};
    for (var key in settings) out[key] = settings[key];
    if (Object.keys(colors).length) out.colors = colors;
    return out;
  }

  /** One chart or widget in `host`: an iframe of the web version and the credit line under it. */
  function Embed(host, root, settings) {
    this.host = host;
    this.root = root;
    this.settings = withColors(host, settings);
    this.ready = false;
    this.frame = null;
    var kind = widgetOf(settings);
    var widget = WIDGETS[kind];
    var style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);
    // A height the page gives the element wins over this one (measured once it is a block).
    if (!host.style.height && host.getBoundingClientRect().height === 0)
      host.style.height = kind === "ticker-tape" && settings.direction === "vertical" ? "400px" : widget.height;
    var credit = document.createElement("div");
    credit.className = "credit";
    var link = document.createElement("a");
    link.href = "https://opentrader.markets/";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = widget.credit;
    credit.appendChild(link);
    this.load();
    root.appendChild(credit);
    var self = this;
    this.onMessage = function (e) {
      if (!self.frame || e.source !== self.frame.contentWindow || e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || d.source !== FROM_CHART) return;
      if (d.type === "ready") self.ready = true;
      var name =
        d.type === "ready" ? "ot-ready"
        : d.type === "symbol" ? "ot-symbol-change"
        : d.type === "interval" ? "ot-interval-change"
        : d.type === "symbol-click" ? "ot-symbol-click"
        : null;
      if (!name) return;
      var detail = {};
      if (d.symbol) detail.symbol = d.symbol;
      if (d.interval) detail.interval = d.interval;
      self.host.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true, composed: true }));
    };
    window.addEventListener("message", this.onMessage);
  }

  Embed.prototype.load = function () {
    var frame = document.createElement("iframe");
    frame.className = "frame";
    frame.title = WIDGETS[widgetOf(this.settings)].credit;
    frame.setAttribute("allow", "clipboard-write; fullscreen");
    frame.src = ORIGIN + "/?view=embed#" + encodeURIComponent(JSON.stringify(this.settings));
    if (this.frame) this.root.replaceChild(frame, this.frame);
    else this.root.appendChild(frame);
    this.frame = frame;
    this.ready = false;
  };

  /** New settings: the live ones go to the running embed, any other reloads it. */
  Embed.prototype.update = function (settings) {
    settings = withColors(this.host, settings);
    var live = WIDGETS[widgetOf(settings)].live;
    var changed = {};
    var reload = false;
    var keys = Object.keys(settings).concat(Object.keys(this.settings));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (JSON.stringify(settings[k]) === JSON.stringify(this.settings[k])) continue;
      if (live.indexOf(k) >= 0) changed[k] = settings[k];
      else reload = true;
    }
    this.settings = settings;
    if (reload || !this.ready) this.load();
    else if (Object.keys(changed).length)
      this.frame.contentWindow.postMessage({ source: FROM_PAGE, type: "config", config: changed }, ORIGIN);
  };

  Embed.prototype.destroy = function () {
    window.removeEventListener("message", this.onMessage);
  };

  // ── Script tag with its settings inside ───────────────────────────────────
  if (script && script.textContent && script.textContent.trim()) {
    var settings = {};
    try {
      settings = JSON.parse(script.textContent);
    } catch (e) {
      console.error("[OpenTrader] the settings inside the script tag are not valid JSON:", e);
    }
    var container = script.parentElement;
    if (!container || !container.classList.contains("opentrader-embed")) {
      container = document.createElement("div");
      container.className = "opentrader-embed";
      script.parentNode.insertBefore(container, script);
    }
    new Embed(container, container.attachShadow({ mode: "open" }), settings);
  }

  // ── <opentrader-…> elements ───────────────────────────────────────────────
  if (!window.customElements || customElements.get("opentrader-chart")) return;

  /** The element's settings, from its attributes. */
  function settingsOf(el, widget) {
    var out = { widget: widget };
    for (var i = 0; i < ATTRIBUTES.length; i++) {
      var name = ATTRIBUTES[i];
      if (!el.hasAttribute(name)) continue;
      var value = el.getAttribute(name);
      if (LISTS.indexOf(name) >= 0 && /^\s*\[/.test(value)) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          console.error("[OpenTrader] attribute " + name + " is not valid JSON:", e);
          continue;
        }
      }
      out[camel(name)] = value;
    }
    return out;
  }

  /** The element class of one embed. */
  function elementOf(widget) {
    return class extends HTMLElement {
      static get observedAttributes() {
        return ATTRIBUTES;
      }
      connectedCallback() {
        if (this._embed) return;
        this._embed = new Embed(this, this.shadowRoot || this.attachShadow({ mode: "open" }), settingsOf(this, widget));
      }
      disconnectedCallback() {
        if (!this._embed) return;
        this._embed.destroy();
        this.shadowRoot.innerHTML = "";
        this._embed = null;
      }
      attributeChangedCallback() {
        if (!this._embed || this._pending) return;
        // Several attributes set together make one update.
        this._pending = true;
        Promise.resolve().then(() => {
          this._pending = false;
          if (this._embed) this._embed.update(settingsOf(this, widget));
        });
      }
    };
  }

  for (var w in WIDGETS) customElements.define(WIDGETS[w].tag, elementOf(w));
})();
