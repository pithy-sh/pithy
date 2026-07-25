import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  emptyManifest,
  type FeatureManifest,
  type FeatureResource,
  manifestPath,
  readManifest,
  upsertResource,
  writeManifest,
} from "./manifest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-feature-manifest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DB_RESOURCE: FeatureResource = {
  kind: "d1",
  binding: "DB",
  name: "acme-f69-media-cli-db-d1",
  id: "11111111-1111-1111-1111-111111111111",
};

describe("manifestPath", () => {
  test("is <worktreeDir>/.pithy-feature.json", () => {
    expect(manifestPath("/tmp/worktree")).toBe("/tmp/worktree/.pithy-feature.json");
  });
});

describe("emptyManifest", () => {
  test("builds an empty manifest for an identity + env", () => {
    const manifest = emptyManifest({ project: "acme", issue: "69", slug: "media-cli", env: "dev" });
    expect(manifest).toEqual({
      version: 1,
      project: "acme",
      issue: "69",
      slug: "media-cli",
      env: "dev",
      resources: [],
    });
  });
});

describe("writeManifest + readManifest", () => {
  test("round-trips an equal object", async () => {
    const path = manifestPath(dir);
    const manifest = upsertResource(
      emptyManifest({ project: "acme", issue: "69", slug: "media-cli", env: "dev" }),
      DB_RESOURCE,
    );

    await writeManifest(path, manifest);
    const read = await readManifest(path);

    expect(read).toEqual(manifest);
  });

  test("readManifest on a missing file returns null", async () => {
    const path = manifestPath(dir);
    expect(await readManifest(path)).toBeNull();
  });

  test("readManifest on corrupt JSON throws a PithyError", async () => {
    const path = manifestPath(dir);
    await writeFile(path, "{ not valid json");

    await expect(readManifest(path)).rejects.toMatchObject({ name: "PithyError" });
  });

  test("readManifest on a shape that fails Zod validation throws a PithyError", async () => {
    const path = manifestPath(dir);
    await writeFile(path, JSON.stringify({ version: 1, project: "acme" }));

    await expect(readManifest(path)).rejects.toMatchObject({ name: "PithyError" });
  });

  test("writeManifest rejects an invalid manifest (missing field)", async () => {
    const path = manifestPath(dir);
    const invalid = { version: 1, project: "acme", issue: "69", slug: "media-cli" } as unknown as FeatureManifest;

    await expect(writeManifest(path, invalid)).rejects.toThrow();
  });
});

describe("upsertResource", () => {
  test("appends a new resource", () => {
    const manifest = emptyManifest({ project: "acme", issue: "69", slug: "media-cli", env: "dev" });
    const updated = upsertResource(manifest, DB_RESOURCE);

    expect(updated.resources).toEqual([DB_RESOURCE]);
  });

  test("replaces a matching (kind, binding, name) entry rather than duplicating", () => {
    const manifest = upsertResource(
      emptyManifest({ project: "acme", issue: "69", slug: "media-cli", env: "dev" }),
      DB_RESOURCE,
    );
    const replacement: FeatureResource = { ...DB_RESOURCE, id: "22222222-2222-2222-2222-222222222222" };

    const updated = upsertResource(manifest, replacement);

    expect(updated.resources).toHaveLength(1);
    expect(updated.resources[0]).toEqual(replacement);
  });

  test("does not mutate its input", () => {
    const manifest = emptyManifest({ project: "acme", issue: "69", slug: "media-cli", env: "dev" });
    const original = JSON.parse(JSON.stringify(manifest));

    upsertResource(manifest, DB_RESOURCE);

    expect(manifest).toEqual(original);
  });
});
