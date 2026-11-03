/*
 * The chart snapshots the member sent from the OpenTrader app, to attach to
 * a post or a reply: their pictures (private, fetched with the session),
 * one selected. The website has no chart of its own to picture.
 */
import { For, Show, createResource, onCleanup } from "solid-js";
import { api, type Snapshot } from "../data/community/api";
import { me } from "../data/community/session";
import { tfShort } from "./ui";

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const SNAPSHOT_HOWTO = "In OpenTrader, open the chart's menu and choose \"Send snapshot to Community\".";

function Thumb(props: { snap: Snapshot }) {
  const [url] = createResource(() => props.snap.id, (id) => api.snapshotImage(id).catch(() => null));
  onCleanup(() => { const u = url(); if (u) URL.revokeObjectURL(u); });
  return (
    <Show when={url()} fallback={<div class="cs-snapthumb-empty" />}>
      <img src={url()!} alt={`${props.snap.symbol} snapshot`} />
    </Show>
  );
}

export function SnapshotPicker(props: { selected: string | null; onSelect: (id: string | null) => void; columns?: number }) {
  const [list, { refetch }] = createResource(() => me()?.user.name ?? null, () => api.snapshots().then((r) => r.snapshots).catch(() => [] as Snapshot[]));
  return (
    <div>
      <Show when={(list() ?? []).length} fallback={<p class="cs-note">{list.loading ? "Loading your snapshots…" : `No snapshot yet. ${SNAPSHOT_HOWTO}`} <button type="button" class="cs-link-btn" onClick={() => refetch()}>Refresh</button></p>}>
        <div class="cs-snaps" style={{ "grid-template-columns": `repeat(${props.columns ?? 3}, minmax(0, 1fr))` }}>
          <For each={list()!}>
            {(s) => {
              const on = () => props.selected === s.id;
              return (
                <button type="button" class={"cs-snapcard" + (on() ? " is-on" : "")} aria-pressed={on()} onClick={() => props.onSelect(on() ? null : s.id)}>
                  <div class="cs-snapthumb"><Thumb snap={s} /></div>
                  <div class="cs-snapcard-foot">
                    <span><strong>{s.symbol.split(":").pop()}</strong> · {tfShort(s.interval)} · {hhmm(s.created_at)}</span>
                    <span class="cs-snapcard-sel">{on() ? "Attached" : ""}</span>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
