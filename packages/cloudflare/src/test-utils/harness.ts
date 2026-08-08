// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { fitSegment, kebab, MAX_RESOURCE_NAME, RESERVED_TEST_PREFIX } from "@pithy-sh/core/src/naming/resource";
import { CloudflareClients } from "../client/clients";
import { loadCloudflareEnv } from "../env/devVars";
import { R2Credentials } from "../r2/r2Credentials";

/**
 * Shared scaffolding for the package's `*.integration.test.ts` live suites. Every live test does the
 * same three things — find credentials, create a throwaway resource, and guarantee it is torn down —
 * so that logic lives here once instead of being re-derived per manager. Generalized from the D1
 * provisioner's first live test; see `README.md` § "Live integration tests" for the template.
 */

/**
 * **This** package's root, whichever package's live suite is running — `@pithy-sh/storage` imports this
 * harness, so its credentials come from `packages/cloudflare/.dev.vars` too, and a `.dev.vars` beside the
 * importing package is read by nothing. See `README.md` § "Live integration tests".
 *
 * Nothing creates that file. It was a symlink to the repository root's, wired by a `vars:local` task that
 * #154 deleted along with every other `.dev.vars` link, and generation does not replace it here: `apps/`
 * is the registry, so `pithy dev` and `pithy seed` reach an adopter's Workers and never a kit package.
 * Write it by hand, or export the keys — {@link loadCloudflareEnv} overlays `process.env` per key for
 * anything the file does not set, which is how CI runs with no file at all.
 */
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

/**
 * The project name a live test provisions under, so that names composed by the *product's* provisioners —
 * `<project>-<env>-<thing>`, where the project segment is verbatim and first — land inside the reservation
 * too. A live test of `pithy feature provision` cannot route through {@link uniqueName}: the names are the
 * thing under test. Giving it a reserved project puts them in the namespace anyway.
 *
 * The reservation itself is {@link RESERVED_TEST_PREFIX}, in `@pithy-sh/core`. It lives beside the name
 * composer because both sides of it are naming facts: this harness mints inside it, and `scaffoldProject`
 * refuses to mint a project that would land in it. One literal, or the two drift apart.
 */
export const RESERVED_TEST_PROJECT = `${RESERVED_TEST_PREFIX}test`;

/** Deduplicates names minted within one test file; the random suffix covers the cross-file case. */
let nameCounter = 0;

/**
 * Mint a collision-proof name for a throwaway live resource:
 * `pithy-int-<label>-<timestamp>-<counter>-<rand>`.
 *
 * The caller supplies only the distinguishing part — {@link RESERVED_TEST_PREFIX} is composed on, never
 * passed in. That is the point: when the prefix was a *default* a caller could override, a suite could
 * silently create resources under a name the reaper does not recognise, which is exactly how orphans
 * came to sit on a real account. A label that already carries the prefix is refused rather than doubled.
 *
 * The 6-char random suffix guarantees uniqueness across separate test files (Vitest isolates each file, so
 * the counter only deduplicates within one); the timestamp is what {@link testResourceAge} reads, so every
 * name this mints is reapable by construction. The label is kebabbed and fitted, so the result always
 * stays inside R2's {@link MAX_RESOURCE_NAME} cap and the lowercase `a-z0-9-` charset every CF namespace
 * accepts, whatever the caller passed.
 */
export function uniqueName(label: string): string {
  const segment = kebab(label);
  if (!segment) {
    throw new ValidationError({
      message: "A throwaway resource needs a label.",
      action: "Pass a short label, e.g. uniqueName('kv').",
      detail: `uniqueName received ${JSON.stringify(label)}, which kebabs to nothing.`,
    });
  }
  if (segment.startsWith(RESERVED_TEST_PREFIX)) {
    throw new ValidationError({
      message: `A throwaway label must not repeat the reserved "${RESERVED_TEST_PREFIX}" prefix.`,
      action: `Pass only the distinguishing part, e.g. uniqueName('${segment.slice(RESERVED_TEST_PREFIX.length) || "kv"}').`,
      detail: `uniqueName composes ${RESERVED_TEST_PREFIX} itself; ${JSON.stringify(label)} would double it.`,
    });
  }

  nameCounter += 1;
  // `Math.random()` can produce a short base-36 string, and a name must never end on a hyphen.
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const suffix = `-${Date.now()}-${nameCounter}-${rand}`;
  const budget = MAX_RESOURCE_NAME - RESERVED_TEST_PREFIX.length - suffix.length;
  return `${RESERVED_TEST_PREFIX}${fitSegment(segment, budget)}${suffix}`;
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

/**
 * Create a live resource **at a name the caller already chose**, exercise it, and guarantee teardown —
 * including when `create` itself rejects.
 *
 * {@link withThrowawayResource} runs `create` outside the `try` on purpose: for a kind whose id only
 * exists once creation succeeds, tearing down a failed create would be tearing down nothing. But a whole
 * family of Cloudflare calls are **named writes** — `putSecret(name, …)`, `createBucket(name)`,
 * `createDatabase(name)`, `createWorker(name)` — where the address is the caller's own argument. There a
 * rejection is ambiguous: the server may have accepted the write and failed on the way back, and the
 * resource now exists under a name the test is still holding. `withThrowawayResource` walks away from it.
 *
 * This variant tears down on the **name**, and arms the teardown before `create` is ever called, so the
 * ambiguous case cleans up. `teardown` must therefore tolerate a resource that was never created — every
 * caller here passes an idempotent delete, and the reaper is the backstop if one is not.
 */
export async function withNamedResource<T>(
  name: string,
  create: (name: string) => Promise<unknown>,
  exercise: (name: string) => Promise<T>,
  teardown: (name: string) => Promise<void>,
): Promise<T> {
  try {
    await create(name);
    return await exercise(name);
  } finally {
    await teardown(name);
  }
}

/**
 * How old a resource must be before a reaper will remove it.
 *
 * **Twelve hours, and the size is the safety argument.** Reaping is a race with any suite that is still
 * running: a resource deleted mid-flight surfaces as an unexplained 404 in a test that was passing, which
 * is a far worse failure than debris. Cloudflare offers no way to mark a D1, KV namespace, bucket, or
 * index as owned by a live process — no lease, no tag our client can set on every kind — so the only
 * defence available is a window nothing plausible can cross.
 *
 * A single live test is capped at 120s and a hook at 120s (`vitest.integration.config.ts`); a whole
 * package's suite is minutes, and every package's suites together are well under an hour even when
 * Vectorize is settling. Twelve hours is two orders of magnitude past that, and still short enough that
 * debris never survives a day. The cost of the wider window is a handful of orphans lingering longer;
 * the cost of the narrower one is a green suite turned red by its own housekeeping.
 */
export const DEFAULT_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * The ms-epoch {@link uniqueName} embedded, or `null` if this is not one of our names.
 *
 * `uniqueName` composes `pithy-int-<label>-<epoch>-<counter>-<rand>`, so the timestamp is the third
 * segment from the end. Anything that does not match that shape returns `null` and is therefore never
 * reaped — including a name inside the reservation that some *other* generator produced, such as a
 * feature resource provisioned under {@link RESERVED_TEST_PROJECT}. Conservative on purpose: failing to
 * clean up costs pennies, deleting someone's data does not.
 */
export function testResourceAge(name: string, now: number): number | null {
  if (!name.startsWith(RESERVED_TEST_PREFIX)) return null;
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

/**
 * An S3 client for the account's R2, built from the harness's own key pair.
 *
 * **R2 is the one kind the API token cannot reap.** Cloudflare refuses to delete a non-empty bucket, and
 * emptying one is an S3-protocol operation — `ListObjectsV2`, `DeleteObject`, `AbortMultipartUpload` —
 * that the REST API does not offer and a scoped API token cannot authenticate. So the harness holds the
 * S3 credentials itself: {@link IntegrationCreds.r2}, parsed from `R2_CREDENTIALS`, is what makes a
 * throwaway bucket reclaimable at all.
 *
 * Raw S3 rather than `CloudflareR2Manager` on purpose. This is teardown, and teardown must not depend on
 * the code under test: if `emptyBucket` is the thing that broke, the bucket still has to come back empty
 * or a failing test leaks a real resource instead of reporting a bug.
 */
function testS3(creds: IntegrationCreds): S3Client {
  if (!creds.r2) {
    throw new ValidationError({
      message: "Emptying an R2 bucket needs the S3 key pair.",
      action: "Set R2_CREDENTIALS in .dev.vars, or gate the suite on `creds.r2`.",
      detail: "R2 refuses to delete a non-empty bucket, and draining one is an S3 operation, not a REST one.",
    });
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: creds.r2.accessKeyId, secretAccessKey: creds.r2.secretAccessKey },
  });
}

/**
 * Empty a throwaway bucket so R2 will delete it.
 *
 * Two things hold a bucket against deletion: stored objects, and the parts of a multipart upload that was
 * never completed or aborted — precisely what a test that failed mid-upload leaves behind. Both are
 * cleared, dangling uploads first. Every page is drained, so a bucket with more than a thousand keys is
 * emptied rather than half-emptied.
 *
 * Throws when the S3 key pair is absent: a bucket that cannot be emptied cannot be deleted, and silence
 * there is how debris becomes permanent.
 */
export async function emptyTestBucket(creds: IntegrationCreds, bucketName: string): Promise<void> {
  const s3 = testS3(creds);
  const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
  for (const upload of uploads.Uploads ?? []) {
    if (!upload.Key || !upload.UploadId) continue;
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: upload.Key, UploadId: upload.UploadId }));
  }

  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token }));
    for (const entry of page.Contents ?? []) {
      if (entry.Key) await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: entry.Key }));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Reclaim stale throwaway R2 buckets — the one kind that needs more than an API token, so it lives here
 * once instead of being re-derived by every suite that makes a bucket.
 *
 * Without `R2_CREDENTIALS` this reaps nothing and says so loudly rather than failing quietly: the buckets
 * are still there, still cost money, and the only fix is the key pair. Never throws — a reaper must not
 * fail the suite it is trying to help.
 */
export async function reapStaleTestBuckets(
  creds: IntegrationCreds,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<{ reaped: string[]; failed: string[] }> {
  if (!creds.r2) {
    console.warn("no R2_CREDENTIALS: stale pithy-int- buckets cannot be emptied, so none were reaped.");
    return { reaped: [], failed: [] };
  }

  const provisioner = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken }).r2Provisioner();
  return reapStaleTestResources(
    {
      label: "R2 bucket",
      list: async () => (await provisioner.listBuckets()).map((bucket) => bucket.name),
      remove: async (name) => {
        await emptyTestBucket(creds, name);
        await provisioner.deleteBucket(name);
      },
    },
    options,
  );
}
