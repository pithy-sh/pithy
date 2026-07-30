// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverPackages, sourceFiles } from "./workspace";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pithy-licenses-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `content` at `relative`, creating parent directories. */
function put(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("discoverPackages", () => {
  test("reads each package's directory, name, declared license and group", () => {
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "MIT" }));
    put("packages/audit/package.json", JSON.stringify({ name: "@pithy-sh/audit", license: "FSL-1.1-MIT" }));

    expect(discoverPackages(root)).toEqual([
      { name: "@pithy-sh/audit", dir: join(root, "packages/audit"), license: "FSL-1.1-MIT", group: "packages" },
      { name: "@pithy-sh/core", dir: join(root, "packages/core"), license: "MIT", group: "packages" },
    ]);
  });

  // `tooling/*` is a workspace like `packages/*` — private and never published, but its source is
  // still ours and still needs a header. The licence tool itself living unlicensed was the tell.
  test("finds tooling packages as well as published ones", () => {
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "MIT" }));
    put("tooling/license-headers/package.json", JSON.stringify({ name: "@pithy-sh/license-headers", license: "MIT" }));

    expect(discoverPackages(root).map((p) => [p.name, p.group])).toEqual([
      ["@pithy-sh/core", "packages"],
      ["@pithy-sh/license-headers", "tooling"],
    ]);
  });

  test("still works when a workspace directory is absent entirely", () => {
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "MIT" }));

    expect(discoverPackages(root).map((p) => p.name)).toEqual(["@pithy-sh/core"]);
  });

  test("reports a missing license field as null rather than throwing", () => {
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core" }));

    expect(discoverPackages(root)[0]?.license).toBeNull();
  });

  // A stale directory left behind by a rename (packages/wallet after the ledger rename held only
  // dist/ and node_modules/) is not a package. Keying on package.json is what skips it.
  test("skips a directory with no package.json", () => {
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "MIT" }));
    mkdirSync(join(root, "packages/wallet/dist"), { recursive: true });

    expect(discoverPackages(root).map((p) => p.name)).toEqual(["@pithy-sh/core"]);
  });
});

describe("sourceFiles", () => {
  test("finds .ts and .tsx under src, at any depth", () => {
    put("packages/core/src/index.ts", "");
    put("packages/core/src/http/routes.ts", "");
    put("packages/core/src/ui/Button.tsx", "");

    expect(sourceFiles(join(root, "packages/core")).map((f) => f.replace(`${root}/`, ""))).toEqual([
      "packages/core/src/http/routes.ts",
      "packages/core/src/index.ts",
      "packages/core/src/ui/Button.tsx",
    ]);
  });

  test("includes co-located tests", () => {
    put("packages/core/src/codec.ts", "");
    put("packages/core/src/codec.test.ts", "");

    expect(sourceFiles(join(root, "packages/core")).map((f) => f.replace(`${root}/`, ""))).toEqual([
      "packages/core/src/codec.test.ts",
      "packages/core/src/codec.ts",
    ]);
  });

  test("ignores non-TypeScript files and anything outside src", () => {
    put("packages/core/src/index.ts", "");
    put("packages/core/src/query.sql", "");
    put("packages/core/tsdown.config.ts", "");

    expect(sourceFiles(join(root, "packages/core")).map((f) => f.replace(`${root}/`, ""))).toEqual([
      "packages/core/src/index.ts",
    ]);
  });

  test("never descends into node_modules or dist", () => {
    put("packages/core/src/index.ts", "");
    put("packages/core/src/node_modules/dep/evil.ts", "");
    put("packages/core/src/dist/built.ts", "");

    expect(sourceFiles(join(root, "packages/core")).map((f) => f.replace(`${root}/`, ""))).toEqual([
      "packages/core/src/index.ts",
    ]);
  });

  test("returns nothing for a package with no src directory", () => {
    put("packages/core/package.json", "{}");

    expect(sourceFiles(join(root, "packages/core"))).toEqual([]);
  });
});
