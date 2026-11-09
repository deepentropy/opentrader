import { beforeEach, describe, expect, it, vi } from "vitest";

// The reload event charts listen to goes to the window; kv falls back to localStorage.
vi.stubGlobal("window", new EventTarget());
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

/** The folder on disk: file name → text and modification time. */
const disk = new Map<string, { text: string; mtime: number }>();
const reads: string[] = [];

vi.mock("../../bindings", async () => {
  const { localSeriesCommands: c } = await import("../../web/local-series");
  const typed = async <T,>(p: Promise<unknown>) => {
    try {
      return { status: "ok" as const, data: (await p) as T };
    } catch (error) {
      return { status: "error" as const, error: String(error) };
    }
  };
  return {
    commands: {
      localSeriesList: () => typed(c.local_series_list({})),
      localSeriesSave: (meta: unknown, rows: unknown) => typed(c.local_series_save({ meta, rows })),
      localSeriesRead: (name: string) => typed(c.local_series_read({ name })),
      localSeriesDelete: (name: string) => typed(c.local_series_delete({ name })),
      localSeriesRename: (from: string, to: string) => typed(c.local_series_rename({ from, to })),
      localFolderScan: async (folder: string) =>
        folder === "D:/data"
          ? { status: "ok", data: [...disk].sort(([a], [b]) => a.localeCompare(b)).map(([file, f]) => ({ file, mtime: f.mtime, size: f.text.length })) }
          : { status: "error", error: `${folder}: not found` },
      localFolderRead: async (_folder: string, file: string) => {
        reads.push(file);
        const f = disk.get(file);
        return f ? { status: "ok", data: f.text } : { status: "error", error: `${file}: not found` };
      },
    },
  };
});

import { addLocalFolder, localFolders, removeLocalFolder, setLocalFolderOptions, syncLocalFolder } from "../local-folders";
import { deleteLocalSeries, importLocalSeries, localSeriesList, renameLocalSeries } from "../local-series";
import { commands } from "../../bindings";

const daily = (closes: number[]) => "time,open,high,low,close\n" + closes.map((c, i) => `2024-01-0${i + 1},${c},${c},${c},${c}`).join("\n");

async function names(): Promise<string[]> {
  const r = await commands.localSeriesList();
  return r.status === "ok" ? r.data.map((s) => s.name) : [];
}

describe("synced folders", () => {
  beforeEach(async () => {
    for (const n of await names()) await deleteLocalSeries(n);
    for (const f of localFolders()) removeLocalFolder(f.path);
    disk.clear();
    reads.length = 0;
  });

  it("imports new files, then reads only the changed ones", async () => {
    disk.set("aaa.csv", { text: daily([1, 2]), mtime: 1 });
    disk.set("bbb.csv", { text: daily([3, 4, 5]), mtime: 1 });
    disk.set("README.csv", { text: "hello", mtime: 1 });
    disk.set("symbol_info.json", { text: JSON.stringify({ symbol: ["AAA"], description: ["Alpha"] }), mtime: 1 });
    expect(addLocalFolder("D:/data", "UTC")).toBe(true);
    expect(addLocalFolder("d:/data/", "UTC")).toBe(false);

    const first = await syncLocalFolder("D:/data");
    expect(first).toMatchObject({ scanned: 3, imported: 2, bars: 5, unchanged: 0 });
    expect(first.errors.map((e) => e.file)).toEqual(["README.csv"]);
    expect(await names()).toEqual(["AAA", "BBB"]);
    const list = (await commands.localSeriesList()) as { data: { name: string; description: string; source: unknown }[] };
    expect(list.data[0]).toMatchObject({ description: "Alpha", source: { folder: "D:/data", file: "aaa.csv", mtime: 1 } });
    expect(localFolders()[0].status?.imported).toBe(2);

    // Nothing changed: only the symbol_info file is read (the bad file failed as it is).
    reads.length = 0;
    const again = await syncLocalFolder("D:/data");
    expect(again).toMatchObject({ imported: 0, unchanged: 2 });
    expect(again.errors).toHaveLength(1);
    expect(reads).toEqual(["symbol_info.json"]);

    // One file changed.
    disk.set("bbb.csv", { text: daily([3, 4, 5, 6]), mtime: 2 });
    reads.length = 0;
    expect(await syncLocalFolder("D:/data")).toMatchObject({ imported: 1, bars: 4, unchanged: 1 });
    expect(reads).toEqual(["symbol_info.json", "bbb.csv"]);
    expect(localSeriesList().find((s) => s.name === "BBB")?.bars).toBe(4);

    // Another zone: every file is read again.
    setLocalFolderOptions("D:/data", { timeZone: "Asia/Kolkata" });
    expect(await syncLocalFolder("D:/data")).toMatchObject({ imported: 2, unchanged: 0 });
  });

  it("takes over a series imported by hand, follows a renamed one and refuses another folder's", async () => {
    await importLocalSeries({ name: "AAA", csv: daily([9]), timeZone: "UTC", description: "Mine" });
    await importLocalSeries({ name: "BBB", csv: daily([9]), timeZone: "UTC", source: { folder: "E:/other", file: "bbb.csv", mtime: 1, size: 1 } });
    disk.set("aaa.csv", { text: daily([1, 2]), mtime: 1 });
    disk.set("bbb.csv", { text: daily([1, 2]), mtime: 1 });
    addLocalFolder("D:/data", "UTC");
    const s = await syncLocalFolder("D:/data");
    expect(s.imported).toBe(1);
    expect(s.errors).toEqual([{ file: "bbb.csv", message: "LOCAL:BBB comes from bbb.csv in E:/other." }]);
    const aaa = localSeriesList().find((x) => x.name === "AAA");
    expect(aaa).toMatchObject({ bars: 2, description: "Mine", source: { file: "aaa.csv" } });

    await renameLocalSeries("AAA", "ALPHA");
    disk.set("aaa.csv", { text: daily([1, 2, 3]), mtime: 2 });
    await syncLocalFolder("D:/data");
    expect(await names()).toEqual(["ALPHA", "BBB"]);
    expect(localSeriesList().find((x) => x.name === "ALPHA")?.bars).toBe(3);
  });

  it("keeps the series of deleted files unless asked, and reports a folder it cannot read", async () => {
    disk.set("aaa.csv", { text: daily([1]), mtime: 1 });
    addLocalFolder("D:/data", "UTC");
    await syncLocalFolder("D:/data");
    disk.delete("aaa.csv");
    expect(await syncLocalFolder("D:/data")).toMatchObject({ removed: 0 });
    expect(await names()).toEqual(["AAA"]);
    setLocalFolderOptions("D:/data", { removeDeleted: true });
    expect(await syncLocalFolder("D:/data")).toMatchObject({ removed: 1 });
    expect(await names()).toEqual([]);

    addLocalFolder("Z:/gone", "UTC");
    expect((await syncLocalFolder("Z:/gone")).failed).toBe("Z:/gone: not found");
  });
});
