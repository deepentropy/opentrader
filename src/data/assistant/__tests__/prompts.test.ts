import { describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => ({ value: null as null | { version: number | null; latestVersion: number } }));
vi.mock("../local", () => ({ localInfo: () => info.value }));

import { PROMPTS, modelVersion, promptFor } from "../prompts";

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("the prompt of each fine-tune", () => {
  it("is the one it was trained with, byte for byte (opentrader-llm/prompts/*.sha256)", async () => {
    expect(await sha256(PROMPTS[2].text)).toBe("4c2056112f7b16cad48a1be0a75eead5e5afbd6a6bc5d66a42a2e8778941bc54");
    expect(await sha256(PROMPTS[3].text)).toBe("a199b2a20e579b304469f8b37fde375cf4ba8c0eeeb3a4bebf2756e525c1f723");
    expect(PROMPTS[3].text).not.toContain("write_script(");
  });

  it("follows the version on disk, else the one this build offers", () => {
    info.value = { version: 2, latestVersion: 3 };
    expect(promptFor(modelVersion()).name).toBe("compact-v1");
    info.value = { version: 3, latestVersion: 3 };
    expect(promptFor(modelVersion()).name).toBe("compact-v2");
    info.value = { version: null, latestVersion: 3 };
    expect(modelVersion()).toBe(3);
    info.value = null;
    expect(modelVersion()).toBe(2);
    // A version newer than this build knows: the newest prompt it has.
    expect(promptFor(9).name).toBe("compact-v2");
  });
});
