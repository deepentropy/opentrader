import { beforeEach, describe, expect, it, vi } from "vitest";

const getTickerInfo = vi.fn();
vi.mock("../../bindings", () => ({ commands: { getTickerInfo: (s: string) => getTickerInfo(s) } }));

import { forgetTickerInfo, getTickerInfo as ask, tickerInfoEpoch } from "../datafeed-rest";

const notFound = { status: "error", error: "NSE:RELIANCE: unknown symbol (NOT_FOUND)" };
const row = { status: "ok", data: { ticker: "NSE:RELIANCE", name: "Reliance", type: "stock" } };

describe("ticker info kept (#371)", () => {
  beforeEach(() => {
    getTickerInfo.mockReset();
    forgetTickerInfo();
  });

  it("asks again for a symbol not found once the plugins change", async () => {
    getTickerInfo.mockResolvedValueOnce(notFound).mockResolvedValueOnce(row);
    await expect(ask("NSE:RELIANCE")).rejects.toMatch(/NOT_FOUND/);
    await expect(ask("NSE:RELIANCE")).rejects.toMatch(/NOT_FOUND/);
    expect(getTickerInfo).toHaveBeenCalledTimes(1);
    forgetTickerInfo();
    await expect(ask("NSE:RELIANCE")).resolves.toMatchObject({ type: "stock" });
    expect(getTickerInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps a request still waiting, and tells the askers", async () => {
    let answer!: (v: unknown) => void;
    getTickerInfo.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const first = ask("NSE:TCS");
    forgetTickerInfo();
    expect(ask("NSE:TCS")).toBe(first);
    answer(row);
    await first;

    // What the asking effects track.
    const epoch = tickerInfoEpoch();
    forgetTickerInfo();
    expect(tickerInfoEpoch()).toBe(epoch + 1);
  });
});
