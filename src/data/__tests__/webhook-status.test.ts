import { describe, expect, it } from "vitest";
import { webhookStatus } from "../webhook-status";

describe("webhookStatus", () => {
  it("nothing sent: no line", () => {
    expect(webhookStatus(undefined)).toBeNull();
    expect(webhookStatus({ httpCode: null, error: null })).toBeNull();
  });

  it("a 2xx is delivered", () => {
    expect(webhookStatus({ httpCode: 204, error: null })).toEqual({ ok: true, text: "Webhook successfully delivered" });
  });

  it("an HTTP error names the status", () => {
    expect(webhookStatus({ httpCode: 404, error: null })!.text).toBe("Webhook delivery failed — 404 Not Found.");
    expect(webhookStatus({ httpCode: 418, error: null })!.text).toBe("Webhook delivery failed — 418 Client Error.");
    expect(webhookStatus({ httpCode: 599, error: null })!.text).toBe("Webhook delivery failed — 599 Server Error.");
    expect(webhookStatus({ httpCode: 302, error: null })!.text).toBe("Webhook delivery failed — 302.");
  });

  it("a request error is shown, long ones cut", () => {
    expect(webhookStatus({ httpCode: null, error: "operation timed out" })).toEqual({ ok: false, text: "Webhook delivery failed — operation timed out." });
    const long = webhookStatus({ httpCode: null, error: "x".repeat(150) })!.text;
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBe("Webhook delivery failed — ".length + 100);
  });
});
