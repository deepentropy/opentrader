import { describe, expect, it } from "vitest";
import type { Comment } from "../contract";
import { withReply, type ReplySource } from "../replies";

const reply = (id: string, own = false): Comment => ({
  id, parent_id: null, author: "ann", author_record: null, by_op: false, kind: "data", body: `reply ${id}`,
  useful_count: 0, my_useful: false, created_at: 1, edited_at: null, deleted: false, removed: false,
  removed_reason: null, own, chart: null, image_url: null,
});

/** The thread and its reply count after each arrival, as the post thread applies them. */
function apply(start: Comment[], arrivals: [Comment, ReplySource][]) {
  let list = start;
  let count = start.length;
  for (const [c, from] of arrivals) {
    const r = withReply(list, c, from);
    list = r.list;
    if (r.added) count += 1;
  }
  return { list, count };
}

describe("the reader's own reply arriving twice (#280)", () => {
  const before = [reply("a")];
  // The live room broadcasts the reply without knowing who reads it; the answer says it is the reader's.
  const live = reply("b", false);
  const answer = reply("b", true);

  it("counts once when the live update comes before the answer, and keeps the answer's copy", () => {
    const { list, count } = apply(before, [[live, "live"], [answer, "answer"]]);
    expect(count).toBe(2);
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
    expect(list[1].own).toBe(true);
  });

  it("counts once when the answer comes before the live update, and keeps the answer's copy", () => {
    const { list, count } = apply(before, [[answer, "answer"], [live, "live"]]);
    expect(count).toBe(2);
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
    expect(list[1].own).toBe(true);
  });

  it("does not count or bring back a reply deleted before its late copy arrives", () => {
    const sent = apply(before, [[answer, "answer"]]);
    const deleted = sent.list.map((c) => (c.id === "b" ? { ...c, deleted: true, body: "" } : c));
    const { list, count } = apply(deleted, [[live, "live"], [answer, "answer"]]);
    expect(count).toBe(2);
    expect(list[1]).toMatchObject({ id: "b", deleted: true, body: "" });
  });

  it("counts each other reader's reply once", () => {
    const { list, count } = apply(before, [[reply("c"), "live"], [reply("d"), "live"], [reply("c"), "live"]]);
    expect(count).toBe(3);
    expect(list.map((c) => c.id)).toEqual(["a", "c", "d"]);
  });
});
