// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloudflareEnv } from "../env/devVars";
import { R2Credentials } from "../r2/r2Credentials";

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
  /** R2 S3 keys (from `R2_CREDENTIALS` JSON), for the R2 presigned-URL test. Null when unset. */
  r2: R2Credentials | null;
  /** True only when both an account id and a token are present — the gate for `describe.skipIf`. */
  hasCreds: boolean;
}

/**
 * Parse the `R2_CREDENTIALS` JSON blob through the canonical {@link R2Credentials} schema — the same
 * object the R2 storage feature manages as a JSON payload, so the harness and the feature validate it
 * identically. Returns null when unset (the R2 suite then skips); a set-but-malformed/invalid blob
 * fails `.parse()` and throws, surfacing the misconfiguration loudly rather than silently skipping.
 */
export function parseR2Creds(raw: string | undefined): R2Credentials | null {
  if (!raw) return null;
  return R2Credentials.parse(JSON.parse(raw));
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
    r2: parseR2Creds(vars.R2_CREDENTIALS),
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

/** The marker every throwaway name carries, so a reaper can tell test debris from a real resource. */
const TEST_RESOURCE_PREFIX = "pithy-int-";

/**
 * How old a resource must be before a reaper will remove it. An hour is far longer than any suite runs,
 * so a reaper can never delete a resource a concurrent run is still using — the property that makes
 * automatic reaping safe rather than a race.
 */
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * The ms-epoch {@link uniqueName} embedded, or `null` if this is not one of our names.
 *
 * `uniqueName` composes `<prefix>-<epoch>-<counter>-<rand>`, so the timestamp is the third segment from
 * the end. Anything that does not match that shape — including a real resource that happens to start
 * with the prefix — returns `null` and is therefore never reaped. Conservative on purpose: failing to
 * clean up costs pennies, deleting someone's data does not.
 */
export function testResourceAge(name: string, now: number): number | null {
  if (!name.startsWith(TEST_RESOURCE_PREFIX)) return null;
  const segments = name.split("-");
  if (segments.length < 3) return null;
  const stamp = Number(segments[segments.length - 3]);
  if (!Number.isInteger(stamp) || stamp <= 0 || stamp > now) return null;
  return now - stamp;
}

/**
 * Which of these names are stale test debris — ours, and old enough that no running suite owns them.
 *
 * Pure, so the age arithmetic is unit-tested without touching Cloudflare.
 */
export function staleTestResourceNames(
  names: readonly string[],
  options: { now?: number; staleAfterMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return names.filter((name) => {
    const age = testResourceAge(name, now);
    return age !== null && age >= staleAfterMs;
  });
}

/** One reapable resource kind: what it is called, how to list it, and how to remove one. */
export interface ReapableKind {
  /** Human label for the reap log, e.g. "Vectorize index". */
  label: string;
  /** Every resource name of this kind currently in the account. */
  list: () => Promise<string[]>;
  /** Remove one by name. Must be idempotent — another runner may have reaped it first. */
  remove: (name: string) => Promise<void>;
}

/**
 * Remove stale throwaway resources of one kind, and report what went.
 *
 * `withThrowawayResource` guarantees teardown only while the process lives. A run killed by a test
 * timeout, a Ctrl-C, or a crash orphans whatever it had created — which is exactly how two Vectorize
 * indexes came to sit on a real account for a month. Calling this in a suite's `beforeAll` makes each
 * run clean up after the last one, so the failure mode self-heals instead of accumulating.
 *
 * Never throws: a reaper that fails must not fail the suite it is trying to help. Failures are reported
 * in the returned list of what could not be removed.
 */
export async function reapStaleTestResources(
  kind: ReapableKind,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<{ reaped: string[]; failed: string[] }> {
  const reaped: string[] = [];
  const failed: string[] = [];
  let names: string[];
  try {
    names = await kind.list();
  } catch {
    return { reaped, failed };
  }

  for (const name of staleTestResourceNames(names, options)) {
    try {
      await kind.remove(name);
      reaped.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (reaped.length > 0) console.warn(`reaped ${reaped.length} stale ${kind.label}(s): ${reaped.join(", ")}`);
  if (failed.length > 0) console.warn(`could not reap ${failed.length} stale ${kind.label}(s): ${failed.join(", ")}`);
  return { reaped, failed };
}
