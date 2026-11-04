import { describe, expect, it } from "vitest";
import { migrateTab, makeTab, revivePanels } from "../tabs";

describe("panels of a tab", () => {
  it("reads back stored panels and drops malformed ones", () => {
    const ok = { rail: "alerts", screener: true, editor: false, journal: true };
    expect(revivePanels(ok)).toEqual(ok);
    expect(revivePanels({ rail: null, screener: 1 })).toEqual({ rail: null, screener: false, editor: false, journal: false });
    expect(revivePanels({ rail: 3 })).toBeUndefined();
    expect(revivePanels(undefined)).toBeUndefined();
  });
  it("keeps them through a reload; a new tab has none", () => {
    const t = { ...makeTab(), panels: { rail: null, screener: true, editor: true, journal: false } };
    expect(migrateTab(JSON.parse(JSON.stringify(t))).panels).toEqual(t.panels);
    expect(makeTab().panels).toBeUndefined();
  });
});
