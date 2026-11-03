/*
 * Markdown of community posts and comments, to safe HTML. The text is escaped first, then a small subset is
 * rendered: paragraphs (a line break stays one), headings, bold / italic / strikethrough, inline code and code
 * blocks, quotes, lists, tables, rules, links (http and https only) and bare addresses. No raw HTML, no images.
 * Links carry `data-external`: the panel opens them in the browser.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const link = (url: string, text: string) => `<a href="${url}" data-external="1" rel="noopener noreferrer">${text}</a>`;

/** Bare address: trailing punctuation stays outside. */
const AUTOLINK = /\bhttps?:\/\/[^\s<]+[^\s<.,:;!?'")\]]/g;

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

export function renderInline(src: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  // Code spans and links first: nothing inside them is formatted again.
  let s = src.replace(/\u0000/g, "").replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => keep(link(esc(url), emphasis(esc(text)))));
  s = s.replace(AUTOLINK, (url) => keep(link(esc(url), esc(url))));
  s = emphasis(esc(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** The line under a table's head: at least two columns of dashes. */
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes("|") && next !== undefined && TABLE_SEP.test(next));
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (m) items.push(m[2]);
        // A continuation line, indented under its item.
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += "\n" + lines[i].trim();
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_c, k) => `<td>${renderInline(r[k] ?? "")}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1])); i++) para.push(lines[i].trim());
    out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
  }
  return out.join("");
}

/** The text without its Markdown marks, on one line (previews in the list). */
export function plainText(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\|/g, " ")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
