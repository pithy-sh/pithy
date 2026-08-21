// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PithyPlugin, pithy } from "@pithy-sh/vite/src/plugin";
import { build as build6 } from "vite";
import { build as build7 } from "vite7";
import { build as build8 } from "vite8";
import { afterAll, describe, expect, test } from "vitest";

/**
 * The plugin's hooks, driven by each Vite in the peer range rather than described to it.
 *
 * **`peerRange.ts` next door proves something narrower than it looks — Jim, 2026-08-21.** It proves a
 * two-property object is a `PluginOption` in 6, 7 and 8, which is the fix for #414 and is not a claim
 * about the hooks at all. `PithyPlugin` names no Vite type precisely so an adopter's checker never
 * compares one, and the cost of that is exact: **nothing in a type can any longer say the hooks work at
 * Vite 6.** The kit declares `^6.1.0`. That has to be paid for somewhere.
 *
 * It cannot be paid in types, and the reason is worth stating once. Vite 8 is rolldown-based; 6 and 7
 * are rollup-based. `hotUpdate`'s `this` is `MinimalPluginContext & { environment: DevEnvironment }`
 * out of two different bundlers, and rolldown's `meta` carries a `rolldownVersion` rollup's does not —
 * so no single object can be written `satisfies Plugin` against both. Restoring `pithy(): Plugin`
 * reports precisely that at 6.1.6 and 7.0.0. It is a fact about the two Vites, not about this plugin,
 * and a checker will never agree that the same object is both.
 *
 * So it is paid by running it. Each major builds a real project through the plugin, from its own
 * `build()`, and the assertions are the ones that matter to an adopter: the projection is inlined, the
 * environment threaded, and a config value the capability did not project is not in the bundle. That
 * covers `configResolved`, `resolveId` and `load` — the three hooks a build calls.
 *
 * **What is still on trust, said out loud.** `configureServer` and `hotUpdate` are dev-server hooks; no
 * build calls them, and `packages/vite`'s `plugin.test.ts` drives them against one Vite. Across the
 * range they are covered by name only — `PITHY_PLUGIN_HOOKS` against each major's `keyof Plugin`, in
 * `peerRange.ts`. That is the accepted gap. It is narrow: both read the arguments Vite has passed since
 * the Environment API landed in 6.0, and `^6.1.0` is the floor because `hotUpdate` itself arrived in
 * 6.1 and the plugin would be silently inert below it.
 *
 * One thing this does not reproduce and cannot: `loadWorkerConfig` reaches `runnerImport` from the Vite
 * `@pithy-sh/vite` resolves, which in this monorepo is the kit's 8.2.1 whichever `build` is running
 * outside it. A real adopter on Vite 6 has one copy doing both. The hooks are still being called by
 * Vite 6's plugin container with Vite 6's arguments, which is the half that was unproven.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A `pithy.config.ts` holding one secret the projection does not carry, and one value it does. */
const CONFIG = `
export default {
  capabilities: [
    {
      name: "auth",
      requiredBindings: [],
      secret: "sk_test_never_ship_this",
      client: (context) => ({
        enabled: true,
        otpLength: 6,
        turnstileSitekey: context.environment === "production" ? "0x4AAA_prod" : "0x4AAA_dev",
      }),
    },
  ],
};
`;

/** A screen, as an adopter writes one: it imports its backend's projection and branches on `enabled`. */
const ENTRY = [
  'import auth from "virtual:pithy/auth";',
  'import ledger from "virtual:pithy/ledger";',
  "export const screen = { auth, ledger };",
].join("\n");

/** A scratch Worker directory, written fresh per build so no run can read another's output. */
async function workerDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-adopter-"));
  dirs.push(dir);
  await writeFile(join(dir, "pithy.config.ts"), CONFIG, "utf8");
  await writeFile(join(dir, "entry.ts"), ENTRY, "utf8");
  return dir;
}

/**
 * The whole `InlineConfig` an adopter passes, stated once and handed to all three `build`s.
 *
 * The explicit return type is doing work. Written once and passed three times, it is checked against
 * each major's own `InlineConfig` at the call site — so this file also proves the surrounding config
 * compiles, not only the `plugins` array `peerRange.ts` annotates.
 */
function inline(dir: string): {
  root: string;
  configFile: false;
  logLevel: "silent";
  plugins: [PithyPlugin];
  build: { write: false; minify: false; lib: { entry: string; formats: ["es"]; fileName: string } };
} {
  return {
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [pithy({ environment: "production" })],
    build: { write: false, minify: false, lib: { entry: "entry.ts", formats: ["es"], fileName: "entry" } },
  };
}

/** Every chunk a `write: false` build returned, joined. The three majors agree on this shape. */
function bundled(result: unknown): string {
  const results = (Array.isArray(result) ? result : [result]) as { output?: { type: string; code?: string }[] }[];
  return results
    .flatMap((one) => one.output ?? [])
    .filter((chunk) => chunk.type === "chunk")
    .map((chunk) => chunk.code ?? "")
    .join("\n");
}

/** What an adopter gets out of the build, whichever major they are on. */
function expectPithyBundle(code: string): void {
  // The projection reached the bundle, and the environment threaded through to it.
  expect(code).toContain("0x4AAA_prod");
  expect(code).toMatch(/"?otpLength"?:\s*6/);
  expect(code).not.toContain("0x4AAA_dev");
  // The security boundary: a config value the capability did not project is not shipped.
  expect(code).not.toContain("sk_test_never_ship_this");
  // An uncomposed capability still resolves, disabled, so the screen branches rather than failing.
  expect(code).toMatch(/"?enabled"?:\s*false/);
}

describe("the plugin's hooks, run by every Vite in the peer range", () => {
  test("vite 6.1.6 builds through pithy()", async () => {
    expectPithyBundle(bundled(await build6(inline(await workerDir()))));
  }, 60_000);

  test("vite 7.0.0 builds through pithy()", async () => {
    expectPithyBundle(bundled(await build7(inline(await workerDir()))));
  }, 60_000);

  test("vite 8.0.0 builds through pithy()", async () => {
    expectPithyBundle(bundled(await build8(inline(await workerDir()))));
  }, 60_000);
});
