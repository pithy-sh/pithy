import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ejectCapability, parseEjectedCapabilities } from "./eject";

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
