/*
 * TV "Image" dialog (chart.imageDialog, module 484731; captured 25/09/2026):
 * opened when the Image tool is armed
 * and from the image settings. A drop zone (click = file picker, or drop a
 * file) "Choose image / JPG, PNG or WEBP / Max size 2MB", a Transparency
 * slider, Cancel / Ok. Ok without an image shows "Image is required"; a click
 * outside confirms (when an image is chosen) and closes, like TV.
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { IMAGE_MAX_SIDE, IMAGE_TYPES } from "lightweight-charts-drawing/tv/kinds/images";
import { saveDrawingImage } from "./image-store";

export type ImageDialogResult = { name: string; width: number; height: number; transparency: number };

export function ImageDialog(props: {
  transparency?: number;
  onConfirm: (r: ImageDialogResult) => void;
  onClose: () => void;
}) {
  const [transparency, setTransparency] = createSignal(props.transparency ?? 0);
  const [picked, setPicked] = createSignal<{ name: string; width: number; height: number; url: string } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  async function take(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!IMAGE_TYPES[file.type]) { setError("Use a JPG, PNG or WEBP image"); return; }
    setBusy(true);
    try {
      const r = await saveDrawingImage(file);
      // TV checkImageSize: natural size above 2000 x 2000 is refused.
      if (r.width > IMAGE_MAX_SIDE || r.height > IMAGE_MAX_SIDE) {
        setError("The image being pasted is way too large");
        setPicked(null);
      } else {
        setPicked({ ...r, url: URL.createObjectURL(file) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPicked(null);
    } finally {
      setBusy(false);
    }
  }

  function submit(): boolean {
    const p = picked();
    if (!p) { setError("Image is required"); return false; }
    props.onConfirm({ name: p.name, width: p.width, height: p.height, transparency: transparency() });
    return true;
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  onCleanup(() => { const p = picked(); if (p) URL.revokeObjectURL(p.url); });

  return (
    <div
      class="drawing-settings-backdrop"
      role="presentation"
      // TV onClickOutside: confirm (when an image is chosen) and close.
      onClick={() => { submit(); props.onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        class="drawing-settings-dialog image-dialog"
        role="dialog"
        aria-label="Image"
        data-name="create-image-drawing-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="drawing-settings-header">
          <div class="drawing-settings-title">
            <span class="drawing-settings-title-text">Image</span>
          </div>
          <button type="button" aria-label="Close menu" data-qa-id="close" class="drawing-settings-close" onClick={props.onClose}>
            <svg viewBox="0 0 18 18" width="18" height="18">
              <path stroke="currentColor" stroke-width="1.2" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
        </header>
        <div class="image-dialog-content">
          <div
            class={"image-dropzone" + (dragOver() ? " drag-over" : "")}
            onClick={() => fileInput?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void take(e.dataTransfer?.files?.[0]); }}
          >
            <Show
              when={picked() && !error()}
              fallback={
                <span class="image-dropzone-text">
                  <span class={"image-dropzone-headline" + (error() ? " error" : "")}>{busy() ? "…" : error() ?? "Choose image"}</span>
                  <span>JPG, PNG or WEBP</span>
                  <span>Max size 2MB</span>
                </span>
              }
            >
              <img class="image-dropzone-img" src={picked()!.url} alt="" />
            </Show>
            <Show when={dragOver()}>
              <div class="image-dropzone-backdrop"><p>Drop image here!</p></div>
            </Show>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={(e) => { void take(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }}
            />
          </div>
          <div class="image-dialog-transparency">
            <span class="image-dialog-transparency-title">Transparency</span>
            <TransparencySlider value={transparency()} onChange={setTransparency} class="image-dialog-transparency-control" />
          </div>
        </div>
        <footer class="drawing-settings-footer image-dialog-footer">
          <div class="drawing-settings-footer-buttons">
            <button type="button" name="cancel" class="drawing-settings-btn secondary" onClick={props.onClose}>Cancel</button>
            <button
              type="button"
              name="submit"
              data-name="submit-button"
              class="drawing-settings-btn primary"
              onClick={() => { if (submit()) props.onClose(); }}
            >
              Ok
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** TV Transparency control (module 102987): the Opacity slider without its
 *  input, tv-blue-500, value = transparency (0 = opaque, thumb at the right). */
export function TransparencySlider(props: { value: number; onChange: (t: number) => void; class?: string }) {
  let track: HTMLDivElement | undefined;
  const opacity = () => Math.max(0, Math.min(100, 100 - props.value));
  const setFrom = (clientX: number) => {
    if (!track) return;
    const r = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    props.onChange(Math.round(100 - 100 * f));
  };
  return (
    <div
      ref={track}
      class={"tv-transparency" + (props.class ? ` ${props.class}` : "")}
      role="slider"
      aria-label="Transparency"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setFrom(e.clientX);
      }}
      onPointerMove={(e) => { if (e.buttons & 1) setFrom(e.clientX); }}
    >
      <div class="tv-transparency-gradient" />
      <div class="tv-transparency-thumb" style={{ left: `calc((100% - 12px) * ${opacity() / 100})` }} />
    </div>
  );
}
