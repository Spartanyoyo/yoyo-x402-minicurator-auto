import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { FormData, fetch as apiFetch } from "undici";
import { curatorFetch, curlFetch, curatorDispatcher } from "./curator-transport.mjs";

// Deploy through Cloudflare's official Workers API because Wrangler's bundled
// transport is unreliable on this host. The read-back below resolves the
// unknown outcome left by a lost upload/deployment response.
const config = JSON.parse(readFileSync("wrangler.curator.jsonc", "utf8"));
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN || config.name !== "yoyo-x402-minicurator") throw new Error("MiniCurator deployment configuration required");
const main = readFileSync("dist/curator/curator-worker.js", "utf8");
const files = ["curator-worker.js", ...new Set(Array.from(main.matchAll(/from ["']\.\/([A-Za-z0-9._-]+\.md)["']/g), match => match[1]))];
const hashes = Object.fromEntries(files.map(name => [name, createHash("sha256").update(readFileSync(`dist/curator/${name}`)).digest("hex")]));
const startedAt = new Date().toISOString();
const versionMessage = `MiniCurator validation ${hashes["curator-worker.js"].slice(0, 12)}`;
const record = { startedAt, worker: config.name, versionMessage, moduleHashes: hashes, status: "prepared" };
mkdirSync("evidence/phase2a", { recursive: true });
const output = `evidence/phase2a/deploy-api-${Date.now()}.json`;
const save = () => writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
save();

function accountUrl(path) {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${config.name}${path}`;
}

async function mutateApi(path, init = {}) {
  const response = await apiFetch(accountUrl(path), { ...init, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, ...init.headers }, ...(curatorDispatcher ? { dispatcher: curatorDispatcher } : {}), signal: AbortSignal.timeout(90000) });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Cloudflare API HTTP ${response.status}; codes: ${(body.errors ?? []).map(error => error.code).join(",")}`);
  return body.result;
}

async function readApi(path) {
  let lastError;
  for (const fetcher of [curatorFetch, curlFetch]) {
    try {
      const response = await fetcher(accountUrl(path), { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(45000) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(`Cloudflare read HTTP ${response.status}; codes: ${(body.errors ?? []).map(error => error.code).join(",")}`);
      return body.result;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function matchingVersion() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const versions = await readApi("/versions");
    const items = versions.items ?? versions;
    const match = items.find(version => version.annotations?.["workers/message"] === versionMessage);
    if (match) return match;
    if (attempt < 3) await delay(1000 * attempt);
  }
  return null;
}

function activeMatch(deployments, versionId) {
  const items = deployments.deployments ?? deployments;
  return items[0]?.versions?.find(version => version.version_id === versionId && version.percentage === 100) ?? null;
}

async function activeDeployment(versionId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const match = activeMatch(await readApi("/deployments"), versionId);
    if (match) return match;
    if (attempt < 3) await delay(1000 * attempt);
  }
  return null;
}

async function deployKnownVersion(versionId) {
  try {
    const deployed = await mutateApi("/deployments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }) });
    record.deploymentId = deployed.id;
    record.status = "deployment_submitted";
    save();
  } catch (error) {
    record.deploymentTransportError = error.message;
    record.status = "deployment_outcome_unknown";
    save();
  }
  const active = await activeDeployment(versionId);
  if (!active) throw new Error("Deployment outcome remains unknown; no automatic upload retry was attempted");
  record.activeVersions = [active];
}

try {
  const metadata = {
    main_module: "curator-worker.js",
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    bindings: [...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })), ...config.ratelimits.map(limit => ({ ...limit, type: "ratelimit" }))],
    annotations: { "workers/message": versionMessage },
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const name of files) form.set(name, new Blob([readFileSync(`dist/curator/${name}`)], { type: name.endsWith(".js") ? "application/javascript+module" : "text/plain" }), name);
  record.status = "upload_submitted"; save();
  let uploaded;
  try {
    uploaded = await mutateApi("/versions?bindings_inherit=strict", { method: "POST", body: form });
  } catch (error) {
    record.uploadTransportError = error.message;
    record.status = "upload_outcome_unknown"; save();
    uploaded = await matchingVersion();
    if (!uploaded) throw new Error(`${error.message}; no matching Cloudflare version was found after read-back`);
    record.uploadReconciledAfterTransportError = true;
    record.status = "upload_reconciled"; save();
  }
  record.versionId = uploaded.id; save();
  await deployKnownVersion(uploaded.id);
  record.status = "deployed"; record.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ evidence: output, status: record.status, worker: config.name, versionId: record.versionId, activeVersions: record.activeVersions, uploadReconciled: record.uploadReconciledAfterTransportError === true, deploymentTransportError: record.deploymentTransportError ?? null }, null, 2));
} catch (error) {
  record.error = error.message; save();
  console.error(JSON.stringify({ evidence: output, status: record.status, error: error.message, instruction: "Inspect versions/deployments before another upload; no automatic mutation retry was attempted" }));
  process.exitCode = 1;
}