import { describe, expect, it } from "vitest";
import { foldedToasts, toastPlace } from "../plugin-toast-piles";

describe("plugin toast piles", () => {
  it("puts a toast where the plugin asks, bottom left when it doesn't or asks for an unknown place", () => {
    expect(toastPlace("plugin", "top-right")).toBe("top-right");
    expect(toastPlace("plugin", null)).toBe("bottom-left");
    expect(toastPlace("plugin", "center")).toBe("bottom-left");
  });

  it("follows the user's choice first", () => {
    expect(toastPlace("top-center", "bottom-right")).toBe("top-center");
    expect(toastPlace("off", "top-right")).toBeNull();
  });

  it("keeps the errors of a folded pile in view", () => {
    const t = (level: string, n: number) => ({ level, n });
    expect(foldedToasts([t("error", 1), t("info", 2), t("error", 3), t("warn", 4), t("info", 5)]).map((x) => x.n)).toEqual([1, 3, 5]);
    expect(foldedToasts([t("info", 1), t("error", 2)]).map((x) => x.n)).toEqual([2]);
    expect(foldedToasts([])).toEqual([]);
  });
});
