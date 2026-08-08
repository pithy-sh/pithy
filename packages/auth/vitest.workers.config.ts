import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 — the app database auth's tables live
 * in — and a real `SECRETS` D1 beside it.
 *
 * The second one is not scaffolding. Every secret auth reads is a `d1` entry, so it comes from an
 * encrypted row here exactly as in a deployed worker (#153): its own database, its own master key,
 * never a plaintext binding. `seedSecrets` writes the rows and `devEncryptionKeys` mints the key.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "SECRETS"],
        bindings: { SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
