import { describe, expect, it } from "vitest";
import { clampPointer } from "../dialog-drag";

describe("dialog drag pointer (#185)", () => {
  it("stays 20 px inside the window", () => {
    expect(clampPointer(-3000, -3000, 1920, 998)).toEqual({ x: 20, y: 20 });
    expect(clampPointer(5000, 5000, 1920, 998)).toEqual({ x: 1900, y: 978 });
    expect(clampPointer(700, 400, 1920, 998)).toEqual({ x: 700, y: 400 });
  });
});
