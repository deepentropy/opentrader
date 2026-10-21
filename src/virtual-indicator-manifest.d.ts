/** Names of the indicator library's entries (scripts/indicator-manifest-plugin.mjs): [id, name, short name, group
 *  ("s" standard, "c" community, "k" candlestick)]. */
declare module "virtual:indicator-manifest" {
  const manifest: { version: string; entries: [string, string, string, "s" | "c" | "k"][] };
  export default manifest;
}
