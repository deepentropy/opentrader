/*
 * A tool step of the AI assistant as a line of the chat ("Added RSI", "Creating watchlist Semis…"): the tool's title
 * and the argument that says the most, by status.
 */
import type { ToolStep } from "../../data/assistant/session";

/** The argument shown after the title, by tool. */
const KEY_ARG: [string, (a: Record<string, unknown>) => unknown][] = [
  ["symbol", (a) => a.symbol],
  ["name", (a) => a.name],
  ["indicatorId", (a) => a.indicatorId ?? a.id],
  ["screen", (a) => a.screen],
  ["kind", (a) => a.kind],
  ["condition", (a) => a.condition],
  ["interval", (a) => a.interval],
  ["query", (a) => a.query],
];

const words = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function stepTitle(step: ToolStep): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(step.arguments || "{}");
  } catch {
    /* shown without its argument */
  }
  const keyed = KEY_ARG.map(([, f]) => f(args)).find((v) => typeof v === "string" && v.trim());
  const symbols = Array.isArray(args.symbols) ? (args.symbols as unknown[]).filter((s) => typeof s === "string").slice(0, 4).join(", ") : "";
  const what = [words(step.name), keyed as string | undefined, symbols].filter(Boolean).join(" · ");
  return step.status === "running" || step.status === "pending" ? `${what}…` : what;
}
