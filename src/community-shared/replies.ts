/*
 * The reader's own reply reaches the thread twice: in the server's answer to
 * the post request and from the post's live room (#208), in either order. The
 * thread holds it once, by its id, and the post's reply count goes up once
 * (#280).
 */
import type { Comment } from "./contract";

/** Where a reply came from: the post's live room, or the answer to the reader's own post request. */
export type ReplySource = "live" | "answer";

/** The thread with `c` in it; `added` is true when it was not there yet, so the reply count goes up by one. */
export function withReply(list: Comment[], c: Comment, from: ReplySource): { list: Comment[]; added: boolean } {
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) return { list: [...list, c], added: true };
  // The live copy is the one every reader gets: the answer's copy knows the reader wrote it (edit, delete).
  // A reply deleted meanwhile stays deleted.
  if (from === "live" || list[i].deleted) return { list, added: false };
  return { list: list.map((x, j) => (j === i ? c : x)), added: false };
}
