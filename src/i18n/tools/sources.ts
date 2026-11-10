/*
 * The files whose text the interface shows: the app's components and the modules holding what they show (menus,
 * tabs, dialogs). Not read: the website (community-site, not translated), the tools of the agent and of the assistant
 * (read by a model) and the exported report (in English), the strategy engine (a worker, no page), these tools, the
 * tests and the generated bindings.
 */
const LEFT_OUT = [
  /^src\/community-site\//,
  /^src\/agent\//,
  /^src\/data\/assistant\//,
  /^src\/backtester\//,
  /^src\/window\/strategy-tester\/xlsx-report\.ts$/,
  /^src\/i18n\/tools\//,
  /^src\/bindings\.ts$/,
  /\/__tests__\//,
  /\.d\.ts$/,
];

/** A source file (path from the repository root, "src/…") read for interface text. */
export function scanned(path: string): boolean {
  return /^src\/.*\.tsx?$/.test(path) && !LEFT_OUT.some((r) => r.test(path));
}
