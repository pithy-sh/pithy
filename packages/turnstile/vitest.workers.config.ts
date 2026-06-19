import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run the `turnstile()` middleware inside Miniflare, where its `fetch` to
 * Cloudflare's live siteverify endpoint behaves as it does in production. The `TURNSTILE_SECRET_KEY`
 * binding is set to one of Cloudflare's documented test secrets per test, so the positive, negative,
 * and challenge paths are deterministic without a real widget.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: { name: "workers", include: ["src/**/*.workers.test.ts"] },
});
