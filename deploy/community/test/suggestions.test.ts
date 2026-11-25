import { describe, expect, it } from "vitest";
import { statusOfIssue, webhook, withoutTitleHeading } from "../src/suggestions";
import type { Env } from "../src/env";
import { GITHUB_REPO, hmacHex, parseCommunityId } from "../src/util";

describe("statusOfIssue", () => {
  it("reads an open issue as planned", () => {
    expect(statusOfIssue({ state: "open", state_reason: null })).toBe("planned");
    expect(statusOfIssue({ state: "open", state_reason: "reopened" })).toBe("planned");
  });
  it("reads a completed issue as shipped", () => {
    expect(statusOfIssue({ state: "closed", state_reason: "completed" })).toBe("shipped");
    // Issues closed before GitHub gave reasons.
    expect(statusOfIssue({ state: "closed", state_reason: null })).toBe("shipped");
  });
  it("reads an issue closed as not planned or duplicate as declined", () => {
    expect(statusOfIssue({ state: "closed", state_reason: "not_planned" })).toBe("declined");
    expect(statusOfIssue({ state: "closed", state_reason: "duplicate" })).toBe("declined");
  });
});

describe("the Suggestions community", () => {
  it("is a valid community id", () => {
    expect(parseCommunityId("c:suggestions")).toEqual({ kind: "theme", key: "suggestions" });
  });
});

describe("withoutTitleHeading", () => {
  it("drops a first heading that repeats the title", () => {
    expect(withoutTitleHeading("# Feature Request: LOCAL Series – Sync\n\n## Context\nText", "Feature Request: LOCAL Series – Sync")).toBe("## Context\nText");
  });
  it("keeps other headings and plain text", () => {
    expect(withoutTitleHeading("## Context\nText", "Folder sync")).toBe("## Context\nText");
    expect(withoutTitleHeading("Hi there", "Folder sync")).toBe("Hi there");
  });
});

describe("GitHub's webhook", () => {
  const secret = "s".repeat(40);
  /** One open suggestion, linked to issue 412; its writes are kept. */
  function server() {
    const writes: { sql: string; args: unknown[] }[] = [];
    let status = "review";
    const prepare = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: async () => (/FROM posts/.test(sql) && args[0] === 412 && status === "review" ? { id: "p1", title: "A plugin", author_id: "u1", sg_status: status, sg_note: null } : null),
        all: async () => ({ results: [{ user_id: "u1" }, { user_id: "u2" }] }),
      }),
    });
    const batch = async (stmts: { sql: string; args: unknown[] }[]) => {
      writes.push(...stmts);
      if (stmts.some((x) => x.sql.startsWith("UPDATE posts"))) status = String(stmts[0].args[0]);
    };
    return { env: { GITHUB_WEBHOOK_SECRET: secret, DB: { prepare, batch } } as unknown as Env, writes, status: () => status };
  }
  const closed = (over: object = {}) => JSON.stringify({ action: "closed", repository: { full_name: GITHUB_REPO }, issue: { number: 412, state: "closed", state_reason: "completed" }, ...over });
  const deliver = async (env: Env, body: string, over: Record<string, string> = {}) =>
    webhook(env, new Request("https://x/github/webhook", { method: "POST", body, headers: { "x-github-event": "issues", "x-hub-signature-256": `sha256=${await hmacHex(secret, body)}`, ...over } }));

  it("ships the suggestion of an issue that closes, and tells its author and supporters once", async () => {
    const s = server();
    expect(await (await deliver(s.env, closed())).json()).toEqual({ ok: true, updated: true });
    expect(s.status()).toBe("shipped");
    expect(s.writes.filter((w) => w.sql.startsWith("INSERT INTO notifications")).map((w) => w.args[1])).toEqual(["u1", "u2"]);
    expect(await (await deliver(s.env, closed())).json()).toEqual({ ok: true, updated: false });
    expect(s.writes).toHaveLength(3);
  });
  it("declines the one of an issue closed as not planned", async () => {
    const s = server();
    await deliver(s.env, closed({ issue: { number: 412, state: "closed", state_reason: "not_planned" } }));
    expect(s.status()).toBe("declined");
  });
  it("leaves other issues, events and repositories alone", async () => {
    const s = server();
    await deliver(s.env, closed({ issue: { number: 7, state: "closed", state_reason: "completed" } }));
    await deliver(s.env, closed({ action: "reopened" }));
    await deliver(s.env, closed({ repository: { full_name: "someone/else" } }));
    await deliver(s.env, closed(), { "x-github-event": "issue_comment" });
    await deliver(s.env, JSON.stringify({ zen: "ping" }), { "x-github-event": "ping" });
    expect(s.writes).toEqual([]);
  });
  it("refuses a delivery GitHub did not sign, and is off without a secret", async () => {
    const s = server();
    await expect(deliver(s.env, closed(), { "x-hub-signature-256": "sha256=00" })).rejects.toMatchObject({ status: 401 });
    await expect(deliver(s.env, closed(), { "x-hub-signature-256": "" })).rejects.toMatchObject({ status: 401 });
    await expect(webhook({ ...s.env, GITHUB_WEBHOOK_SECRET: undefined } as Env, new Request("https://x", { method: "POST", body: closed() }))).rejects.toMatchObject({ status: 404 });
    expect(s.writes).toEqual([]);
  });
});
