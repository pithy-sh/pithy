// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The oldest Node `pithy` works on, and the refusal for anything older.
 *
 * Kept here, dependency-free, for the reason `rootFlags.ts` is: `bin.ts` is an entry script with
 * top-level side effects, so a rule that lives in it cannot be tested. This is a pure function and a
 * constant, and `nodeFloor.test.ts` exercises both.
 *
 * ## Why the floor is not the kit's
 *
 * The libraries ship compiled JavaScript and genuinely run on Node 22.0. The CLI does more: it imports
 * the adopter's `pithy.config.ts` — TypeScript, in their own tree — and resolves the extensionless
 * relative imports inside it. Both are runtime features newer than 22.0:
 *
 * - **22.18** — unflagged type stripping, without which a `.ts` config cannot be imported at all
 * - 22.15 — `module.registerHooks`, which `project/typescriptResolve.ts` uses for the specifiers node
 *   will not resolve on its own
 *
 * So 22.18 is the real floor, and it is stated on `@pithy-sh/cli` alone rather than raised across all
 * twenty-two — a floor nobody needs is adopters excluded for nothing.
 *
 * ## Why it is checked at runtime as well as declared
 *
 * `engines` is advisory: npm warns and installs anyway unless somebody set `engine-strict`. Without
 * this an adopter on 22.10 installs cleanly and then meets a failure inside their own config that says
 * nothing about their Node version — which is the shape of unfollowable guidance #489 is about.
 */

/** The floor, as `engines.node` in this package's manifest states it. `manifests.test.ts` holds them equal. */
export const MINIMUM_NODE = [22, 18, 0] as const;

/**
 * Whether `actual` is older than `minimum`, compared the way a version is read.
 *
 * Component by component, deciding at the **first** that differs. Compared component-wise and
 * independently — the first way this was written — 24.13.0 reads as older than 22.18.0 because 13 is
 * less than 18, and the CLI refused to start on the newest Node there is.
 */
export function olderThan(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const running = actual[index] ?? 0;
    const wanted = minimum[index] ?? 0;
    if (running !== wanted) return running < wanted;
  }
  return false;
}

/**
 * The refusal for `version`, or `null` when it is supported.
 *
 * A version that will not parse answers `null`: refusing to start over a string we could not read is
 * worse than trying, and a runtime reporting something unexpected is not evidence that it is old.
 */
export function unsupportedNodeMessage(version: string): string | null {
  // Each component must be digits. `Number("")` is 0 and `Number.isFinite(0)` is true, so parsing with
  // `Number` alone reads the empty string as version zero and refuses to start over nothing at all.
  const raw = version.split(".");
  if (!raw.every((part) => /^\d+$/.test(part))) return null;
  const parts = raw.map(Number);
  if (!olderThan(parts, MINIMUM_NODE)) return null;
  return (
    `pithy needs Node ${MINIMUM_NODE.join(".")} or newer, and this is ${version}.\n` +
    "It loads your pithy.config.ts, which needs the TypeScript support Node added in 22.18.\n"
  );
}
