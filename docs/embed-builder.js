// Embed page (embed.html): the settings form, the live preview and the code to copy.
(function () {
  "use strict";
  var LOADER = "https://demo.opentrader.markets";
  // A local web build to try the page against (?loader=http://localhost:1431).
  var asked = new URLSearchParams(location.search).get("loader");
  if (asked && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(asked)) LOADER = asked;
  var SCRIPT = LOADER + "/embed.js";

  var TAGS = { chart: "opentrader-chart", "ticker-tape": "opentrader-ticker-tape", "mini-chart": "opentrader-mini-chart", quote: "opentrader-quote" };
  var HEIGHTS = { chart: 500, "ticker-tape": 70, "mini-chart": 244, quote: 96 };
  // The settings each widget takes, in the order they are written.
  var FIELDS = {
    chart: ["symbol", "layout", "layoutSymbols", "interval", "range", "from", "to", "chartType", "theme", "timezone", "locale",
      "studies", "compare", "watchlist", "markers", "highlights",
      "allowSymbolChange", "hideTopToolbar", "drawingToolbar", "dateRanges", "hideLegend", "hideVolume",
      "hideSnapshotButton", "extendedHours", "details", "movers", "popupButton"],
    "ticker-tape": ["symbols", "direction", "theme", "hideLogos"],
    "mini-chart": ["symbol", "range", "theme"],
    quote: ["symbol", "theme"],
  };
  var LISTS = ["symbols", "layoutSymbols", "studies", "compare", "watchlist"];
  // Lists of objects, written as JSON.
  var JSON_LISTS = ["markers", "highlights"];
  // Form fields named apart from their setting (the ticker tape has its own symbols).
  var KEYS = { layoutSymbols: "symbols" };
  // Values that are the defaults are left out of the code.
  var DEFAULTS = { interval: "1D", chartType: "candle", direction: "horizontal" };
  var COLORS = ["background", "text", "accent", "up", "down"];

  var form = document.getElementById("eb-settings");
  var preview = document.getElementById("eb-preview");
  var codeEl = document.getElementById("eb-code");
  var kind = "chart";
  var heightTouched = false;

  var kebab = function (name) {
    return name.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
  };
  var esc = function (s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  };
  var listOf = function (text) {
    return text.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  };

  /** The chosen settings of the shown widget: { name: value } (lists as arrays, switches as true). */
  function settings() {
    var out = {};
    var bad = [];
    var layout = form.elements.layout.value;
    FIELDS[kind].forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      if (el.type === "checkbox") {
        if (el.checked) out[name] = true;
        return;
      }
      var v = el.value.trim();
      if (!v || DEFAULTS[name] === v) return;
      if (name === "layoutSymbols" && !layout) return;
      if (JSON_LISTS.indexOf(name) >= 0) {
        try {
          var list = JSON.parse(v);
          if (Array.isArray(list)) out[name] = list;
          else bad.push(name);
        } catch (e) {
          bad.push(name);
        }
        return;
      }
      out[KEYS[name] || name] = LISTS.indexOf(name) >= 0 ? listOf(v) : v;
    });
    // A span needs both ends.
    if (!out.from !== !out.to) {
      delete out.from;
      delete out.to;
    }
    var note = document.getElementById("eb-json");
    if (note) note.textContent = bad.length ? "Not a JSON list, left out: " + bad.join(", ") + "." : "";
    return out;
  }

  /** An attribute's value: lists of objects as JSON, others comma-separated. */
  var attrValue = function (v) {
    if (!Array.isArray(v)) return String(v);
    return typeof v[0] === "object" ? JSON.stringify(v) : v.join(",");
  };

  function colors() {
    if (!form.elements.useColors.checked) return null;
    var out = {};
    COLORS.forEach(function (c) { out[c] = form.elements["color-" + c].value; });
    return out;
  }

  function styleText() {
    var parts = ["height: " + (Number(form.elements.height.value) || HEIGHTS[kind]) + "px"];
    var c = colors();
    if (c) COLORS.forEach(function (k) { parts.push("--opentrader-" + k + ": " + c[k]); });
    return parts.join("; ");
  }

  function elementCode() {
    var s = settings();
    var attrs = Object.keys(s).map(function (k) {
      var v = s[k];
      if (v === true) return kebab(k);
      // JSON in single quotes, so its double quotes read as they are.
      if (JSON_LISTS.indexOf(k) >= 0) return kebab(k) + "='" + attrValue(v).replace(/&/g, "&amp;").replace(/'/g, "&#39;") + "'";
      return kebab(k) + '="' + esc(attrValue(v)) + '"';
    });
    attrs.push('style="' + styleText() + '"');
    return '<script src="' + SCRIPT + '" async></script>\n<' + TAGS[kind] + " " + attrs.join(" ") + "></" + TAGS[kind] + ">";
  }

  function scriptCode() {
    var s = settings();
    if (kind !== "chart") s = Object.assign({ widget: kind }, s);
    var c = colors();
    if (c) s.colors = c;
    // "<" escaped: a text holding "</script>" cannot end the tag.
    var json = JSON.stringify(s, null, 2).replace(/</g, "\\u003c").replace(/\n/g, "\n  ");
    var h = Number(form.elements.height.value) || HEIGHTS[kind];
    return '<div class="opentrader-embed" style="height: ' + h + 'px">\n  <script src="' + SCRIPT + '" async>\n  ' + json + "\n  </script>\n</div>";
  }

  function format() {
    return form.ownerDocument.querySelector('input[name="format"]:checked').value;
  }

  var timer = null;
  function update() {
    codeEl.textContent = format() === "script" ? scriptCode() : elementCode();
    clearTimeout(timer);
    timer = setTimeout(showPreview, 400);
  }

  function showPreview() {
    preview.innerHTML = "";
    var s = settings();
    var el = document.createElement(TAGS[kind]);
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      el.setAttribute(kebab(k), v === true ? "" : attrValue(v));
    });
    el.setAttribute("style", styleText());
    preview.appendChild(el);
  }

  function showKind(next) {
    kind = next;
    document.querySelectorAll(".eb-kinds [data-kind]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.kind === kind));
    });
    form.querySelectorAll("[data-for]").forEach(function (el) {
      el.hidden = el.dataset.for.split(" ").indexOf(kind) < 0 || (el.hasAttribute("data-layout") && !form.elements.layout.value);
    });
    if (!heightTouched) form.elements.height.value = HEIGHTS[kind];
    update();
  }

  document.querySelectorAll(".eb-kinds [data-kind]").forEach(function (b) {
    b.addEventListener("click", function () { showKind(b.dataset.kind); });
  });
  form.addEventListener("input", function (e) {
    if (e.target.name === "height") heightTouched = true;
    if (e.target.name === "layout") showKind(kind);
    else update();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  document.querySelectorAll('input[name="format"]').forEach(function (r) { r.addEventListener("change", update); });
  document.getElementById("eb-copy").addEventListener("click", function () {
    var done = document.getElementById("eb-copied");
    navigator.clipboard.writeText(codeEl.textContent).then(
      function () { done.textContent = "Copied."; },
      function () { done.textContent = "Select the code and copy it."; }
    );
    setTimeout(function () { done.textContent = ""; }, 2500);
  });

  var loader = document.createElement("script");
  loader.src = SCRIPT;
  loader.async = true;
  document.head.appendChild(loader);
  showKind("chart");
})();
