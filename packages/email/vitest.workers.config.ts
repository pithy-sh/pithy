import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run against Miniflare with a real D1 `DB` binding — the same database the
 * three email tables (`pithy_email_jobs`, `pithy_email_events`, `pithy_email_suppressions`) live in.
 * The `send_email` binding is not simulated here: send tests inject a fake `EmailSender` so the
 * outcome is deterministic, while D1 reads/writes hit the live Miniflare database.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "EMAIL_SUPPRESSIONS"],
      },
    }),
  ],
  test: { name: "workers", include: ["src/**/*.workers.test.ts"] },
});
