// The language tools (#288), see AGENTS.md "Languages":
//   npm run i18n:extract               writes src/i18n/catalog.json from the code, the built-in studies and the run-time texts
//   npm run i18n:report                coverage and problems per language
//   npm run i18n:prune                 removes the dictionary entries the catalog no longer has, lists them
//   npm run i18n:missing -- <lang> [file]          writes the texts a language lacks, with context, for a translator
//   npm run i18n:merge -- <lang> <file>            merges a filled file back into the dictionary, checked
//
// The tools are the app's TypeScript (src/i18n/tools), bundled for node on each run.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const I18N = join(ROOT, "src", "i18n");
const CATALOG = join(I18N, "catalog.json");

async function loadTools() {
  const outfile = join(ROOT, "node_modules", ".cache", "opentrader-i18n", "tools.mjs");
  await build({
    entryPoints: [join(I18N, "tools", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    packages: "external",
    define: { "import.meta.env.DEV": "false" },
    logLevel: "error",
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

const tools = await loadTools();

function sourceFiles(dir = join(ROOT, "src"), out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else {
      const rel = relative(ROOT, path).replace(/\\/g, "/");
      if (tools.scanned(rel)) out.push(rel);
    }
  }
  return out.sort();
}

async function extractCatalog() {
  const code = sourceFiles().flatMap((f) => tools.staticTexts(f, readFileSync(join(ROOT, f), "utf8")));
  const { indicatorRegistry } = await import("lightweight-charts-indicators");
  return { catalog: tools.buildCatalog(code, tools.studyTexts(indicatorRegistry), tools.RUN_TIME_TEXTS), registry: indicatorRegistry };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const dictionaryPath = (id) => join(I18N, `${id}.json`);
/** A language just added may have no dictionary file yet: nothing translated. */
const readDictionary = (id) => (existsSync(dictionaryPath(id)) ? readJson(dictionaryPath(id)) : {});
/** The languages with a dictionary file (a pseudo-language is generated from the catalog). */
const translated = () => tools.LANGUAGES.filter((l) => l.dictionary && !l.pseudo);
const language = (id) => {
  const l = translated().find((x) => x.id === id);
  if (!l) throw new Error(`No language "${id}" in src/i18n/languages.ts (${translated().map((x) => x.id).join(", ")}).`);
  return l;
};
const categoriesOf = (l) => new Intl.PluralRules(l.pluralLocale).resolvedOptions().pluralCategories;

/** A dictionary as committed: sorted, one entry per line. */
function writeDictionary(id, d) {
  const keys = Object.keys(d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  writeFileSync(dictionaryPath(id), `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(d[k])}`).join(",\n")}\n}\n`);
}

async function extract() {
  const before = existsSync(CATALOG) ? readJson(CATALOG) : {};
  const { catalog } = await extractCatalog();
  writeFileSync(CATALOG, tools.serializeCatalog(catalog));
  const added = Object.keys(catalog).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in catalog));
  console.log(`catalog: ${Object.keys(catalog).length} texts (${added.length} new, ${removed.length} gone)`);
  for (const k of added) console.log(`  + ${JSON.stringify(k)}  ${catalog[k].at[0]}`);
  for (const k of removed) console.log(`  - ${JSON.stringify(k)}`);
}

async function report() {
  const catalog = readJson(CATALOG);
  const { indicatorRegistry } = await import("lightweight-charts-indicators");
  const known = tools.knownStudyTexts(indicatorRegistry);
  console.log(`catalog: ${Object.keys(catalog).length} texts`);
  for (const l of translated()) {
    const d = readDictionary(l.id);
    const p = tools.checkDictionary(catalog, d, categoriesOf(l), known);
    const extra = Object.keys(d).filter((k) => !(k in catalog) && known.has(k)).length;
    console.log(
      `${l.id.padEnd(8)} ${String(tools.coverage(catalog, d)).padStart(5)}%  missing ${p.missing.length}, obsolete ${p.obsolete.length}, ` +
        `values ${p.values.length}, senses ${p.senses.length}, plurals ${p.plurals.length}; other study texts ${extra}${l.partial ? " (partial)" : ""}`,
    );
    for (const [what, keys] of Object.entries(p)) for (const k of keys.slice(0, 20)) console.log(`    ${what}: ${JSON.stringify(k)}`);
  }
}

async function prune() {
  const catalog = readJson(CATALOG);
  const { indicatorRegistry } = await import("lightweight-charts-indicators");
  const known = tools.knownStudyTexts(indicatorRegistry);
  for (const l of translated()) {
    const d = readDictionary(l.id);
    const { obsolete } = tools.checkDictionary(catalog, d, categoriesOf(l), known);
    for (const k of obsolete) delete d[k];
    writeDictionary(l.id, d);
    console.log(`${l.id}: ${obsolete.length} removed`);
    for (const k of obsolete) console.log(`  - ${JSON.stringify(k)}`);
  }
}

/** The glossary terms a text holds: whole words, longest first. */
function glossaryHits(glossary, text) {
  const lower = text.toLowerCase();
  return Object.entries(glossary)
    .filter(([term]) => new RegExp(`(^|[^a-z])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(lower))
    .sort(([a], [b]) => b.length - a.length)
    .map(([term, g]) => ({ term, ...g }));
}

function missing(id, file) {
  const l = language(id);
  const catalog = readJson(CATALOG);
  const d = readDictionary(l.id);
  const glossaryPath = join(I18N, "glossary", `${l.id}.json`);
  const glossary = existsSync(glossaryPath) ? readJson(glossaryPath) : {};
  const categories = categoriesOf(l);
  const out = {};
  for (const key of Object.keys(catalog)) {
    if (tools.hasText(d, key)) continue;
    const e = catalog[key];
    const bar = key.indexOf("|");
    out[key] = {
      ...(e.sense ? { english: key.slice(0, bar), sense: e.sense } : {}),
      ...(e.values ? { values: e.values } : {}),
      ...(e.plural ? { english: e.plural, forms: categories } : {}),
      at: e.at,
      ...(glossaryHits(glossary, key).length ? { glossary: glossaryHits(glossary, key) } : {}),
      translation: e.plural && categories.length > 1 ? Object.fromEntries(categories.map((c) => [c, ""])) : "",
    };
  }
  const target = file ?? join(ROOT, ".tmp", "i18n", `${l.id}-missing.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`${Object.keys(out).length} texts missing in ${l.id}: ${relative(ROOT, target)}`);
  console.log(`Fill each "translation" (keep the values {0}, {1}…; the glossary's terms), then: npm run i18n:merge -- ${l.id} ${relative(ROOT, target)}`);
}

function merge(id, file) {
  const l = language(id);
  if (!file) throw new Error("npm run i18n:merge -- <lang> <file>");
  const catalog = readJson(CATALOG);
  const d = readDictionary(l.id);
  const filled = readJson(file);
  const categories = categoriesOf(l);
  const errors = [];
  let merged = 0;
  for (const [key, entry] of Object.entries(filled)) {
    const given = typeof entry === "object" && entry !== null && "translation" in entry ? entry.translation : entry;
    // A form left empty falls back to "other".
    const to = typeof given === "string" ? given : Object.fromEntries(Object.entries(given ?? {}).filter(([, f]) => f));
    const forms = typeof to === "string" ? [to] : Object.values(to);
    if (forms.every((f) => !f)) continue;
    if (!(key in catalog)) errors.push(`not in the catalog: ${JSON.stringify(key)}`);
    else if (forms.some((f) => !f || tools.valuesOf(f).join(" ") !== tools.valuesOf(key).join(" "))) errors.push(`values differ from the English: ${JSON.stringify(key)}`);
    else if (typeof to === "object" && (!catalog[key].plural || !("other" in to) || Object.keys(to).some((c) => !categories.includes(c))))
      errors.push(`forms must be among ${categories.join(", ")} with "other": ${JSON.stringify(key)}`);
    else if (typeof to === "string" && catalog[key].plural && categories.length > 1) errors.push(`needs one form per category (${categories.join(", ")}): ${JSON.stringify(key)}`);
    else {
      d[key] = to;
      merged++;
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(`  ${e}`);
    console.error(`${errors.length} entries not merged; nothing written.`);
    process.exit(1);
  }
  writeDictionary(l.id, d);
  console.log(`${merged} texts merged into src/i18n/${l.id}.json`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { extract, report, prune, missing: () => missing(args[0], args[1]), merge: () => merge(args[0], args[1]) };
if (!commands[command]) {
  console.error(`Usage: node scripts/i18n.mjs ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
await commands[command]();
