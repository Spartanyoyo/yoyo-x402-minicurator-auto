import documentation from "../docs/F-02_weather-service.md";
import { createApp } from "./app.mjs";

export default {
  fetch(request, env, context) {
    // The SDK starts asynchronous initialization; keep it in the current request.
    const app = createApp({ seller: env.SELLER_ADDRESS, documentation });
    return app.fetch(request, env, context);
  },
};
