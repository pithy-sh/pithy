import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { devEncryptionKeys } from "@pithy-sh/secrets/src/test-utils/devEncryptionKeys";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 — the app database auth's tables live
 * in — and a real `SECRETS` D1 beside it.
 *
 * The second one is not scaffolding. Every secret auth reads is a `d1` entry, so it comes from an
 * encrypted row here exactly as in a deployed worker (#153): its own database, its own master key,
 * never a plaintext binding. `seedSecrets` writes the rows and `devEncryptionKeys` mints the key.
 *
 * ## `unhandled_rejection_after_microtask_checkpoint`, now carried by the date (#385, #388)
 *
 * Before workerd's 2026-03-03 behaviour change, an `async` function that **returned** a rejected
 * promise instead of awaiting it fired `unhandledrejection` even when the caller awaited the result and
 * caught it. Nothing was unhandled; the check simply ran before the adoption job that attaches the
 * handler. Better Auth's `runWithEndpointContext` and `runWithRequestState` are exactly that shape, so
 * every endpoint that refuses — `sign-in/social` for a provider the instance does not hold, above all —
 * left two phantom rejections behind, and vitest counted them against the run. #381 gave up a live
 * assertion to avoid them.
 *
 * #385 named the flag here rather than moving the date, so that one behaviour was adopted on its own
 * and said which, and wrote down that the entry would become redundant when the date moved. **It has,
 * and it is: {@link COMPATIBILITY_DATE} is 2026-06-01, three months past the date the flag is default-on
 * from, so the flag is gone from the list below rather than left as a line nobody can date.**
 *
 * **That removal is the check, not a tidy-up.** A compatibility date that had not really taken effect
 * would show as this suite going red the moment the explicit flag stopped propping it up. It stayed
 * green — 14 files, 145 tests, no rejection counted — and the control was run the other way too:
 * with the flag removed and the date set to 2026-03-02, the phantom rejections come straight back.
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
