import { describe, expect, it } from "vitest";
import { wheelText } from "../screener-progress";

describe("screener loading wheel text", () => {
  it("shows the share when every size is known", () => {
    expect(wheelText({ receivedBytes: 2_100_000, totalBytes: 5_300_000, downloading: ["state"] })).toEqual({
      label: "39%",
      caption: "Downloading daily data · 2.1 of 5.3 MB",
    });
  });

  it("never shows 100% while the wheel is up", () => {
    expect(wheelText({ receivedBytes: 5_300_000, totalBytes: 5_300_000, downloading: [] })).toEqual({
      label: "99%",
      caption: "Preparing the table · 5.3 of 5.3 MB",
    });
  });

  it("shows the megabytes read when a size is unknown", () => {
    expect(wheelText({ receivedBytes: 1_250_000, totalBytes: null, downloading: ["market", "tickers"] })).toEqual({
      label: "1.3 MB",
      caption: "Downloading market data, ticker list",
    });
  });

  it("shows nothing before any download", () => {
    expect(wheelText(null)).toEqual({ label: "", caption: "" });
    expect(wheelText({ receivedBytes: 0, totalBytes: null, downloading: [] })).toEqual({ label: "", caption: "" });
  });
});
