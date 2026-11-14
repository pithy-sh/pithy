// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * `@expo/app-integrity` belongs to the scaffolded React Native app and to nothing in this package. The bearer
 * client takes the platform attester as an injected adapter, so a web-only or server-only project installs nothing
 * for attestation.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const NATIVE_MODULE = "@expo/app-integrity";

const manifest = JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf8")) as Record<string, unknown>;

describe("@pithy-sh/auth's manifest", () => {
  test("names @expo/app-integrity in no dependency field, required, peer, optional or dev", () => {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "optionalDependencies",
      "devDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      const entries = manifest[field];
      const names = Array.isArray(entries) ? entries : Object.keys((entries as Record<string, unknown>) ?? {});
      expect(names, field).not.toContain(NATIVE_MODULE);
    }
  });

  test("the check reads the real manifest, so it is not vacuous", () => {
    expect(manifest.name).toBe("@pithy-sh/auth");
    expect(Object.keys(manifest.peerDependencies as Record<string, unknown>)).toContain("@pithy-sh/core");
  });

  test("no source file imports it", () => {
    const importers = readdirSync(`${PACKAGE_ROOT}src`, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path) && !path.endsWith("packageManifest.test.ts"))
      .filter((path) => readFileSync(`${PACKAGE_ROOT}src/${path}`, "utf8").includes(`"${NATIVE_MODULE}"`));
    expect(importers).toEqual([]);
  });
});
