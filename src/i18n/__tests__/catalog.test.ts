import { describe, expect, it } from "vitest";
import { indicatorRegistry } from "lightweight-charts-indicators";
import catalogJson from "../catalog.json";
import { LANGUAGES } from "../languages";
import type { Dictionary } from "../translator";
import { buildCatalog, checkDictionary, type Catalog } from "../tools/catalog";
import { RUN_TIME_TEXTS } from "../tools/run-time-texts";
import { joinedTexts, staticTexts } from "../tools/scan";
import { scanned } from "../tools/sources";
import { knownStudyTexts, studyTexts, type StudyEntry } from "../tools/study-texts";

const catalog = catalogJson as Catalog;

const SOURCES = Object.entries(
  import.meta.glob(["../../**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)
  .map(([path, source]) => ({ file: path.replace(/^(\.\.\/)+/, "src/"), source }))
  .filter((f) => scanned(f.file));

const DICTIONARIES = import.meta.glob("../*.json", { import: "default", eager: true }) as Record<string, Dictionary>;
const registry = indicatorRegistry as unknown as StudyEntry[];

describe("the English catalog (#288)", () => {
  it("is the catalog of the code, the built-in studies and the run-time texts (npm run i18n:extract)", () => {
    const fresh = buildCatalog(SOURCES.flatMap((f) => staticTexts(f.file, f.source)), studyTexts(registry), RUN_TIME_TEXTS);
    const shape = (c: Catalog) => Object.fromEntries(Object.entries(c).map(([k, e]) => [k, { plural: e.plural, sense: e.sense }]));
    expect(shape(catalog), "src/i18n/catalog.json is out of date: npm run i18n:extract").toEqual(shape(fresh));
  });

  it("has no interface text joined from words and values (write it as a template for translateWith)", () => {
    const joined = SOURCES.flatMap((f) => joinedTexts(f.file, f.source)).map((j) => `${j.file}:${j.line}  ${j.code}`);
    expect(joined).toEqual([]);
  });
});

describe("the dictionaries (#288)", () => {
  const known = knownStudyTexts(registry);
  it("each glossary is a registered language's, each term translated", () => {
    const glossaries = import.meta.glob("../glossary/*.json", { import: "default", eager: true }) as Record<string, Record<string, { translation?: string }>>;
    for (const [path, terms] of Object.entries(glossaries)) {
      expect(LANGUAGES.some((l) => path.endsWith(`/${l.id}.json`)), path).toBe(true);
      expect(Object.entries(terms).filter(([, t]) => !t.translation).map(([term]) => term), path).toEqual([]);
    }
  });
  for (const l of LANGUAGES.filter((x) => x.dictionary)) {
    const d = DICTIONARIES[`../${l.id}.json`];
    const categories = new Intl.PluralRules(l.pluralLocale).resolvedOptions().pluralCategories;
    describe(l.id, () => {
      const p = checkDictionary(catalog, d, categories, known);
      it(l.partial ? "is partial: its missing texts are reported (npm run i18n:report)" : "has every text of the catalog (npm run i18n:missing)", () => {
        if (!l.partial) expect(p.missing).toEqual([]);
      });
      it("has no entry the catalog lost (npm run i18n:prune)", () => expect(p.obsolete).toEqual([]));
      it("keeps the values of each text ({0}, {1}…)", () => expect(p.values).toEqual([]));
      it("has the word of each sense", () => expect(p.senses).toEqual([]));
      it("gives counted texts the forms of its plural rules", () => expect(p.plurals).toEqual([]));
    });
  }
});
