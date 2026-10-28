import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipDirectories = new Set([".git", "node_modules", "dist", ".wrangler", "local-only", "private"]);
const markdown = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) markdown.push(full);
  }
}

collect(root);
const failures = [];
let linksChecked = 0;

for (const file of markdown.sort()) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    linksChecked++;
    const local = decodeURIComponent(target.split("#")[0]);
    if (!local) continue;
    const destination = local.startsWith("/") ? resolve(root, `.${local}`) : resolve(dirname(file), local);
    if (!existsSync(destination)) failures.push({ file: file.slice(root.length + 1).replaceAll("\\", "/"), target });
  }
}

const outIndex = process.argv.indexOf("--out");
const result = {
  checkedAt: new Date().toISOString(),
  filesChecked: markdown.length,
  linksChecked,
  failures,
  passed: failures.length === 0,
};
if (outIndex >= 0 && process.argv[outIndex + 1]) {
  writeFileSync(resolve(root, process.argv[outIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;