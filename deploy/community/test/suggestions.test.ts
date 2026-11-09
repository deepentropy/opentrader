import { describe, expect, it } from "vitest";
import { statusOfIssue, withoutTitleHeading } from "../src/suggestions";
import { parseCommunityId } from "../src/util";

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
