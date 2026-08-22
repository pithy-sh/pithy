import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run the `turnstile()` middleware inside Miniflare, where its `fetch` to
 * Cloudflare's live siteverify endpoint behaves as it does in production. The widget secret is one of
 * Cloudflare's documented test secrets per case, so the positive, negative, and challenge paths are
 * deterministic without a real widget.
 *
 * The secret is a `d1` entry, so it is read from an encrypted row — here as in a deployed worker
 * (#153). That needs the dedicated `SECRETS` database and a master key, exactly as a project composing
 * `secrets` has; `seedSecrets` writes the row and `devEncryptionKeys` mints the key.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
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
    setupFiles: [WORKERS_ENV_SETUP],
  },
});
