import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import type { VectorConfig } from "../config/config";
import { assertProvisionedMetadataIndexes, readProvisionRecord } from "../index/provisioned";

/**
 * The boot check, as middleware: compare the filterable fields this config declares against what
 * `pithy vector provision` last observed, and refuse to serve if they disagree.
 *
 * **Why middleware and not the `compose` hook.** `compose` is the obvious home — it fires once when
 * `createBackend` assembles the backend — but it is handed the composed capabilities and nothing else,
 * because in Workers there *is* no `env` at assembly. Bindings and vars arrive per request. The record lives
 * in a var, so the earliest moment it can be read is the first request. That is exactly why core's own
 * `validateBindings` runs there too, memoized, rather than at module load: "in Workers `env` is per-request,
 * so there is no env to check until a request arrives." First request is what boot means here.
 *
 * **It gates every route, not just the vector ones.** Same precedent, same reasoning: a missing binding fails
 * the whole app rather than the capability that needed it, because a Worker deployed against the wrong
 * configuration should be unmistakably broken, not subtly wrong. `GET /health` is registered before any
 * capability middleware and answers without reaching this, so an orchestrator's health probe still gets a
 * response — the deploy fails on real traffic, where a human is reading the error.
 *
 * The result is memoized only on success. A failure leaves the check armed, so it re-runs and re-throws on
 * the next request instead of collapsing into a bare 500 with no explanation.
 */
export function provisionGuard(config: VectorConfig): PithyMiddleware {
  let verified = false;
  return (app) => {
    app.use("*", async (c, next) => {
      if (!verified) {
        assertProvisionedMetadataIndexes(config, readProvisionRecord(c.env as Record<string, unknown>));
        verified = true;
      }
      await next();
    });
  };
}
