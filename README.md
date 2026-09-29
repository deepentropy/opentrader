<p align="center">
  <img src="docs/assets/banner.png" alt="OpenTrader" width="520">
</p>

# OpenTrader

**An attempt at an open trading app.** OpenTrader is a free, open-source desktop charting application built for speed. It is an open-source alternative to commercial trading software, out in the open for anyone to read, run, and extend.

It is an early work in progress: some features are stubbed or partially wired. Contributions, issues, and ideas are welcome.

> **Disclaimer:** OpenTrader is an independent project, not affiliated with any commercial trading platform or data provider. It is for charting and research only and is **not financial advice**. Provided "as is", without warranty. See [LICENSE](LICENSE).

## Download

Download the installer for your system from the [latest GitHub Release](https://github.com/deepentropy/opentrader/releases/latest) and run it. Nothing else to set up: no account, no API key, no token. Market data works out of the box.

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
- **Charts:** [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0)
- **Drawing tools:** [`deepentropy/lightweight-charts-drawing`](https://github.com/deepentropy/lightweight-charts-drawing), imported from source
- **Indicators and scripts:** [`lightweight-charts-indicators`](https://www.npmjs.com/package/lightweight-charts-indicators), [`oakscriptjs`](https://www.npmjs.com/package/oakscriptjs), Monaco editor
- **Market data:** Massive (formerly Polygon.io), through the OpenTrader gateway (`src-tauri/src/data/gateway.rs`)

## Build from source

### Prerequisites

- Rust stable: https://rustup.rs/
- Node.js 22 or newer (npm)
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

### Market data token (source builds only)

The released installers already contain the gateway token. Only a build from source needs one: market data goes through the OpenTrader gateway, and the app token is compiled into the build. Copy `.env.example` to `.env` and set `OPENTRADER_GATEWAY_TOKEN`, or set it as an environment variable. A build without a token runs, but charts get no data. `.env` is gitignored: never commit it.

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

## Third-party notices

OpenTrader uses [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts), licensed under the Apache License 2.0:

> TradingView Lightweight Charts™  
> Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/

## License

[MIT](LICENSE)
