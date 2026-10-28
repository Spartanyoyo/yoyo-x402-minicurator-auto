import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { purchaseWeather } from "./purchase.mjs";

let evidenceFile;
let purchaseStarted = false;
try {
  const { values } = parseArgs({ options: { "base-url": { type: "string", default: process.env.RESOURCE_SERVER_URL }, latitude: { type: "string" }, longitude: { type: "string" }, intent: { type: "string" } } });
  if (!/^0x[0-9a-f]{64}$/i.test(process.env.EVM_PRIVATE_KEY ?? "")) throw new Error("A valid local EVM_PRIVATE_KEY is required");
  let buyer;
  try { buyer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY); }
  catch { throw new Error("A valid local EVM_PRIVATE_KEY is required"); }
  if (process.env.BUYER_ADDRESS && buyer.address.toLowerCase() !== process.env.BUYER_ADDRESS.toLowerCase()) throw new Error("BUYER_ADDRESS does not match the local signing key");
  mkdirSync("evidence/transactions", { recursive: true });
  const file = `evidence/transactions/purchase-${Date.now()}.json`;
  evidenceFile = file;
  const record = await purchaseWeather({ ...values, baseUrl: values["base-url"], seller: process.env.SELLER_ADDRESS, buyer, save: value => {
    purchaseStarted = true;
    writeFileSync(file, JSON.stringify(value, null, 2));
  } });
  const result = { evidence: file, status: record.status, ...(record.error ? { error: record.error } : {}), weather: record.response?.weather, transaction: record.receipt?.transactionHash, audit: record.audit };
  if (result.transaction) result.explorer = `https://sepolia.basescan.org/tx/${result.transaction}`;
  console.log(JSON.stringify(result, null, 2));
  if (record.status !== "verified") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: purchaseStarted ? "interrupted_check_evidence_before_retry" : "not_started", evidence: purchaseStarted ? evidenceFile : undefined, error: error.message }));
  process.exitCode = 1;
}
