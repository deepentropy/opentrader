import { describe, expect, it } from "vitest";
import { enabledProviders, mailCode, normalizeMail } from "../src/auth";
import type { Env } from "../src/env";

describe("e-mail sign-in", () => {
  it("keeps real addresses, in lower case", () => {
    expect(normalizeMail("  Jane.Doe+trading@Example.CO.uk ")).toBe("jane.doe+trading@example.co.uk");
    expect(normalizeMail("a@b.io")).toBe("a@b.io");
  });

  it("refuses what is not one address", () => {
    for (const bad of ["", "jane", "jane@", "@example.com", "jane@localhost", "jane@exa mple.com", "jane@example.com\r\nBcc: x@y.com", "a@b@c.com", "jané@example.com", "jane@-example.com", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`]) {
      expect(normalizeMail(bad), bad).toBeNull();
    }
  });

  it("makes six-digit codes spread over the whole range", () => {
    const seen = new Set<string>();
    let low = 0;
    for (let i = 0; i < 2000; i++) {
      const c = mailCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
      if (c < "500000") low++;
    }
    expect(seen.size).toBeGreaterThan(1990);
    expect(low).toBeGreaterThan(850);
    expect(low).toBeLessThan(1150);
  });

  it("is offered only with a sender and the bot check", () => {
    const base = { EMAIL: {} as SendEmail, EMAIL_FROM: "no-reply@example.com" } as Partial<Env>;
    expect(enabledProviders({ ...base, TURNSTILE_SITE_KEY: "k" } as Env)).toContain("email");
    expect(enabledProviders(base as Env)).not.toContain("email");
    expect(enabledProviders({ ...base, EMAIL_FROM: "", TURNSTILE_SITE_KEY: "k" } as Env)).not.toContain("email");
    expect(enabledProviders({ ...base, DEV_LOGIN: "1" } as Env)).toEqual(["email", "dev"]);
  });
});
