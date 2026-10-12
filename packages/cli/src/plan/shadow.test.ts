// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { snapshotTree } from "../test-utils/treeSnapshot";
import { inShadow } from "./shadow";

/**
 * **A dry run runs the real write, somewhere else (#697).** The plan a person reviews is only worth
 * anything if it is the change the real run makes, so `add` and `ui add` do not describe their writes —
 * they make them, in a copy of the project, and the plan is the difference. These hold the copy to the
 * two things that makes safe: the project is never touched, and the difference is exactly the write.
 */

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "pithy-shadow-test-"));
  await mkdir(join(project, "apps", "api"), { recursive: true });
  await writeFile(join(project, "package.json"), '{ "name": "acme" }\n');
  await writeFile(join(project, "apps", "api", "wrangler.jsonc"), '{\n  "name": "acme-api"\n}\n');
  await writeFile(join(project, "apps", "api", "keep.ts"), "export {};\n");
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("inShadow", () => {
  test("a write in the copy is a planned edit, with its diff, and the project is untouched", async () => {
    const before = await snapshotTree(project);
    const { result, files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "wrangler.jsonc")), '{\n  "name": "acme-board"\n}\n');
      return "ran";
    });
    expect(result).toBe("ran");
    expect(files).toEqual([
      {
        path: "apps/api/wrangler.jsonc",
        action: "edit",
        changes: [],
        diff: '@@ -1,3 +1,3 @@\n {\n-  "name": "acme-api"\n+  "name": "acme-board"\n }\n',
      },
    ]);
    expect(await snapshotTree(project)).toEqual(before);
  });

  test("a new file is a create, a removed one a delete, an untouched one nothing", async () => {
    const { files } = await inShadow(project, async (shadow) => {
      await mkdir(shadow.at(join(project, "apps", "api", "src")), { recursive: true });
      await writeFile(shadow.at(join(project, "apps", "api", "src", "new.ts")), "export const a = 1;\n");
      await rm(shadow.at(join(project, "apps", "api", "keep.ts")));
    });
    expect(files).toEqual([
      { path: "apps/api/keep.ts", action: "delete", changes: [] },
      { path: "apps/api/src/new.ts", action: "create", changes: [], diff: "@@ -0,0 +1 @@\n+export const a = 1;\n" },
    ]);
  });

  test("the copy is gone afterwards, and gone when the work throws", async () => {
    let root = "";
    await inShadow(project, async (shadow) => {
      root = shadow.root;
    });
    expect(existsSync(root)).toBe(false);
    await expect(
      inShadow(project, async (shadow) => {
        root = shadow.root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(root)).toBe(false);
  });

  test("node_modules is reached through a link, never copied, and never planned", async () => {
    await mkdir(join(project, "node_modules", "@pithy-sh", "auth"), { recursive: true });
    await writeFile(join(project, "node_modules", "@pithy-sh", "auth", "package.json"), '{ "version": "1.0.0" }\n');
    const { result, files } = await inShadow(project, async (shadow) =>
      readFile(join(shadow.root, "node_modules", "@pithy-sh", "auth", "package.json"), "utf8"),
    );
    expect(result).toContain("1.0.0");
    expect(files).toEqual([]);
  });

  test("what a dry run has no business reading is not copied: git, build output, local state, secrets", async () => {
    for (const dir of [".git", ".wrangler", "apps/api/dist", ".turbo"]) {
      await mkdir(join(project, dir), { recursive: true });
      await writeFile(join(project, dir, "x"), "x");
    }
    await writeFile(join(project, ".dev.vars"), "SECRET=1\n");
    await writeFile(join(project, "apps", "api", ".env.local"), "SECRET=1\n");
    await inShadow(project, async (shadow) => {
      for (const path of [".git/x", ".wrangler/x", "apps/api/dist/x", ".turbo/x", ".dev.vars", "apps/api/.env.local"]) {
        expect(existsSync(join(shadow.root, path)), path).toBe(false);
      }
      expect(existsSync(join(shadow.root, "apps", "api", "keep.ts"))).toBe(true);
    });
  });

  test("a link inside the project is kept as a link; one leading out of it is not copied", async () => {
    await symlink("keep.ts", join(project, "apps", "api", "alias.ts"));
    const outside = await mkdtemp(join(tmpdir(), "pithy-shadow-outside-"));
    await symlink(outside, join(project, "apps", "out"));
    try {
      await inShadow(project, async (shadow) => {
        expect(await readFile(join(shadow.root, "apps", "api", "alias.ts"), "utf8")).toBe("export {};\n");
        expect(existsSync(join(shadow.root, "apps", "out"))).toBe(false);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("the copy's own path never reaches a plan: a diff and a sentence both name the project", async () => {
    const { result, files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "keep.ts")), `// ${shadow.root}/apps/api\n`);
      return shadow.toProject(`Wrote ${shadow.root}/apps/api/keep.ts.`);
    });
    expect(result).toBe(`Wrote ${project}/apps/api/keep.ts.`);
    expect(files[0]?.diff).toContain(`+// ${project}/apps/api`);
  });

  /**
   * A write that differs from the project only by the copy's own root — a generated config holding an absolute
   * path, regenerated — is the file that is there, put back in the project's terms. Not an edit, and never an
   * edit with an empty diff (#697).
   */
  test("a file that differs only by the copy's root is unchanged, not an edit", async () => {
    const config = join(project, "apps", "api", "wrangler.jsonc");
    await writeFile(config, `{\n  "main": "${project}/apps/api/src/index.ts"\n}\n`);
    const { files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(config), `{\n  "main": "${shadow.root}/apps/api/src/index.ts"\n}\n`);
    });
    expect(files).toEqual([]);
  });

  test("a path outside the project has no place in the copy", async () => {
    await inShadow(project, async (shadow) => {
      expect(() => shadow.at(tmpdir())).toThrow(/outside the project/);
    });
  });

  test("a binary file is planned without a diff", async () => {
    const { files } = await inShadow(project, async (shadow) => {
      await writeFile(shadow.at(join(project, "apps", "api", "icon.png")), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    });
    expect(files).toEqual([{ path: "apps/api/icon.png", action: "create", changes: ["Binary file."] }]);
  });
});
