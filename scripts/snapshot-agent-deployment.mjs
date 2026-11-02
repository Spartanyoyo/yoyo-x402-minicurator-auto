import { writeFileSync, readFileSync } from "node:fs";
import { fetch } from "undici";
import { curatorDispatcher } from "./curator-transport.mjs";
import { sha256 } from "../src/agent-contract.mjs";
const records = [];
for (const name of ["yoyo-x402-weather", "yoyo-x402-minicurator", "yoyo-x402-cloud-curator"]) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${name}/deployments`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, dispatcher: curatorDispatcher, signal: AbortSignal.timeout(45000) });
  const body = await response.json(); if (!response.ok || !body.success) throw new Error(`Cloudflare read HTTP ${response.status}`);
  const active = body.result.deployments[0]; records.push({ worker: name, deploymentId: active.id, versions: active.versions });
}
const result = { at: new Date().toISOString(), deployments: records, sourceHash: sha256(readFileSync("src/agent-job.mjs")), configHash: sha256(readFileSync("wrangler.agent.jsonc")) };
writeFileSync("evidence/phase2b/deployment.json", JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
