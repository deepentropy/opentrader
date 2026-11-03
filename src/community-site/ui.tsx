/*
 * Pieces shared by the website's pages: the post-type and direction tags,
 * the ticker drawn as the chart's price-axis label, initials, pill tabs, the
 * chart snapshot; and (data/community/format.ts) how figures read.
 */
import { For, Show } from "solid-js";
import { GENERAL, imageUrl, type Post, type PostType } from "../data/community/api";
import { TYPE_LABEL } from "../data/community/format";
import { longIntervalLabel, shortIntervalLabel } from "../window/chart/interval-favorites";
import { go } from "./router";

export * from "../data/community/format";

export function TypeTag(props: { type: PostType }) {
  return <span class={`cs-type is-${props.type}`}>{TYPE_LABEL[props.type]}</span>;
}

export function DirTag(props: { dir: "long" | "short" }) {
  return <span class="cs-type is-dir">{props.dir === "long" ? "Long" : "Short"}</span>;
}

/** "NVDA" for `t:NVDA`, "General" for General. */
export function tickerName(communityId: string): string {
  return communityId === GENERAL ? "General" : communityId.replace(/^t:/, "").replace(/^\$/, "");
}

export function communityHref(communityId: string): string {
  return communityId === GENERAL ? "/c/general" : `/t/${encodeURIComponent(tickerName(communityId))}`;
}

/** The ticker as a price-axis label (blue, notched on the left); a link to its page. */
export function TickerTag(props: { id: string; size?: "big" | "mid" }) {
  const href = () => communityHref(props.id);
  return (
    <a class={"cs-tk" + (props.size ? ` is-${props.size}` : "")} href={href()} onClick={go(href())}>
      {tickerName(props.id)}
    </a>
  );
}

/** Two letters: the first of each part of the name ("s.amari" → SA), or its first two. */
export function initials(name: string | null): string {
  if (!name) return "?";
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

export function Avatar(props: { name: string | null; size?: number }) {
  const s = () => props.size ?? 32;
  return (
    <span class="cs-av" style={{ width: `${s()}px`, height: `${s()}px`, "font-size": `${Math.round(s() * 0.36)}px` }} aria-hidden="true">
      {initials(props.name)}
    </span>
  );
}

export function UserLink(props: { name: string | null }) {
  return (
    <Show when={props.name} fallback={<span class="cs-user is-gone">[deleted]</span>}>
      <a class="cs-user" href={`/u/${encodeURIComponent(props.name!)}`} onClick={go(`/u/${encodeURIComponent(props.name!)}`)}>{props.name}</a>
    </Show>
  );
}

/** Pill tabs: Most useful / Newest, Long / Short, the profile's tabs. */
export function Pills<T extends string>(props: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div class="cs-pills" role="tablist" aria-label={props.label}>
      <For each={props.items}>
        {(it) => (
          <button type="button" role="tab" aria-selected={props.value === it.id} class={props.value === it.id ? "is-on" : ""} onClick={() => props.onChange(it.id)}>
            {it.label}
          </button>
        )}
      </For>
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────

export const tfShort = (interval: string) => shortIntervalLabel(interval);
export const tfLong = (interval: string) => longIntervalLabel(interval);

/** The post's chart picture, with its caption ("NVDA · 1D · OpenTrader snapshot"). */
export function Snapshot(props: { post: Post; caption?: boolean }) {
  return (
    <Show when={props.post.image_url}>
      <a class="cs-snap" href={`/p/${props.post.id}`} onClick={go(`/p/${props.post.id}`)}>
        <img src={imageUrl(props.post.image_url!)} alt={`Chart shared with "${props.post.title}"`} loading="lazy" />
      </a>
      <Show when={props.caption !== false}>
        <div class="cs-snap-cap">
          {tickerName(props.post.community.id)}
          <Show when={props.post.chart}> · {tfShort(props.post.chart!.interval)}</Show> · OpenTrader snapshot
        </div>
      </Show>
    </Show>
  );
}

export function signInPath(): string {
  return `/signin?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export const SEARCH_ICON = (size = 16, stroke = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
