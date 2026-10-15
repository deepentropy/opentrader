/*
 * "Symbol info" dialog (main series and compared-symbol menus): the symbol's
 * fields in two groups, two per row (data/symbol-info.ts), then its trading
 * session: today's parts on a 24-hour bar, "All sessions" for the whole week,
 * the exchange time zone. 480 wide, centred; closed with its button, Escape
 * or a press outside it.
 */
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { getTickerInfo, getTickerSnapshot } from "../../data/datafeed";
import { quoteFor } from "../../data/quotes";
import { chartLastPrice } from "../../data/chart-state-registry";
import { countryOfExchange, flagUrl } from "../../data/country-flags";
import { splitSymbol } from "../../data/symbol-name";
import { symbolSessions } from "../../data/session";
import { utcOffsetText } from "../../data/alert-schedule";
import { minutesText, sessionWeek, symbolInfoGroups, zoneCity, type InfoField, type SessionPart } from "../../data/symbol-info";

const PART_LABEL: Record<SessionPart, string> = { pre: "Pre-market", open: "Market open", post: "Post-market" };

type Props = { symbol: string; onClose: () => void };

export function SymbolInfoDialog(props: Props) {
  const [info] = createResource(() => props.symbol, (s) => getTickerInfo(s).catch(() => null));
  const [sessions] = createResource(() => props.symbol, (s) => symbolSessions(s).catch(() => null));
  // The price the tick size depends on: the chart's, else the latest quote, else a snapshot.
  const [snapshotLast] = createResource(() => props.symbol, (s) => getTickerSnapshot(s).then((x) => x.last, () => null));
  const [allDays, setAllDays] = createSignal(false);
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const groups = createMemo(() => {
    const i = info();
    const exchange = splitSymbol(props.symbol).exchange;
    const s = sessions();
    const price = chartLastPrice(props.symbol) ?? quoteFor(props.symbol)?.last ?? snapshotLast() ?? null;
    const tick = s && price != null ? s.tickAt(price) : null;
    return symbolInfoGroups({
      symbol: props.symbol,
      name: i?.name,
      sector: i?.sector,
      industry: i?.industry,
      figi: i?.figi,
      homepageUrl: i?.homepageUrl,
      securityType: i?.securityType,
      listedExchange: exchange,
      flag: flagUrl(countryOfExchange(exchange)) ?? null,
      currency: i?.currency,
      tickSize: tick != null ? String(Number(tick.toPrecision(6))) : null,
    });
  });
  const week = createMemo(() => {
    const s = sessions();
    if (!s) return null;
    return sessionWeek(s.spec("RTH"), s.spec("ETH"), now());
  });
  const shownDays = () => (allDays() ? week() ?? [] : (week() ?? []).filter((d) => d.today));
  const timeZone = () => sessions()?.timeZone ?? "America/New_York";
  /** The regular session of today, for the time marks. */
  const openPart = () => week()?.find((d) => d.today)?.segments.find((s) => s.part === "open") ?? null;
  const nowMinutes = () => {
    const tz = timeZone();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now() * 1000));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return n("hour") * 60 + n("minute");
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); props.onClose(); } };
    window.addEventListener("keydown", onKey, true);
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    onCleanup(() => { window.removeEventListener("keydown", onKey, true); clearInterval(timer); });
  });

  return (
    <Portal mount={document.body}>
      <div class="sid-backdrop" onMouseDown={() => props.onClose()}>
        <div class="sid" role="dialog" aria-label="Symbol info" data-name="symbol-info-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div class="sid-header">
            <span class="sid-title">Symbol info</span>
            <button type="button" class="sid-close" aria-label="Close menu" onClick={() => props.onClose()}>
              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="m3.5 3.5 11 11m0-11-11 11" /></svg>
            </button>
          </div>
          <div class="sid-body">
            <For each={groups()}>
              {(group, gi) => (
                <>
                  <Show when={gi() > 0}><div class="sid-sep" /></Show>
                  <div class="sid-group" classList={{ "is-first": gi() === 0 }}>
                    <For each={pairs(group)}>
                      {(row) => <div class="sid-row"><For each={row}>{(f) => <Field field={f} />}</For></div>}
                    </For>
                  </div>
                </>
              )}
            </For>
            <Show when={week()}>
              <div class="sid-sep sid-sep--widget" />
              <div class="sid-session-header">
                <span class="sid-label">Session</span>
                <button type="button" class="sid-all" aria-expanded={allDays()} onClick={() => setAllDays(!allDays())}>
                  <svg classList={{ "is-open": allDays() }} viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" d="m5 7.5 4 3.5 4-3.5" /></svg>
                  All sessions
                </button>
              </div>
              <div class="sid-week">
                <For each={shownDays()}>
                  {(d) => (
                    <div class="sid-day" classList={{ "is-today": d.today }}>
                      <span class="sid-weekday">{d.weekday}</span>
                      <div class="sid-segments">
                        <For each={d.segments}>
                          {(s) => (
                            <Tooltip text={`${PART_LABEL[s.part]} ${minutesText(s.from)} — ${minutesText(s.to)}`}>
                              <div class={`sid-segment sid-segment--${s.part}`} style={{ left: `${(s.from / 1440) * 100}%`, width: `${((s.to - s.from) / 1440) * 100}%` }} />
                            </Tooltip>
                          )}
                        </For>
                        <Show when={d.today}>
                          <div class="sid-now" style={{ left: `${(nowMinutes() / 1440) * 100}%` }} />
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={openPart()}>
                  {(o) => (
                    <div class="sid-day sid-marks">
                      <span class="sid-weekday" />
                      <div class="sid-marks-bar">
                        <span class="sid-mark" style={{ left: `${(o().from / 1440) * 100}%` }}>{minutesText(o().from)}</span>
                        <span class="sid-mark" style={{ left: `${(o().to / 1440) * 100}%` }}>{minutesText(o().to)}</span>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
              <div class="sid-tz">Exchange timezone: {zoneCity(timeZone())} ({utcOffsetText(timeZone())})</div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** Fields two per row. */
function pairs(list: InfoField[]): InfoField[][] {
  const out: InfoField[][] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list.slice(i, i + 2));
  return out;
}

function Field(props: { field: InfoField }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.field.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class="sid-item">
      <span class="sid-label">{props.field.title}</span>
      <div class="sid-value">
        <Show when={props.field.flag}>{(src) => <img class="sid-flag" src={src()} alt="" />}</Show>
        <Show when={props.field.link} fallback={<span>{props.field.value}</span>}>
          {(href) => (
            <a class="sid-link" href={href()} target="_blank" rel="noreferrer">
              <span>{props.field.value}</span>
              <svg class="sid-link-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" d="M10.5 4.5h3v3m0-3L8 10m-1-5.5H5.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V11" /></svg>
            </a>
          )}
        </Show>
        <Show when={props.field.copy}>
          <Tooltip text={copied() ? "Text copied to clipboard" : "Copy"}>
            <button type="button" class="sid-copy" aria-label="Copy" onClick={copy}>
              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" d="M6.5 2.5h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm-2 3h-.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-.5" /></svg>
            </button>
          </Tooltip>
        </Show>
      </div>
    </div>
  );
}
