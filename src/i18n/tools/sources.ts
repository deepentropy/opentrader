/*
 * The files whose text the interface shows: the app's components and the modules holding what they show (menus,
 * tabs, dialogs). Not read: the website (community-site, not translated), the tools of the agent and of the assistant
 * (read by a model), the exported report and list of trades (in English), the strategy engine (a worker, no page; its
 * built-in strategies are read apart), these tools, the tests and the generated bindings.
 */
const LEFT_OUT = [
  /^src\/community-site\//,
  /^src\/agent\//,
  /^src\/data\/assistant\//,
  /^src\/backtester\//,
  /^src\/window\/strategy-tester\/xlsx-report\.ts$/,
  /^src\/window\/strategy-tester\/trades-csv\.ts$/,
  /^src\/i18n\/tools\//,
  /^src\/bindings\.ts$/,
  /\/__tests__\//,
  /\.d\.ts$/,
];

/** A built-in strategy (an OakScript script of src/backtester/builtins): its name and inputs are read (study-texts.ts). */
export function builtInStrategy(path: string): boolean {
  return /^src\/backtester\/builtins\/[\w-]+\.ts$/.test(path) && !path.endsWith("/index.ts");
}

/** A source file (path from the repository root, "src/…") read for interface text. */
export function scanned(path: string): boolean {
  return /^src\/.*\.tsx?$/.test(path) && !LEFT_OUT.some((r) => r.test(path));
}
