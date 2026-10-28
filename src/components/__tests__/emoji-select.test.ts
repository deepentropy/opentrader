import { describe, expect, it } from "vitest";
import { separateEmoji } from "../EmojiSelect";

describe("separateEmoji", () => {
  it("splits a leading emoji (a whole grapheme) from the rest", () => {
    expect(separateEmoji("🚀 Rocket")).toEqual({ emoji: "🚀", rest: " Rocket" });
    expect(separateEmoji("☺️x")).toEqual({ emoji: "☺️", rest: "x" });
    expect(separateEmoji("👨‍💻 dev")).toEqual({ emoji: "👨‍💻", rest: " dev" });
  });
  it("keeps names without a leading emoji whole", () => {
    expect(separateEmoji("Plain")).toEqual({ emoji: "", rest: "Plain" });
    expect(separateEmoji(" 🚀a")).toEqual({ emoji: "", rest: " 🚀a" });
    expect(separateEmoji("")).toEqual({ emoji: "", rest: "" });
  });
});
