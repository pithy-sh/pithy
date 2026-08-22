// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ResolvedConfig } from "vite";
import { afterAll, describe, expect, test } from "vitest";
import { type PithyPlugin, pithy } from "./plugin";
import { pithyTest } from "./testPlugin";

const run = promisify(execFile);

/**
 * **The gap this file closes, stated once (#366).**
 *
 * A module that reads `virtual:pithy/*` could be built and could not be tested. Vitest bundles its
 * config and hands every bare specifier to node, so `@pithy-sh/vite/src/plugin` in a `vitest.config.ts`
 * stopped at an extensionless import inside `@pithy-sh/core` and the config never loaded — and the
 * failure is transitive, so one unreadable projection took every screen that reaches it. Three lanes in
 * `pithy-sh/dashboard` hit it independently.
 *
 * So the checks here are child processes rather than hook calls. **The subject is a real `vitest` run
 * with its real config loader**; nothing smaller can be wrong in the way this was wrong.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** This package's own directory — what an adopter's `@pithy-sh/vite` resolves to. */
const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The installed vitest package, and the CLI inside it. Resolved, never a guessed `node_modules` path. */
const VITEST_DIR = fileURLToPath(new URL("../", import.meta.resolve("vitest/node")));
const VITEST_CLI = join(VITEST_DIR, "vitest.mjs");

/**
 * A capability whose projection has every shape a restatement gets wrong: a nested object, a per-rail
 * null, an array of records, and a value that varies by environment. A flat `{ enabled: true }` would
 * pass a comparison that had stopped reading.
 */
const WORKER_CONFIG = `
export default {
  capabilities: [
    {
      name: "payments",
      requiredBindings: [],
      client: (context) => ({
        enabled: true,
        environment: context.environment,
        rails: { stripe: false, lemonSqueezy: false, paddle: true },
        paddle: { clientToken: "test_366", environment: "sandbox", checkout: "overlay" },
        products: [
          { id: "solo", name: "Solo", skus: { stripe: null, lemonSqueezy: null, paddle: "pri_366" } },
        ],
      }),
    },
  ],
};
`;

/**
 * The adopter's two modules, and the point of there being two.
 *
 * `projection.ts` is the one that reads `virtual:pithy/payments` — the dashboard's `pithy-config.tsx`.
 * `screen.ts` imports it and names no virtual module at all — the dashboard's `panes/screen.tsx`, which
 * every pane test mounts. The test file below imports **only** `screen.ts`, so what it proves is the
 * transitive property: a consumer two hops from the projection configures nothing.
 */
const PROJECTION_MODULE = `
import payments from "virtual:pithy/payments";
export const projection = payments;
`;

const SCREEN_MODULE = `
import { projection } from "./projection";
export function mount() {
  return projection;
}
`;

/**
 * What the child asserts: the module it imported, serialized, against the module the **build** plugin
 * renders — passed in as a string by the parent.
 *
 * `JSON.stringify` rather than `toEqual`, on purpose. Key order survives the round trip, so this is a
 * comparison of bytes: a projection that agreed in value and differed in shape would still fail.
 */
const MOUNTED_TEST = `
import { expect, test } from "vitest";
import { mount } from "./screen";

test("what a test imports is what the build inlines", () => {
  const expected = process.env.PITHY_366_EXPECTED;
  expect(typeof expected).toBe("string");
  expect(JSON.stringify(mount())).toBe(expected);
});
`;

function vitestConfig(plugin: string, from: string): string {
  return `
import { ${plugin} } from "${from}";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [${plugin}()],
  test: { name: "adopter", environment: "node", include: ["*.test.ts"] },
});
`;
}

/**
 * A throwaway project laid out the way an adopter's is: `node_modules` carries the two packages its
 * config names, so the config's specifiers are the bare ones an adopter writes rather than relative
 * paths a bundler would inline. That distinction is the whole defect — see the header.
 */
async function adopterProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-366-"));
  dirs.push(dir);
  await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
  await symlink(PACKAGE_DIR, join(dir, "node_modules", "@pithy-sh", "vite"), "dir");
  await symlink(VITEST_DIR, join(dir, "node_modules", "vitest"), "dir");
  await writeFile(join(dir, "package.json"), '{ "name": "adopter", "private": true, "type": "module" }\n');
  await writeFile(join(dir, "pithy.config.ts"), WORKER_CONFIG);
  await writeFile(join(dir, "projection.ts"), PROJECTION_MODULE);
  await writeFile(join(dir, "screen.ts"), SCREEN_MODULE);
  await writeFile(join(dir, "mounted.test.ts"), MOUNTED_TEST);
  await writeFile(join(dir, "vitest.config.ts"), vitestConfig("pithyTest", "@pithy-sh/vite/src/testPlugin"));
  await writeFile(join(dir, "vitest.build.config.ts"), vitestConfig("pithy", "@pithy-sh/vite/src/plugin"));
  return dir;
}

/** One child `vitest run`, with its real config loader. Never throws — the exit code is the subject. */
async function childVitest(dir: string, args: string[], expected: string) {
  try {
    const { stdout, stderr } = await run(process.execPath, [VITEST_CLI, "run", ...args], {
      cwd: dir,
      env: { ...process.env, PITHY_366_EXPECTED: expected, CI: "true" },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (cause: unknown) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/**
 * The module the **build** renders, as the source text vite would inline.
 *
 * Driven through the plugin's own hooks, exactly as `plugin.test.ts` drives them. This is the reference
 * side of the comparison: it is produced by the code path a `vite build` takes, not by a fixture.
 */
async function builtProjection(dir: string, name: string): Promise<string> {
  const hooks = pithy() as unknown as {
    configResolved: (config: ResolvedConfig) => void;
    resolveId: (id: string) => string | null;
    load: (id: string) => Promise<string | null>;
  };
  hooks.configResolved({ root: dir } as ResolvedConfig);
  const resolved = hooks.resolveId(`virtual:pithy/${name}`);
  expect(resolved).toBe(`\0virtual:pithy/${name}`);
  const code = await hooks.load(resolved as string);
  const match = /^export default (.*);$/m.exec(code ?? "");
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

describe("a module reading the projection is testable, and reads the real one", () => {
  test("a test two hops from the projection imports exactly what the build inlines", { timeout: 120_000 }, async () => {
    const dir = await adopterProject();
    const expected = await builtProjection(dir, "payments");
    // The reference is the real projection, not `{ enabled: false }`. Without this the comparison
    // below would hold between two absent capabilities and prove nothing.
    expect(expected).toContain('"pri_366"');

    const { code, output } = await childVitest(dir, [], expected);
    expect({ code, output }).toEqual({ code: 0, output });
    expect(output).toContain("1 passed");
  });

  test("the build plugin still cannot be loaded from a vitest config — which is why this one exists", {
    timeout: 120_000,
  }, async () => {
    const dir = await adopterProject();
    const { code, output } = await childVitest(dir, ["--config", "vitest.build.config.ts"], "{}");
    // Named rather than merely non-zero: a fixture typo also exits non-zero, and would read as this.
    expect(output).toContain("failed to load config");
    expect(code).not.toBe(0);
    // When this test fails because the child now passes, vitest has changed how it loads a config and
    // `pithyTest` has become a redirect nobody needs. Delete it then, and not before.
  });

  test("it resolves to the build plugin itself, not to a second one", async () => {
    const plugin: PithyPlugin = await pithyTest();
    expect(plugin.name).toBe("pithy");
    // Every hook the build plugin declares, and no hook it does not. A stub answering the same module
    // shape would pass a value comparison and fail here.
    expect(Object.keys(plugin).sort()).toEqual(Object.keys(pithy()).sort());
  });
});
