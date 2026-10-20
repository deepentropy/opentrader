// Release notes for a version tag (release.yml): library versions that
// changed, then the commit subjects since the previous version tag.
//
//   node scripts/release-notes.mjs <tag>
//
// Prints the notes as Markdown on stdout.
import { execSync } from "node:child_process";

const tag = process.argv[2];
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const tryJson = (cmd) => {
  try { return JSON.parse(sh(cmd)); } catch { return null; }
};

const tags = sh("git tag --list v*.*.* --sort=-v:refname").split("\n");
const previous = tags[tags.indexOf(tag) + 1];

const lines = [];

// Library versions: package.json at both tags.
const now = tryJson(`git show ${tag}:package.json`);
const before = previous ? tryJson(`git show ${previous}:package.json`) : null;
if (now && before) {
  const libs = [
    ["oakscriptjs", (p) => p.dependencies?.oakscriptjs?.replace(/^[\^~]/, "")],
    ["lightweight-charts-indicators", (p) => p.dependencies?.["lightweight-charts-indicators"]?.replace(/^[\^~]/, "")],
    ["lightweight-charts-drawing", (p) => p.config?.drawingRef?.replace(/^v/, "")],
  ];
  const bumps = libs
    .map(([name, get]) => [name, get(before), get(now)])
    .filter(([, from, to]) => to && from !== to)
    .map(([name, from, to]) => `- ${name} ${from ?? "?"} → ${to}`);
  if (bumps.length) lines.push("### Libraries", "", ...bumps, "");
}

// Commit subjects, without version commits. Subjects naming a third-party
// product are left out of the public notes.
const range = previous ? `${previous}..${tag}` : tag;
const subjects = sh(`git log ${range} --no-merges --format=%s`)
  .split("\n")
  .filter((s) => s && !/^OpenTrader \d+\.\d+\.\d+$/.test(s))
  .filter((s) => !/tradingview|\btv\b/i.test(s));
if (subjects.length) lines.push("### Changes", "", ...subjects.map((s) => `- ${s}`), "");

lines.push("See the assets below to download and install OpenTrader.");
process.stdout.write(lines.join("\n") + "\n");
