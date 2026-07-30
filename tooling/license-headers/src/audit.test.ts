// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyFixes, audit, fixFiles } from "./audit";
import { buildHeader } from "./header";
import { canonicalText } from "./licenses";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pithy-audit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A repo whose root is already correct, so a test only has to set up the part it is about. */
function goodRoot(): void {
  put("package.json", JSON.stringify({ name: "@pithy-sh/monorepo", license: "MIT" }));
  put("LICENSE", canonicalText("MIT") ?? "");
}

/** A package that passes every check, ready to be broken one way per test. */
function goodPackage(name: string, license = "MIT"): void {
  put(`packages/${name}/package.json`, JSON.stringify({ name: `@pithy-sh/${name}`, license }));
  put(`packages/${name}/LICENSE`, canonicalText(license) ?? "");
  put(`packages/${name}/src/index.ts`, `${buildHeader(license)}\n\nexport const a = 1;\n`);
}

const kinds = (root: string): string[] => audit(root).map((f) => f.kind);

describe("audit", () => {
  test("finds nothing wrong with a correct repo", () => {
    goodRoot();
    goodPackage("core");
    goodPackage("audit", "FSL-1.1-MIT");

    expect(audit(root)).toEqual([]);
  });

  test("flags a source file with no header", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/src/bare.ts", "export const b = 2;\n");

    expect(audit(root)).toEqual([
      { kind: "missing-header", path: "packages/core/src/bare.ts", expected: "MIT", actual: null },
    ]);
  });

  test("flags a header naming a licence its package does not declare", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/src/wrong.ts", `${buildHeader("FSL-1.1-MIT")}\n\nexport const b = 2;\n`);

    expect(audit(root)).toEqual([
      { kind: "wrong-header", path: "packages/core/src/wrong.ts", expected: "MIT", actual: "FSL-1.1-MIT" },
    ]);
  });

  test("flags a package with no LICENSE file", () => {
    goodRoot();
    goodPackage("core");
    rmSync(join(root, "packages/core/LICENSE"));

    expect(kinds(root)).toEqual(["missing-license-file"]);
  });

  test("flags a LICENSE whose text is not the licence the package declares", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/LICENSE", canonicalText("FSL-1.1-MIT") ?? "");

    expect(kinds(root)).toEqual(["license-file-mismatch"]);
  });

  test("flags a package whose manifest omits the licence field", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core" }));

    expect(kinds(root)).toEqual(["missing-license-field"]);
  });

  test("flags a licence we hold no canonical text for, rather than skipping the package", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "Apache-2.0" }));

    expect(kinds(root)).toEqual(["unknown-license"]);
  });

  // A package with no resolvable licence has nothing to check headers against. Reporting the one
  // root cause beats burying it under a finding for every file in the package.
  test("does not report headers for a package whose licence cannot be resolved", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core" }));
    put("packages/core/src/bare.ts", "export const b = 2;\n");

    expect(kinds(root)).toEqual(["missing-license-field"]);
  });

  test("checks the repo root's own LICENSE and manifest", () => {
    put("package.json", JSON.stringify({ name: "@pithy-sh/monorepo" }));

    expect(kinds(root)).toEqual(["missing-license-field", "missing-license-file"]);
  });

  // The carve-out has to be enforced, not merely documented: scaffolded files become the adopter's,
  // and Pithy's copyright must never ride along into their repo.
  test("flags a header on a scaffolded template, which must stay unstamped", () => {
    goodRoot();
    goodPackage("ui-react");
    put("packages/ui-react/templates/src/sign-in.tsx", `${buildHeader("MIT")}\n\nexport const S = 1;\n`);

    expect(audit(root)).toEqual([{ kind: "unexpected-header", path: "packages/ui-react/templates/src/sign-in.tsx" }]);
  });

  test("accepts an unstamped scaffolded template", () => {
    goodRoot();
    goodPackage("ui-react");
    put("packages/ui-react/templates/src/sign-in.tsx", "export const S = 1;\n");

    expect(audit(root)).toEqual([]);
  });

  test("flags a header in the root starter template too", () => {
    goodRoot();
    put("templates/starter/apps/api/src/index.ts", `${buildHeader("MIT")}\n\nexport default {};\n`);

    expect(kinds(root)).toEqual(["unexpected-header"]);
  });

  test("does not care about the copyright line, only the identifier", () => {
    goodRoot();
    goodPackage("core");
    put(
      "packages/core/src/custom.ts",
      "// SPDX-FileCopyrightText: 2031 Pithy, LLC\n// SPDX-License-Identifier: MIT\n\nexport const b = 2;\n",
    );

    expect(audit(root)).toEqual([]);
  });
});

describe("audit of tooling packages", () => {
  /** A tooling package: private, never published, so no LICENSE file — but its source is still ours. */
  function goodTooling(name: string): void {
    put(`tooling/${name}/package.json`, JSON.stringify({ name: `@pithy-sh/${name}`, license: "MIT" }));
    put(`tooling/${name}/src/index.ts`, `${buildHeader("MIT")}\n\nexport const a = 1;\n`);
  }

  test("requires a header on tooling source", () => {
    goodRoot();
    goodTooling("license-headers");
    put("tooling/license-headers/src/bare.ts", "export const b = 2;\n");

    expect(audit(root)).toEqual([
      { kind: "missing-header", path: "tooling/license-headers/src/bare.ts", expected: "MIT", actual: null },
    ]);
  });

  // A private package produces no tarball, so a LICENSE file in it would be a file nobody can ever
  // receive. The header is the part that carries.
  test("does not require a LICENSE file in a tooling package", () => {
    goodRoot();
    goodTooling("license-headers");

    expect(audit(root)).toEqual([]);
  });

  test("still requires a LICENSE file in a published package", () => {
    goodRoot();
    goodPackage("core");
    rmSync(join(root, "packages/core/LICENSE"));

    expect(kinds(root)).toEqual(["missing-license-file"]);
  });

  test("still requires a licence field on a tooling package, to derive the identifier from", () => {
    goodRoot();
    goodTooling("license-headers");
    put("tooling/license-headers/package.json", JSON.stringify({ name: "@pithy-sh/license-headers" }));

    expect(kinds(root)).toEqual(["missing-license-field"]);
  });

  test("stamps tooling source through the commit-hook path", () => {
    goodRoot();
    goodTooling("license-headers");
    put("tooling/license-headers/src/bare.ts", "export const b = 2;\n");

    expect(fixFiles(root, ["tooling/license-headers/src/bare.ts"])).toEqual(["tooling/license-headers/src/bare.ts"]);
  });
});

describe("fixFiles", () => {
  // `packages/email/src/templates/` is nine files of real library source, not a scaffold. Skipping
  // any path with a `templates` segment made the two fix paths disagree: the commit hook stamped
  // nothing there while a repo-wide --fix did, so CI failed on a file the hook had just passed.
  test("stamps library source that happens to live in a src/templates directory", () => {
    goodRoot();
    goodPackage("email");
    put("packages/email/src/templates/engine.ts", "export const e = 1;\n");

    expect(fixFiles(root, ["packages/email/src/templates/engine.ts"])).toEqual([
      "packages/email/src/templates/engine.ts",
    ]);
    expect(readFileSync(join(root, "packages/email/src/templates/engine.ts"), "utf8")).toBe(
      `${buildHeader("MIT")}\n\nexport const e = 1;\n`,
    );
  });

  test("still refuses a scaffolded template at the package root", () => {
    goodRoot();
    goodPackage("ui-react");
    put("packages/ui-react/templates/src/sign-in.tsx", "export const S = 1;\n");

    expect(fixFiles(root, ["packages/ui-react/templates/src/sign-in.tsx"])).toEqual([]);
  });

  test("still refuses a file in the root starter template", () => {
    goodRoot();
    put("templates/starter/apps/api/src/index.ts", "export default {};\n");

    expect(fixFiles(root, ["templates/starter/apps/api/src/index.ts"])).toEqual([]);
  });

  // The two fix paths must agree: whatever the hook stamps, a repo-wide run stamps too, and vice
  // versa. Disagreement is what produces a commit that passes the hook and fails CI.
  test("agrees with applyFixes about which files get stamped", () => {
    goodRoot();
    goodPackage("email");
    put("packages/email/src/templates/engine.ts", "export const e = 1;\n");
    put("packages/email/src/plain.ts", "export const p = 1;\n");

    const byPath = fixFiles(root, ["packages/email/src/templates/engine.ts", "packages/email/src/plain.ts"]);
    expect(byPath.sort()).toEqual(["packages/email/src/plain.ts", "packages/email/src/templates/engine.ts"]);
    expect(audit(root)).toEqual([]);
  });
});

describe("applyFixes", () => {
  test("stamps a missing header and reports the file as changed", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/src/bare.ts", "export const b = 2;\n");

    expect(applyFixes(root)).toEqual(["packages/core/src/bare.ts"]);
    expect(readFileSync(join(root, "packages/core/src/bare.ts"), "utf8")).toBe(
      `${buildHeader("MIT")}\n\nexport const b = 2;\n`,
    );
  });

  test("writes a missing LICENSE from the canonical text", () => {
    goodRoot();
    goodPackage("core");
    rmSync(join(root, "packages/core/LICENSE"));

    expect(applyFixes(root)).toEqual(["packages/core/LICENSE"]);
    expect(readFileSync(join(root, "packages/core/LICENSE"), "utf8")).toBe(canonicalText("MIT"));
  });

  // The root takes a different branch to a package: it is not in the package list, so its licence
  // has to be read straight off the root manifest.
  test("writes the repo root's own LICENSE", () => {
    put("package.json", JSON.stringify({ name: "@pithy-sh/monorepo", license: "MIT" }));

    expect(applyFixes(root)).toEqual(["LICENSE"]);
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe(canonicalText("MIT"));
  });

  test("cannot write a LICENSE for a package whose licence it cannot resolve", () => {
    goodRoot();
    put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core" }));

    expect(applyFixes(root)).toEqual([]);
  });

  test("leaves a correct repo untouched", () => {
    goodRoot();
    goodPackage("core");

    expect(applyFixes(root)).toEqual([]);
  });

  test("is idempotent — a second run changes nothing", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    rmSync(join(root, "packages/core/LICENSE"));

    expect(applyFixes(root).length).toBeGreaterThan(0);
    expect(applyFixes(root)).toEqual([]);
    expect(audit(root)).toEqual([]);
  });

  // A wrong LICENSE body could be a deliberate, reviewed edit. Overwriting legal text without being
  // asked is the one repair this tool must not make on its own.
  test("reports a mismatched LICENSE body but never overwrites it", () => {
    goodRoot();
    goodPackage("core");
    put("packages/core/LICENSE", "MIT License\n\nedited by hand\n");

    expect(applyFixes(root)).toEqual([]);
    expect(kinds(root)).toEqual(["license-file-mismatch"]);
  });

  test("never stamps a scaffolded template", () => {
    goodRoot();
    goodPackage("ui-react");
    put("packages/ui-react/templates/src/sign-in.tsx", "export const S = 1;\n");

    expect(applyFixes(root)).toEqual([]);
    expect(readFileSync(join(root, "packages/ui-react/templates/src/sign-in.tsx"), "utf8")).toBe(
      "export const S = 1;\n",
    );
  });
});
