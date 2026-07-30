// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { VectorConfig } from "../config/config";
import { VectorMetadataIndexDriftError } from "../error/errors";
import { compareMetadataIndexes } from "./drift";
import { type MetadataIndexDescriptor, metadataIndexes } from "./metadata";

/**
 * The provisioning record — what `pithy vector provision` observed on the live indexes — and the boot check
 * that reads it.
 *
 * The failure being guarded is the one Vectorize refuses to report. Someone marks a metadata field
 * `filterable`, deploys, and never re-runs provision. Every query filtering on that field returns a short,
 * plausible result set, because Cloudflare states it verbatim: *"Vectors upserted before a metadata index was
 * created won't have their metadata contained in that index."* Nothing errors. The bug surfaces weeks later
 * as "search feels wrong". A startup error costs one deploy; that costs trust.
 *
 * **Why a record and not a live call.** Reading an index's metadata indexes is a Cloudflare control-plane
 * call, authorized only by an account API token. Doing it at boot would put a control-plane token on the
 * request path of every search — a strictly worse trade than the bug it catches. So the token stays where it
 * already is: `pithy vector provision` holds it, already compares declared against live, and now **writes
 * down what it saw** as one Zod-validated JSON var ({@link VECTOR_PROVISIONED_VAR}) — the same way
 * `MEDIA_CONFIG` and `EMAIL_THEME` carry structured config into a prebuilt worker. The Worker compares its
 * declared filterable set against that record with no network at all.
 *
 * **Be honest about what this proves.** It proves the config declares nothing that provisioning did not
 * observe *the last time it ran*. It does not prove anything about Cloudflare right now: someone who deletes
 * a metadata index from the dashboard leaves the record stale and this check silent. What it catches is the
 * common, silent case — a schema edited and deployed without re-provisioning — because the record only ever
 * changes when provision runs.
 *
 * **An absent record fails, but only when something is declared filterable.** The two cases are not the same
 * project. A project with no filterable field has nothing that can drift, so it boots — an adopter who has
 * added vector but not provisioned yet still serves every other route. A project that *declares* filterable
 * fields with no record has provably never provisioned, which means the index does not exist either and every
 * filtered search is already wrong. Booting it would serve exactly the silently-partial results this package
 * exists to prevent, so it fails and names the command. Running `pithy vector provision` is the whole fix.
 *
 * A live metadata index the config does not declare is **not** fatal here either. It may predate the config
 * or belong to another consumer of the same index, and refusing to boot over a leftover would be hostile. It
 * costs one of the ten slots, and `pithy vector provision` is where it gets reported.
 */

/**
 * The wrangler var the record travels in. Written per environment by `pithy vector provision`, read off the
 * Worker's env at boot. A var, not a binding: it is plain data, and it must be diffable in `wrangler.jsonc`.
 */
export const VECTOR_PROVISIONED_VAR = "VECTOR_PROVISIONED";

/** One metadata index as provisioning found it on the live Vectorize index. */
export const ObservedMetadataIndex = z
  .object({
    propertyName: z.string().min(1).describe("The metadata property the live index covers."),
    indexType: z
      .string()
      .min(1)
      .describe(
        "The type Vectorize reports the index was created with, recorded verbatim rather than narrowed to the three types this package can declare — a record of an observation must round-trip whatever was observed, including a type only Cloudflare knows about.",
      ),
  })
  .describe("One metadata index `pithy vector provision` observed on a live Vectorize index.");
export type ObservedMetadataIndex = z.infer<typeof ObservedMetadataIndex>;

/** One configured index as provisioning left it: the Vectorize name, and every metadata index it then had. */
export const ProvisionedIndex = z
  .object({
    indexName: z.string().min(1).describe("The Vectorize index name this configured index was provisioned as."),
    metadataIndexes: z
      .array(ObservedMetadataIndex)
      .describe(
        "Every metadata index live on that index when provisioning finished — the declared ones, each waited for until Cloudflare showed it, plus any the config does not declare.",
      ),
  })
  .describe("What `pithy vector provision` last observed for one configured index.");
export type ProvisionedIndex = z.infer<typeof ProvisionedIndex>;

/** The whole record, keyed by the config's index names. The value of the `VECTOR_PROVISIONED` var. */
export const VectorProvisionRecord = z
  .object({
    indexes: z
      .record(z.string(), ProvisionedIndex)
      .describe("Each configured index, keyed by the name used in pithy.config.ts, as provisioning last saw it."),
  })
  .describe("What `pithy vector provision` observed, carried into the Worker so boot can check drift offline.");
export type VectorProvisionRecord = z.infer<typeof VectorProvisionRecord>;

/**
 * Read the record off a Worker env. Absent or blank returns `undefined` — the caller decides what absence
 * means. Present but unreadable **throws**: a record that cannot be parsed cannot be compared against, and
 * treating it as absence would silently downgrade a corrupted record into "never provisioned".
 */
export function readProvisionRecord(env: Record<string, unknown>): VectorProvisionRecord | undefined {
  const raw = env[VECTOR_PROVISIONED_VAR];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    throw new VectorMetadataIndexDriftError(
      {
        message: `The ${VECTOR_PROVISIONED_VAR} var is not valid JSON, so the metadata indexes cannot be checked.`,
        action: `Run \`pithy vector provision --env <env>\` to rewrite ${VECTOR_PROVISIONED_VAR}, then redeploy.`,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      { cause },
    );
  }

  const parsed = VectorProvisionRecord.safeParse(decoded);
  if (!parsed.success) {
    throw new VectorMetadataIndexDriftError({
      message: `The ${VECTOR_PROVISIONED_VAR} var is not a provisioning record, so the metadata indexes cannot be checked.`,
      action: `Run \`pithy vector provision --env <env>\` to rewrite ${VECTOR_PROVISIONED_VAR}, then redeploy.`,
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    });
  }
  return parsed.data;
}

/** Every configured index that declares at least one filterable field, with the descriptors it declares. */
function declaredFilterable(config: VectorConfig): Map<string, MetadataIndexDescriptor[]> {
  const declared = new Map<string, MetadataIndexDescriptor[]>();
  for (const [name, index] of Object.entries(config.indexes)) {
    const fields = index.metadata ? metadataIndexes(index.metadata) : [];
    if (fields.length > 0) declared.set(name, fields);
  }
  return declared;
}

/**
 * Refuse to boot when the config declares a filterable field that provisioning never observed, or observed
 * as a different type. Pure — no network, no token, one comparison of two plain lists.
 *
 * The field names ride in the public `message` rather than in `detail`, for the reason core's
 * `validateBindings` gives for doing the same: they are config keys, not secrets, and this surfaces at
 * startup, where the reader is the operator staring at a 500 and needs to be told which field and which
 * command. `detail` carries the same facts for the log.
 */
export function assertProvisionedMetadataIndexes(
  config: VectorConfig,
  record: VectorProvisionRecord | undefined,
): void {
  const declared = declaredFilterable(config);
  if (declared.size === 0) return;

  if (!record) {
    const fields = [...declared].flatMap(([name, descriptors]) =>
      descriptors.map((descriptor) => `${name}.${descriptor.propertyName}`),
    );
    throw new VectorMetadataIndexDriftError({
      message: `No metadata index has been provisioned for ${fields.join(", ")}, so every filter naming one returns partial results.`,
      action: "Run `pithy vector provision --env <env>`, then redeploy. Re-embed anything written before it.",
      detail: `no ${VECTOR_PROVISIONED_VAR} var on env; declared filterable: ${fields.join(", ")}`,
    });
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [name, descriptors] of declared) {
    // An index absent from the record has no observed metadata indexes at all, which the comparison already
    // reports as every declared field missing — no separate branch, no separate message to keep in step.
    const report = compareMetadataIndexes(descriptors, record.indexes[name]?.metadataIndexes ?? []);
    for (const entry of report.missing) missing.push(`${name}.${entry.propertyName} (${entry.indexType})`);
    for (const entry of report.mismatched) {
      mismatched.push(`${name}.${entry.propertyName} (declared ${entry.declared}, indexed as ${entry.live})`);
    }
  }
  if (missing.length === 0 && mismatched.length === 0) return;

  const problems = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    mismatched.length > 0 ? `mismatched: ${mismatched.join(", ")}` : "",
  ].filter(Boolean);
  throw new VectorMetadataIndexDriftError({
    message: `Search is not configured correctly — ${problems.join("; ")}.`,
    action:
      "Run `pithy vector provision --env <env>` to create the missing metadata indexes, then redeploy and re-embed. A mis-typed index is fixed only by `pithy vector reset`, which rebuilds the index from the corpus.",
    detail: `${problems.join("; ")}; checked against what \`pithy vector provision\` last observed, not against Cloudflare now`,
  });
}
