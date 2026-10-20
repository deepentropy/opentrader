// Prepares a release (prepare-release.yml): bumps the three libraries to their
// latest release, then the app version in every file that carries it.
//
//   node scripts/release-bump.mjs <when> <part>
//     when: "libs"    release only if a library has a new version (daily run)
//           "changes" release if a library changed or main has commits since
//                     the last version tag (manual run)
//     part: "patch" | "minor"
//
// Writes release=true|false and version=<x.y.z> to $GITHUB_OUTPUT (stdout
// without it). Files are changed only when release=true.
import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [when = "changes", part = "patch"] = process.argv.slice(2);
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const semverCmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

const output = (values) => {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
};

const pkg = readJson("package.json");
const current = pkg.version;

// npm libraries: dependency range "^x.y.z" against the latest published version.
const npmLibs = ["oakscriptjs", "lightweight-charts-indicators"].map((name) => ({
  name,
  from: pkg.dependencies[name].replace(/^[\^~]/, ""),
  to: sh(`npm view ${name} version`),
}));

// Drawing core: imported from source at a git tag (package.json config.drawingRef).
const drawingTags = sh("git ls-remote --tags --refs https://github.com/deepentropy/lightweight-charts-drawing.git")
  .split("\n")
  .map((line) => line.split("refs/tags/")[1])
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  .sort((a, b) => semverCmp(a.slice(1), b.slice(1)));
const drawing = { from: pkg.config.drawingRef, to: drawingTags.at(-1) };

const libChanges = npmLibs.filter((l) => semverCmp(l.to, l.from) > 0);
const drawingChanged = semverCmp(drawing.to.slice(1), drawing.from.slice(1)) > 0;
const commits = Number(sh(`git rev-list --count v${current}..HEAD`));

for (const l of npmLibs) console.error(`${l.name}: ${l.from} -> ${l.to}`);
console.error(`lightweight-charts-drawing: ${drawing.from} -> ${drawing.to}`);
console.error(`commits since v${current}: ${commits}`);

const libsChanged = libChanges.length > 0 || drawingChanged;
if (!libsChanged && (when === "libs" || commits === 0)) {
  console.error("Nothing to release.");
  output({ release: "false", version: current });
  process.exit(0);
}

// Libraries first: npm rewrites package.json and the lockfile.
if (libChanges.length) {
  sh(`npm install --save ${libChanges.map((l) => `${l.name}@${l.to}`).join(" ")}`);
}

const [major, minor, patch] = current.split(".").map(Number);
const version = part === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const pkgNext = readJson("package.json");
pkgNext.version = version;
pkgNext.config.drawingRef = drawing.to;
writeJson("package.json", pkgNext);

const lock = readJson("package-lock.json");
lock.version = version;
lock.packages[""].version = version;
writeJson("package-lock.json", lock);

const tauriConf = readJson("src-tauri/tauri.conf.json");
tauriConf.version = version;
writeJson("src-tauri/tauri.conf.json", tauriConf);

// First version line of Cargo.toml is the [package] one; in Cargo.lock the
// app's own entry is the line after name = "opentrader".
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
writeFileSync("src-tauri/Cargo.toml", cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`));
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");
writeFileSync(
  "src-tauri/Cargo.lock",
  cargoLock.replace(/(name = "opentrader"\r?\nversion = )".*"/, `$1"${version}"`),
);

console.error(`Release ${version}`);
output({ release: "true", version });
