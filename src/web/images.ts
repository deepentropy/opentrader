/*
 * Web build: drawing images (Image tool) and the chart snapshots of symbol notes, kept in the browser's IndexedDB
 * under the names the desktop app gives its files (`<16 hex of the content hash>.<ext>`), so a drawing or a note
 * stores only the name either way.
 */
const DB = "opentrader-images";
const STORE = "images";
/** A drawing image; a note's chart snapshot may be bigger (NOTE_MAX_BYTES). */
const MAX_BYTES = 2_000_000;
export const NOTE_MAX_BYTES = 10_000_000;
const EXTS = ["png", "jpg", "jpeg", "webp"];

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(String(req.error));
  });
  return db;
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(String(req.error));
      }),
  );
}

/** Store an image (base64 bytes); returns its file name. The same bytes always
 *  give the same name. Rejects with a message string, as the desktop command. */
export async function saveImage(dataBase64: string, ext: string, maxBytes = MAX_BYTES): Promise<string> {
  const e = ext.toLowerCase();
  if (!EXTS.includes(e)) throw `unsupported image type: ${ext}`;
  let bin: string;
  try {
    bin = atob(dataBase64);
  } catch {
    throw "the image data is not valid base64";
  }
  if (bin.length > maxBytes) throw `image is larger than ${maxBytes / 1_000_000} MB`;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  const name = `${hex}.${e}`;
  await request("readwrite", (s) => s.put(dataBase64, name));
  return name;
}

const NAME = /^[0-9a-f]{16}\.(png|jpe?g|webp)$/i;

/** A stored image as base64. */
export async function readImage(name: string): Promise<string> {
  if (!NAME.test(name)) throw `invalid image name: ${name}`;
  const data = await request<string | undefined>("readonly", (s) => s.get(name));
  if (data == null) throw `image not found: ${name}`;
  return data;
}

/** Remove a stored image (none when it is already gone). */
export async function deleteImage(name: string): Promise<null> {
  if (!NAME.test(name)) throw `invalid image name: ${name}`;
  await request("readwrite", (s) => s.delete(name));
  return null;
}
