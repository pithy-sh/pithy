import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { UNIT_BUDGETS } from "../../vitest.shared";
// A fresh AES-256 master-key config for the test run, provided to Miniflare as the
// `SECRETS_ENCRYPTION_KEYS` binding — the same string shape `.dev.vars` supplies in local dev. This
// is why read/write/at-rest-rotation are all testable locally: the worker resolves its encryption
// config from this binding, no live CF Secrets Store needed. Shared with every other package that
// seeds a secret, so there is one definition of a test master key rather than one per suite.
import { devEncryptionKeys } from "./src/test-utils/devEncryptionKeys";

// Workers-runtime project: tests run inside workerd via Miniflare with a real D1 `SECRETS` binding
// (the dedicated secrets database, separate from any app `DB`) and the `SECRETS_ENCRYPTION_KEYS`
// string binding. Only `*.workers.test.ts` run here. Test bindings are typed in `src/cloudflare-test.d.ts`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["SECRETS"],
        bindings: { SECRETS_ENCRYPTION_KEYS: devEncryptionKeys() },
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
