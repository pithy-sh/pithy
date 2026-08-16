import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks. The claim the
 * whole capability rests on can only be proved against live D1: one provider transaction is one row
 * forever (`UNIQUE (rail, providerTransactionId)`), an event staler than the row it would update changes
 * nothing (the monotonic guard is a SQL predicate, not a JS comparison), and the entitlement read model
 * is re-derived inside the same `DB.batch` as the purchase write, so the two can never disagree. A mock
 * would assert the code we wrote; D1 asserts the constraints.
 *
 * The provider credential bundle is a `d1` secret, so it is read from an encrypted row — here as in a
 * deployed worker (#153). That needs the dedicated `SECRETS` database and a master key, exactly as a
 * project composing `secrets` has; `seedSecrets` writes the row and `devEncryptionKeys` mints the key.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "SECRETS"],
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
