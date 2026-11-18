import { afterEach, describe, expect, it, vi } from "vitest";
import { openChannel } from "../broadcast";

describe("openChannel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is null when the browser refuses the channel (#364)", () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        }
      },
    );
    expect(openChannel("ot:test")).toBeNull();
  });

  it("is null without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(openChannel("ot:test")).toBeNull();
  });

  it("opens the channel otherwise", () => {
    const ch = openChannel("ot:test");
    expect(ch).toBeInstanceOf(BroadcastChannel);
    ch?.close();
  });
});
