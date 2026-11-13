/*
 * Files the user attaches to an assistant message: kept in memory while the app runs, by a short id. The model reads
 * only a line with their name and id in the message (attachmentLine, as it was trained); the tools that take a file
 * (read_trade_file, import_trades) read its text by that id. Chats are kept without the files: a chat reopened after
 * a restart names ids the tools no longer have, and they say so.
 */

export type Attachment = { id: string; name: string; text: string };

/** Larger files are refused when attached. */
export const MAX_ATTACHMENT_BYTES = 5_000_000;

const files = new Map<string, Attachment>();

/** Keeps a file's text; its id ("f" and 4 letters or digits, unlike the ids of an earlier run). */
export function attach(name: string, text: string): Attachment {
  let id: string;
  do id = `f${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
  while (files.has(id));
  const a = { id, name, text };
  files.set(id, a);
  return a;
}

export function attachment(id: string): Attachment | undefined {
  return files.get(id.trim());
}

/** The line the model reads for a file attached to a message. */
export function attachmentLine(f: { id: string; name: string }): string {
  return `[Attached file "${f.name}", file id: ${f.id}]`;
}
