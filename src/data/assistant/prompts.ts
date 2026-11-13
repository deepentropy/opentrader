/*
 * The prompt each version of the assistant's fine-tune was trained with (src-tauri/src/local_model.rs ADAPTERS), byte
 * for byte (a test checks their sha256): the window sends the installed version's. The files come from
 * opentrader-llm/prompts, where they are frozen with the adapter trained on them.
 */
import { localInfo } from "./local";
import COMPACT_V1_RAW from "./compact-v1.txt?raw";
import COMPACT_V2_RAW from "./compact-v2.txt?raw";

export type TrainedPrompt = { name: string; text: string };

/** Line ends as written in training. */
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** Fine-tune version -> its prompt. */
export const PROMPTS: Record<number, TrainedPrompt> = {
  2: { name: "compact-v1", text: lf(COMPACT_V1_RAW) },
  3: { name: "compact-v2", text: lf(COMPACT_V2_RAW) },
};

/** The installed fine-tune's version: the one on disk, else the one this build offers. */
export function modelVersion(): number {
  const i = localInfo();
  return i?.version ?? i?.latestVersion ?? 2;
}

/** The prompt of a version (the newest known for one this build has no prompt for). */
export function promptFor(version: number): TrainedPrompt {
  return PROMPTS[version] ?? PROMPTS[Math.max(...Object.keys(PROMPTS).map(Number))];
}
