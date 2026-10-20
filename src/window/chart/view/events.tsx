/*
 * Events of a chart view (Events tab): the Dividends / Splits / Earnings
 * lollipops along the bottom of the price pane, and the card a click on one
 * opens.
 *
 * Card (dark theme): 300 px wide, #1F1F1F, radius 10, padding 16 16 16 20,
 * a 4 px stripe of the marker colour on its left edge. Title row: 28 px icon
 * in the marker colour + 18 px / 600 title, 12 px under it. Rows: two 132 px
 * columns, 14 px text on 21 px lines; groups (Earnings, Revenue) under an
 * 11 px uppercase #8C8C8C title, 12 px above it, on 22 px lines. The card
 * sits centred over the marker, 8 px above its top. The reference card's
 * links to the company's financials page are left out (no such page here).
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, untrack, type Accessor, type JSX, type Setter } from "solid-js";
import { aggregateUnitFor, getEvents, type ChartEvent } from "../../../data/datafeed";
import { formatChartTime } from "../time-format";
import { volumeFormat } from "../../../data/volume-format";
import { EVENT_STYLES } from "../event-markers";
import { type ChartCx } from "./context";

/** What createEvents adds to the chart context. */
export interface EventsApi {
  EventCard: () => JSX.Element;
  /** Index of the marker whose card is open, or null. */
  eventCard: Accessor<number | null>;
  setEventCard: Setter<number | null>;
  /** Click on a marker: toggles its card. */
  toggleEventCard: (index: number) => void;
  /** The markers of the symbol (time-ascending). */
  chartEvents: Accessor<ChartEvent[] | undefined>;
}

const MINUS = "−";
/** A value rounded to 3 decimals, minus sign U+2212. */
function third(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return (r < 0 ? MINUS : "") + String(Math.abs(r));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jun '25" of a period end (UNIX s, 00:00 UTC). */
function monthYear(sec: number): string {
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
}

const ICONS: Record<string, string[]> = {
  dividend: [
    "M24.5 14A10.5 10.5 0 1 0 14 24.5V26a12 12 0 1 1 0-24 12 12 0 0 1 0 24v-1.5c5.8 0 10.5-4.7 10.5-10.5",
    "M17.3 14A4.3 4.3 0 0 0 13 9.7h-1.3v8.6H13V20h-3V8h3a6 6 0 0 1 .3 12H13v-1.7a4.3 4.3 0 0 0 4.3-4.3",
  ],
  split: [
    "M24.5 14A10.5 10.5 0 1 0 14 24.5V26a12 12 0 1 1 0-24 12 12 0 0 1 0 24v-1.5c5.8 0 10.5-4.7 10.5-10.5",
    "M13.99 8q1.14 0 1.97.43A3.3 3.3 0 0 1 17.78 11H16q-.1-.3-.29-.55a2 2 0 0 0-.7-.54 3 3 0 0 0-1.03-.2q-.57 0-1 .2-.45.19-.7.54a1.4 1.4 0 0 0-.25.84q0 .4.18.72.2.3.58.53.4.22 1.04.37l1.1.26q1.09.26 1.76.68.67.41 1 1.04.3.61.31 1.49 0 1.13-.49 1.92-.48.81-1.39 1.26T14 20q-1.2 0-2.08-.41A3.28 3.28 0 0 1 10 17h1.8q.09.3.3.53.3.36.8.56a3.1 3.1 0 0 0 2.25-.01q.48-.22.75-.6.27-.36.27-.86v-.01q0-.62-.44-1a3 3 0 0 0-1.43-.64l-1.1-.25q-1.05-.25-1.71-.7t-.98-1.1q-.32-.65-.32-1.49 0-1.04.49-1.8.48-.76 1.34-1.2A4 4 0 0 1 14 8",
  ],
  earnings: [
    "M23 23.5V25H5v-1.5zm.5-.5V5a.5.5 0 0 0-.5-.5H5a.5.5 0 0 0-.5.5v18c0 .28.22.5.5.5V25l-.2-.01A2 2 0 0 1 3 23.2L3 23V5c0-1.1.9-2 2-2h18a2 2 0 0 1 2 2v18a2 2 0 0 1-1.8 1.99L23 25v-1.5a.5.5 0 0 0 .5-.5",
    "M11 20V9h6.5v1.7h-4.8v2.95h3.8v1.7h-3.8v2.95h4.8V20z",
  ],
};
/** After the close / before the open (18 × 18). */
const SESSION_ICONS = {
  amc: { path: "M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5z", title: "After market close" },
  bmo: { path: "M12.22 11.78A3.47 3.47 0 0 0 9 6.98a3.48 3.48 0 0 0-3.22 4.8 6.97 6.97 0 0 1 6.44 0zM4.18 9.83L2.1 9.28l.33-1.24 2.07.55-.33 1.24zM6.38 6.36l-.9-1.94 1.16-.54.9 1.94-1.16.54zM10.46 5.82l.9-1.94 1.16.54-.9 1.94-1.16-.54zM13.49 8.6l2.07-.56.33 1.24-2.07.55-.33-1.24z", title: "Before market open" },
};

type Row = { name: string; value: string; icon?: keyof typeof SESSION_ICONS };
type Group = { title: string; rows: Row[] };
type Card = { title: string; kind: ChartEvent["kind"]; rows: Row[]; groups: Group[] };

export function createEvents(cx: ChartCx): EventsApi {
  const { appearance, eventMarkers, props } = cx;
  const [eventCard, setEventCard] = createSignal<number | null>(null);

  // Markers, fetched once per symbol (independent of the interval).
  const [events] = createResource(
    () => props.symbol ?? "",
    (sym) => (sym ? getEvents(sym).catch(() => []) : Promise.resolve([] as ChartEvent[])),
  );
  createEffect(() => {
    const a = appearance();
    // Dividends, Splits and Earnings default ON, Earnings breaks OFF.
    const show = { dividend: a.eventsDividends ?? true, split: a.eventsSplits ?? true, earnings: a.eventsEarnings ?? true };
    const list = events() ?? [];
    eventMarkers.setData(list, show, a.earningsBreaks ?? false);
    // The card of a kind turned off closes.
    const open = untrack(eventCard);
    if (open !== null && !show[list[open]?.kind ?? "dividend"]) setEventCard(null);
  });
  createEffect(() => eventMarkers.setTheme(props.theme !== "light"));
  createEffect(() => eventMarkers.setCoarseBars(aggregateUnitFor(props.interval ?? "1D") !== null));
  // A new symbol or interval closes the card.
  createEffect(() => { void props.symbol; void props.interval; setEventCard(null); });
  createEffect(() => {
    const i = eventCard();
    eventMarkers.setActive(i);
  });

  function toggleEventCard(index: number) {
    setEventCard(eventCard() === index ? null : index);
  }

  const dateText = (sec: number) => {
    const a = appearance();
    return formatChartTime(sec, props.timeZone ?? "UTC", false, false, { dateFormat: a.dateFormat, dayOfWeek: a.dayOfWeek });
  };

  const card = createMemo<Card | null>(() => {
    const i = eventCard();
    const m = i === null ? undefined : eventMarkers.marker(i);
    if (!m) return null;
    if (m.kind === "dividend") {
      const rows: Row[] = [{ name: "Ex-dividend date", value: dateText(m.time) }];
      if (m.amount != null) rows.push({ name: "Amount", value: third(m.amount) });
      if (m.payDate != null) rows.push({ name: "Payment date", value: dateText(m.payDate) });
      return { title: "Dividends", kind: m.kind, rows, groups: [] };
    }
    if (m.kind === "split") {
      const title = m.to != null && m.from != null ? `Split: ${m.to}/${m.from}` : "Split";
      return { title, kind: m.kind, rows: [{ name: dateText(m.time), value: "" }], groups: [] };
    }
    const rows: Row[] = [{ name: "Date", value: dateText(m.time), icon: m.session ?? undefined }];
    if (m.periodEnd != null) rows.push({ name: "Period Ending", value: monthYear(m.periodEnd) });
    const groups: Group[] = [];
    if (m.eps != null) groups.push({ title: "Earnings", rows: [{ name: "Reported", value: third(m.eps) }] });
    if (m.revenue != null) groups.push({ title: "Revenue", rows: [{ name: "Reported", value: volumeFormat(m.revenue) }] });
    return { title: m.revenue != null ? "Earnings & Revenue" : "Earnings", kind: m.kind, rows, groups };
  });

  /** Card anchor (viewport px): centred over the marker, 8 px above its top. */
  const cardPos = () => {
    const i = eventCard();
    if (i === null || !cx.chart || !cx.paneRoot) return null;
    void cx.scaleGeom();
    void cx.mainPaneEpoch();
    const m = cx.mainPane();
    const p = eventMarkers.placed(cx.chart.paneSize(m).height).find((q) => q.index === i);
    if (!p) return null;
    const r = cx.paneRoot.getBoundingClientRect();
    const top = cx.paneBoxes().find((b) => b.index === m)?.top ?? 0;
    const x = r.left + cx.leftAxisWidth() + p.cx;
    const pointY = r.top + top + p.cy - p.size / 2 - 8;
    const width = 300;
    return {
      left: Math.max(0, Math.min(window.innerWidth - width, Math.round(x - width / 2))),
      bottom: Math.round(window.innerHeight - pointY),
      maxHeight: Math.max(0, Math.round(pointY - 15)),
    };
  };

  function EventCard() {
    return (
      <Show when={card()}>
        {(c) => (
          <Show when={cardPos()}>
            {(pos) => {
              const color = () => {
                const st = EVENT_STYLES[c().kind];
                return props.theme === "light" ? st.color.light : st.color.dark;
              };
              return (
                <div
                  class="ot-event-card"
                  style={{ left: `${pos().left}px`, bottom: `${pos().bottom}px`, "max-height": `${pos().maxHeight}px`, "--ot-event-color": color() }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div class="ot-event-card-title">
                    <svg class="ot-event-card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
                      <For each={ICONS[c().kind]}>{(d) => <path fill="currentColor" d={d} />}</For>
                    </svg>
                    <span class="ot-event-card-heading">{c().title}</span>
                  </div>
                  <div class="ot-event-card-rows">
                    <For each={c().rows}>{(row) => <EventRow row={row} />}</For>
                  </div>
                  <For each={c().groups}>
                    {(g) => (
                      <div class="ot-event-card-group">
                        <div class="ot-event-card-group-title">{g.title}</div>
                        <For each={g.rows}>{(row) => <EventRow row={row} />}</For>
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </Show>
        )}
      </Show>
    );
  }

  return { EventCard, eventCard, setEventCard, toggleEventCard, chartEvents: events };
}

function EventRow(props: { row: Row }) {
  return (
    <div class="ot-event-card-row">
      <div class="ot-event-card-cell">{props.row.name}</div>
      <Show when={props.row.value}>
        <div class="ot-event-card-cell">
          {props.row.value}
          <Show when={props.row.icon}>
            {(k) => (
              <span class={`ot-event-card-session is-${k()}`} title={SESSION_ICONS[k()].title}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d={SESSION_ICONS[k()].path} />
                </svg>
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
