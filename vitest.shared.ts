// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { CLOUDFLARE_ENV_KEYS } from "./packages/cloudflare/src/env/devVars";

/**
 * What every vitest config in this repository states, stated once.
 *
 * **Two defects in two weeks were the same defect.** #198 was a unit test reaching a live Cloudflare
 * account, because `cloudflareEnv` overlays `process.env` per key and the operator had a token exported.
 * #200 was a unit test minting real AES master keys into the operator's `~/.config/pithy`, because
 * `bootstrapAdd` resolved the real config directory when nothing forced it to resolve a fake one. Both
 * are a test resolving a real thing because no config said otherwise, and both were fixed once, in one
 * package, and left every other package exposed.
 *
 * A config is a place to forget. These two constants are what a config cannot forget without
 * `packages/cli/src/ci/testIsolation.test.ts` going red — that gate loads each config and reads the
 * object vitest will actually use, so a guard that is *present but inert* fails exactly like a missing
 * one. That distinction is not theoretical: #198's guard was a second `env:` key on the same object
 * literal, which JavaScript discards without a word, and it had never taken effect.
 */

/**
 * The setup file every project loads: one throwaway `PITHY_CONFIG_DIR` per test file.
 *
 * Absolute, so a config states it without counting `../` segments — and so the gate compares paths
 * rather than spellings.
 *
 * **Integration configs load it too.** A live suite needs the real account; it has never needed the
 * operator's real config directory, and `stateDir` refuses to resolve one under vitest anyway (#200).
 */
export const CONFIG_DIR_SETUP = fileURLToPath(new URL("./vitest.setup.ts", import.meta.url));

/**
 * Every Cloudflare credential key, blanked — the whole of {@link CLOUDFLARE_ENV_KEYS}, never a copy of
 * today's four names. A fifth key is covered by the commit that adds it, which is the only reason this
 * is derived rather than written out.
 *
 * Empty is unset: that is exactly how the `process.env` overlay in `@pithy-sh/cli`'s `cloudflare/config`
 * treats a blank value, so a unit test resolves no account rather than a broken one.
 *
 * **Unit configs only.** An integration config that blanked these would have nothing to test.
 */
export const NO_ACCOUNT: Readonly<Record<string, string>> = Object.fromEntries(
  CLOUDFLARE_ENV_KEYS.map((key) => [key, ""]),
);
