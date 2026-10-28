import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.mjs";

const documentation = readFileSync(new URL("../docs/F-02_weather-service.md", import.meta.url), "utf8");
const app = createApp({ seller: process.env.SELLER_ADDRESS, documentation });
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4021) });
console.log("Weather service listening on http://127.0.0.1:" + (process.env.PORT ?? 4021));
