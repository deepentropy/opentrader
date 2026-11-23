/*
 * The OakScript editor's Release notes and Help ▸ (#325, More menu), as the reference's: Release notes opens the
 * script language's release notes (the engine's changelog, oakscriptjs), with a dot until the notes of the installed
 * engine version have been opened; Help groups the editor's own help (the scripting page, the keyboard shortcuts),
 * the language's manual and reference (the engine's guide) and a feature request. Links open in the browser.
 */
import { createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import oakPackage from "../../../node_modules/oakscriptjs/package.json";
import * as kv from "../../data/kv";

const ENGINE_REPO = "https://github.com/deepentropy/oakscriptJS/blob/main";
export const RELEASE_NOTES_URL = `${ENGINE_REPO}/CHANGELOG.md`;

export type HelpLink = { label: string; icon: string; url?: string };

/** Help ▸, by section. A link without `url` is the app's Keyboard shortcuts panel. */
export const HELP_SECTIONS: { title: string; items: HelpLink[] }[] = [
  {
    title: "Editor references",
    items: [
      { label: "How to use", icon: "profile-help", url: "https://opentrader.markets/scripting.html" },
      { label: "Keyboard shortcuts", icon: "profile-keyboard" },
    ],
  },
  {
    title: "OakScript references",
    items: [
      { label: "User Manual", icon: "oak-help-manual", url: `${ENGINE_REPO}/docs/guide.md#script-api` },
      { label: "Reference manual", icon: "oak-help-reference", url: `${ENGINE_REPO}/docs/guide.md#api-reference` },
    ],
  },
  {
    title: "Request a feature",
    items: [
      { label: "GitHub", icon: "signin-github", url: "https://github.com/deepentropy/opentrader/issues/new?template=feature_request.yml" },
    ],
  },
];

/** The engine version whose release notes were opened last. */
const SEEN_KEY = "ot:oakscript:releaseNotesSeen";
const [seen, setSeen] = createSignal(kv.getItem(SEEN_KEY));

/** The release notes of the installed engine version are not opened yet (the menu's dot). */
export const releaseNotesNew = () => seen() !== oakPackage.version;

export function releaseNotesOpened(): void {
  kv.setItem(SEEN_KEY, oakPackage.version);
  setSeen(oakPackage.version);
}

export function openHelpLink(url: string): void {
  void openUrl(url).catch((e) => console.warn("[oakscript] link not opened", e));
}
