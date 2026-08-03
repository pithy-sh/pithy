// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { describe, expect, test, vi } from "vitest";
import { imageMinter, videoMinter } from "./cloudflare";

/**
 * Cloudflare Images and Stream are account-flat and their assets are keyed by a Cloudflare-minted id,
 * so a name cannot scope them — the ownership metadata these adapters stamp is the only lever that
 * says which project and environment an asset belongs to.
 */

const owner = { project: "acme", env: "prod" };

function images(): { manager: CloudflareImageManager; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({ id: "img-1", uploadURL: "https://images/upload" });
  return { manager: { createDirectUploadUrl: create } as unknown as CloudflareImageManager, create };
}

function stream(): { manager: CloudflareStreamManager; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({ uid: "vid-1", uploadURL: "https://stream/upload" });
  return { manager: { createDirectUpload: create } as unknown as CloudflareStreamManager, create };
}

describe("imageMinter", () => {
  test("stamps the owner into the metadata of every direct upload", async () => {
    const { manager, create } = images();
    const result = await imageMinter(manager, owner).mintDirectUpload();

    expect(result).toEqual({ id: "img-1", uploadUrl: "https://images/upload" });
    expect(create).toHaveBeenCalledWith({ metadata: { pithyProject: "acme", pithyEnv: "prod" } });
  });

  test("merges the stamp over a caller's own metadata without imposing a shape on it", async () => {
    const { manager, create } = images();
    await imageMinter(manager, owner).mintDirectUpload({ userId: "u-7" });

    expect(create).toHaveBeenCalledWith({
      metadata: { userId: "u-7", pithyProject: "acme", pithyEnv: "prod" },
    });
  });

  test("a caller cannot omit or overwrite the ownership keys", async () => {
    const { manager, create } = images();
    await imageMinter(manager, owner).mintDirectUpload({ pithyProject: "globex", pithyEnv: "dev" });

    expect(create).toHaveBeenCalledWith({ metadata: { pithyProject: "acme", pithyEnv: "prod" } });
  });
});

describe("videoMinter", () => {
  test("stamps the owner into the Stream direct upload's meta", async () => {
    const { manager, create } = stream();
    const result = await videoMinter(manager, owner).mintDirectUpload();

    expect(result).toEqual({ uid: "vid-1", uploadUrl: "https://stream/upload" });
    expect(create).toHaveBeenCalledWith({
      maxDurationSeconds: 21600,
      meta: { pithyProject: "acme", pithyEnv: "prod" },
    });
  });

  test("carries a caller's metadata too — the same two keys as Images, so one query spans both", async () => {
    const { manager, create } = stream();
    await videoMinter(manager, owner).mintDirectUpload({ userId: "u-7", pithyProject: "globex" });

    expect(create).toHaveBeenCalledWith({
      maxDurationSeconds: 21600,
      meta: { userId: "u-7", pithyProject: "acme", pithyEnv: "prod" },
    });
  });
});
