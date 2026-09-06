// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { checkSharedRuntimes, describeSharedRuntimes, SHARED_RUNTIMES } from "./sharedRuntimes";

/**
 * The fixture is a resolver, not a directory tree.
 *
 * The check's whole subject is what node's resolver answers from a given root, so a table of answers is
 * a more direct statement of a case than a `node_modules` built to provoke one — and it can express
 * situations that are tedious to construct on disk, like one capability resolving a copy of its own.
 */
function resolverOver(answers: Record<string, Record<string, string>>) {
  return (from: string, name: string): string | null => {
    for (const [suffix, byName] of Object.entries(answers)) {
      if (from.endsWith(suffix)) return byName[name] ?? null;
    }
    return null;
  };
}

const PROJECT = "/app";
const HOISTED = { zod: "/app/node_modules/zod/index.js", kysely: "/app/node_modules/kysely/dist/index.js" };

describe("checkSharedRuntimes", () => {
  test("one copy each is healthy, and says which it found", () => {
    const check = checkSharedRuntimes({
      projectDir: PROJECT,
      resolveFrom: resolverOver({ "/app": HOISTED, "@pithy-sh/auth": HOISTED }),
    });

    expect(check.duplicated).toEqual([]);
    expect(check.resolutions.map((one) => one.name)).toEqual(["zod", "kysely"]);
    expect(check.resolutions[0]?.copies).toEqual(["/app/node_modules/zod"]);
  });

  // The defect itself: the adopter's own import and the kit's reach different directories.
  test("a nested copy is two copies, and both are named", () => {
    const check = checkSharedRuntimes({
      projectDir: PROJECT,
      resolveFrom: resolverOver({
        "/app": { zod: "/app/node_modules/zod/index.js" },
        "@pithy-sh/auth": { zod: "/app/node_modules/@pithy-sh/auth/node_modules/zod/index.js" },
      }),
    });

    expect(check.duplicated).toHaveLength(1);
    expect(check.duplicated[0]?.copies).toEqual([
      "/app/node_modules/@pithy-sh/auth/node_modules/zod",
      "/app/node_modules/zod",
    ]);
  });

  // Different specifiers into one copy are one copy. Without trimming at the package root, `zod` and
  // `zod/v4` would look like a duplication of the thing they are both inside.
  test("two paths into the same copy are one copy", () => {
    const check = checkSharedRuntimes({
      projectDir: PROJECT,
      resolveFrom: resolverOver({
        "/app": { zod: "/app/node_modules/zod/index.js" },
        "@pithy-sh/auth": { zod: "/app/node_modules/zod/v4/classic/external.js" },
      }),
    });

    expect(check.duplicated).toEqual([]);
    expect(check.resolutions[0]?.copies).toEqual(["/app/node_modules/zod"]);
  });

  // A project that has installed nothing, or composes no capability needing one, is not a fault.
  test("a runtime nothing resolves is absent rather than reported", () => {
    const check = checkSharedRuntimes({ projectDir: PROJECT, resolveFrom: () => null });
    expect(check).toEqual({ resolutions: [], duplicated: [] });
    expect(describeSharedRuntimes(check)).toContain("No shared runtime");
  });

  test("the three it asks about are the three the kit peers", () => {
    expect([...SHARED_RUNTIMES]).toEqual(["zod", "kysely", "hono"]);
  });
});

describe("describeSharedRuntimes", () => {
  test("healthy names what it checked, so silence is not read as not-run", () => {
    const check = checkSharedRuntimes({
      projectDir: PROJECT,
      resolveFrom: resolverOver({ "/app": HOISTED }),
    });
    expect(describeSharedRuntimes(check)).toBe("One copy each of zod, kysely.");
  });

  // The sentence has to carry the part the compiler's own message leaves out.
  test("a duplicate names the count and why it matters", () => {
    const check = checkSharedRuntimes({
      projectDir: PROJECT,
      resolveFrom: resolverOver({
        "/app": { hono: "/app/node_modules/hono/index.js" },
        "@pithy-sh/auth": { hono: "/app/node_modules/@pithy-sh/auth/node_modules/hono/index.js" },
      }),
    });

    expect(describeSharedRuntimes(check)).toBe(
      "More than one copy of hono (2). Two copies are two types, and the compiler will not say so.",
    );
  });
});
