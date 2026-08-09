// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";

/**
 * The remedy for a file that is there and would not open, chosen from the errno (#217).
 *
 * `readOptionalFile`'s `unreadable` is **every errno but `ENOENT`**. *Check permissions on X* answers
 * one of them. An adopter whose `.pithy-feature.json` is a directory, a symlink loop, or a bad sector
 * reads a sentence about permissions, runs `chmod`, and learns nothing — which is the shape #217 is
 * about: a `catch` reachable more than one way may not name a single remedy. Unrecognised errnos get no
 * remedy at all, only the errno, because a wrong action is worse than no action.
 *
 * `ports.ts` carries its own copy for its own file. Two is under this repository's threshold for hoisting
 * a rule out of its call sites (see `readOptionalFile.ts`: *three is this repository's count*). The home
 * for a third is beside `readOptionalFile`, which already owns the absent/unreadable decision itself.
 */
function unreadableAction(code: string | undefined, name: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Check permissions on ${name}.`;
    case "EISDIR":
      return `${name} is a directory, not a file. Remove it, then re-run.`;
    case "ELOOP":
      return `${name} is a symlink loop. Replace it with a regular file, then re-run.`;
    default:
      return `${name} is there and would not open (${code ?? "unknown error"}). Check that file, then re-run.`;
  }
}

/** One provisioned Cloudflare resource recorded for teardown. */
export const FeatureResource = z
  .object({
    kind: z.enum(["d1", "kv", "r2"]).describe("The Cloudflare resource type."),
    binding: z.string().describe("The Worker binding name this resource backs, e.g. DB."),
    name: z.string().describe("The full CF resource name, e.g. acme-f69-media-cli-db-d1."),
    id: z.string().describe("The CF-assigned id (D1 uuid, KV namespace id) or the bucket name for r2."),
  })
  .describe("One provisioned Cloudflare resource recorded for teardown.");
export type FeatureResource = z.output<typeof FeatureResource>;

/** The per-feature record of provisioned Cloudflare resources (git-ignored, in the worktree). */
export const FeatureManifest = z
  .object({
    version: z.literal(1).describe("Manifest schema version."),
    project: z.string().describe('The project name, from pithy.config (e.g. "acme").'),
    issue: z.string().describe('The issue number this feature was created for (e.g. "69").'),
    slug: z.string().describe('The kebab-case feature slug (e.g. "media-cli").'),
    env: z.string().describe("The environment these resources belong to."),
    resources: z.array(FeatureResource).describe("Every provisioned resource, for exact-id teardown."),
  })
  .describe("The per-feature record of provisioned Cloudflare resources (git-ignored, in the worktree).");
export type FeatureManifest = z.output<typeof FeatureManifest>;

/** The manifest path for a worktree dir: `<worktreeDir>/.pithy-feature.json`. */
export function manifestPath(worktreeDir: string): string {
  return join(worktreeDir, ".pithy-feature.json");
}

/**
 * Read + Zod-validate the manifest, or `null` if the file does not exist.
 *
 * "Does not exist" is {@link readOptionalFile}'s decision — a manifest that is there and will not open
 * would otherwise read as "this worktree provisioned nothing", and `pithy feature destroy` tears down by
 * exact id from this record. The words stay here; the errno does not.
 */
export async function readManifest(path: string): Promise<FeatureManifest | null> {
  const raw = await readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new InternalError({
        message: "Could not read the feature manifest.",
        action: unreadableAction(code, ".pithy-feature.json"),
        detail: `${code ?? "unknown error"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InternalError({
      message: "The feature manifest is corrupt.",
      action: "Delete .pithy-feature.json and re-run pithy feature provision.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const result = FeatureManifest.safeParse(parsed);
  if (!result.success) {
    throw fromZodError(result.error, {
      message: "The feature manifest is corrupt.",
      action: "Delete .pithy-feature.json and re-run pithy feature provision.",
    });
  }
  return result.data;
}

/** Zod-validate then write the manifest atomically (pretty JSON, 2-space indent, trailing newline). */
export async function writeManifest(path: string, manifest: FeatureManifest): Promise<void> {
  const parsed = FeatureManifest.parse(manifest);
  await writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Return a NEW manifest with `resource` upserted — deduped by (kind, binding, name); a match is
 * replaced in place, otherwise the resource is appended. Pure: never mutates `manifest`.
 */
export function upsertResource(manifest: FeatureManifest, resource: FeatureResource): FeatureManifest {
  const index = manifest.resources.findIndex(
    (existing) =>
      existing.kind === resource.kind && existing.binding === resource.binding && existing.name === resource.name,
  );

  const resources =
    index === -1
      ? [...manifest.resources, resource]
      : manifest.resources.map((existing, i) => (i === index ? resource : existing));

  return { ...manifest, resources };
}

/** Build an empty manifest for an identity + environment. */
export function emptyManifest(args: { project: string; issue: string; slug: string; env: string }): FeatureManifest {
  return { version: 1, ...args, resources: [] };
}
