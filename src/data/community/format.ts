/*
 * How the community's figures read, on the website and in the app's panel:
 * prices, R multiples, dates (dd/mm/yyyy), a trader's record, an idea's
 * state, a post's status line.
 */
import type { Idea, Post, PostType, TrackRecord } from "./api";

export const TYPE_LABEL: Record<PostType, string> = { idea: "Idea", analysis: "Analysis", question: "Question", postmortem: "Post-mortem" };
export const TYPE_PLURAL: Record<PostType, string> = { idea: "Ideas", analysis: "Analysis", question: "Questions", postmortem: "Post-mortems" };
export const TYPES: PostType[] = ["idea", "analysis", "question", "postmortem"];

export const UP = "#089981";
export const DOWN = "#f23645";
export const INK = "#d9dbe0";
export const FOG = "#8b8f99";

// ── Numbers and dates ───────────────────────────────────────────────────

export const price = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));

const MINUS = "\u2212";

/** "+0.44R", "−1.0R", "+2.4R": two decimals under 1R, one above. */
export function fmtR(r: number | null | undefined): string {
  if (r == null) return "—";
  const a = Math.abs(r);
  const s = a >= 1 ? a.toFixed(1) : a.toFixed(2).replace(/0$/, "");
  return `${r < 0 ? MINUS : "+"}${s}R`;
}

export const rColor = (r: number | null | undefined) => (r == null || r === 0 ? INK : r > 0 ? UP : DOWN);

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return "—";
  return `${v < 0 ? MINUS : "+"}${Math.abs(v).toFixed(digits)}%`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** dd/mm/yyyy of a UNIX time. */
export function date(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** dd/mm/yyyy hh:mm of a UNIX time. */
export function dateTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${date(sec)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** dd/mm/yyyy of a session date (YYYY-MM-DD). */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Days from now to a session date, at least 0. */
export function daysLeft(iso: string, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(`${iso}T21:00:00Z`) - nowMs) / 86_400_000));
}

/** "2h", "5h", "1d", then the date. */
export function age(sec: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - sec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return date(sec);
}

/** "34 ideas · 62% hit", "2 open ideas", "no ideas yet". */
export function recordLine(r: TrackRecord | null | undefined): string {
  if (!r || (!r.resolved && !r.open)) return "no ideas yet";
  if (!r.resolved) return `${r.open} open idea${r.open === 1 ? "" : "s"}`;
  return `${r.resolved} idea${r.resolved === 1 ? "" : "s"} · ${r.hit_pct}% hit`;
}

/** "34 resolved ideas · 62% hit · +0.42R avg". */
export function recordLong(r: TrackRecord | null | undefined): string {
  if (!r || !r.resolved) return recordLine(r);
  return `${r.resolved} resolved idea${r.resolved === 1 ? "" : "s"} · ${r.hit_pct}% hit · ${fmtR(r.avg_r)} avg`;
}

// ── Ideas ───────────────────────────────────────────────────────────────

const OUTCOME: Record<string, string> = { target: "Target hit", stopped: "Stopped", expired: "Expired", untriggered: "Expired, not triggered", pending: "Not triggered", open: "Open" };

/** An idea's state in a line: "Open · +0.44R", "Target hit · +2.1R", "Not triggered". */
export function ideaState(i: Idea): { text: string; color: string } {
  if (i.status === "pending" || i.status === "untriggered") return { text: OUTCOME[i.status], color: FOG };
  if (i.status === "open") return { text: `Open · ${fmtR(i.result_r)}`, color: INK };
  return { text: `${OUTCOME[i.status]} · ${fmtR(i.result_r)}`, color: i.status === "stopped" ? DOWN : rColor(i.result_r) };
}

/** The outcome alone: "Open", "Target · 28/10/2026", "Stopped · 30/09/2026". */
export function outcome(i: Idea): string {
  if (i.status === "pending") return "Not triggered";
  if (i.status === "open") return "Open";
  const when = i.resolved_at ? ` · ${date(i.resolved_at)}` : "";
  return `${i.status === "target" ? "Target" : OUTCOME[i.status]}${when}`;
}

/** The status line of a post in a list: an idea's state, an answered question, a post-mortem's idea. */
export function postState(p: Post): { text: string; color: string } | null {
  if (p.idea) return ideaState(p.idea);
  if (p.type === "question" && p.answer_id) return { text: "Answered", color: INK };
  if (p.type === "postmortem" && p.linked?.status) {
    const s = p.linked.status;
    const label = s === "target" ? "target hit" : s === "pending" ? "not triggered" : s === "untriggered" ? "not triggered" : s;
    return { text: `Linked idea: ${label}${p.linked.result_r != null ? ` · ${fmtR(p.linked.result_r)}` : ""}`, color: s === "stopped" ? DOWN : rColor(p.linked.result_r) };
  }
  return null;
}
