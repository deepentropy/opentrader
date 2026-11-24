/*
 * Where the plugins' toasts show (`plugin.toast`, plugins/PROTOCOL.md): at the place the plugin asks for, unless the
 * user picked one for all of them, or none, in Settings > Plugins.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

export const TOAST_POSITIONS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const;
export type ToastPosition = (typeof TOAST_POSITIONS)[number];
/** The user's choice: "plugin" leaves it to the plugins, "off" shows no toast (they are still in the plugins' logs). */
export type ToastChoice = "plugin" | ToastPosition | "off";
export const TOAST_CHOICES: ToastChoice[] = ["plugin", ...TOAST_POSITIONS, "off"];

const KEY = "ot:plugin-toasts:position";
const isPosition = (v: unknown): v is ToastPosition => TOAST_POSITIONS.includes(v as ToastPosition);
const load = (): ToastChoice => {
  const v = kv.getItem(KEY);
  return v === "off" || isPosition(v) ? v : "plugin";
};

const [choice, setChoice] = createSignal<ToastChoice>(load());
kv.onExternalChange(KEY, () => setChoice(load()));

export const toastChoice = choice;
export function setToastChoice(v: ToastChoice): void {
  setChoice(v);
  kv.setItem(KEY, v);
}

/** The place of a toast a plugin asks to show at `asked` (none or unknown: bottom left); null: not shown. */
export function toastPlace(user: ToastChoice, asked: string | null | undefined): ToastPosition | null {
  if (user === "off") return null;
  if (user !== "plugin") return user;
  return isPosition(asked) ? asked : "bottom-left";
}

/** What a folded pile shows: its newest toast and every error, so that a later message never covers one. */
export function foldedToasts<T extends { level: string }>(pile: T[]): T[] {
  return pile.filter((t, i) => t.level === "error" || i === pile.length - 1);
}
