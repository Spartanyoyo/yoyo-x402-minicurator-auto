import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { purchaseCurator } from "./curator-purchase.mjs";
import { curatorFetch } from "./curator-transport.mjs";

let file;
try {
  const { values } = parseArgs({ options: { "base-url": { type: "string", default: process.env.CURATOR_SERVER_URL ?? "https://yoyo-x402-minicurator.accessible-trip.workers.dev" }, service: { type: "string" }, q: { type: "string" }, id: { type: "string" }, limit: { type: "string" }, offset: { type: "string" }, "department-id": { type: "string" }, intent: { type: "string" }, "max-amount-atomic": { type: "string", default: "1000" } } });
  if (!/^0x[0-9a-f]{64}$/i.test(process.env.EVM_PRIVATE_KEY ?? "")) throw new Error("A valid local EVM_PRIVATE_KEY is required");
  const buyer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
  if (process.env.BUYER_ADDRESS && buyer.address.toLowerCase() !== process.env.BUYER_ADDRESS.toLowerCase()) throw new Error("BUYER_ADDRESS does not match the local signing key");
  const parameters = Object.fromEntries(["q", "id", "limit", "offset", "department-id"].filter(key => values[key] !== undefined).map(key => [key === "department-id" ? "departmentId" : key, values[key]]));
  mkdirSync("evidence/phase2a/purchases", { recursive: true });
  file = `evidence/phase2a/purchases/${values.service}-${Date.now()}.json`;
  const record = await purchaseCurator({ baseUrl: values["base-url"], service: values.service, parameters, maxAmountAtomic: values["max-amount-atomic"], intent: values.intent, buyer, seller: process.env.SELLER_ADDRESS, fetcher: curatorFetch, save: value => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`) });
  console.log(JSON.stringify({ evidence: file, status: record.status, service: record.resourceService, resource: record.response?.resource, transaction: record.receipt?.transactionHash, audit: record.audit, error: record.error }, null, 2));
  if (record.status !== "verified") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ evidence: file, error: error.message, instruction: "Inspect saved evidence before another purchase; this command never automatically repeats a paid request" }));
  process.exitCode = 1;
}
