// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isCapabilityImport, isInside } from "./configImports";
import { ejectCapability, ejectImportPath, parseEjectedCapabilities } from "./eject";

describe("parseEjectedCapabilities", () => {
  test("finds capabilities imported from a local ./capabilities/<name> path", () => {
    const source = [
      'import { auth } from "./capabilities/auth";',
      'import { email } from "@pithy-sh/email/src/index";',
      "export default { capabilities: [auth(), email()] };",
    ].join("\n");
    expect(parseEjectedCapabilities(source)).toEqual(["auth"]);
  });

  test("returns nothing when no capability is ejected", () => {
    expect(parseEjectedCapabilities('import { email } from "@pithy-sh/email/src/index";')).toEqual([]);
  });

  test("captures the leaf name, ignoring any nested import path", () => {
    expect(parseEjectedCapabilities('import { auth } from "./capabilities/auth/index";')).toEqual(["auth"]);
  });

  test("reads either quote style — a reformatted config still counts as ejected", () => {
    expect(parseEjectedCapabilities("import { auth } from './capabilities/auth';")).toEqual(["auth"]);
  });

  test("agrees with isCapabilityImport about every path it calls ejected", () => {
    // Two functions answering one question differently is the bug: this one accepted
    // `./capabilities/auth/<anything>` while `isCapabilityImport` demanded exact equality, so `remove`
    // read a config as ejected and then refused to unwire the very import that made it so.
    for (const specifier of ["./capabilities/auth", "./capabilities/auth/index", "./capabilities/auth/http/routes"]) {
      expect(parseEjectedCapabilities(`import { auth } from "${specifier}";`)).toEqual(["auth"]);
      expect(isCapabilityImport(specifier, "@pithy-sh/auth", ejectImportPath("auth"))).toBe(true);
    }
  });

  test("a traversal out of the eject directory ejects nothing", () => {
    // `[^"'/]+` captured `..` as the capability's name — a name no capability has, read off a path that
    // points outside the fork directory entirely.
    expect(parseEjectedCapabilities('import { auth } from "./capabilities/../lib/auth";')).toEqual([]);
  });

  test("a commented-out local import is not an ejected capability", () => {
    expect(parseEjectedCapabilities('// import { auth } from "./capabilities/auth";')).toEqual([]);
  });
});

describe("ejectCapability", () => {
  let dir: string;
  /** The Worker whose wiring is being forked — where the config lives and the source lands. */
  let worker: string;
  const noop = async () => {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-eject-"));
    worker = join(dir, "apps", "api");
    await mkdir(worker, { recursive: true });
    // A project with turnstile added the normal way (package import in the worker's managed region).
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@pithy-sh/core": "^0.1.0", "@pithy-sh/turnstile": "^0.1.0" } }),
    );
    await writeFile(
      join(worker, "pithy.config.ts"),
      [
        'import { turnstile } from "@pithy-sh/turnstile/src/index";',
        "export default {",
        "  capabilities: [",
        "    turnstile(),",
        "    // pithy:capabilities",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
    // The installed package: a small src tree plus a manifest with mixed deps.
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "turnstile");
    await mkdir(join(pkgDir, "src", "http"), { recursive: true });
    await writeFile(join(pkgDir, "src", "index.ts"), "export { turnstile } from './capability';\n");
    await writeFile(join(pkgDir, "src", "capability.ts"), "export function turnstile() { return {}; }\n");
    await writeFile(join(pkgDir, "src", "http", "middleware.ts"), "export const mw = 1;\n");
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@pithy-sh/turnstile",
        dependencies: { "@pithy-sh/core": "workspace:*", hono: "^4.12.0", zod: "^4.0.0" },
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function eject(overrides: Partial<Parameters<typeof ejectCapability>[0]> = {}) {
    return ejectCapability({
      projectDir: dir,
      workerDir: worker,
      capability: "turnstile",
      package: "@pithy-sh/turnstile",
      promoteDeps: noop,
      ...overrides,
    });
  }

  test("copies the package src tree into capabilities/<cap>/, preserving structure", async () => {
    const result = await eject();
    expect(await readFile(join(worker, "capabilities/turnstile/index.ts"), "utf8")).toContain("export { turnstile }");
    expect(await readFile(join(worker, "capabilities/turnstile/http/middleware.ts"), "utf8")).toContain(
      "export const mw",
    );
    expect(result.path).toBe("capabilities/turnstile");
  });

  test("rewrites the managed-region import to the local path, leaving the registration alone", async () => {
    await eject();
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { turnstile } from "./capabilities/turnstile";');
    expect(config).not.toContain("@pithy-sh/turnstile/src/index");
    expect(config).toContain("turnstile(),");
  });

  test("repoints a hand-edited deep import of the package as well as the barrel one", async () => {
    const path = join(worker, "pithy.config.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace("/src/index", "/src/capability"));

    await eject();

    const config = await readFile(path, "utf8");
    expect(config).toContain('import { turnstile } from "./capabilities/turnstile";');
    expect(config).not.toContain("@pithy-sh/turnstile");
  });

  test("promotes the package's third-party deps, filtering workspace: ones", async () => {
    let promoted: string[] = [];
    const result = await eject({
      promoteDeps: async (_dir, deps) => {
        promoted = deps;
      },
    });
    expect(promoted).toEqual(["hono@^4.12.0", "zod@^4.0.0"]);
    expect(result.promotedDependencies).toEqual(["hono@^4.12.0", "zod@^4.0.0"]);
  });

  test("refuses to overwrite an existing local copy without --force", async () => {
    await mkdir(join(worker, "capabilities", "turnstile"), { recursive: true });
    await writeFile(join(worker, "capabilities", "turnstile", "mine.ts"), "// my edits");
    await expect(eject()).rejects.toThrow(PithyError);
    // The user's edit survives — nothing was clobbered.
    expect(await readFile(join(worker, "capabilities", "turnstile", "mine.ts"), "utf8")).toBe("// my edits");
  });

  test("--force re-copies over an existing local copy, discarding stale files", async () => {
    await mkdir(join(worker, "capabilities", "turnstile"), { recursive: true });
    await writeFile(join(worker, "capabilities", "turnstile", "mine.ts"), "// my edits");

    const result = await eject({ force: true });

    expect(result.forced).toBe(true);
    expect(await readFile(join(worker, "capabilities/turnstile/index.ts"), "utf8")).toContain("turnstile");
    await expect(readFile(join(worker, "capabilities", "turnstile", "mine.ts"), "utf8")).rejects.toThrow();
  });

  test("fails when the package src is not installed", async () => {
    await expect(
      ejectCapability({
        projectDir: dir,
        workerDir: worker,
        capability: "ghost",
        package: "@pithy-sh/ghost",
        promoteDeps: noop,
      }),
    ).rejects.toThrow(PithyError);
  });

  test("a malformed package.json fails as a PithyError, not a raw parse error", async () => {
    await writeFile(join(dir, "node_modules", "@pithy-sh", "turnstile", "package.json"), "{ not json");
    await expect(eject()).rejects.toThrow(PithyError);
  });

  test("a failed dep promotion leaves the config pointing at the working package", async () => {
    const failure = eject({
      promoteDeps: async () => {
        throw new Error("registry down");
      },
    });
    await expect(failure).rejects.toThrow("registry down");
    // The import was not repointed — the project still resolves the installed package.
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain("@pithy-sh/turnstile/src/index");
    expect(config).not.toContain("./capabilities/turnstile");
  });
});

/**
 * Eject's local path is built from the capability's name, so #183's narrowing lands here too.
 *
 * A manifest's `name` is what `pithy add --eject` uses for the fork directory and the import that points
 * at it. Held to a bare identifier, that path has no separator, no `..`, and no quote in it — so the one
 * thing an ejected import could never do is leave `./capabilities/`. Checked because the rule lives at
 * the schema, one package away, and nothing here would notice if it were relaxed.
 */
describe("a manifest name cannot name a fork directory outside ./capabilities", () => {
  test("every name the schema admits stays inside the fork directory", () => {
    for (const name of ["auth", "_x", "$x", "x9", "controlplane"]) {
      const parsed = CapabilityManifest.safeParse({ name, package: "@pithy-sh/x", requiredBindings: [] });
      expect(parsed.success).toBe(true);
      expect(ejectImportPath(name)).toBe(`./capabilities/${name}`);
      expect(isInside(ejectImportPath(name), "./capabilities")).toBe(true);
    }
  });

  test("the names that would escape are the names the schema refuses", () => {
    for (const name of ["..", "../../elsewhere", "a/b", 'a"b']) {
      expect(CapabilityManifest.safeParse({ name, package: "@pithy-sh/x", requiredBindings: [] }).success).toBe(false);
    }
  });
});
