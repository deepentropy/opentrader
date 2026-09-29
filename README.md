<p align="center">
  <img src="docs/assets/banner.png" alt="OpenTrader" width="520">
</p>

# OpenTrader

**An attempt at an open trading app.** OpenTrader is a free, open-source desktop charting application modeled on TradingView and tuned for speed. The goal is to see how close an independent, hackable project can get to a polished commercial charting platform, with the whole thing out in the open for anyone to read, run, and extend.

It is an early work in progress: some features are stubbed or partially wired. Contributions, issues, and ideas are welcome.

> **Disclaimer:** OpenTrader is not affiliated with, endorsed by, or connected to TradingView, TC2000, or Massive (formerly Polygon.io). It is for charting and research only and is **not financial advice**. Provided "as is", without warranty. See [LICENSE](LICENSE).

## Download

Installers are attached to each [GitHub Release](https://github.com/deepentropy/opentrader/releases):

| OS | File |
|---|---|
| Windows | `OpenTrader_<version>_x64-setup.exe` (or the `.msi`) |
| macOS (Intel and Apple Silicon) | `OpenTrader_<version>_universal.dmg` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

The installers are not signed with a paid certificate:

- **Windows:** SmartScreen may show "Windows protected your PC". Click *More info*, then *Run anyway*.
- **macOS:** the app is ad-hoc signed. On first launch macOS blocks it. Open *System Settings > Privacy & Security* and click *Open Anyway*.

Windows is the main development platform. The macOS and Linux builds are produced by the same code but are less tested.

## Stack

- **Shell:** Tauri 2 (Rust + system WebView)
- **Frontend:** SolidJS + TypeScript + Vite + Tailwind CSS v4
- **Backend:** in-process Rust in `src-tauri/`
- **Typed IPC:** `tauri-specta` generates `src/bindings.ts` from the Rust commands
- **Charts:** [`deepentropy/lightweight-charts`](https://github.com/deepentropy/lightweight-charts) (a fork of TradingView Lightweight Charts)
- **Drawing tools:** [`deepentropy/lightweight-charts-drawing`](https://github.com/deepentropy/lightweight-charts-drawing), imported from source
- **Indicators and scripts:** [`lightweight-charts-indicators`](https://www.npmjs.com/package/lightweight-charts-indicators), [`oakscriptjs`](https://www.npmjs.com/package/oakscriptjs), Monaco editor
- **Market data:** Massive (formerly Polygon.io), through the OpenTrader gateway (`src-tauri/src/data/gateway.rs`)

## Build from source

### Prerequisites

- Rust stable: https://rustup.rs/
- Node.js 22.3 or newer (npm)
- Tauri system dependencies for your OS: https://v2.tauri.app/start/prerequisites/
  (Windows: MSVC Build Tools and WebView2; Linux: `libwebkit2gtk-4.1-dev` and friends; macOS: Xcode Command Line Tools)

### Get the code

The drawing core is read from a sibling folder, so clone both repositories side by side:

```bash
git clone https://github.com/deepentropy/opentrader.git
git clone https://github.com/deepentropy/lightweight-charts-drawing.git
cd opentrader
npm ci
```

### Market data token

Market data goes through the OpenTrader gateway, which needs an app token compiled into the build. Copy `.env.example` to `.env` and set `OPENTRADER_GATEWAY_TOKEN`, or set it as an environment variable. A build without a token runs, but charts get no data. `.env` is gitignored: never commit it.

### Run and build

```bash
npm run tauri dev      # opens the app with hot reload
npm run tauri build    # installers under src-tauri/target/release/bundle/
```

The first run is slow (cold Rust build, a few minutes). Later runs take seconds.

`src/bindings.ts` is written on each debug run of the app. For a release build from a fresh clone, generate it first with `cargo test --lib export_bindings` in `src-tauri/`. Do not edit it by hand.

## Layout

```
src/                  SolidJS frontend (window/, components/, data/, styles/, assets/)
src-tauri/            Rust backend and Tauri config
  src/commands/       IPC commands called by the frontend
  src/data/           market data: gateway, REST, WebSocket, providers
docs/assets/          README images
.github/workflows/    release build
```

## Release

1. Set the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Commit, then push a matching tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The [Release workflow](.github/workflows/release.yml) builds Windows, macOS and Linux installers and attaches them to a draft release. Review the draft and publish it.

The workflow needs the repository secret `OPENTRADER_GATEWAY_TOKEN`.

## License

[MIT](LICENSE) © 2026 Odyssée
