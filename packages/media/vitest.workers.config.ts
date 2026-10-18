import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real D1 binding — the same `DB` database the
 * `pithy_media_*` tables live in. The Cloudflare REST calls (direct-upload minting, signing, Workers AI)
 * are exercised against injected fakes so the storage and enrichment paths are deterministic without a
 * real account, while D1 reads and writes hit the live Miniflare binding.
 *
 * One suite composes the capability whole (#728): an R2-only project served through `createBackend`, every
 * route on its default resolvers. That reads its R2 bundle from an encrypted row and presigns against a
 * real bucket binding, so the `SECRETS` database, a master key and `MEDIA_BUCKET` are here as a deployed
 * Worker binds them.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "SECRETS"],
        r2Buckets: ["MEDIA_BUCKET"],
        bindings: { SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },
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
