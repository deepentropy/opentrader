# OpenTrader: notes for coding agents

A desktop charting app: a Rust backend (Tauri 2) and a SolidJS frontend. This file is for working **on this
repository**. To work **with the running app** (charts, scripts, strategies), connect to its MCP server instead:
see "Use with a coding agent" in the README.

## Layout

```
src/                     frontend (SolidJS, TypeScript)
  App.tsx                the window: tabs, panes, the stores below wired together
  window/                UI by area: chart/, drawings/, oakscript/ (script editor), strategy-tester/, header/, shell/ …
  data/                  stores and data access (datafeed, kv persistence, alerts, scripts, strategy results)
  agent/                 the MCP server's tools, guide and protocol (answered in the window)
  backtester/            strategy engine (worker)
  bindings.ts            generated from the Rust commands: never edit, it is gitignored
src-tauri/               Rust: commands (src/commands/), windows, alerts, updates, agent.rs (MCP endpoint)
  crates/core            data side shared with the web server
  crates/server          the web build's backend
../lightweight-charts-drawing   drawing core, read from a sibling checkout (see README)
```

Indicators come from `lightweight-charts-indicators`, the script runtime from `oakscriptjs`, drawings from
`lightweight-charts-drawing`. A change to an indicator, the script API or a drawing tool belongs in that library;
each ships its own agent guide in `skills/`.

## Commands

```bash
npm ci
npm test                         # vitest (tests in __tests__/ next to the code)
npx tsc --noEmit -p tsconfig.json
cd src-tauri && cargo test --lib # Rust tests; also regenerates src/bindings.ts
npm run tauri dev                # the app with hot reload (first Rust build: minutes)
```

A new Tauri command: add it in `src-tauri/src/`, list it in `specta_builder()` (`src-tauri/src/lib.rs`), then run
`cargo test --lib export_bindings` and call it through `commands` from `src/bindings.ts`. If the web build serves it
too, put its body in `opentrader_core::commands`, add its name to `SERVED` there and route it in
`crates/server/src/invoke.rs` (tests check that the lists match).

## Conventions

- Match the code around you: comments say why, in plain words; no dead code.
- Persist through `src/data/kv.ts`, not `localStorage`.
- Chart edits go through the stores (`window/shell/chart-edits.ts`, `window/drawings/drawing-store.ts`) so they are
  undo steps and are saved.
- Do not name market-data providers in code, docs or issues.
- Dates shown to the user: dd/mm/yyyy.
- Commit only the files you changed (no `git add -A`): other work may be in the tree.

## Languages

The components keep their English text; `src/i18n/translator.ts` translates the page as it appears from a dictionary
keyed by the English text (`src/i18n/<lang>.json`). `src/i18n/catalog.json` lists every text to translate, generated
from the code, the built-in studies and `src/i18n/tools/run-time-texts.ts`.

- A text: write it whole. Values go through `translateWith("{0} bars of {1}", n, sym)`, counts through
  `translatePlural(n, { one: "{0} bar", other: "{0} bars" })`, dates and numbers through `src/i18n/format.ts`; never
  join words to values (`"Undo " + name`, a test fails). A word with two meanings takes a sense (`data-i18n-sense`,
  `translateAs`). Then `npm run i18n:extract` and add the new entries to each dictionary.
- Not interface text: data (tickers, company and script names, exchanges, hotkeys, what the user wrote, legal notices
  kept verbatim) is shown in an element with `data-no-translate`; a text the code already wrote in the language (words
  translated one by one and joined with values, dates of `format.ts`) goes through `formatted()`. Neither is looked
  up, so neither is reported as left in English.
- A language: one entry in `src/i18n/languages.ts` (name, plural locale, formats, direction, `partial` while it is
  being translated) and its `<lang>.json`; `src/i18n/glossary/<lang>.json` holds its terms.
- `npm run i18n:report` gives each language's coverage; `npm run i18n:missing -- <lang>` writes the missing texts with
  their context and glossary terms to `.tmp/i18n/<lang>-missing.json`, `npm run i18n:merge -- <lang> <file>` merges
  the filled file back (checked); `npm run i18n:prune` removes the entries the catalog lost. In the dev build,
  `window.__i18nMisses()` lists the texts left in English on screen.
- The pseudo-language "Pseudo" (`en-XA`, dev builds' language menu, `src/i18n/pseudo.ts`) shows every catalog text
  accented, a third longer and between markers ⟦…⟧: text without them is left in English. With the dev app running
  with CDP, `npm run i18n:walk -- 9231` walks its screens, menus, dialogs and panels in it and writes the English left
  on screen, the cut text and the misses to `.tmp/i18n-walk/` (report.md, screenshots), then puts the app back.
  `--language=en-XB` or `--language=fr` walks another language (`.tmp/i18n-walk/<lang>/`), `--all-shots` keeps a
  screenshot of every state to check by eye.
- Right to left: the page's `dir` is the language's. CSS uses start/end (`margin-inline-start`, `inset-inline-end`,
  `text-align: start`); left/right only for what keeps its side: the panels' places and their outer edges and resize
  handles, the chart and what sits over it (`src/styles/rtl.css` holds those rules). Code that places a menu or
  popover uses `src/components/reading-direction.ts` (`fitToWindow` and `createPopover` already do). An icon that
  points along the reading direction (back, submenu chevron, expander) takes `ot-flip-rtl`; undo/redo, replay, logos
  and drawing tools don't. A value shown inside text (price, percent, volume, time) is isolated: the `ot-value`
  class (`src/styles/rtl.css`). Check with the dev build's pseudo-language "English, right to left (test)"
  (`en-XB`, `src/i18n/pseudo-rtl.ts`): the English words in right-to-left order inside ⟦ ⟧.
