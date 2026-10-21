/*
 * Paints a small DOM overlay (the chart's trading lines: rows of chips,
 * line segments, axis labels, execution arrows) onto a snapshot canvas:
 * backgrounds, borders (solid / dashed / dotted, rounded), text runs and
 * inline SVG icons, with the elements' opacity. Enough for flat absolutely
 * positioned overlays; no shadows, gradients or transforms but the icons'.
 */

type Box = { x: number; y: number; w: number; h: number };

const px = (v: string) => parseFloat(v) || 0;

function isTransparent(c: string): boolean {
  return !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
}

function dashOf(style: string, width: number): number[] {
  if (style === "dotted") return [width, width];
  if (style === "dashed") return [3 * width, 2 * width];
  return [];
}

function roundRect(ctx: CanvasRenderingContext2D, b: Box, r: number) {
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, Math.max(0, Math.min(r, b.w / 2, b.h / 2)));
}

/** Background and borders of `el` at `b`. */
function paintBox(ctx: CanvasRenderingContext2D, cs: CSSStyleDeclaration, b: Box) {
  const r = px(cs.borderTopLeftRadius);
  if (!isTransparent(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor;
    roundRect(ctx, b, r);
    ctx.fill();
  }
  const sides = (["Top", "Right", "Bottom", "Left"] as const).map((s) => ({
    w: cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" ? 0 : px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)),
    style: cs.getPropertyValue(`border-${s.toLowerCase()}-style`),
    color: cs.getPropertyValue(`border-${s.toLowerCase()}-color`),
  }));
  const same = sides.every((s) => s.w === sides[0].w && s.style === sides[0].style && s.color === sides[0].color);
  if (same && sides[0].w > 0 && !isTransparent(sides[0].color)) {
    const w = sides[0].w;
    ctx.strokeStyle = sides[0].color;
    ctx.lineWidth = w;
    ctx.setLineDash(dashOf(sides[0].style, w));
    roundRect(ctx, { x: b.x + w / 2, y: b.y + w / 2, w: b.w - w, h: b.h - w }, r - w / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const seg = (i: number, x1: number, y1: number, x2: number, y2: number) => {
    const s = sides[i];
    if (s.w <= 0 || isTransparent(s.color)) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.w;
    ctx.setLineDash(dashOf(s.style, s.w));
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const [t, rt, bt, l] = sides.map((s) => s.w / 2);
  seg(0, b.x, b.y + t, b.x + b.w, b.y + t);
  seg(1, b.x + b.w - rt, b.y, b.x + b.w - rt, b.y + b.h);
  seg(2, b.x, b.y + b.h - bt, b.x + b.w, b.y + b.h - bt);
  seg(3, b.x + l, b.y, b.x + l, b.y + b.h);
  ctx.setLineDash([]);
}

/** An inline SVG as an image, `currentColor` resolved to `color`. */
function svgImage(svg: SVGSVGElement, color: string, w: number, h: number): Promise<HTMLImageElement | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("style");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("color", color);
  clone.style.color = color;
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

type Op = (ctx: CanvasRenderingContext2D) => void;

/** Paint `root` and its subtree onto `ctx` (CSS pixels, already scaled),
 *  positions relative to `origin` (the canvas' top-left on screen). */
export async function paintDomLayer(ctx: CanvasRenderingContext2D, root: HTMLElement, origin: DOMRect): Promise<void> {
  const ops: (Op | Promise<Op | null>)[] = [];
  const rel = (r: DOMRect): Box => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  const clip = rel(root.getBoundingClientRect());

  const walk = (el: Element, alpha: number) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none") return;
    const a = alpha * (px(cs.opacity) || (cs.opacity === "0" ? 0 : 1));
    if (a <= 0) return;
    const visible = cs.visibility !== "hidden";
    const b = rel(el.getBoundingClientRect());
    if (el instanceof SVGSVGElement) {
      if (!visible || b.w <= 0 || b.h <= 0) return;
      const m = new DOMMatrix(cs.transform === "none" ? undefined : cs.transform);
      ops.push(
        svgImage(el, cs.color, b.w, b.h).then((img) =>
          img
            ? (c) => {
                c.save();
                c.globalAlpha = a;
                c.translate(b.x + b.w / 2, b.y + b.h / 2);
                c.transform(m.a, m.b, m.c, m.d, 0, 0);
                c.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h);
                c.restore();
              }
            : null,
        ),
      );
      return;
    }
    if (visible && b.w > 0 && b.h > 0) {
      ops.push((c) => {
        c.save();
        c.globalAlpha = a;
        paintBox(c, cs, b);
        c.restore();
      });
    }
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent?.trim();
        if (!text || !visible) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = rel(range.getBoundingClientRect());
        if (r.w <= 0) continue;
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const color = cs.color;
        ops.push((c) => {
          c.save();
          c.globalAlpha = a;
          c.font = font;
          c.fillStyle = color;
          c.textBaseline = "middle";
          c.fillText(text, r.x, r.y + r.h / 2);
          c.restore();
        });
      } else if (n instanceof Element) {
        walk(n, a);
      }
    }
  };
  walk(root, 1);

  const resolved = await Promise.all(ops);
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.w, clip.h);
  ctx.clip();
  for (const op of resolved) op?.(ctx);
  ctx.restore();
}
