// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { availableManifests, loadManifest } from "./manifests";

/** Drop a `pithy.manifest.json` into `<dir>/node_modules/@pithy-sh/<name>`. */
async function installManifest(dir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@pithy-sh", name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
}

const authManifest = {
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [{ type: "d1", name: "DB" }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-manifests-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadManifest", () => {
  test("resolves and validates an installed capability's manifest", async () => {
    await installManifest(dir, "auth", authManifest);

    const manifest = await loadManifest("auth", dir);
    expect(manifest.name).toBe("auth");
    expect(manifest.package).toBe("@pithy-sh/auth");
    // BindingSpec normalization ran — proof it went through the schema.
    expect(manifest.requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  test("an uninstalled capability fails with its name and how to add it", async () => {
    const error = await loadManifest("auth", dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).message).toContain("auth");
    expect((error as PithyError).payload.action).toContain("pithy add auth");
  });

  test("a malformed manifest fails validation", async () => {
    await installManifest(dir, "auth", { name: "auth" }); // no package, no requiredBindings
    await expect(loadManifest("auth", dir)).rejects.toThrow();
  });

  /**
   * A manifest is third-party data, read out of `node_modules`, and its option keys and rationales are
   * interpolated into the TypeScript `pithy add` writes. #174 narrowed both at the schema; this is the
   * refusal an adopter actually sees, and it has to say which manifest and which option — a capability
   * with a dozen options and one bad key is otherwise a "malformed manifest" and nothing more.
   */
  test("an option key that is not a bare identifier is refused, naming the manifest and the option", async () => {
    await installManifest(dir, "auth", {
      ...authManifest,
      configOptions: [
        { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
        { key: "content-type", default: "x", describe: "Not renderable as a bare key." },
      ],
    });

    const error = (await loadManifest("auth", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("@pithy-sh/auth"); // the manifest
    expect(error.message).toContain("configOptions[1].key"); // the option
    expect(error.message).toContain('"content-type"'); // and what it said
    expect(error.payload.detail).toContain("bare identifier");
  });

  test("a describe that spans lines is refused the same way", async () => {
    await installManifest(dir, "auth", {
      ...authManifest,
      configOptions: [{ key: "basePath", default: "/auth", describe: "Where the routes mount.\nevil();" }],
    });

    const error = (await loadManifest("auth", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("configOptions[0].describe");
    expect(error.message).toContain("one line");
  });
});

describe("availableManifests", () => {
  test("a project with no node_modules has no capabilities", async () => {
    expect(await availableManifests(dir)).toEqual([]);
  });

  test("scans node_modules/@pithy-sh/* and returns every validated manifest", async () => {
    await installManifest(dir, "auth", authManifest);
    await installManifest(dir, "storage", {
      name: "storage",
      package: "@pithy-sh/storage",
      requiredBindings: [{ type: "r2", name: "BUCKET" }],
    });

    const manifests = await availableManifests(dir);
    expect(manifests.map((m) => m.name).sort()).toEqual(["auth", "storage"]);
  });

  test("skips @pithy-sh packages that ship no manifest (core, cli)", async () => {
    await installManifest(dir, "auth", authManifest);
    await mkdir(join(dir, "node_modules", "@pithy-sh", "core"), { recursive: true });

    const manifests = await availableManifests(dir);
    expect(manifests.map((m) => m.name)).toEqual(["auth"]);
  });
});
