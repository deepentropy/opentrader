// Copies the emoji images of the emoji picker (src/components/emoji-groups.ts)
// from the Twemoji set (@twemoji/svg, graphics CC-BY 4.0) to src/assets/emoji.
// Run after changing the emoji groups: node scripts/emoji-assets.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const src = "node_modules/@twemoji/svg";
const out = "src/assets/emoji";
const text = readFileSync("src/components/emoji-groups.ts", "utf8");
const emojis = [...text.matchAll(/emojis: "([^"]*)"/g)].flatMap((m) => m[1].split(" "));

/** Twemoji file name: the code points in hex, without U+FE0F unless the emoji is a ZWJ sequence. */
export function emojiFile(e) {
  const s = e.includes("‍") ? e : e.replace(/️/g, "");
  return [...s].map((c) => c.codePointAt(0).toString(16)).join("-");
}

if (existsSync(out)) for (const f of readdirSync(out)) rmSync(join(out, f));
mkdirSync(out, { recursive: true });
const missing = [];
for (const e of emojis) {
  const f = `${emojiFile(e)}.svg`;
  if (existsSync(join(src, f))) copyFileSync(join(src, f), join(out, f));
  else missing.push(`${e} ${f}`);
}
console.log(`${emojis.length - missing.length} copied, ${missing.length} missing${missing.length ? ": " + missing.join(", ") : ""}`);
