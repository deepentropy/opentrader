/*
 * A price field in the interface language (format.ts, "Price fields"): its text is kept in English marks by the code
 * ("1,234.5"). In a language with its own decimal sign it shows "1 234,5", takes "1234,5" or "1234.5" as typed, and
 * once left keeps the typed number in English marks again (shown in the language's). In English: the text as it is.
 */
import { createSignal } from "solid-js";
import { leftNumber, shownNumber } from "./format";
import { activeFormats } from "./translator";

/** `value`, `onFocus` and `onBlur` of an input showing the text `get()`, changed with `set` (spread them on it). */
export function priceFieldProps(get: () => string, set: (text: string) => void) {
  // The text when the field took the focus: until the user types, it shows in the language's marks.
  const [atFocus, setAtFocus] = createSignal<string | null>(null);
  return {
    get value() {
      const text = get();
      return atFocus() !== null && text !== atFocus() ? text : shownNumber(text);
    },
    onFocus: () => {
      if (activeFormats().numberMarks) setAtFocus(get());
    },
    onBlur: () => {
      const before = atFocus();
      setAtFocus(null);
      const text = get();
      if (before === null || text === before) return;
      const left = leftNumber(text);
      if (left !== text) set(left);
    },
  };
}
