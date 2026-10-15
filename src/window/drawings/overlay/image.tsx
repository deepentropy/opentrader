/*
 * Image drawings in the overlay: the Image dialog opened by the tool, the
 * placement of a dialog or pasted image, and the removal of an image that
 * fails to load.
 */
import { createEffect, createSignal, Show, type JSX } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import { unproject } from "lightweight-charts-drawing/core/interact/project";
import { drawingImageFailed, imageInitialSize, IMAGE_MAX_SIDE } from "lightweight-charts-drawing/core/kinds/images";
import { imagesVersion, saveDrawingImage } from "../image-store";
import { ImageDialog } from "../ImageDialog";
import { type OverlayCx } from "./context";

/** What createImages adds to the overlay context. */
export interface ImagesApi {
  ImageDialogHost: () => JSX.Element;
  imageDialog: Accessor<boolean>;
  pasteImage: (file: File) => Promise<void>;
  placeImage: (r: { name: string; width: number; height: number; transparency: number }) => void;
  setImageDialog: Setter<boolean>;
}

export function createImages(cx: OverlayCx): ImagesApi {
  const { props } = cx;
  // ── Image ─────────────────────────────────────────────────────────────
  // Arming the tool opens the Image dialog at once (active pane only); Ok
  // places the image at the pane centre, sized to fit a quarter of the pane,
  // and selects it. Cancel / Ok both leave the tool.
  const [imageDialog, setImageDialog] = createSignal(false);
  createEffect(() => {
    if (props.armedTool === "image" && props.active !== false) setImageDialog(true);
  });
  function placeImage(r: { name: string; width: number; height: number; transparency: number }) {
    const f = cx.mainFrame();
    if (!f) return;
    const c = f.coords;
    const { w, h } = f.dims;
    const dp = unproject(c, { x: w / 2, y: h / 2 });
    if (!dp) return;
    const id = props.onPlace({
      kind: "image",
      points: [dp],
      image: { name: r.name, ...imageInitialSize(r.width, r.height, w, h) },
      style: { ...defaultStyleFor("image"), transparency: r.transparency },
    });
    if (id) props.setSelectedId(id);
  }
  /** Paste an image as a drawing: a pasted image file (type, 2 MB and 2000 x
   *  2000 checks as the Image dialog) is placed like a dialog image, with the
   *  factory transparency, and selected. */
  async function pasteImage(file: File) {
    try {
      const r = await saveDrawingImage(file);
      if (r.width > IMAGE_MAX_SIDE || r.height > IMAGE_MAX_SIDE) throw new Error("The image being pasted is way too large");
      placeImage({ ...r, transparency: defaultStyleFor("image").transparency ?? 0 });
    } catch (err) {
      console.warn("[image] paste failed:", err instanceof Error ? err.message : err);
    }
  }
  // An image drawing whose image fails to load is removed.
  createEffect(() => {
    void imagesVersion();
    if (props.active === false) return;
    for (const d of props.drawings) {
      if (d.kind === "image" && drawingImageFailed(d.image?.name)) props.onRemove(d.id);
    }
  });

  /** The Image dialog of the armed Image tool. */
  function ImageDialogHost() {
    return (
      <Show when={imageDialog()}>
        <ImageDialog
          onConfirm={(r) => placeImage(r)}
          onClose={() => {
            setImageDialog(false);
            if (props.armedTool === "image") props.onDisarm();
          }}
        />
      </Show>
    );
  }

  return { ImageDialogHost, imageDialog, pasteImage, placeImage, setImageDialog };
}
