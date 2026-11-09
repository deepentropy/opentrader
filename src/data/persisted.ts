/*
 * persisted — one kv setting as a Solid signal: read and checked once at
 * import, saved on every set and, when asked, following the writes of the
 * other windows (kv's onExternalChange).
 *
 * Why: most stores hand-rolled the same read / parse / validate / save steps,
 * and only some remembered to follow the other windows. Kept apart from kv.ts,
 * which loads before anything else and has no dependency, and built on kv's
 * own functions so a test that replaces kv replaces it here too.
 */
import { createSignal, type Accessor } from "solid-js";
import * as kv from "./kv";

export type PersistedOptions<T> = {
  /** The value of a stored string; undefined when it is not one (the default
   *  is used). A parse that throws (bad JSON) counts as undefined. */
  parse: (raw: string) => T | undefined;
  /** The stored string of a value: JSON unless the setting stores plain text. */
  format?: (value: T) => string;
  /** The value when nothing valid is stored. */
  default: T;
  /** Follow the writes of the other windows (a removed key: the default). */
  sync?: boolean;
};

export type Persisted<T> = [get: Accessor<T>, set: (value: T) => void];

/** The setting stored under `key`. */
export function persisted<T>(key: string, opts: PersistedOptions<T>): Persisted<T> {
  const format = opts.format ?? ((v: T) => JSON.stringify(v));
  const read = (raw: string | null): T => {
    if (raw === null) return opts.default;
    try {
      return opts.parse(raw) ?? opts.default;
    } catch {
      return opts.default;
    }
  };
  const [get, setSignal] = createSignal<T>(read(kv.getItem(key)));
  if (opts.sync) kv.onExternalChange(key, (raw) => setSignal(() => read(raw)));
  const set = (value: T) => {
    setSignal(() => value);
    kv.setItem(key, format(value));
  };
  return [get, set];
}

/** Parse of a setting stored as one of `values` in plain text. */
export const oneOf =
  <V extends string>(...values: V[]) =>
  (raw: string): V | undefined =>
    (values as string[]).includes(raw) ? (raw as V) : undefined;
