import { readFileSync, writeFileSync } from "node:fs";
import { auditPurchase } from "./chain.mjs";
import { validateCuratorDelivery } from "./curator-purchase.mjs";

const file = process.argv[2];
if (!file) throw new Error("Pass the purchase evidence JSON to audit; this command never sends payments");
const record = JSON.parse(readFileSync(file, "utf8"));
const previousError = record.error;
try {
  await auditPurchase(record, undefined, record.resourceService ? { validateDelivery: validateCuratorDelivery } : {});
  if (previousError && record.status === "verified") { record.auditRecovery = { previousError, recoveredAt: new Date().toISOString() }; delete record.error; }
} catch (error) {
  record.error = error.message;
  process.exitCode = 1;
}
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ evidence: file, status: record.status, transaction: record.receipt?.transactionHash, before: record.before, after: record.after, audit: record.audit, error: record.error, deliveryError: record.deliveryError }, null, 2));
if (record.status !== "verified") process.exitCode = 1;
