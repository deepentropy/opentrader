/*
 * Web build stand-in for `@tauri-apps/api/core` (aliased in vite.config.ts).
 * `invoke` sends a command to the OpenTrader server, except the few the desktop
 * backend answers from the machine itself, which the browser answers here.
 * The rest of the module is the original (other packages import from it).
 */
import { call } from "./server";
import { readImage, saveImage } from "./images";

// By path: the package name is aliased to this file.
export * from "../../node_modules/@tauri-apps/api/core.js";

type Args = Record<string, unknown>;

const LOCAL: Record<string, (args: Args) => Promise<unknown>> = {
  // "Open image in new tab": the PNG in a browser tab.
  open_snapshot: async (a) => {
    const bin = atob(String(a.pngBase64 ?? ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    if (!window.open(url, "_blank")) throw "the browser blocked the new tab";
    return null;
  },
  save_drawing_image: (a) => saveImage(String(a.dataBase64 ?? ""), String(a.ext ?? "")),
  read_drawing_image: (a) => readImage(String(a.name ?? "")),
};

export async function invoke<T>(cmd: string, args: Args = {}): Promise<T> {
  const local = LOCAL[cmd];
  return (await (local ? local(args) : call(cmd, args))) as T;
}
