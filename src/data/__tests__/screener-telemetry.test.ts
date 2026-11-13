import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { event: string; props: Record<string, unknown> }[] = [];
vi.mock("../analytics", () => ({ track: (event: string, props: Record<string, unknown> = {}) => sent.push({ event, props }) }));

import { newScreen, type Filter, type Screen } from "../screener-catalog";
import { resetScreenerTelemetry, screenChanges, trackScreenChange } from "../screener-telemetry";

const cond = (id: string, field: string, value: number): Filter => ({
  id, type: "Condition", left: { id: field, params: {} }, operation: "greater", target: "", right: { value },
} as Filter);

const base = (): Screen => ({ ...newScreen("stock", "Mine"), filters: [cond("a", "Price", 5)], customColumns: null });

describe("screenChanges", () => {
  it("names each kind of step by catalogue id, never a value or a name", () => {
    const prev = base();
    const next: Screen = {
      ...prev,
      title: "Renamed",
      filters: [cond("a", "Price", 10), cond("b", "MarketCap", 1e9)],
      activeColumnSetId: "performance",
      sort: { sortBy: { id: "Volume", params: {} }, sortOrder: "desc" },
      viewMode: "heatmap",
      watchlistId: "wl-secret",
    };
    expect(screenChanges(prev, next)).toEqual([
      { change: "filter_set", field: "Price" },
      { change: "filter_added", field: "MarketCap" },
      { change: "column_set", field: "performance" },
      { change: "sort", field: "Volume" },
      { change: "view", field: "heatmap" },
      { change: "scope", field: "watchlist" },
    ]);
    expect(JSON.stringify(screenChanges(prev, next))).not.toMatch(/Renamed|wl-secret|1000000000/);
  });

  it("removed filters and custom columns", () => {
    const prev: Screen = { ...base(), customColumns: [{ id: "Price", params: {} }, { id: "Beta", params: {} }] };
    const next: Screen = { ...prev, filters: [], customColumns: [{ id: "Price", params: {} }, { id: "Gap", params: {} }] };
    expect(screenChanges(prev, next)).toEqual([
      { change: "filter_removed", field: "Price" },
      { change: "column_added", field: "Gap" },
      { change: "column_removed", field: "Beta" },
    ]);
    const moved: Screen = { ...prev, customColumns: [{ id: "Beta", params: {} }, { id: "Price", params: {} }] };
    expect(screenChanges(prev, moved)).toEqual([{ change: "columns_moved" }]);
  });
});

describe("trackScreenChange", () => {
  beforeEach(() => {
    sent.length = 0;
    resetScreenerTelemetry();
  });

  it("a value typed digit by digit counts once", () => {
    let cur = base();
    for (const v of [1, 12, 120]) {
      const next = { ...cur, filters: [cond("a", "Price", v)] };
      trackScreenChange(cur, next);
      cur = next;
    }
    expect(sent).toEqual([{ event: "screener_changed", props: { screener: "stock", change: "filter_set", field: "Price" } }]);
  });
});
