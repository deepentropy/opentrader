/*
 * Web version: the imported series (#266) live in this browser tab only, for
 * the session (the desktop app keeps them in its data folder). Answers the
 * `local_series_*` commands in place of the server.
 */
import type { LocalSeries } from "../bindings";

const NAME = /^[A-Z0-9._-]{1,42}$/;
const store = new Map<string, { meta: LocalSeries; rows: number[] }>();

function checkName(name: string): void {
  if (!NAME.test(name)) throw `invalid series name: ${name}`;
}

export const localSeriesCommands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  local_series_list: async () => [...store.values()].map((s) => s.meta).sort((a, b) => a.name.localeCompare(b.name)),
  local_series_save: async (a) => {
    const meta = a.meta as LocalSeries;
    checkName(meta.name);
    store.set(meta.name, { meta, rows: a.rows as number[] });
    return null;
  },
  local_series_read: async (a) => {
    const s = store.get(String(a.name));
    if (!s) throw `no series named ${String(a.name)}`;
    return s.rows;
  },
  local_series_delete: async (a) => {
    store.delete(String(a.name));
    return null;
  },
  local_series_rename: async (a) => {
    const [from, to] = [String(a.from), String(a.to)];
    checkName(to);
    if (from === to) return null;
    if (store.has(to)) throw `a series named ${to} exists`;
    const s = store.get(from);
    if (!s) throw `no series named ${from}`;
    store.delete(from);
    store.set(to, { meta: { ...s.meta, name: to }, rows: s.rows });
    return null;
  },
};
