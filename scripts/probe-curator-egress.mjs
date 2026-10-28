import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { upstreamProbes, validProbePayload } from "./curator-egress-worker.mjs";
import { curatorFetch } from "./curator-transport.mjs";

const repair = process.argv.includes("--repair");
const base = new URL(process.argv.slice(2).find(v => !v.startsWith("--")) ?? "https://yoyo-minicurator-egress.accessible-trip.workers.dev");
mkdirSync("evidence/phase2a", { recursive: true });
const file = "evidence/phase2a/cloudflare-egress-2026-10-25.json";
const record = repair ? JSON.parse(readFileSync(file, "utf8")) : { startedAt: new Date().toISOString(), baseUrl: base.origin, scope: "Real Cloudflare Workers outbound fetches; no payment", rounds: 2, records: [] };
const save = () => writeFileSync(file, `${JSON.stringify(record, (key, value) => key === "error" && typeof value === "string" ? value.replace(/'[A-Za-z]:\\[^']*'/g, "'[local temporary path]'") : value, 2)}\n`);
for (let round = 1; round <= record.rounds; round++) {
  for (const service of Object.keys(upstreamProbes)) {
    const previous = repair ? record.records.find(v => v.round === round && v.service === service) : null;
    if (previous?.clientValidated) continue;
    if (previous?.previousAttempts?.length) throw new Error("Read-only repair was already attempted; inspect the saved evidence");
    const index = previous ? record.records.indexOf(previous) : record.records.length;
    const history = previous ? [{ error: previous.error, status: previous.status, validPayload: previous.validPayload, at: previous.startedAt ?? record.startedAt }] : [];
    try {
      const response = await curatorFetch(new URL(`/probe/${service}`, base), { redirect: "error", signal: AbortSignal.timeout(35000) });
      if (!response.ok) throw new Error(`Probe Worker HTTP ${response.status}`);
      const probe = await response.json();
      probe.clientValidated = probe.environment === "Cloudflare Workers" && probe.upstream === upstreamProbes[service] && probe.status === 200 && validProbePayload(service, probe.body);
      record.records[index] = { round, ...probe, ...(history.length ? { previousAttempts: history } : {}) };
      console.log(JSON.stringify({ round, service, status: probe.status, valid: probe.clientValidated, durationMs: probe.durationMs, error: probe.error }));
    } catch (error) {
      record.records[index] = { round, service, clientValidated: false, error: error.message, ...(history.length ? { previousAttempts: history } : {}) };
      console.log(JSON.stringify({ round, service, error: error.message }));
    }
    save();
  }
}
record.completedAt = new Date().toISOString();
record.passed = record.records.length === 18 && record.records.every(v => v.clientValidated);
save();
console.log(JSON.stringify({ evidence: file, passed: record.passed, succeeded: record.records.filter(v => v.clientValidated).length, total: record.records.length }));
if (!record.passed) process.exitCode = 1;
