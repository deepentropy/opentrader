/*
 * Popups of the drawings overlay: the floating toolbar of the selected
 * drawing, the drawing context menu and the drawing Settings dialog.
 */
import { createSignal, Show, type JSX } from "solid-js";
import type { Accessor } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { screenPoints } from "lightweight-charts-drawing/core/interact/project";
import { isAnchorable } from "lightweight-charts-drawing/core/interact/anchor";
import { tableUi } from "../table-ui";
import { emitAppEvent } from "../../../data/app-events";
import { SelectedToolbar } from "../SelectedToolbar";
import { DrawingContextMenu } from "../DrawingContextMenu";
import { SettingsDialog } from "../SettingsDialog";
import { copyDrawing } from "../clipboard";
import { factoryStyleFor } from "lightweight-charts-drawing/core/specs";
import { clearKindDefault, type DrawingTemplate } from "../templates";
import { drawingCanAlert, drawingLabel, rulesOfDrawing } from "../../../data/alert-condition";
import { alertStore } from "../../../data/alert-store";
import { type OverlayCx } from "./context";

type SettingsTab = "Style" | "Text" | "Coordinates" | "Visibility";

/** What createPopups adds to the overlay context. */
export interface PopupsApi {
  DrawingPopups: () => JSX.Element;
  openSettings: (id: string, tab?: SettingsTab) => void;
  selectedAnchor: () => { drawing: Drawing; pos: Pt } | null;
  settingsDrawing: () => Drawing | null;
  settingsTab: Accessor<SettingsTab>;
}

export function createPopups(cx: OverlayCx): PopupsApi {
  const { intervalHidden, menu, props, setMenu, size } = cx;
  /** Settings dialog open for the drawing with this id. */
  const [settingsId, setSettingsId] = createSignal<string | null>(null);
  /** Tab the dialog opens on ("Visibility on intervals…" routes there). */
  const [settingsTab, setSettingsTab] = createSignal<"Style" | "Text" | "Coordinates" | "Visibility">("Style");
  /** Resolve the current drawing the dialog is editing — reactive so updates
   *  flow through (e.g. lock toggle from inside the dialog). */
  const settingsDrawing = () => {
    const id = settingsId();
    if (!id) return null;
    return props.drawings.find((d) => d.id === id) ?? null;
  };
  function openSettings(id: string, tab?: "Style" | "Text" | "Coordinates" | "Visibility") {
    setSettingsTab(tab ?? "Style");
    setSettingsId(id);
  }

  // Floating-toolbar anchor: bbox-top center of the selected drawing in
  // screen space. Reading `size` keeps it reactive on pan/zoom/resize.
  function selectedAnchor(): { drawing: Drawing; pos: Pt } | null {
    const id = props.selectedId;
    if (!id) return null;
    void size();
    void props.coordEpoch;
    const d = props.drawings.find((x) => x.id === id);
    if (!d) return null;
    // A drawing filtered off this interval by its Visibility matrix isn't
    // painted — anchor no toolbar over the empty chart.
    if (intervalHidden(d)) return null;
    const f = cx.drawFrame(d);
    if (!f) return null;
    // Overlay coordinates (the pane top added).
    const pts = screenPoints(f.coords, d, f.dims)?.map((p) => ({ x: p.x, y: p.y + f.top }));
    if (!pts) return null;
    let minY = Infinity;
    let sumX = 0;
    if (d.kind === "horizontal-line" || d.kind === "horizontal-ray" || d.kind === "vertical-line" || d.kind === "cross-line") {
      // Use the click point as the anchor — these kinds paint full-extent
      // but only have one meaningful position.
      return { drawing: d, pos: { x: pts[0].x, y: pts[0].y } };
    }
    let xCount = 0;
    for (const p of pts) {
      if (p.y < minY) minY = p.y;
      sumX += p.x;
      xCount++;
    }
    return { drawing: d, pos: { x: sumX / xCount, y: minY } };
  }

  /** The selected drawings (the menu's drawing first when it is not selected). */
  const selectedDrawings = (d: Drawing): Drawing[] => {
    const list = cx.selIds().map((id) => props.drawings.find((x) => x.id === id)).filter((x): x is Drawing => !!x);
    return list.some((x) => x.id === d.id) ? list : [d];
  };
  /** Which Visual order moves would change the drawing order (its place among the pane's drawings). */
  const orderSteps = (d: Drawing) => {
    const same = props.drawings.filter((x) => (x.owner ?? null) === (d.owner ?? null));
    const i = same.findIndex((x) => x.id === d.id);
    const last = same.length - 1;
    return { front: i < last, forward: i < last, back: i > 0, backward: i > 0 };
  };
  /** The current sync of drawings: their common one, null when they differ. */
  const syncOf = (list: Drawing[]) => {
    const read = props.drawingSync;
    if (!read) return undefined;
    const modes = new Set(list.map((d) => read(d.id)));
    return modes.size === 1 ? [...modes][0] : null;
  };
  /** A template (or the factory style) on the drawings of the tool. */
  const applyStyle = (list: Drawing[], style: (d: Drawing) => Drawing) => {
    const next = list.map(style);
    if (next.length > 1 && props.onUpdateMany) props.onUpdateMany(next);
    else if (next[0]) props.onUpdate(next[0]);
  };

  /** Selected-drawing toolbar, context menu and Settings dialog. */
  function DrawingPopups() {
    return (
      <>
        {/* Only the active pane shows the selected-drawing toolbar — panes that
            share a symbol all render the selected drawing, so without this gate two
            (or more) toolbars would stack on a multi-layout. */}
        <Show when={props.active !== false && selectedAnchor()}>
          {(a) => (
            <SelectedToolbar
              drawing={a().drawing}
              group={cx.selIds()
                .map((id) => props.drawings.find((d) => d.id === id))
                .filter((d): d is Drawing => !!d)}
              anchor={a().pos}
              onUpdate={props.onUpdate}
              onUpdateMany={props.onUpdateMany}
              onRemove={props.onRemove}
              onRemoveMany={props.onRemoveMany}
              onOpenSettings={openSettings}
              onClone={props.onClone}
              onCopy={copyDrawing}
              onReorder={props.onReorder}
              onTableOp={(op) => cx.tableOp(a().drawing.id, op)}
              onToggleAnchor={isAnchorable(a().drawing.kind) ? () => cx.toggleAnchored(a().drawing.id) : undefined}
              interval={props.interval}
              sync={syncOf(selectedDrawings(a().drawing))}
              onSync={props.onSync}
              onAddAlert={(d) => {
                // Same event the chart context menu uses; the drawing is the
                // alert's level, so the alert follows it when it is moved.
                emitAppEvent("chart-open-alert-dialog", { symbol: props.symbol, drawingId: d.id });
              }}
            />
          )}
        </Show>
        <Show when={menu()}>
          {(m) => (
            <DrawingContextMenu
              drawing={m().drawing}
              group={selectedDrawings(m().drawing)}
              interval={props.interval}
              orderSteps={orderSteps(m().drawing)}
              alert={drawingCanAlert(m().drawing.kind) ? { edit: rulesOfDrawing(alertStore.rules(), m().drawing.id).length > 0, name: drawingLabel(m().drawing) } : null}
              onAlert={() => {
                const rule = rulesOfDrawing(alertStore.rules(), m().drawing.id)[0];
                emitAppEvent("chart-open-alert-dialog", rule ? { editId: rule.id } : { symbol: props.symbol, drawingId: m().drawing.id });
              }}
              onObjectTree={() => emitAppEvent("chart-open-panel", { id: "object_tree" })}
              sync={syncOf(selectedDrawings(m().drawing))}
              onSync={props.onSync}
              anchored={isAnchorable(m().drawing.kind) ? !!m().drawing.anchored : undefined}
              onToggleAnchor={() => cx.toggleAnchored(m().drawing.id)}
              onUpdateMany={props.onUpdateMany}
              onApplyTemplate={(tpl: DrawingTemplate) => applyStyle(selectedDrawings(m().drawing).filter((d) => d.kind === m().drawing.kind), (d) => ({
                ...d,
                style: { ...factoryStyleFor(d.kind), ...tpl.style },
                ...(tpl.text !== undefined ? { text: tpl.text } : {}),
              } as Drawing))}
              onApplyDefault={() => {
                const list = selectedDrawings(m().drawing);
                for (const d of list) clearKindDefault(d.kind);
                applyStyle(list, (d) => ({ ...d, style: factoryStyleFor(d.kind) } as Drawing));
              }}
              // Locked members are excluded so the menu's bulk Remove matches the
              // Delete key (the clicked drawing itself falls to the single path).
              groupIds={cx.selIds().filter((id) => {
                const dd = props.drawings.find((x) => x.id === id);
                return !!dd && (!dd.locked || id === m().drawing.id);
              })}
              anchor={m().pos}
              onClose={() => setMenu(null)}
              onUpdate={props.onUpdate}
              onClone={props.onClone}
              onCopy={copyDrawing}
              onReorder={props.onReorder}
              onRemove={props.onRemove}
              onRemoveMany={props.onRemoveMany}
              onOpenSettings={openSettings}
              tableCell={(() => { const u = tableUi(); return u && u.id === m().drawing.id ? u.cell : null; })()}
              onTableOp={(op) => cx.tableOp(m().drawing.id, op)}
            />
          )}
        </Show>
        <Show when={settingsDrawing()}>
          {(d) => (
            <SettingsDialog
              drawing={d()}
              coords={cx.frameOf(d())?.coords ?? props.coords}
              symbol={props.symbol}
              initialTab={settingsTab()}
              onClose={() => setSettingsId(null)}
              onUpdate={props.onUpdate}
            />
          )}
        </Show>
      </>
    );
  }

  return { DrawingPopups, openSettings, selectedAnchor, settingsDrawing, settingsTab };
}
