// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { kitSource } from "./kitSource";

/**
 * **The host worker wrangler is handed is the project's, not the CLI's — #533's silent half.**
 *
 * Nine commands resolve a host worker's source directory this way and hand it to `wrangler deploy`:
 * storage, email, hosts, payments, testers, support, media, vector, secrets. `kitSource` resolved with
 * `import.meta.resolve`, whose base is `kitSource.ts` itself, so a globally installed `pithy` answered
 * with **its own** bundled copy — a real path, no error, nothing said — and deployed the CLI's worker
 * under the adopter's name, against the adopter's database.
 *
 * That half shipped with no test at all, and the gate beside it could not see the defect either: its
 * extractor matched `import.meta.resolve("@pithy-sh/…")` with a **string literal**, and this file's call
 * passed a variable. So the one site the issue's own survey had to be extended to find was invisible to
 * the check written to find it. `ci/kitResolution.test.ts` now refuses `import.meta.resolve` outright,
 * whatever its argument, and this is the behavioral half of the same claim.
 *
 * ## The fixture is a shipped package, not the workspace's
 *
 * A published `@pithy-sh/*` maps `./src/*` onto `./dist/*.js` and ships both trees; `kitSource` reverses
 * that mapping. So the fixture ships both, with **different contents** in each, and the assertion is that
 * the answer is the project's `src` file. Nothing about the workspace's own layout is under test — that
 * is the layout that made the bug invisible.
 */

/** The fixture project root, holding one shipped-shape `@pithy-sh/email`. */
let projectDir = "";

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-533-source-"));
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "adopter", type: "module" }));

  const pkg = join(projectDir, "node_modules", "@pithy-sh", "email");
  await mkdir(join(pkg, "dist", "workflows"), { recursive: true });
  await mkdir(join(pkg, "src", "workflows"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@pithy-sh/email",
      version: "0.0.0-fixture",
      type: "module",
      exports: { "./src/*": "./dist/*.js" },
    }),
  );
  await writeFile(join(pkg, "dist", "workflows", "worker.js"), "export default {};\n");
  await writeFile(join(pkg, "src", "workflows", "worker.ts"), "export default {} as unknown;\n");
  // What wrangler is actually after, and what `dist` never holds: the committed config beside the source.
  await writeFile(join(pkg, "src", "workflows", "wrangler.jsonc"), "{}\n");
});

describe("a host worker's source directory", () => {
  test("is the project's copy, not the CLI's", () => {
    const source = kitSource(projectDir, "@pithy-sh/email/src/workflows/worker");
    expect(source.startsWith(projectDir)).toBe(true);
    expect(source.endsWith(join("src", "workflows", "worker.ts"))).toBe(true);
  });

  // The reason the mapping exists at all. `dist` is a compiler's output and nothing copies a hand-written
  // config into it, so a directory taken from `dist` is `ENOENT` on the config sitting one tree over.
  test("holds the wrangler config the deploy reads", () => {
    const source = kitSource(projectDir, "@pithy-sh/email/src/workflows/worker");
    expect(existsSync(join(source, "..", "wrangler.jsonc"))).toBe(true);
  });

  // A resolution that lands outside a package's `dist` means the layout this depends on has changed, and
  // every host deployment is about to read the wrong directory. It refuses rather than guessing.
  test("a module that is not inside a build refuses instead of guessing", async () => {
    const pkg = join(projectDir, "node_modules", "@pithy-sh", "flat");
    await mkdir(join(pkg, "src"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@pithy-sh/flat",
        version: "0.0.0",
        type: "module",
        exports: { "./src/*": "./src/*.js" },
      }),
    );
    await writeFile(join(pkg, "src", "thing.js"), "export default {};\n");

    expect(() => kitSource(projectDir, "@pithy-sh/flat/src/thing")).toThrow(/could not be located/);
  });

  // The absent case travels through, unchanged: `kitSource` adds no second opinion about what is installed.
  test("a package the project does not have is refused as absent", () => {
    expect(() => kitSource(projectDir, "@pithy-sh/nothing/src/workflows/worker")).toThrow(/Cannot find package/);
  });
});
