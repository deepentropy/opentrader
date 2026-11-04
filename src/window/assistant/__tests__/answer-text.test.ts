import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => undefined }));
vi.mock("../../../data/datafeed", () => ({ toFullSymbol: () => new Promise(() => {}) }));
vi.mock("../../../data/community/chart-share", () => ({ chartBridge: () => null }));

import { linkTickers, symbolsOf } from "../AnswerText";

const links = (html: string) => [...html.matchAll(/<a [^>]*data-ticker="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]}=${m[1]}`);

describe("tickers in the assistant's answers", () => {
  it("collects the symbols the tools met", () => {
    const m = new Map<string, string>();
    symbolsOf('{"name":"Semis","symbols":["NASDAQ:NVDA","AMD"]}', m);
    symbolsOf('{"total":2,"rows":[{"symbol":"AVGO","close":325},{"symbol":"MU"}]}', m);
    expect([...m]).toEqual([["NVDA", "NASDAQ:NVDA"], ["AMD", "AMD"], ["AVGO", "AVGO"], ["MU", "MU"]]);
  });

  it("links known tickers and the ones the search knows, never abbreviations or code", () => {
    const known = new Map([["NVDA", "NASDAQ:NVDA"], ["AMD", "NASDAQ:AMD"]]);
    const html = "<p>Created <strong>Semis</strong> with NVDA, AMD and TSM (RSI above 50). See NYSE:IBM.</p><pre><code>AMD</code></pre>";
    const out = linkTickers(html, known, (w) => (w === "TSM" ? "NYSE:TSM" : null));
    expect(links(out)).toEqual(["NVDA=NASDAQ:NVDA", "AMD=NASDAQ:AMD", "TSM=NYSE:TSM", "NYSE:IBM=NYSE:IBM"]);
    expect(out).toContain("<code>AMD</code>");
    expect(out).toContain("RSI above 50");
  });
});
