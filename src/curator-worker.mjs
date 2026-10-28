import documentation from "../docs/F-02_minicurator.md";
import { createCuratorApp } from "./curator-app.mjs";

export default {
  fetch(request, env, context) {
    // Request-scoped SDK initialization preserves Cloudflare I/O ownership.
    const app = createCuratorApp({ seller: env.SELLER_ADDRESS, documentation });
    return app.fetch(request, { ...env, CATALOG_CACHE: caches.default }, context);
  },
};
