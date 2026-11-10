/* What the language scripts (scripts/i18n.mjs) use: bundled for node on each run. */
export { staticTexts, joinedTexts } from "./scan";
export { buildCatalog, checkDictionary, coverage, hasText, serializeCatalog, valuesOf, type Catalog } from "./catalog";
export { knownStudyTexts, strategyTexts, studyTexts } from "./study-texts";
export { RUN_TIME_TEXTS } from "./run-time-texts";
export { builtInStrategy, scanned } from "./sources";
export { LANGUAGES } from "../languages";
