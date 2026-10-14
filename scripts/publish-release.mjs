#!/usr/bin/env node
/**
 * Publishes the built installers as a GitHub release, which installed copies of VBuddy pick up as an update
 * (they read the newest release of Ravishankar642/Vbuddy-web: its tag is the version; the installers and
 * SHA256SUMS.txt are its files). Needs the GitHub CLI signed in (gh auth login). Run after pnpm package:both.
 *
 *   pnpm release:publish            publish release/ for the version in package.json
 *   pnpm release:publish -- --draft make it a draft first (installed copies ignore drafts)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.VBUDDY_UPDATE_REPO || "Ravishankar642/Vbuddy-web";
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = join(root, "release");
const files = [`VBuddy-Setup-${version}.exe`, `VBuddy-Local-Setup-${version}.exe`, "SHA256SUMS.txt"].map((f) => join(out, f));
const missing = files.filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`Missing ${missing.map((f) => f.split(/[\\/]/).pop()).join(", ")}. Run pnpm package:both first (on Windows with Inno Setup).`);
  process.exit(1);
}
const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
for (const f of files.slice(0, 2)) if (!sums.includes(f.split(/[\\/]/).pop())) {
  console.error(`SHA256SUMS.txt has no line for ${f}. Run pnpm package:both again.`);
  process.exit(1);
}
// Release notes: this version's section of CHANGELOG.md, if there is one.
const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const m = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(log);
const notesFile = join(out, "release-notes.md");
writeFileSync(notesFile, (m?.[1] ?? `VBuddy ${version}`).trim() + "\n");
const args = ["release", "create", `v${version}`, ...files, "--repo", repo, "--title", `VBuddy ${version}`, "--notes-file", notesFile];
if (process.argv.includes("--draft")) args.push("--draft");
const r = spawnSync("gh", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
