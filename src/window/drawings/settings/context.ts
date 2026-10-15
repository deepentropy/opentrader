/*
 * Shared context of the drawing Settings dialog's pages (settings/*-tab.tsx):
 * the dialog props and the helpers the dialog itself owns (style patch,
 * kind, price step, the position's money unit).
 */
import type { Drawing, DrawingStyle } from "lightweight-charts-drawing/core/types";
import type { Tab } from "./kind-config";

export type SettingsDialogProps = {
  drawing: Drawing;
  onClose: () => void;
  onUpdate: (d: Drawing) => void;
  /** Tab to open on (context menu's "Visibility on intervals…" routes here). */
  initialTab?: Tab;
  /** Pixel↔data bridge — used by the Coordinates tab to show/edit each point's
   *  bar index. Null before the chart lays out. */
  coords?: import("../coords").Coords | null;
  /** Bare ticker of the pane (position Risk unit: the symbol currency). */
  symbol?: string;
};

/** What the dialog hands its pages. */
export interface SettingsCx {
  props: SettingsDialogProps;
  kind: () => string;
  moneyUnit: () => string;
  patchStyle: (patch: Partial<DrawingStyle>) => void;
  pip: () => number;
  priceDigits: () => number;
}
