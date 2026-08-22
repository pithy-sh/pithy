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
 * The setup file every *workers* project loads instead: the guard that refuses a Cloudflare credential
 * inside workerd (#437).
 *
 * Instead, not as well. {@link CONFIG_DIR_SETUP} reaches for `node:fs` and `node:os` to mint a throwaway
 * directory, and there is no filesystem in workerd to mint one on. The two setups answer to two
 * runtimes, so a config states exactly one of them and `packages/cli/src/ci/testIsolation.test.ts`
 * gates each set against its own.
 *
 * Absolute, for the reason above it: a config states it without counting `../` segments, and the gate
 * compares paths rather than spellings.
 */
export const WORKERS_ENV_SETUP = fileURLToPath(new URL("./vitest.workers.setup.ts", import.meta.url));

/**
 * The off switch on the `process.env` credential overlay — `PITHY_OFFLINE_ENV` in `@pithy-sh/cli`'s
 * `cloudflare/config`, which owns it (#218).
 *
 * **Spelled here rather than imported, and that is a cost rather than a preference.** A vitest config is
 * loaded by vite's own loader, which bundles this file's relative imports and leaves every bare specifier
 * to node — so importing the CLI's `cloudflare/config` reaches `@pithy-sh/core/src/error/pithyError`
 * externalised, whose own extensionless `./payload` node then cannot resolve. Every config in the tree
 * fails to load, before a test runs. {@link CLOUDFLARE_ENV_KEYS} is importable because
 * `@pithy-sh/cloudflare`'s `env/devVars` imports nothing at all.
 *
 * **A copy is a second place for a name to be right, and this one is not yet gated.**
 * `packages/cli/src/ci/testIsolation.test.ts` is where that belongs — it already loads every config and
 * reads the object vitest is handed, and it *can* import `PITHY_OFFLINE_ENV`, because a test file is
 * transformed rather than externalised. An assertion there that every unit project pins the real
 * constant blank would catch both a config that dropped it and a rename that left this string behind.
 * Until it exists, the drift this file's other constant cannot suffer, this one can.
 */
const OFFLINE_ENV = "PITHY_OFFLINE";

/**
 * Every Cloudflare credential key, blanked — the whole of {@link CLOUDFLARE_ENV_KEYS}, never a copy of
 * today's four names. A fifth key is covered by the commit that adds it, which is the only reason this
 * is derived rather than written out.
 *
 * Empty is unset: that is exactly how the `process.env` overlay in `@pithy-sh/cli`'s `cloudflare/config`
 * treats a blank value, so a unit test resolves no account rather than a broken one.
 *
 * **And {@link OFFLINE_ENV} is pinned with them, because it decides what they mean (#227).** Set it and a
 * resolution refuses the ambient pair outright. It is the supported way to run the CLI in a sandbox, it
 * is in every agent brief, and `CONTRIBUTING.md` recommends it — so a developer exports it once, in their
 * shell, and every unit run in this tree inherits it. Two suites that supply their credentials *through*
 * that overlay went red the first time somebody did: four tests in
 * `cli/src/doctor/probeAccountEvidence.test.ts` and one in `cli/src/commands/add.test.ts`. An agent
 * reported them as breakage on `main`, which they were not.
 *
 * A guard that silently changes a test outcome teaches people to stop setting it, which is the opposite
 * of what it is for. So it is pinned exactly as the credential keys are, for the same sentence: **a unit
 * result is a fact about the code, not about the shell it ran in.** Blank is not offline, so the pin
 * restores the resolution those suites already assume, and a test that wants the offline path sets it
 * itself with `vi.stubEnv` — where the reader of that test can see it.
 *
 * **Unit configs only.** An integration config that blanked the credentials would have nothing to test,
 * and one that pinned this would be answering for a suite whose whole point is the network.
 */
export const NO_ACCOUNT: Readonly<Record<string, string>> = Object.fromEntries([
  ...CLOUDFLARE_ENV_KEYS.map((key) => [key, ""]),
  [OFFLINE_ENV, ""],
]);

/**
 * The two budgets every unit and workers project states, and the reason they are not vitest's defaults.
 *
 * **Twenty-two of twenty-three packages had never chosen either number** (#361). Only `@pithy-sh/cli`
 * set `testTimeout`, so every other suite in this repository — including every workers suite, each of
 * which spawns workerd and talks to real D1 — ran against vitest's out-of-the-box `testTimeout` of
 * **5,000ms** and `hookTimeout` of **10,000ms**. Nothing decided that. It is what you get for saying
 * nothing, and it is far too tight for a suite doing real I/O on a machine running `bun run test`,
 * which starts twenty-three packages at `--concurrency=50%` and deliberately oversubscribes the box.
 *
 * **The measurement, so a later reader can check it rather than take it.** Every case in five packages
 * was timed under a real parallel load. The slowest legitimate case in the whole measured population is
 * **3,287ms** (`storage`, `sweep.workers.test.ts`, chunking a page past D1's bound-parameter cap) —
 * against the 5,000ms default that is a **1.5x margin**. A dozen more sat between 1.6s and 2.5s, all
 * inside 3x. Meanwhile `bun run test --force` on this box produced a measured **7.5x** whole-file
 * slowdown versus running the same file alone. A population whose margins are 1.5x-3x under a 7.5x
 * spread does not fail sometimes; it fails on a schedule nobody can predict, and it did — three
 * separate packages went red on three consecutive full runs, each passing alone straight afterwards.
 *
 * **These are hang ceilings, not margins any test is meant to live in.** 60,000ms is ~18x the slowest
 * case ever measured here and 120,000ms is ~39x the slowest hook. Nothing should approach either; a
 * test that does has hung, which is the only thing a timeout is any good at catching. **Slowness is not
 * what these numbers are for** — a case creeping from 300ms to 3s is a real regression and one of these
 * would never notice it. That is what timing the population catches, and #361's report is the worked
 * example of doing it.
 *
 * A project needing genuinely longer states it on the case, where the reader of that case can see it —
 * as `cli`'s `e2e.test.ts` and `scaffoldGates.test.ts` already do. **Integration configs set their own**
 * and deliberately do not use these: those suites wait on live Cloudflare, and their budgets answer to
 * the network rather than to this machine.
 *
 * `packages/cli/src/ci/testIsolation.test.ts` gates that every unit project actually states both, for
 * the same reason it gates the other two constants here: a config is a place to forget.
 */
export const UNIT_BUDGETS: Readonly<{ testTimeout: number; hookTimeout: number }> = {
  testTimeout: 60_000,
  hookTimeout: 120_000,
};
