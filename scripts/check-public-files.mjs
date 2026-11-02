import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", "node_modules", ".wrangler", "dist", "private", "local-only"]);
const ignoredFiles = new Set([".env.local", ".env.cloudflare", ".env.phase2b.local", ".dev.vars"]);
const localCredentialFiles = [
  { file: ".env.local", key: "EVM_PRIVATE_KEY", kind: "buyer_private_key" },
  { file: ".env.cloudflare", key: "CLOUDFLARE_API_TOKEN", kind: "cloudflare_api_token" },
  { file: ".env.phase2b.local", key: "AGENT_LLM_API_KEY", kind: "agent_model_api_key" },
  { file: ".env.phase2b.local", key: "AGENT_WALLET_KEY", kind: "agent_wallet_private_key" },
];
const comparisons = [];

function envValue(file, key) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find(value => value.startsWith(`${key}=`));
  if (!line) return undefined;
  let value = line.slice(key.length + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value || undefined;
}

for (const item of localCredentialFiles) {
  const value = envValue(item.file, item.key);
  if (value && value.length >= 16) comparisons.push({ kind: item.kind, value });
}
if (existsSync("private/seller-key.txt")) {
  const value = readFileSync("private/seller-key.txt", "utf8").trim();
  if (value.length >= 16) comparisons.push({ kind: "seller_private_key", value });
}
const accountId = envValue(".env.cloudflare", "CLOUDFLARE_ACCOUNT_ID");
if (accountId) comparisons.push({ kind: "cloudflare_account_id", value: accountId });
const rawDeployment = "local-only/evidence/raw-private/deployment-review-2026-10-22.json";
if (existsSync(rawDeployment)) {
  try {
    const email = JSON.parse(readFileSync(rawDeployment, "utf8")).version?.metadata?.author_email;
    if (email) comparisons.push({ kind: "author_email", value: email });
  } catch {}
}

const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || ignoredFiles.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile()) files.push(full);
  }
}
collect(root);

function publicSensitiveArtifacts(text) {
  const kinds = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) kinds.push("pem_private_key");
  if (/\b(?:EVM_PRIVATE_KEY|AGENT_WALLET_KEY)[ \t]*=[ \t]*["']?0x[0-9a-fA-F]{64}\b/.test(text)) kinds.push("evm_private_key_assignment");
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text)) kinds.push("model_api_key");
  if (/\bCLOUDFLARE_API_TOKEN[ \t]*=[ \t]*["']?[A-Za-z0-9_-]{20,}/.test(text)) kinds.push("cloudflare_token_assignment");
  if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text) || /\bgithub_pat_[A-Za-z0-9_]{40,}\b/.test(text)) kinds.push("github_token");
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) kinds.push("aws_access_key");
  if (/\bsk_live_[A-Za-z0-9]{16,}\b/.test(text)) kinds.push("stripe_live_key");
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) kinds.push("jwt");
  if (/Authorization["']?\s*:\s*["'`]?Bearer\s+(?!\$\{)[A-Za-z0-9._~+\/=-]{20,}/i.test(text)) kinds.push("bearer_token");
  return kinds;
}

function publicEvidenceArtifacts(text, publicName) {
  if (!publicName.startsWith("evidence/")) return [];
  const kinds = [];
  if (/eth_sendRawTransaction/i.test(text)) kinds.push("raw_signed_transaction");
  if (/0x[0-9a-fA-F]{300,}/.test(text)) kinds.push("long_hex_payload");
  for (const match of text.matchAll(/"(?:payment-signature|x-payment)"\s*:\s*"([^"]*)"/gi)) {
    if (match[1].length > 32 && match[1] !== "invalid") kinds.push("reusable_payment_header");
  }
  for (const match of text.matchAll(/"payment-response"\s*:\s*"([A-Za-z0-9+/=]{80,})"/gi)) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      if (/eth_sendRawTransaction|transferWithAuthorization|"rawTransaction"/i.test(decoded)) kinds.push("raw_signed_transaction_base64");
    } catch {}
  }
  return kinds;
}

const matchingFiles = [];
for (const file of files) {
  const publicName = relative(root, file).replaceAll("\\", "/");
  let bytes;
  try { bytes = readFileSync(file); } catch { continue; }
  const text = bytes.toString("utf8");
  const matchedKinds = comparisons.filter(item => bytes.includes(Buffer.from(item.value))).map(item => item.kind);
  if (/[A-Za-z]:\\\\Users\\\\|[A-Za-z]:\\\\X402\\\\/i.test(text)) matchedKinds.push("absolute_local_path");
  matchedKinds.push(...publicSensitiveArtifacts(text));
  matchedKinds.push(...publicEvidenceArtifacts(text, publicName));
  if (matchedKinds.length) matchingFiles.push({ file: publicName, kinds: [...new Set(matchedKinds)] });
}

const result = {
  checkedAt: new Date().toISOString(),
  filesScanned: files.length,
  localComparisonsLoaded: comparisons.length,
  comparisonKinds: comparisons.map(item => item.kind).sort(),
  missingOptionalLocalComparisons: [
    ...localCredentialFiles.filter(item => !envValue(item.file, item.key)).map(item => item.kind),
    ...(existsSync("private/seller-key.txt") ? [] : ["seller_private_key"]),
    ...(accountId ? [] : ["cloudflare_account_id"]),
    ...(existsSync(rawDeployment) ? [] : ["author_email"]),
  ],
  matchingFiles,
  passed: matchingFiles.length === 0,
};
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0 && process.argv[outIndex + 1]) writeFileSync(resolve(root, process.argv[outIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
