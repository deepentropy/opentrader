import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  onExternalChange: () => () => {},
}));

import {
  DEFAULT_RIGHT_OFFSET,
  SETTINGS_FINGERPRINT,
  SETTINGS_REV,
  appearanceFrom,
  cloneDraft,
  formatRatio,
  keyOf,
  loadChartSettingsDefaults,
  makeDefaultDraft,
  patchDraftScales,
  reviveDraft,
  saveChartSettingsDefaults,
  seedDraft,
  stdThemeOf,
  withStdTheme,
  type CtrlValue,
  type Draft,
} from "../chart-settings";

const ctrl = (d: Draft, tab: string, id: string, i = 0): CtrlValue => d[keyOf(tab, id)].controls[i];
const members = (d: Draft, id: string) => {
  const c = ctrl(d, "scales", id);
  return c.kind === "multicheck" ? c.on : null;
};

describe("formatRatio", () => {
  it("up to 7 decimals, no trailing zeros", () => {
    expect(formatRatio(0.123456789)).toBe("0.1234568");
    expect(formatRatio(2)).toBe("2");
    expect(formatRatio(1234.5)).toBe("1234.5");
    expect(formatRatio(1e-8)).toBe("0");
  });
});

describe("appearanceFrom — factory defaults", () => {
  const a = appearanceFrom(undefined);

  it("no stored settings = the dialog defaults", () => {
    expect(appearanceFrom(makeDefaultDraft())).toEqual(a);
  });

  it("price labels and lines", () => {
    expect(a.symbolLastValue).toBe(true);
    expect(a.symbolPriceLine).toBe(true);
    expect(a.symbolNameLabel).toBe(false);
    expect(a.symbolValuePercent).toBe(false);
    expect(a.prevCloseLabel).toBe(false);
    expect(a.prevCloseLine).toBe(false);
    expect(a.prePostLabel).toBe(true);
    expect(a.prePostLine).toBe(true);
    expect(a.preMarketColor).toBe("#FB8C00");
    expect(a.postMarketColor).toBe("#2962FF");
    expect(a.highLowLabels).toBe(true);
    expect(a.highLowLines).toBe(false);
    expect(a.highLowColor).toBe("");
    expect(a.countdown).toBe(true);
    expect(a.alignLabels).toBe(true);
    expect(a.plusButton).toBe(true);
    expect(a.lockRatio).toBe(false);
    expect(a.lockRatioValue).toBeUndefined();
    expect(a.scalesMode).toBe("auto");
    expect(a.scalesPlacement).toBe("right");
  });

  it("time scale, canvas, margins and buttons", () => {
    expect(a.dayOfWeek).toBe(true);
    expect(a.dateFormat).toBe("Mon 29 Sep '97");
    expect(a.timeFormat).toBe("24-hours");
    expect(a.saveLeftEdge).toBe(false);
    expect(a.bgGradient).toBe(false);
    expect(a.gridVertVisible).toBe(true);
    expect(a.gridVertStyle).toBe(2);
    expect(a.crosshairStyle).toBe(1);
    expect(a.crosshairWidth).toBe(1);
    expect(a.scaleFontSize).toBe(12);
    expect(a.marginTop).toBeCloseTo(0.1, 12);
    expect(a.marginBottom).toBeCloseTo(0.08, 12);
    expect(a.rightOffset).toBe(10);
    expect(DEFAULT_RIGHT_OFFSET).toBe(10);
    expect(a.navButtons).toBe("visibleOnMouseOver");
    expect(a.paneButtons).toBe("visibleOnMouseOver");
  });

  it("status line, events, alerts", () => {
    expect(a.legendTitleMode).toBe("Name");
    expect(a.legendVolume).toBe(false);
    expect(a.legendIndBgOpacity).toBe(50); // 100 - 50 % transparency
    expect(a.sessionBreaksVisible).toBe(false);
    expect(a.sessionBreaksColor).toBe("rgb(73, 133, 231)");
    expect(a.sessionBreaksStyle).toBe(1);
    expect(a.eventsDividends).toBe(true);
    expect(a.latestNews).toBe(true);
    expect(a.alertLines).toBe(true);
    expect(a.alertLineColor).toBe("");
  });

  it("dark is the app theme in a headless run", () => {
    expect(a.bg).toBe("rgb(15, 15, 15)");
    expect(appearanceFrom(makeDefaultDraft("light")).bg).toBe("rgb(255, 255, 255)");
  });
});

describe("patchDraftScales", () => {
  it("label and line are independent memberships of the check lists", () => {
    const base = makeDefaultDraft("dark");
    const next = patchDraftScales(base, { symbolLastValue: false, symbolNameLabel: true, prevCloseLine: true, highLowLabels: true });
    expect(members(next, "Symbol")).toEqual(["Line", "Name"]);
    expect(members(next, "Previous day close")).toEqual(["Line"]);
    expect(members(next, "High and low")).toEqual(["Value"]); // already on: no duplicate
    const a = appearanceFrom(next);
    expect(a.symbolLastValue).toBe(false);
    expect(a.symbolNameLabel).toBe(true);
    expect(a.prevCloseLine).toBe(true);
    expect(a.prevCloseLabel).toBe(false);
  });

  it("does not touch the input draft; undefined fields stay as they are", () => {
    const base = makeDefaultDraft("dark");
    const before = JSON.stringify(base);
    const next = patchDraftScales(base, { countdown: false });
    expect(JSON.stringify(base)).toBe(before);
    expect(appearanceFrom(next).countdown).toBe(false);
    expect(appearanceFrom(next).symbolLastValue).toBe(true);
  });

  it("scale placement, ratio lock, events and alerts rows", () => {
    const left = appearanceFrom(patchDraftScales(undefined, { scalesPlacement: "left", lockRatio: true, lockRatioValue: 0.123456789, sessionBreaks: true, alertLines: false }));
    expect(left.scalesMode).toBe("left");
    expect(left.scalesPlacement).toBe("left");
    expect(left.lockRatio).toBe(true);
    expect(left.lockRatioValue).toBe(0.1234568);
    expect(left.sessionBreaksVisible).toBe(true);
    expect(left.alertLines).toBe(false);
    // "Move scale to right" goes back to Auto.
    expect(appearanceFrom(patchDraftScales(undefined, { scalesPlacement: "right" })).scalesMode).toBe("auto");
  });

  it("indicator labels and toggles", () => {
    const a = appearanceFrom(patchDraftScales(undefined, { indLastValue: true, indNameLabel: true, alignLabels: false, plusButton: false, scaleSeriesOnly: true }));
    expect(a.indLastValue).toBe(true);
    expect(a.indNameLabel).toBe(true);
    expect(a.alignLabels).toBe(false);
    expect(a.plusButton).toBe(false);
    expect(a.scaleSeriesOnly).toBe(true);
  });
});

describe("seedDraft", () => {
  it("folds the live timezone, ADJ flag, session and ratio in", () => {
    const d = seedDraft(undefined, { timezone: "UTC", adjusted: true, session: "ETH", scaleRatio: 0.5 });
    const a = appearanceFrom(d);
    expect(a.timezone).toBe("UTC");
    expect(a.adjustDividends).toBe(true);
    expect(a.session).toBe("Extended");
    expect(a.lockRatioValue).toBe(0.5);
  });

  it("no ratio / a non-finite one: empty field", () => {
    const d = seedDraft(makeDefaultDraft("dark"), { timezone: "Exchange", adjusted: false, session: "RTH", scaleRatio: Number.NaN });
    expect(ctrl(d, "scales", "Lock price to bar ratio")).toEqual(expect.objectContaining({ kind: "input", value: "" }));
    expect(appearanceFrom(d).session).toBe("Regular");
  });
});

describe("reviveDraft / persistence", () => {
  it("unknown stamp or unusable blob: undefined", () => {
    expect(reviveDraft({}, "nope")).toBeUndefined();
    expect(reviveDraft(null, SETTINGS_FINGERPRINT)).toBeUndefined();
    expect(reviveDraft("x", SETTINGS_FINGERPRINT)).toBeUndefined();
  });

  it("round-trips a current draft", () => {
    const d = patchDraftScales(makeDefaultDraft("dark"), { countdown: false, symbolNameLabel: true });
    const back = reviveDraft(JSON.parse(JSON.stringify(d)), SETTINGS_FINGERPRINT, SETTINGS_REV)!;
    expect(back).toEqual(d);
  });

  it("stored values are shape-checked against the defaults", () => {
    const back = reviveDraft(
      {
        "scales:Countdown to bar close": { checked: "yes" },
        "scales:Symbol": { controls: [{ kind: "multicheck", on: [1, 2] }, { kind: "color", color: 5, width: 3 }] },
        "canvas:Top": { controls: [{ kind: "slider", value: 3 }] },
        "unknown:row": { checked: true },
      },
      SETTINGS_FINGERPRINT,
      SETTINGS_REV,
    )!;
    const def = makeDefaultDraft("dark");
    expect(back["scales:Countdown to bar close"].checked).toBe(true);
    expect(members(back, "Symbol")).toEqual(["Value", "Line"]);
    expect(ctrl(back, "scales", "Symbol", 1)).toEqual({ kind: "color", color: "", width: 3 });
    expect(ctrl(back, "canvas", "Top")).toEqual(ctrl(def, "canvas", "Top"));
    expect(back["unknown:row"]).toBeUndefined();
  });

  it("value migrations of older revisions", () => {
    // Rev < 4: Latest news on; rev < 6: the old up-colour alert line becomes automatic.
    const old = reviveDraft(
      { "events:Latest news": { checked: false }, "alerts:Alert lines": { checked: true, controls: [{ kind: "color", color: "#089981" }] } },
      SETTINGS_FINGERPRINT,
      3,
    )!;
    expect(old["events:Latest news"].checked).toBe(true);
    expect(ctrl(old, "alerts", "Alert lines")).toEqual({ kind: "color", color: "" });
    // Current revision keeps both choices.
    const cur = reviveDraft(
      { "events:Latest news": { checked: false }, "alerts:Alert lines": { checked: true, controls: [{ kind: "color", color: "#089981" }] } },
      SETTINGS_FINGERPRINT,
      SETTINGS_REV,
    )!;
    expect(cur["events:Latest news"].checked).toBe(false);
    expect(ctrl(cur, "alerts", "Alert lines")).toEqual({ kind: "color", color: "#089981" });
  });

  it("legacy index-keyed drafts are converted", () => {
    // pil70i layout: legend index 2 = Title, scales index 8 = Countdown to bar close.
    const legacy = reviveDraft(
      { "legend:2": { checked: true, controls: [{ kind: "select", value: "Ticker and name" }] }, "scales:8": { checked: false, controls: [] } },
      "pil70i",
      2,
    )!;
    expect(appearanceFrom(legacy).legendTitleMode).toBe("Symbol and name");
    expect(appearanceFrom(legacy).countdown).toBe(false);
  });

  it("saved defaults load back", () => {
    expect(loadChartSettingsDefaults()).toBeUndefined();
    const d = patchDraftScales(makeDefaultDraft("dark"), { plusButton: false });
    saveChartSettingsDefaults(d);
    expect(loadChartSettingsDefaults()).toEqual(d);
    store.set("ot:chart-settings-defaults", "{not json");
    expect(loadChartSettingsDefaults()).toBeUndefined();
  });
});

describe("standard themes", () => {
  it("detects the standard theme of a draft", () => {
    expect(stdThemeOf(makeDefaultDraft("dark"))).toBe("dark");
    expect(stdThemeOf(makeDefaultDraft("light"))).toBe("light");
    expect(stdThemeOf(undefined)).toBe("dark");
  });

  it("colours compare by value (hex vs rgb)", () => {
    const d = makeDefaultDraft("dark");
    const bg = d["canvas:Background"].controls[1];
    if (bg.kind === "color") bg.color = "#0F0F0F";
    expect(stdThemeOf(d)).toBe("dark");
  });

  it("a custom colour is no standard theme; withStdTheme restores it and keeps the other settings", () => {
    const d = patchDraftScales(makeDefaultDraft("dark"), { countdown: false });
    const bg = d["canvas:Background"].controls[1];
    if (bg.kind === "color") bg.color = "rgb(1, 2, 3)";
    expect(stdThemeOf(d)).toBeNull();
    const light = withStdTheme(d, "light");
    expect(stdThemeOf(light)).toBe("light");
    expect(appearanceFrom(light).countdown).toBe(false);
    expect(stdThemeOf(d)).toBeNull(); // input untouched
  });

  it("the watermark is not a theme value", () => {
    const d = makeDefaultDraft("dark");
    const wm = d["canvas:Watermark"].controls[1];
    if (wm.kind === "color") wm.color = "#ff0000";
    expect(stdThemeOf(d)).toBe("dark");
  });
});

describe("cloneDraft", () => {
  it("deep copies the check lists", () => {
    const d = makeDefaultDraft("dark");
    const c = cloneDraft(d);
    const on = c["scales:Symbol"].controls[0];
    if (on.kind === "multicheck") on.on.push("Name");
    expect(members(d, "Symbol")).toEqual(["Value", "Line"]);
  });
});
