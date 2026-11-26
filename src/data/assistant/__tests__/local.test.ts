import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalModelInfo } from "../../../bindings";

vi.mock("../../kv", () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined, onExternalChange: () => () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (d: unknown) => void = () => {};
  },
}));
const sent = vi.hoisted(() => ({ events: [] as { event: string; props: Record<string, any> }[] }));
vi.mock("../../analytics", () => ({ track: (event: string, props: Record<string, any>) => sent.events.push({ event, props }) }));
// The install's answer, set by each test.
const host = vi.hoisted(() => ({ install: { status: "ok", data: null } as { status: string; data?: null; error?: string }, installed: false }));
vi.mock("../../../bindings", () => ({
  commands: {
    localModelInstall: async () => host.install,
    localModelInfo: async () => ({ status: "ok", data: { ...info(), installed: host.installed } }),
  },
}));

import { installLocal, localState, refreshLocal } from "../local";
import { downloadFailureKind, trackPanelOpened } from "../telemetry";

const GB = 1024 ** 3;
function info(over: Partial<LocalModelInfo> = {}): LocalModelInfo {
  return {
    available: true, installed: false, running: false, downloadBytes: 3 * GB, diskBytes: null, ramBytes: 32 * GB,
    ramNeededBytes: 8 * GB, freeDiskBytes: 100 * GB, installing: false, version: null, latestVersion: 3, updateBytes: null,
    ...over,
  };
}

describe("assistant model in the usage statistics", () => {
  beforeEach(() => { sent.events.length = 0; });

  it("names where the model stands when the panel opens", () => {
    expect(localState(null)).toBe("unknown");
    expect(localState(info({ installed: true }))).toBe("ready");
    expect(localState(info())).toBe("not_activated");
    expect(localState(info({ available: false }))).toBe("unavailable");
    expect(localState(info({ ramBytes: 4 * GB }))).toBe("low_memory");
    expect(localState(info({ freeDiskBytes: 1 * GB }))).toBe("low_disk");
    trackPanelOpened(localState(info()));
    expect(sent.events).toEqual([{ event: "assistant_opened", props: { model: "not_activated" } }]);
  });

  it("sends how a download ended, without its error text", async () => {
    host.install = { status: "error", error: "C:\\Users\\someone\\AppData: disk full" };
    await installLocal();
    host.install = { status: "error", error: "Stopped." };
    await installLocal();
    host.install = { status: "ok", data: null };
    await installLocal();
    // Once installed, a download is an update.
    host.installed = true;
    await refreshLocal();
    await installLocal();
    const downloads = sent.events.filter((e) => e.event === "assistant_model_download").map((e) => [e.props.outcome, e.props.update, e.props.reason]);
    expect(downloads).toEqual([["failed", false, "disk"], ["stopped", false, undefined], ["done", false, undefined], ["done", true, undefined]]);
    expect(JSON.stringify(sent.events)).not.toContain("someone");
  });

  it("names a failed download by its kind", () => {
    expect(downloadFailureKind("Download of model.gguf failed: HTTP 404")).toBe("http_404");
    expect(downloadFailureKind("Download of model.gguf failed: error sending request")).toBe("network");
    expect(downloadFailureKind("Download of model.gguf stopped: connection reset")).toBe("network");
    expect(downloadFailureKind("Download of model.gguf stopped early")).toBe("network");
    expect(downloadFailureKind("model.gguf is not the expected file (checksum): download it again.")).toBe("checksum");
    expect(downloadFailureKind("The download is already under way.")).toBe("busy");
    expect(downloadFailureKind("Access is denied. (os error 5)")).toBe("disk");
  });
});
