import { readFileSync, writeFileSync } from "node:fs";
import { reconcilePurchase } from "./reconcile.mjs";

const file = process.argv[2];
if (!file) throw new Error("Pass an existing purchase evidence JSON; this command is read-only on chain");
const record = JSON.parse(readFileSync(file, "utf8"));
try {
  record.reconciliation = await reconcilePurchase(record);
  if (record.reconciliation.signed && record.reconciliation.safeToRetry) {
    record.reconciliation.previousStatus = record.status;
    record.status = "not_charged_reconciled";
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: file, status: record.status, reconciliation: record.reconciliation }, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.shortMessage ?? error.message, instruction: "Reconciliation incomplete; do not repeat payment" })); process.exitCode = 1; }
