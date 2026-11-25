import { expect, it, vi } from "vitest";
import type { PluginInfo } from "../../bindings";

vi.mock("../../bindings", () => ({ commands: {} }));

import { exchangesOf } from "../plugin-exchanges";

const plugin = (over: object, manifest: object) =>
  ({ enabled: true, connected: true, off: [], ...over, manifest: { provides: ["datafeed"], exchange: null, exchanges: [], ...manifest } }) as unknown as PluginInfo;

it("lists the exchanges of the connected data plugins", () => {
  expect([
    ...exchangesOf([
      plugin({}, { exchange: "NT8" }),
      plugin({}, { exchanges: ["nse", "BSE"] }),
      plugin({ connected: false }, { exchange: "OFF1" }),
      plugin({ enabled: false }, { exchange: "OFF2" }),
      plugin({ off: ["datafeed"] }, { exchange: "OFF3", provides: ["datafeed", "broker"] }),
      plugin({}, { exchange: "OFF4", provides: ["broker"] }),
    ]),
  ]).toEqual(["NT8", "NSE", "BSE"]);
});
