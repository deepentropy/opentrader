/*
 * Drawing images in OpenTrader: the file lives in the app data folder (Rust
 * commands save_drawing_image / read_drawing_image, named by content hash).
 * Plugs the reader into the shared core cache and exposes a SolidJS signal
 * that bumps when an image finished loading (renderers re-read the cache).
 */
import { createSignal } from "solid-js";
import { commands } from "../../bindings";
import { cacheImage, decodeImage, IMAGE_MAX_BYTES, IMAGE_TYPES, imageMimeOf, onImagesChanged, setImageReader } from "lightweight-charts-drawing/core/kinds/images";

const [version, setVersion] = createSignal(0);
export const imagesVersion = version;
onImagesChanged(() => setVersion((n) => n + 1));

setImageReader(async (name) => {
  const r = await commands.readDrawingImage(name);
  if (r.status !== "ok") throw new Error(r.error);
  // Blob URL: the <image> href stays short (no base64 in the DOM).
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: imageMimeOf(name) });
});

/** Store a chosen file (checks: type and 2 MB) and return its name and
 *  natural size. Throws with a user message on a bad file. */
export async function saveDrawingImage(file: File): Promise<{ name: string; width: number; height: number }> {
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw new Error("Use a JPG, PNG or WEBP image");
  if (file.size > IMAGE_MAX_BYTES) throw new Error("The image is larger than 2MB");
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("could not read the file"));
    fr.readAsDataURL(file);
  });
  const loaded = await decodeImage(URL.createObjectURL(file));
  const r = await commands.saveDrawingImage(dataUrl.split(",")[1] ?? "", ext);
  if (r.status !== "ok") throw new Error(r.error);
  cacheImage(r.data, loaded);
  return { name: r.data, width: loaded.width, height: loaded.height };
}
