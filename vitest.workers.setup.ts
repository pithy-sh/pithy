// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { visibleCredentialKeys } from "./packages/cloudflare/src/env/devVars";

/**
 * Refuse a Cloudflare credential inside workerd. Every workers project loads this (#437).
 *
 * **The exemption it closes was right about one path and silent about the other.**
 * `packages/cli/src/ci/testIsolation.test.ts` drops every workers project from #198's blank-credential
 * guard, because workerd inherits nothing from the operator's shell — there is no ambient token to
 * blank, and a guard against one would be inert by construction. True, and asserted from inside workerd
 * by `packages/core/src/worker/envIsolation.workers.test.ts`.
 *
 * It says nothing about **declaration**. A `cloudflareTest({ miniflare: { bindings } })` entry puts a
 * host-computed value into workerd by design, and five configs use it for
 * `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()` — a key minted for the test, from no environment, and
 * exactly what bindings are for. One line over is `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`,
 * which is #198 arriving through the exempt door. Nothing refused it.
 *
 * So core's portable claim runs everywhere instead of in one project out of seventeen. What is checked
 * is the environment workerd actually has, whatever put it there — a binding, a future pool option, a
 * harness change nobody read. It is deliberately not a check on how the value was spelled.
 *
 * **Two environments are read, and the second one is the guard rather than a second opinion.**
 * `process.env` is where a binding lands, and it lands there **only while the config keeps
 * `compatibilityFlags: ["nodejs_compat"]`**. Measured on `@pithy-sh/core`: drop that one line, declare
 * `bindings: { CLOUDFLARE_API_TOKEN: "leaked-nocompat" }`, and this scan returns `[]`, three tests pass,
 * and the credential is fully reachable from any test through `env` from `cloudflare:test`. So a scan of
 * `process.env` alone was a guard one deleted line could blind.
 *
 * **And blindness cannot be detected from in here, which is why the bindings are read instead of
 * asserted about.** The obvious answer — refuse to run where there is no `process` — checks a
 * difference that does not exist: with the flag and without it, `typeof process` is `"object"`,
 * `Object.keys(process.env)` is the same seven vitest keys, and `process.version` is `"v22.19.0"`
 * either way. The vitest pool puts a full Node `process` in scope regardless; what the flag decides is
 * whether miniflare copies the bindings into it. An environment that is blind and an environment that
 * is clean are byte-identical, so the only honest fix is to read the thing the flag cannot hide.
 * `cloudflare:test` is the plugin's own virtual module, resolved by its `resolveId` hook rather than by
 * node, so the wall below does not apply to it. `testIsolation.test.ts` holds every workers config to
 * the flag as well — the runtime the capabilities are tested on is worth stating in its own right.
 *
 * **What this cannot catch, and its other half.** A declaration reading the operator's shell carries
 * nothing on a machine with no token exported — every CI runner — so this guard sees an empty
 * environment and passes over a real leak on precisely the machine the gate has to be trusted on.
 * Measured, on one planted config in `@pithy-sh/leaderboard`. The issue's literal example,
 * `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`, does not get that far: miniflare's own
 * option schema refuses `undefined` and the pool will not start. But that error names a type, not a
 * credential, and the shape an author writes next is `process.env.CLOUDFLARE_API_TOKEN ?? ""` — which
 * ran **166 tests green** here with no token exported, and reaches a live account on any machine that
 * has one. Blank is unset, so this guard is right to pass it; the declaration is still the defect.
 * `testIsolation.test.ts`'s source scan refuses it, reading the text and caring nothing for the shell.
 * Two halves of one property: the scan owns the declaration, this owns the runtime.
 *
 * **It throws rather than asserts, and that is the root's constraint rather than a choice.** This file
 * sits above every `node_modules/` holding vitest, so a bare `import … from "vitest"` resolves from the
 * repository root and finds nothing — the wall `vitest.setup.ts` records. A relative import of a
 * repository file is a different mechanism and works: `vitest.shared.ts` already reaches
 * `env/devVars` that way, which is safe because that module imports nothing at all and must keep
 * importing nothing. The assertion given up is bought back in `env/devVars.test.ts`, where the decision
 * is a pure function with four cases. A throw here fails every test file in the project at collection,
 * naming the key and this file, which is the right blast radius for a credential in a test runtime.
 *
 * **And the call is gated too, because for one review it was not.** Every gate around this file checked
 * that seventeen configs *cite* it and that the predicate is correct. Replace the body below with
 * `export {};` and both stay green — measured: `testIsolation.test.ts` at 18 passed, `@pithy-sh/core`'s
 * workers project at 169. A guard nothing can tell from an empty file is the shape this repository
 * refuses one level down and had missed one level up. So both scans are recorded on `globalThis` and
 * `packages/core/src/worker/envIsolation.workers.test.ts` reads the record back from inside workerd,
 * where this runs. Two keys, not a list: dropping either scan leaves a record that test can name. The
 * throw itself is the one clause still held by text, in `testIsolation.test.ts`: proving it at runtime
 * means putting a real credential into a real workers pool, which is the thing being refused.
 */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** The channel the record travels on. `globalThis` is the only one a setup file shares with its tests. */
interface WorkerdCredentialScan {
  /** What each scan returned here. Absent means this file never ran; a missing key means a scan went. */
  pithyWorkerdCredentialScan?: { readonly processEnv: readonly string[]; readonly bindings: readonly string[] };
}

/**
 * The bindings, as a scannable environment. Only the string ones: a D1 or KV binding is an object and
 * is not a credential, and coercing one would report `[object Object]` as a value.
 */
function stringValues(source: Readonly<Record<string, unknown>>): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

const scan = {
  processEnv: visibleCredentialKeys(process.env),
  bindings: visibleCredentialKeys(stringValues(env as Readonly<Record<string, unknown>>)),
};

(globalThis as unknown as WorkerdCredentialScan).pithyWorkerdCredentialScan = scan;

const visible = [...new Set([...scan.processEnv, ...scan.bindings])];

if (visible.length > 0) {
  throw new Error(
    `A Cloudflare credential is visible inside workerd: ${visible.join(", ")}. ` +
      `Remove it from this project's vitest.workers.config.ts — a workers suite never reaches a real account.`,
  );
}
