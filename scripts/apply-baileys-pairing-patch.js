import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "@whiskeysockets", "baileys");
const expectedVersion = "7.0.0-rc14";
const packageInfo = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

if (packageInfo.version !== expectedVersion) {
  throw new Error(`Baileys pairing patch targets ${expectedVersion}, found ${packageInfo.version}`);
}

const patchPath = path.join(projectRoot, "patches", "@whiskeysockets+baileys+7.0.0-rc14.patch");
const patchContents = readFileSync(patchPath, "utf8");
const filePatches = [];
let currentFile;
let currentHunk;

function finishHunk() {
  if (currentHunk === undefined) return;
  const before = currentHunk.before.join("\n") + "\n";
  const after = currentHunk.after.join("\n") + "\n";
  if (currentFile === undefined || before === "\n" || after === "\n") {
    throw new Error("Baileys pairing patch contains an unsupported empty hunk");
  }
  currentFile.hunks.push({ before, after });
  currentHunk = undefined;
}

for (const line of patchContents.split(/\r?\n/)) {
  if (line.startsWith("diff --git ")) {
    finishHunk();
    currentFile = undefined;
    continue;
  }
  if (currentHunk === undefined && line.startsWith("+++ b/")) {
    const relativePath = line.slice("+++ b/".length);
    if (!relativePath.startsWith("node_modules/@whiskeysockets/baileys/")) {
      throw new Error(`Refusing to patch outside pinned Baileys: ${relativePath}`);
    }
    currentFile = { relativePath, hunks: [] };
    filePatches.push(currentFile);
    continue;
  }
  if (line.startsWith("@@ ")) {
    finishHunk();
    if (currentFile === undefined) throw new Error("Baileys patch hunk has no target file");
    currentHunk = { before: [], after: [] };
    continue;
  }
  if (currentHunk === undefined) continue;

  if (line.startsWith(" ")) {
    currentHunk.before.push(line.slice(1));
    currentHunk.after.push(line.slice(1));
  } else if (line.startsWith("-")) {
    currentHunk.before.push(line.slice(1));
  } else if (line.startsWith("+")) {
    currentHunk.after.push(line.slice(1));
  } else if (line.startsWith("\\")) {
    continue;
  } else {
    finishHunk();
  }
}
finishHunk();

if (filePatches.length === 0 || filePatches.some(({ hunks }) => hunks.length === 0)) {
  throw new Error("Baileys pairing patch is empty or malformed");
}

let alreadyApplied = true;
for (const { relativePath, hunks } of filePatches) {
  const targetPath = path.resolve(projectRoot, relativePath);
  const baileysRoot = `${packageRoot}${path.sep}`;
  if (!targetPath.startsWith(baileysRoot)) throw new Error(`Refusing to patch outside Baileys: ${relativePath}`);

  let contents = readFileSync(targetPath, "utf8");
  let changed = false;
  for (const { before, after } of hunks) {
    if (contents.includes(after) || contents.includes(after.slice(0, -1))) continue;
    let beforeBlock = before;
    let afterBlock = after;
    let beforeAt = contents.indexOf(beforeBlock);
    if (beforeAt < 0) {
      // A few published Baileys files intentionally end without a newline.
      beforeBlock = before.slice(0, -1);
      afterBlock = after.slice(0, -1);
      beforeAt = contents.indexOf(beforeBlock);
    }
    if (beforeAt < 0) {
      throw new Error(`Baileys pairing patch did not match ${relativePath}; refusing a partial patch`);
    }
    if (contents.indexOf(beforeBlock, beforeAt + beforeBlock.length) >= 0) {
      throw new Error(`Baileys pairing patch matched more than once in ${relativePath}`);
    }
    contents = contents.slice(0, beforeAt) + afterBlock + contents.slice(beforeAt + beforeBlock.length);
    changed = true;
    alreadyApplied = false;
  }
  if (changed) writeFileSync(targetPath, contents);
}

console.log(alreadyApplied
  ? `Baileys pairing patch ${expectedVersion} is already applied.`
  : `Applied local Baileys pairing patch ${expectedVersion}.`);
