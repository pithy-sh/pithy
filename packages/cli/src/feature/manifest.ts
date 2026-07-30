// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";

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

/** Read + Zod-validate the manifest, or `null` if the file does not exist. */
export async function readManifest(path: string): Promise<FeatureManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new InternalError({
      message: "Could not read the feature manifest.",
      action: "Check permissions on .pithy-feature.json.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

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
