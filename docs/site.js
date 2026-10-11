// Landing pages: pick the visitor's installer and show the latest release details.
(function () {
  var BASE = "https://github.com/deepentropy/opentrader/releases/latest/download/";
  var MAIN = {
    windows: { label: "Download for Windows", file: "OpenTrader_windows_x64-setup.exe" },
    macos: { label: "Download for macOS", file: "OpenTrader_darwin_universal.dmg" },
    linux: { label: "Download for Linux", file: "OpenTrader_linux_amd64.AppImage" },
  };

  function detectOs() {
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
    if (/Windows/i.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
    if (/Linux|X11/i.test(ua)) return "linux";
    return null;
  }

  var os = detectOs();

  // Hero / call-to-action buttons: direct installer link when the system is known.
  if (os) {
    document.querySelectorAll("[data-download]").forEach(function (a) {
      a.href = BASE + MAIN[os].file;
      var label = a.querySelector("[data-download-label]");
      if (label) label.textContent = MAIN[os].label;
    });
    var mine = document.querySelector('[data-os="' + os + '"]');
    if (mine) mine.classList.add("is-mine");
  }

  function size(bytes) {
    return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
  }

  function date(iso) {
    var d = new Date(iso);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  // Latest release: version, date and file sizes. The static text stays if this fails.
  if (!document.querySelector("[data-version], [data-file]")) return;
  fetch("https://api.github.com/repos/deepentropy/opentrader/releases/latest")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.tag_name) return;
      document.querySelectorAll("[data-version]").forEach(function (e) { e.textContent = rel.tag_name; });
      document.querySelectorAll("[data-released]").forEach(function (e) { e.textContent = date(rel.published_at); });
      (rel.assets || []).forEach(function (a) {
        var e = document.querySelector('[data-file="' + a.name + '"] small');
        if (e) e.textContent = size(a.size);
      });
    })
    .catch(function () {});
})();
