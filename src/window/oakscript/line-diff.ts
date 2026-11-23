/*
 * Line diff of a script against its saved version (#325, diff decorations): the changed blocks of lines, each one
 * added, removed or modified. Common first and last lines are skipped, the middle is a longest-common-subsequence diff
 * (scripts are a few hundred lines); a middle too large for that is one modified block.
 */

export type DiffKind = "added" | "removed" | "modified";

/** One changed block. Lines are 1-based; a count of 0 is an empty side. For a removal, `modStart` is the line the
 *  removed lines stood before (the lines above it are kept); for an addition, `origStart` is the same on the saved side. */
export type DiffHunk = {
  kind: DiffKind;
  origStart: number;
  origCount: number;
  modStart: number;
  modCount: number;
};

/** Above this many line pairs in the changed middle, it is reported as one block. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function diffLines(original: string, modified: string): DiffHunk[] {
  if (original === modified) return [];
  const a = splitLines(original);
  const b = splitLines(modified);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_CELLS || n === 0 || m === 0) return [hunk(head + 1, n, head + 1, m)];

  // lcs[i][j]: common lines of a[head+i..] and b[head+j..] (flat array, (n+1) x (m+1)).
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  let gapA = 0;
  let gapB = 0;
  const flush = () => {
    if (gapA || gapB) hunks.push(hunk(head + i - gapA + 1, gapA, head + j - gapB + 1, gapB));
    gapA = gapB = 0;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      gapB++;
      j++;
    } else {
      gapA++;
      i++;
    }
  }
  flush();
  return hunks;
}

function hunk(origStart: number, origCount: number, modStart: number, modCount: number): DiffHunk {
  const kind: DiffKind = origCount === 0 ? "added" : modCount === 0 ? "removed" : "modified";
  return { kind, origStart, origCount, modStart, modCount };
}

/** The lines of the shown script a block's gutter mark covers: its lines, or for a removal the line above the gap
 *  (the first line when the gap is at the top). */
export function markedLines(h: DiffHunk): { from: number; to: number } {
  if (h.kind === "removed") {
    const line = Math.max(1, h.modStart - 1);
    return { from: line, to: line };
  }
  return { from: h.modStart, to: h.modStart + h.modCount - 1 };
}

/** The script text with block `h` put back as it was saved (the block's "Discard changes"). */
export function revertHunk(original: string, modified: string, h: DiffHunk): string {
  const a = splitLines(original);
  const b = splitLines(modified);
  b.splice(h.modStart - 1, h.modCount, ...a.slice(h.origStart - 1, h.origStart - 1 + h.origCount));
  return b.join("\n");
}
