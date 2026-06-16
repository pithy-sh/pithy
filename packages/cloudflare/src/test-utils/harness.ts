import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloudflareEnv } from "../env/devVars";

/**
 * Shared scaffolding for the package's `*.integration.test.ts` live suites. Every live test does the
 * same three things — find credentials, create a throwaway resource, and guarantee it is torn down —
 * so that logic lives here once instead of being re-derived per manager. Generalized from the D1
 * provisioner's first live test; see `README.md` § "Live integration tests" for the template.
 */

/** The package root, where `.dev.vars` is symlinked by `bun run vars:local` (CI overlays `process.env`). */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Cloudflare credentials for a live run, plus whether enough of them are present to run at all. */
export interface IntegrationCreds {
  /** The target account id (`CLOUDFLARE_ACCOUNT_ID`). Empty string when unset. */
  accountId: string;
  /** The scoped API token (`CLOUDFLARE_API_TOKEN`). Empty string when unset. */
  apiToken: string;
  /** The Secrets Store id (`SECRETS_STORE_ID`), for the secrets-store live test. Empty string when unset. */
  secretsStoreId: string;
  /** True only when both an account id and a token are present — the gate for `describe.skipIf`. */
  hasCreds: boolean;
}

/**
 * Load the live-CF credentials a `*.integration.test.ts` needs, reading the package `.dev.vars` and
 * overlaying `process.env` (the loader's own fallback, so CI passes them as plain env vars). Gate the
 * suite with `describe.skipIf(!loadIntegrationCreds().hasCreds)` so it skips cleanly with no creds.
 */
export function loadIntegrationCreds(): IntegrationCreds {
  const vars = loadCloudflareEnv(PACKAGE_ROOT);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  return {
    accountId,
    apiToken,
    secretsStoreId: vars.SECRETS_STORE_ID ?? "",
    hasCreds: Boolean(accountId && apiToken),
  };
}

/** A unique, account-safe resource name — `<prefix>-<timestamp>-<n>-<rand>`, lowercase `a-z0-9-` only. */
let nameCounter = 0;

/**
 * Mint a collision-proof name for a throwaway live resource: `<prefix>-<timestamp>-<n>-<rand>`. The
 * 6-char random suffix is what guarantees uniqueness across separate test files (Vitest isolates each
 * file, so the counter only deduplicates within one); the timestamp and counter keep names readable and
 * ordered. The output stays in the lowercase `a-z0-9-` charset every CF resource name accepts. Keep the
 * `prefix` short — the default lands ~36 chars, well under R2's 63-char cap, but a long custom prefix
 * can exceed a resource's limit. Default prefix marks it as a Pithy integration-test artifact for cleanup.
 */
export function uniqueName(prefix = "pithy-int-test"): string {
  nameCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${nameCounter}-${rand}`;
}

/**
 * Create a live resource, exercise it, and guarantee teardown — even if `exercise` throws. This is the
 * spine of every live integration test: a failed assertion must never orphan a real Cloudflare resource.
 * `create` runs outside the `try`, so a creation failure does not call `teardown` on something that was
 * never created; once `create` resolves, `teardown` always runs in the `finally`. The exercise result is
 * returned for the rare caller that wants it.
 */
export async function withThrowawayResource<R, T>(
  create: () => Promise<R>,
  exercise: (resource: R) => Promise<T>,
  teardown: (resource: R) => Promise<void>,
): Promise<T> {
  const resource = await create();
  try {
    return await exercise(resource);
  } finally {
    await teardown(resource);
  }
}
