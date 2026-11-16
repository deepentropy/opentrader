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
    chart: ["symbol", "interval", "range", "chartType", "theme", "timezone", "locale", "studies", "compare", "watchlist",
      "allowSymbolChange", "hideTopToolbar", "drawingToolbar", "dateRanges", "hideLegend", "hideVolume",
      "hideSnapshotButton", "extendedHours", "details", "movers", "popupButton"],
    "ticker-tape": ["symbols", "direction", "theme", "hideLogos"],
    "mini-chart": ["symbol", "range", "theme"],
    quote: ["symbol", "theme"],
  };
  var LISTS = ["symbols", "studies", "compare", "watchlist"];
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
    FIELDS[kind].forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      if (el.type === "checkbox") {
        if (el.checked) out[name] = true;
        return;
      }
      var v = el.value.trim();
      if (!v || DEFAULTS[name] === v) return;
      out[name] = LISTS.indexOf(name) >= 0 ? listOf(v) : v;
    });
    return out;
  }

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
      return kebab(k) + '="' + esc(Array.isArray(v) ? v.join(",") : v) + '"';
    });
    attrs.push('style="' + styleText() + '"');
    return '<script src="' + SCRIPT + '" async></script>\n<' + TAGS[kind] + " " + attrs.join(" ") + "></" + TAGS[kind] + ">";
  }

  function scriptCode() {
    var s = settings();
    if (kind !== "chart") s = Object.assign({ widget: kind }, s);
    var c = colors();
    if (c) s.colors = c;
    var json = JSON.stringify(s, null, 2).replace(/\n/g, "\n  ");
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
      el.setAttribute(kebab(k), v === true ? "" : Array.isArray(v) ? v.join(",") : v);
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
      el.hidden = el.dataset.for.split(" ").indexOf(kind) < 0;
    });
    if (!heightTouched) form.elements.height.value = HEIGHTS[kind];
    update();
  }

  document.querySelectorAll(".eb-kinds [data-kind]").forEach(function (b) {
    b.addEventListener("click", function () { showKind(b.dataset.kind); });
  });
  form.addEventListener("input", function (e) {
    if (e.target.name === "height") heightTouched = true;
    update();
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
