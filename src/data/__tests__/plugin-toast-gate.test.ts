import { describe, expect, it } from "vitest";
import { createPluginToastGate, PER_MINUTE, REPEAT_MS } from "../plugin-toast-gate";

describe("plugin toast gate", () => {
  it("counts the same message within the repeat window on the shown toast", () => {
    const gate = createPluginToastGate();
    expect(gate("p", "info", "Reloaded", 0)).toBe("show");
    expect(gate("p", "info", "Reloaded", 3_000)).toBe("repeat");
    // Each repeat keeps the window open.
    expect(gate("p", "info", "Reloaded", 3_000 + REPEAT_MS - 1)).toBe("repeat");
    expect(gate("p", "info", "Reloaded", 3_000 + 2 * REPEAT_MS)).toBe("show");
  });

  it("tells apart plugins, levels and texts", () => {
    const gate = createPluginToastGate();
    expect(gate("p", "info", "A", 0)).toBe("show");
    expect(gate("q", "info", "A", 0)).toBe("show");
    expect(gate("p", "error", "A", 0)).toBe("show");
    expect(gate("p", "info", "B", 0)).toBe("show");
  });

  it("shows a few new toasts a minute per plugin and level, repeats not counted", () => {
    const gate = createPluginToastGate();
    for (let i = 0; i < PER_MINUTE; i++) expect(gate("p", "info", `m${i}`, i)).toBe("show");
    expect(gate("p", "info", "m0", 100)).toBe("repeat");
    expect(gate("p", "info", "more", 200)).toBe("drop");
    expect(gate("q", "info", "more", 200)).toBe("show");
    // Routine messages don't hide an error.
    expect(gate("p", "error", "Halted", 300)).toBe("show");
    expect(gate("p", "info", "later", 60_000)).toBe("show");
  });
});
