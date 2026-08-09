// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME_SCREEN, TEMPLATE_GROUPS } from "@pithy-sh/ui-react/src/templates";
import { describe, expect, test } from "vitest";
import { resolveTemplateSource } from "../project/scaffold";

/**
 * **The invariant: every co-located test a scaffolded project can contain is a test the scaffolded
 * runner collects.**
 *
 * `pithy ui add` writes a front end that is `.tsx` to the last file, and the starter's node project
 * collected `apps/*\/src/**\/*.test.ts` — so a route test beside its screen ran nowhere. With
 * `passWithNoTests` on, that is silent and green: the file exists, `bun run test` says nothing, and
 * nobody learns the screen is untested until it breaks. It is the other half of #245, where the same
 * file was a route and shipped Vitest to the browser.
 *
 * Stated against what the stub writes rather than against a literal, so a framework whose templates
 * carry another extension is caught the day it lands rather than the day someone writes its first test.
 */

/** The starter, resolved the way `pithy init` resolves it. */
const STARTER = resolveTemplateSource(import.meta.dirname).dir;

/** The shape of the starter's config, narrowed to the one field this gate reads. */
interface StarterConfig {
  test?: { projects?: ({ test?: { name?: string; include?: string[]; exclude?: string[] } } | string)[] };
}

/** Every extension a scaffolded front end puts under `apps/<worker>/src/` — derived, never listed. */
const CLIENT_EXTENSIONS: string[] = [
  ...new Set(
    [...TEMPLATE_GROUPS.base, ...TEMPLATE_GROUPS.auth, ...TEMPLATE_GROUPS.payments, HOME_SCREEN.target]
      .filter((path) => path.startsWith("src/"))
      .map((path) => extname(path))
      // Only the ones a test can be written in. A stylesheet has no test file.
      .filter((extension) => extension === ".ts" || extension === ".tsx"),
  ),
];

/**
 * Does `pattern` admit `path`? A minimal reading of the glob syntax Vitest's `include` uses — `**`,
 * `*`, and a `{a,b}` alternation — which is all the starter needs and all this gate has to understand.
 */
function admits(pattern: string, path: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const rest = pattern.slice(index);
    if (rest.startsWith("**/")) {
      source += "(?:[^/]+/)*";
      index += 2;
    } else if (rest.startsWith("*")) {
      source += "[^/]*";
    } else if (rest.startsWith("{")) {
      const close = pattern.indexOf("}", index);
      if (close === -1) throw new Error(`unclosed alternation in ${pattern}`);
      source += `(?:${pattern
        .slice(index + 1, close)
        .split(",")
        .map((option) => option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      index = close;
    } else {
      source += rest[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`^${source}$`).test(path);
}

describe("the glob reading this gate depends on", () => {
  // The matcher is the gate's own instrument, so it is calibrated before it is trusted: the pattern the
  // starter shipped before #245 must read as refusing the file that went uncollected.
  test("reads a Vitest include the way Vitest does", () => {
    expect(admits("apps/*/src/**/*.test.ts", "apps/board/src/routes/app/home.test.ts")).toBe(true);
    expect(admits("apps/*/src/**/*.test.ts", "apps/board/src/routes/app/home.test.tsx")).toBe(false);
    expect(admits("apps/*/src/**/*.test.{ts,tsx}", "apps/board/src/routes/app/home.test.tsx")).toBe(true);
    // `*` stops at a separator, and `**/` is what crosses one.
    expect(admits("apps/*/src/*.test.ts", "apps/board/src/routes/home.test.ts")).toBe(false);
    expect(admits("apps/*/src/**/*.workers.test.{ts,tsx}", "apps/board/src/bindings.workers.test.ts")).toBe(true);
  });
});

describe("a scaffolded project collects the tests it can contain", () => {
  test("the node project's include admits a co-located test in every extension the stub writes", async () => {
    const module = (await import(pathToFileURL(join(STARTER, "vitest.config.ts")).href)) as {
      default: StarterConfig;
    };
    const projects = module.default.test?.projects ?? [];
    const node = projects.find((project) => typeof project !== "string" && project.test?.name === "node");
    expect(node, "the starter no longer declares a node project").toBeDefined();
    const include = (typeof node === "string" ? undefined : node?.test?.include) ?? [];
    expect(include.length).toBeGreaterThan(0);

    expect(CLIENT_EXTENSIONS).toContain(".tsx"); // the stub writes a front end, or this gate proves nothing
    for (const extension of CLIENT_EXTENSIONS) {
      const path = `apps/board/src/routes/app/home.test${extension}`;
      expect(
        include.some((pattern) => admits(pattern, path)),
        `${path} is collected by none of ${include.join(", ")}`,
      ).toBe(true);
    }
  });

  test("the Workers-runtime split holds for those same extensions", async () => {
    // The exclude is what keeps a `*.workers.test.*` out of the node project. Widening the include
    // without widening it beside puts a Workers test into a runtime with no bindings at all.
    const module = (await import(pathToFileURL(join(STARTER, "vitest.config.ts")).href)) as {
      default: StarterConfig;
    };
    const projects = module.default.test?.projects ?? [];
    const node = projects.find((project) => typeof project !== "string" && project.test?.name === "node");
    const exclude = (typeof node === "string" ? undefined : node?.test?.exclude) ?? [];
    for (const extension of CLIENT_EXTENSIONS) {
      const path = `apps/board/src/db/schema.workers.test${extension}`;
      expect(
        exclude.some((pattern) => admits(pattern, path)),
        `${path} is excluded by none of ${exclude.join(", ")}`,
      ).toBe(true);
    }
  });
});
