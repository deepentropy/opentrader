import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  onExternalChange: () => () => {},
}));
vi.mock("../../../data/screener-store", () => ({ screenerPanel: { open: () => false } }));

import { onboardingOpen, openFirstStartOnboarding, setOnboardingOpen } from "../app-dialogs";

describe("first-start onboarding", () => {
  it("opens once, then only from the menu", () => {
    store.clear();
    openFirstStartOnboarding();
    expect(onboardingOpen()).toBe(true);
    expect(store.get("ot:app-onboarding")).toBe("shown");

    setOnboardingOpen(false);
    openFirstStartOnboarding();
    expect(onboardingOpen()).toBe(false);

    setOnboardingOpen(true);
    expect(onboardingOpen()).toBe(true);
  });
});
