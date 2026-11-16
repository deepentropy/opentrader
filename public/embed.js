/*
 * OpenTrader chart for other websites (#338).
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
 * The chart is the web version in an iframe (`/?view=embed#<settings>`); the
 * settings are read and checked there (src/embed/config.ts). The element's
 * symbol, interval, chart-type and theme change the chart in place; any other
 * change reloads it. The element (or the script's container) dispatches
 * ot-ready, ot-symbol-change (detail.symbol) and ot-interval-change
 * (detail.interval).
 */
(function () {
  "use strict";
  var script =
    document.currentScript ||
    Array.prototype.slice.call(document.querySelectorAll('script[src*="/embed.js"]')).pop();
  var ORIGIN = script && script.src ? new URL(script.src, location.href).origin : "https://demo.opentrader.markets";
  var FROM_CHART = "opentrader-embed";
  var FROM_PAGE = "opentrader-embed-host";
  var LIVE = ["symbol", "interval", "chartType", "theme"];
  var ATTRIBUTES = [
    "symbol", "interval", "range", "chart-type", "theme", "locale", "timezone", "extended-hours", "studies",
    "hide-volume", "compare", "allow-symbol-change", "hide-top-toolbar", "drawing-toolbar", "date-ranges",
    "hide-legend", "hide-snapshot-button", "watchlist", "details", "popup-button", "popup-width", "popup-height",
  ];
  var STYLE =
    ":host{display:block;position:relative;height:500px}" +
    ".frame{display:block;width:100%;height:calc(100% - 24px);border:0;background:transparent}" +
    ".credit{height:24px;line-height:24px;font:12px/24px system-ui,sans-serif;text-align:center}" +
    ".credit a{color:#2962ff;text-decoration:none}.credit a:hover{text-decoration:underline}";

  var camel = function (name) {
    return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  };

  /** One chart in `host`: an iframe of the web version and the credit line under it. */
  function Embed(host, root, settings) {
    this.host = host;
    this.root = root;
    this.settings = settings;
    this.ready = false;
    this.frame = null;
    var style = document.createElement("style");
    style.textContent = STYLE;
    var credit = document.createElement("div");
    credit.className = "credit";
    var link = document.createElement("a");
    link.href = "https://opentrader.markets/";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Chart by OpenTrader";
    credit.appendChild(link);
    root.appendChild(style);
    this.load();
    root.appendChild(credit);
    var self = this;
    this.onMessage = function (e) {
      if (!self.frame || e.source !== self.frame.contentWindow || e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || d.source !== FROM_CHART) return;
      if (d.type === "ready") self.ready = true;
      var name = d.type === "ready" ? "ot-ready" : d.type === "symbol" ? "ot-symbol-change" : d.type === "interval" ? "ot-interval-change" : null;
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
    frame.title = "OpenTrader chart";
    frame.setAttribute("allow", "clipboard-write; fullscreen");
    frame.src = ORIGIN + "/?view=embed#" + encodeURIComponent(JSON.stringify(this.settings));
    if (this.frame) this.root.replaceChild(frame, this.frame);
    else this.root.appendChild(frame);
    this.frame = frame;
    this.ready = false;
  };

  /** New settings: the live ones go to the running chart, any other reloads it. */
  Embed.prototype.update = function (settings) {
    var changed = {};
    var reload = false;
    var keys = Object.keys(settings).concat(Object.keys(this.settings));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (JSON.stringify(settings[k]) === JSON.stringify(this.settings[k])) continue;
      if (LIVE.indexOf(k) >= 0) changed[k] = settings[k];
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

  // ── <opentrader-chart> element ────────────────────────────────────────────
  if (!window.customElements || customElements.get("opentrader-chart")) return;

  /** The element's settings, from its attributes. */
  function settingsOf(el) {
    var out = {};
    for (var i = 0; i < ATTRIBUTES.length; i++) {
      var name = ATTRIBUTES[i];
      if (!el.hasAttribute(name)) continue;
      var value = el.getAttribute(name);
      if ((name === "studies" || name === "compare" || name === "watchlist") && /^\s*\[/.test(value)) {
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

  class Chart extends HTMLElement {
    static get observedAttributes() {
      return ATTRIBUTES;
    }
    connectedCallback() {
      if (this._embed) return;
      this._embed = new Embed(this, this.shadowRoot || this.attachShadow({ mode: "open" }), settingsOf(this));
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
        if (this._embed) this._embed.update(settingsOf(this));
      });
    }
  }

  customElements.define("opentrader-chart", Chart);
})();
