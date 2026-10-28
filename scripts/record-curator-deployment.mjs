import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { curatorFetch, curlFetch } from "./curator-transport.mjs";

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("Local Cloudflare configuration required");
async function cloudflare(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await (attempt === 0 ? curatorFetch : curlFetch)(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${path}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("Cloudflare read-only metadata request rejected");
      return body.result;
    } catch (error) { if (attempt >= 1) throw error; }
  }
}
const record = { checkedAt: new Date().toISOString(), scope: "Read-only deployment metadata; private account identifiers and author details excluded", workers: {}, localSourceHashes: {} };
for (const name of ["yoyo-x402-minicurator", "yoyo-x402-weather"]) {
  const deployments = await cloudflare(`${name}/deployments`);
  const settings = await cloudflare(`${name}/settings`);
  record.workers[name] = { latest: (deployments.deployments ?? deployments)[0] && (({ id, created_on, versions }) => ({ id, createdOn: created_on, versions }))((deployments.deployments ?? deployments)[0]), bindings: settings.bindings.map(({ name, type }) => ({ name, type })), compatibilityDate: settings.compatibility_date };
}
record.weatherVersionPreserved = record.workers["yoyo-x402-weather"].latest.versions.some(version => version.version_id === "15b034a3-a6bc-4850-befe-1d2f66fbae88" && version.percentage === 100);
for (const file of ["src/curator-worker.mjs", "src/curator-app.mjs", "src/curator-catalog.mjs", "wrangler.curator.jsonc", "docs/F-02_minicurator.md"]) record.localSourceHashes[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
mkdirSync("evidence/phase2a", { recursive: true });
writeFileSync("evidence/phase2a/deployment-2026-10-25.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
if (!record.weatherVersionPreserved) process.exitCode = 1;
