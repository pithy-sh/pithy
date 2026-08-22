// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // The Durable Object the Worker entry re-exports. A real file, because the point of repointing is
    // that the new specifier resolves to one.
    await mkdir(join(pkgDir, "src", "room"), { recursive: true });
    await writeFile(join(pkgDir, "src", "room", "durableObject.ts"), "export class TurnstileRoom {}\n");
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

  /**
   * The package manifest that will not open, and the one that will not parse (#217).
   *
   * One `try` wrapped the read and the parse and answered both with *Reinstall <pkg>*. Reinstalling is
   * right for a package that is absent or corrupt on disk; it is not what an operator does about a mode
   * bit or a directory sitting where a file belongs, and `pithy eject` is a one-way door to be sure of.
   */
  test("a package.json that is a directory is not answered with 'reinstall'", async () => {
    const manifest = join(dir, "node_modules", "@pithy-sh", "turnstile", "package.json");
    await rm(manifest);
    await mkdir(manifest);

    await expect(eject()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/reinstall/i);
      return true;
    });
  });

  test("a package.json that is not JSON says so, and reinstalling is still the remedy", async () => {
    const manifest = join(dir, "node_modules", "@pithy-sh", "turnstile", "package.json");
    await writeFile(manifest, '{ "name": "x",, }');

    await expect(eject()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.message).toMatch(/JSON/i);
      expect(error.payload.action).toMatch(/reinstall/i);
      return true;
    });
  });

  /**
   * Give the Worker an entry with a Durable Object re-export in it — the line `pithy add` writes (#428).
   * The base fixture has no `wrangler.jsonc` at all, which is its own case below.
   */
  async function withEntry(statement: string): Promise<string> {
    await writeFile(join(worker, "wrangler.jsonc"), '{ "name": "api", "main": "src/index.ts" }\n');
    await mkdir(join(worker, "src"), { recursive: true });
    const path = join(worker, "src", "index.ts");
    await writeFile(path, `import config from "../pithy.config";\n\nexport default config;\n${statement}\n`);
    return path;
  }

  /**
   * **A fork that does not fork the Durable Object is not a fork.**
   *
   * `EJECT.md` promises the project imports nothing from the package afterwards, and eject only ever
   * repointed `pithy.config.ts`. The Worker entry's `export { … } from "@pithy-sh/<cap>/…"` — a line the
   * CLI itself writes — kept pointing at the package, so the class Cloudflare instantiated was the
   * package's while the adopter edited the copy. Silently: it builds, it deploys, and every edit to the
   * forked actor is ignored.
   */
  /** Whether a path is on disk. `existsSync`'s question, asked the way the rest of this file reads files. */
  async function exists(path: string): Promise<boolean> {
    return access(path).then(
      () => true,
      () => false,
    );
  }

  /** The module specifier of the entry's re-export of `name`. */
  async function entrySpecifier(path: string, name: string): Promise<string> {
    const found = new RegExp(`export \\{ ${name} \\} from "([^"]+)"`).exec(await readFile(path, "utf8"));
    return found?.[1] ?? "";
  }

  /**
   * **The specifier is relative to the file it is written into, and the two files are not the same one.**
   *
   * `pithy.config.ts` sits at `apps/<worker>/` and the entry at `apps/<worker>/src/`, so the fork the
   * config reaches as `./capabilities/<cap>` the entry reaches as `../capabilities/<cap>`. Eject wrote the
   * config's spelling into both, and the entry's import resolved to a directory that does not exist —
   * a Worker that no longer bundles, from the command whose whole job is that it still does.
   *
   * Asserted against the disk rather than against the string, because the string is what was wrong.
   */
  test("the entry's repointed export resolves to a file, from the entry's own directory", async () => {
    const path = await withEntry('export { TurnstileRoom } from "@pithy-sh/turnstile/src/room/durableObject";');
    await eject();
    const specifier = await entrySpecifier(path, "TurnstileRoom");
    expect(await exists(join(dirname(path), `${specifier}.ts`))).toBe(true);
  });

  test("the package barrel repoints to the fork directory, resolved from the entry", async () => {
    const path = await withEntry('export { thing } from "@pithy-sh/turnstile/src/index";');
    await eject();
    const specifier = await entrySpecifier(path, "thing");
    expect(await exists(join(dirname(path), specifier, "index.ts"))).toBe(true);
  });

  test("the config keeps its own spelling of the same fork", async () => {
    // Both writers derive the path from the file they write into, so the two halves of the wiring still
    // name one directory — and `parseEjectedCapabilities` still reads the config as ejected.
    await withEntry('export { TurnstileRoom } from "@pithy-sh/turnstile/src/room/durableObject";');
    await eject();
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toContain(
      'import { turnstile } from "./capabilities/turnstile";',
    );
  });

  /**
   * A line the adopter commented out contains the live line verbatim, so a literal `String.replace` over
   * the raw source found the comment first: the commented copy was repointed at the fork and the export
   * that actually runs was left pointing at the package — the failure repointing exists to prevent,
   * written by the fix for it.
   */
  test("a commented-out copy above the live export leaves the live one repointed", async () => {
    const statement = 'export { TurnstileRoom } from "@pithy-sh/turnstile/src/room/durableObject";';
    const path = await withEntry(`// ${statement}\n${statement}`);
    await eject();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.at(-2)).toBe(`// ${statement}`);
    // The live line is the last one, and it is the one that moved. Read off that line rather than off the
    // file, because the file's first match is the comment — which is how the bug hid.
    const live = /from "([^"]+)"/.exec(lines.at(-1) ?? "")?.[1] ?? "";
    expect(await exists(join(dirname(path), `${live}.ts`))).toBe(true);
  });

  test("an export of somebody else's module is left alone", async () => {
    const path = await withEntry('export { Room } from "./rooms";');
    await eject();
    expect(await readFile(path, "utf8")).toContain('export { Room } from "./rooms";');
  });

  test("a Worker with no entry to repoint still ejects", async () => {
    // The base fixture: no wrangler.jsonc, so no `main`, so no entry. A frontend Worker that joins the
    // dev set through pithy.worker.jsonc alone is in exactly that state, and it is not a failure.
    await expect(eject()).resolves.toMatchObject({ path: "capabilities/turnstile" });
  });

  test("an export from a path eject cannot copy is refused by name, never left pointing at the package", async () => {
    // Only `src/` is copied, so `@pithy-sh/turnstile/dist/room` has no local counterpart. Silently
    // leaving it would put the package's class back in the bundle under the fork's name — the exact
    // failure these tests exist for — so the line is named and the adopter decides.
    const path = await withEntry('export { TurnstileRoom } from "@pithy-sh/turnstile/dist/room";');
    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    const entry = await readFile(path, "utf8");

    await expect(eject()).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.message).toContain("@pithy-sh/turnstile/dist/room");
      expect(error.payload.action ?? "").not.toBe("");
      return true;
    });
    // And the refusal lands before either write. A config naming the fork while the entry still named the
    // package would be the half-repointed state this ordering exists to prevent.
    expect(await readFile(join(worker, "pithy.config.ts"), "utf8")).toBe(config);
    expect(await readFile(path, "utf8")).toBe(entry);
  });

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
