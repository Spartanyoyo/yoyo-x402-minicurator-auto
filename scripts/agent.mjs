import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { fetch as apiFetch } from "undici";
import { curatorDispatcher, curlFetch } from "./curator-transport.mjs";
import { chainClient } from "./chain.mjs";
import { submitCloudJob, getCloudJob } from "./agent-client.mjs";
import { publicEvidence } from "../src/agent-evidence.mjs";
const args = process.argv.slice(2); const mode = args[0] ?? "status";
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const fetcher = async request => {
  try { return await apiFetch(request.url, { method: request.method, headers: request.headers, ...(request.method === "POST" ? { body: await request.clone().text() } : {}), redirect: "error", signal: request.signal, ...(curatorDispatcher ? { dispatcher: curatorDispatcher } : {}) }); }
  catch (error) { if (request.method === "GET") return curlFetch(request); throw error; }
};
mkdirSync("private/phase2b/jobs", { recursive: true }); mkdirSync("evidence/phase2b", { recursive: true }); mkdirSync("local-only/phase2b", { recursive: true });
const persist = (path, data) => writeFileSync(path, JSON.stringify(path.startsWith("evidence/") ? publicEvidence(data) : data, null, 2) + "\n");
let state;
if (mode === "run" || mode === "submit") {
  const goal = option("--goal"); if (!goal) throw new Error("--goal is required");
  const submitted = await submitCloudJob({ goal, budgetAtomic: option("--budget") ?? "9000", baseUrl: process.env.AGENT_SERVER_URL, buyer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY), rpc: chainClient(), fetcher, savePrivate: value => persist(`private/phase2b/jobs/${value.id}.json`, value), savePublic: value => persist(`evidence/phase2b/acceptance-${value.jobId}.json`, value) });
  state = submitted.privateState;
  console.log(JSON.stringify({ jobId: state.id, acceptance: submitted.record.status, error: submitted.record.error }));
  if (mode === "submit" || submitted.record.status !== "verified") process.exit(submitted.record.status === "verified" ? 0 : 2);
} else {
  const id = option("--id"); if (!/^[a-f0-9]{64}$/.test(id ?? "")) throw new Error("--id must be a saved job identifier");
  state = JSON.parse(readFileSync(`private/phase2b/jobs/${id}.json`, "utf8"));
}
let previous;
for (let attempt = 0; attempt < 180; attempt++) {
  const result = await getCloudJob(state, { fetcher, reconcile: mode === "reconcile" && attempt === 0 });
  persist(`evidence/phase2b/job-${state.id}.json`, result);
  const status = `${result.status}:${result.calls?.length ?? 0}`;
  if (status !== previous) console.log(JSON.stringify({ jobId: state.id, status: result.status, calls: result.calls?.length, error: result.error }));
  previous = status;
  if (result.status === "complete") {
    writeFileSync(`local-only/phase2b/exhibition-${state.id}.md`, result.delivery.reportMarkdown);
    console.log(JSON.stringify({ completed: true, jobId: state.id, upstreamAtomic: result.delivery.totalUpstreamAtomic, reportSha256: result.delivery.reportSha256 })); break;
  }
  if (result.status === "needs_attention") { process.exitCode = 2; break; }
  if (!["run", "wait", "reconcile"].includes(mode)) break;
  if (attempt === 179) { console.log("Polling limit reached; saved job can be resumed with wait --id"); process.exitCode = 2; break; }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
