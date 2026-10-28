import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const directory = "evidence";
const output = join(directory, "MANIFEST.md");
const excluded = new Set(["README.md", "MANIFEST.md"]);

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    if (!entry.isFile() || excluded.has(entry.name)) return [];
    return [full];
  });
}

const files = collect(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const rows = files.map(file => {
  const name = relative(directory, file).split(sep).join("/");
  const contents = readFileSync(file);
  const canonical = Buffer.from(contents.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return `| [${name}](${name}) | ${canonical.length} | \`${createHash("sha256").update(canonical).digest("hex")}\` |`;
});

const manifest = [
  "# 证据文件清单",
  "",
  "此文件由 `npm run evidence:manifest` 生成。SHA256 对应仓库中脱敏后的公开证据文件；本机原始敏感诊断只保存在被忽略的 `local-only/` 目录。",
  "",
  `共 ${files.length} 个证据文件。分类说明见 [README](README.md)。`,
  "",
  "| 文件 | 字节数 | SHA256 |",
  "|---|---:|---|",
  ...rows,
  "",
].join("\n");

writeFileSync(output, manifest);
console.log(`Wrote ${output} with ${files.length} files.`);
