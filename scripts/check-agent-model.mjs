import { curatorDispatcher } from "./curator-transport.mjs";
import { fetch } from "undici";
const response = await fetch(`${process.env.AGENT_LLM_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.AGENT_LLM_API_KEY}` }, ...(curatorDispatcher ? { dispatcher: curatorDispatcher } : {}), signal: AbortSignal.timeout(30000) });
const body = await response.json();
console.log(JSON.stringify({ status: response.status, models: body.data?.map(item => item.id), errorCode: body.error?.code }));
