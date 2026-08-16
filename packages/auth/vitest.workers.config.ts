import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 — the app database auth's tables live
 * in — and a real `SECRETS` D1 beside it.
 *
 * The second one is not scaffolding. Every secret auth reads is a `d1` entry, so it comes from an
 * encrypted row here exactly as in a deployed worker (#153): its own database, its own master key,
 * never a plaintext binding. `seedSecrets` writes the rows and `devEncryptionKeys` mints the key.
 *
 * ## `unhandled_rejection_after_microtask_checkpoint`, and why a flag rather than a date (#385)
 *
 * Before workerd's 2026-03-03 behaviour change, an `async` function that **returned** a rejected
 * promise instead of awaiting it fired `unhandledrejection` even when the caller awaited the result and
 * caught it. Nothing was unhandled; the check simply ran before the adoption job that attaches the
 * handler. Better Auth's `runWithEndpointContext` and `runWithRequestState` are exactly that shape, so
 * every endpoint that refuses — `sign-in/social` for a provider the instance does not hold, above all —
 * left two phantom rejections behind, and vitest counted them against the run. #381 gave up a live
 * assertion to avoid them.
 *
 * **This is not a workaround, and there is nothing here to remove when something lands upstream.** The
 * flag names a workerd fix that is already shipped and already default-on from compatibility date
 * 2026-03-03. `pithy init` scaffolds adopters at `2026-06-01` and `workersManager` defaults to
 * `2026-04-07`, so a deployed Pithy Worker has had the fixed behaviour all along — this suite was the
 * only place still running the old one, fifteen months behind the runtime it is evidence about.
 *
 * **The flag rather than a newer `compatibilityDate`, deliberately.** Moving the date adopts every other
 * behaviour change in those fifteen months at the same time, in one commit, with auth's evidence riding
 * on it. The flag adopts exactly the one behaviour this suite was wrong about, and says which. When the
 * date does move, this entry becomes redundant rather than wrong.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat", "unhandled_rejection_after_microtask_checkpoint"],
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
