import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real D1 `DB` (the `pithy_consent_*` tables), a real R2
 * `CONSENT_EVIDENCE` bucket (drawn signatures and providers' certificates, by hash), and a field key, so the
 * typed and representative names are sealed and opened for real. The append-only triggers, the merge and the
 * evidence are asserted on real rows and real objects, never mocked.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["CONSENT_EVIDENCE"],
        bindings: {
          // A test key set in the field-key format: one version, 32 random bytes. Never a real key.
          PITHY_FIELD_KEYS: JSON.stringify({
            currentVersion: "1",
            versions: { "1": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=" },
            lastRotatedAt: "2026-10-01T00:00:00.000Z",
          }),
        },
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
    setupFiles: [WORKERS_ENV_SETUP],
  },
});
