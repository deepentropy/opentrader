# Details (info) panel — field placement spec

Authoritative layout for `WatchlistDetail.tsx`. Two states:

- **Regular / closed** — "Market closed".
- **Post-market** — "Post-market".

Widget = the details panel, 331px wide, sits below the watchlist. Body padding `0 16px`. Default text `#dbdbdb`; secondary
`#8c8c8c` (rgb 140); tertiary/timestamp `#707070` (rgb 112).

> Rules we follow:
> **no `R` realtime badge** (our data is delayed); **no extended-hours
> dual-price block** — only the single price line; sector/industry are
> **Title-cased**; the pre/post label carries a **moon icon**; the last-update
> time includes the **GMT offset**.

## Vertical block order (the blocks we render)

| # | Block | Notes |
|---|-------|-------|
| 1 | Header (48px) | logo 24×24 · ticker **14px / 600** · note/settings buttons |
| 2 | Name · exchange | `Company Name`(12/400 #dbdbdb) ` · ` exchange(12/400 #dbdbdb), inline, dot margin `0 6px 0 3px` |
| 3 | Sector · industry | two `<a>` links, 12/400, **#8c8c8c** |
| 4 | Price row | see below |
| 5 | Market-state row | see below |
| 6 | Day's Range | low(13/400) — `Day's Range`(11/400 #9c9c9c, centred) — high(13/400) |
| 7 | 52wk Range | same shape, label `52wk Range` |
| 8 | Key stats | heading 13/600; rows `label`(13/400) … `value`(13/600, right-aligned) |
| 9 | Performance | heading 13/600; 2×3 grid, value 13/600 over period 11/400; green `#089981` / red `#f2363f` |
| 10 | Profile | heading 13/600; Website/Employees/FIGI rows (label left, value right 13/600); description 13/400 |

(Other possible sections between Key stats and Profile — Earnings, Dividends,
Income statement, Seasonals, Technicals, Analyst rating, Bonds, ATM IV — need
feeds Polygon Standard doesn't provide, so we omit them.)

## Price row (as we render it)

A single left-packed, bottom-aligned flex row — **no `R` badge**:

`[price] [currency] [±change] [±change%]`

- **Price** — **28px / 600**, `#dbdbdb`, tabular-nums.
- **Currency** (e.g. `USD`) — 12px / 400, `#dbdbdb`, right after the price.
- **±change** / **±change%** — 16px / 600, right after the currency; colour by
  sign: up `#22ab94`, down `#f7525f` (symbol-change tokens, distinct from the
  performance grid's `#089981` / `#f23645`).

## Market-state row

`label` + `Last update at HH:MM GMT±X` (timestamp 13px, `#707070`). The
pre/post label is preceded by a **crescent-moon icon** (viewBox `0 0 18 18`, path `M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5z`).

**The label is session-dependent (the dynamic pre/post behaviour):**

| Session (America/New_York) | Label | Icon | Colour |
|---|---|---|---|
| Mon–Fri 09:30–16:00 | `Market open` | — | grey `#8c8c8c` |
| Mon–Fri 04:00–09:30 | `Pre-market` | moon | **blue `#2962ff`** |
| Mon–Fri 16:00–20:00 | `Post-market` | moon | **blue `#2962ff`** |
| otherwise | `Market closed` | — | grey `#8c8c8c` |

Implemented: `marketSession()` + `.watchlist-detail-state.is-extended` (+ the
`MOON_ICON` shown via `sessionActive()`), ticked every 60s so the label flips at
boundaries. `lastUpdate()` formats the time with `timeZoneName: "shortOffset"`
→ "Last update at 21:59 GMT+2".

## Not rendered: extended-hours dual-price block

A second price block in pre/post (the extended last) is not shown: we render
only the single price line, in every session. (History: it was briefly added behind a
`min.c`-derived `ext_last` snapshot field, then removed at the user's request —
both the block and the backend field are gone.)
