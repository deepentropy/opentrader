/*
 * Emoji drawn as images (Twemoji set, graphics CC-BY 4.0), so they look the
 * same on every system: the system font has no flag emojis on Windows. The
 * images are the emoji picker's (scripts/emoji-assets.mjs); an emoji outside
 * that set stays text.
 */
import { Show } from "solid-js";

const URLS = import.meta.glob("../assets/emoji/*.svg", { query: "?no-inline", import: "default", eager: true }) as Record<string, string>;
const URL_BY_FILE: Record<string, string> = {};
for (const [path, url] of Object.entries(URLS)) {
  const file = /\/([0-9a-f-]+)\.svg$/.exec(path)?.[1];
  if (file) URL_BY_FILE[file] = url;
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** The leading emoji of `s` (at its very start, a whole grapheme) and the rest. */
export function separateEmoji(s: string): { emoji: string; rest: string } {
  const first = segmenter ? (segmenter.segment(s)[Symbol.iterator]().next().value?.segment ?? "") : (Array.from(s)[0] ?? "");
  if (first && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(first)) return { emoji: first, rest: s.slice(first.length) };
  return { emoji: "", rest: s };
}

/** Image file name of an emoji: its code points in hex, without U+FE0F unless it is a ZWJ sequence. */
export function emojiFile(e: string): string {
  const s = e.includes("\u200d") ? e : e.replace(/\ufe0f/g, "");
  return Array.from(s, (c) => c.codePointAt(0)!.toString(16)).join("-");
}

/** Image URL of an emoji, undefined when the set has none. */
export function emojiUrl(e: string): string | undefined {
  return URL_BY_FILE[emojiFile(e)];
}

/** An emoji as an image of `size` px (text when the set has no image). */
export function EmojiImage(props: { emoji: string; size: number; class?: string }) {
  return (
    <Show when={emojiUrl(props.emoji)} fallback={<span class={props.class}>{props.emoji}</span>}>
      {(url) => (
        <img
          class={props.class}
          src={url()}
          width={props.size}
          height={props.size}
          alt={props.emoji}
          decoding="async"
          loading="lazy"
          draggable={false}
          style={{ "vertical-align": "middle" }}
        />
      )}
    </Show>
  );
}

/** A text whose leading emoji is drawn as an image. */
export function LeadingEmojiText(props: { text: string; size?: number }) {
  const parts = () => separateEmoji(props.text);
  return (
    <>
      <Show when={parts().emoji}>
        <EmojiImage emoji={parts().emoji} size={props.size ?? 16} class="ot-leading-emoji" />
      </Show>
      {parts().rest}
    </>
  );
}
