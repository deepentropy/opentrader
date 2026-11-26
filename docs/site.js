// Header Features menu: close it on a click outside, on a choice, or with Escape.
(function () {
  var menu = document.querySelector("details.menu");
  if (!menu) return;
  document.addEventListener("click", function (e) {
    if (menu.open && (!menu.contains(e.target) || e.target.closest(".menu-list a"))) menu.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") menu.open = false;
  });
})();

// Landing pages: pick the visitor's installer and show the latest release details.
(function () {
  // Installer names carry the version (OpenTrader_0.5.1_windows_x64-setup.exe): each file is found by its end.
  var FILES = {
    "windows-exe": /_windows_x64-setup\.exe$/,
    "windows-msi": /_windows_x64\.msi$/,
    "macos-dmg": /_darwin_universal\.dmg$/,
    "linux-appimage": /_linux_amd64\.AppImage$/,
    "linux-deb": /_linux_amd64\.deb$/,
    "linux-rpm": /_linux_x86_64\.rpm$/,
  };
  var MAIN = {
    windows: { label: "Download for Windows", file: "windows-exe" },
    macos: { label: "Download for macOS", file: "macos-dmg" },
    linux: { label: "Download for Linux", file: "linux-appimage" },
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
  if (os) {
    document.querySelectorAll("[data-download]").forEach(function (a) {
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

  // The newest app release (tag v<version>): the repository's plugins have releases of their own, so its
  // "latest" release may be one of them. Version, date, sizes and direct links; the static text and the
  // links to the release page stay if this fails.
  if (!document.querySelector("[data-version], [data-file], [data-download]")) return;
  fetch("https://api.github.com/repos/deepentropy/opentrader/releases?per_page=30")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (list) {
      var rel = (list || []).filter(function (r) { return !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name); })[0];
      if (!rel) return;
      var assets = {};
      (rel.assets || []).forEach(function (a) {
        for (var key in FILES) if (FILES[key].test(a.name)) assets[key] = a;
      });
      document.querySelectorAll("[data-version]").forEach(function (e) { e.textContent = rel.tag_name; });
      document.querySelectorAll("[data-released]").forEach(function (e) { e.textContent = date(rel.published_at); });
      document.querySelectorAll("[data-file]").forEach(function (e) {
        var a = assets[e.getAttribute("data-file")];
        if (!a) return;
        e.href = a.browser_download_url;
        var small = e.querySelector("small");
        if (small) small.textContent = size(a.size);
      });
      if (os && assets[MAIN[os].file]) {
        document.querySelectorAll("[data-download]").forEach(function (a) { a.href = assets[MAIN[os].file].browser_download_url; });
      }
    })
    .catch(function () {});
})();
