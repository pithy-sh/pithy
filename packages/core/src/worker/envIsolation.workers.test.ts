// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";

/**
 * **workerd does not inherit the host environment, and this is where that stops being prose.**
 *
 * `packages/cli/src/ci/testIsolation.test.ts` exempts every `*.workers.test.ts` project from the
 * config-directory and blank-token guards, and the exemption rests entirely on the claim asserted
 * below: nothing from the operator's shell crosses into workerd, so there is no ambient credential to
 * blank and no real `HOME` to relocate. A guard there would be inert by construction.
 *
 * **The portable half of that claim no longer runs only here (#437).** This file certified one workers
 * project out of seventeen, and an exemption over seventeen resting on one of them is an argument about
 * a set made from a sample. So the repository-root `vitest.workers.setup.ts` refuses any Cloudflare
 * credential visible inside workerd and every workers project loads it. What stays here is the exact
 * equality below, which is core's and only core's, for the reason the next paragraph gives.
 *
 * That claim was carried as a probed sentence in a docblock and in `CONTRIBUTING.md`, measured once on
 * workerd `1.20260730.1`. #433 moved the harness to `@cloudflare/vitest-plugin@1.0.0` and with it to
 * workerd `1.20260820.1`, and nothing re-checked it. A fact that only a comment holds is a fact that
 * rots on the next bump, silently, in the file that justifies dropping a security guard. So it is an
 * assertion now, and `packages/cli/src/ci/testIsolation.test.ts` resolves the path it cites rather
 * than trusting it.
 *
 * **Not one key below is a binding.** They are Vite's `import.meta.env` shims and vitest's two pool
 * ids. The older wording called them "miniflare's bindings"; they never were. A binding is reached
 * through `cloudflare:test`, not `process.env`.
 *
 * **The set belongs to this config, not to the harness**, which is why the equality is stated here and
 * not offered as a fact about anyone else's project. `@pithy-sh/core` declares D1 and KV, and neither
 * kind reaches `process.env`; a `cloudflareTest({ miniflare: { bindings } })` entry does. So a project
 * that declares one sees its own key too, and the invariant to carry there is the second assertion,
 * never the first.
 */
const VITEST_WORKERD_ENV = ["BASE_URL", "DEV", "MODE", "PROD", "SSR", "VITEST_POOL_ID", "VITEST_WORKER_ID"];

/**
 * Declared here rather than reached through `@types/node`. `@pithy-sh/core` is bundled into the
 * adopter's Worker and must depend on no Node builtin, so its tsconfig carries no node types —
 * `worker-safety.test.ts` is the gate for the same rule at the import level.
 *
 * **The `nodejs_compat` flag is not what puts a `process` here, which is worth saying because the
 * obvious reading is wrong.** Measured both ways on this project: with the flag and without it,
 * `typeof process` is `"object"`, the keys below are the same seven, and `process.version` is
 * `"v22.19.0"`. The vitest pool supplies it either way. What the flag decides is whether miniflare
 * copies a declared `binding` into `process.env` — so without it, this file's equality still passes
 * while a declared credential sits in `env` from `cloudflare:test`, unseen. That is why the root guard
 * reads both and why `testIsolation.test.ts` holds every workers config to the flag.
 */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

test("a workers test sees vitest's own keys and nothing else", () => {
  expect(Object.keys(process.env).sort()).toEqual(VITEST_WORKERD_ENV);
});

/**
 * **Two names, restated rather than imported — and that is the constraint, not an oversight.**
 *
 * `packages/cli/src/ci/testIsolation.test.ts` makes the opposite call for itself, and says so:
 * `CLOUDFLARE_ENV_KEYS` is the list, imported rather than restated, so a fifth key is covered by the
 * gate the day it is declared. That list lives in `@pithy-sh/cloudflare/src/env/devVars`, and
 * `@pithy-sh/core` does not depend on `@pithy-sh/cloudflare`. It must not gain the dependency for a
 * test either: core is the package bundled into the adopter's Worker, and its dependency set is a
 * shipped surface, not a test convenience.
 *
 * The restatement costs nothing here because it proves nothing here. The equality above is the
 * invariant — an exact key set, so *every* credential is excluded by construction, including all four
 * `CLOUDFLARE_ENV_KEYS` and any fifth added later. A key that starts crossing into workerd fails the
 * first test whatever it is called. These two are the illustration: the credential and the home
 * directory the isolation gate exists for, named so the reason is legible at the assertion.
 *
 * **The version that imports the list exists, and it is not in this package (#437).** The
 * repository-root `vitest.workers.setup.ts` reads `CLOUDFLARE_ENV_KEYS` relatively — the root is not
 * core, so the dependency this file must refuse costs it nothing — and every workers project loads it,
 * including this one. It throws instead of asserting, because the repository root can resolve no bare
 * specifier and so has no `expect`. Two shapes, each paying the price its own location charges.
 */
test("no host environment crosses into workerd", () => {
  expect(process.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(process.env.HOME).toBeUndefined();
});

/**
 * **#437's guard runs, and this is the only place that can say so.**
 *
 * `packages/cli/src/ci/testIsolation.test.ts` proves all seventeen workers projects *state*
 * `vitest.workers.setup.ts`, read off the config object vitest is handed. It cannot prove the file does
 * anything. Emptied to `export {};` behind its license header, that gate stays green at eighteen passed
 * and this project stays green at seventeen files — measured, and it is how the whole mechanism can be
 * silently retired.
 *
 * So the guard records what it saw and the record is asserted from inside workerd, where the guard runs.
 * A file that no longer calls `visibleCredentialKeys` on the real environment cannot produce this value,
 * so an empty setup fails here rather than passing everywhere.
 *
 * **Empty is the assertion, not merely defined.** Undefined means the guard did not run; a non-empty
 * list means it ran and found a credential, which is the state it throws on — so reaching this line with
 * one would mean the throw had gone. One equality covers both.
 *
 * **Two keys rather than one list, because the guard reads two environments and either can be dropped.**
 * `process.env` carries a binding only while the config keeps `nodejs_compat`; `env` from
 * `cloudflare:test` carries it whatever the flags say. A single flattened list would be `[]` with either
 * scan deleted, which is the emptied-file failure again one level in. Naming both keys means a guard that
 * stopped reading one of them fails here.
 *
 * **It is checked in one project, and the set is covered by the other half.** The record is a fact about
 * this isolate; what makes it a fact about seventeen is the config gate above it, which is the same
 * division of labor the two `testIsolation.test.ts` gates already run on.
 */
interface WorkerdCredentialScan {
  /** What each of the root guard's `visibleCredentialKeys` calls returned, left where a test can read it. */
  readonly pithyWorkerdCredentialScan?: {
    readonly processEnv?: readonly string[];
    readonly bindings?: readonly string[];
  };
}

test("the shared credential guard ran in here, and saw nothing", () => {
  const scan = (globalThis as unknown as WorkerdCredentialScan).pithyWorkerdCredentialScan;
  expect(scan, "vitest.workers.setup.ts left no record — it did not run, or it no longer scans").toEqual({
    processEnv: [],
    bindings: [],
  });
});
