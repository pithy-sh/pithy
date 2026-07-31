// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * `@pithy-sh/testers` is an **optional** capability, so the CLI must not hard-depend on it. Types come
 * in through type-only imports (erased at build), and every runtime value comes through
 * {@link loadTesters} — a guarded dynamic import that turns "the package isn't installed" into an
 * actionable error rather than an unresolved-module crash.
 */

/** The testers runtime surface the CLI commands need, from the project's own install. */
type TestersCapabilityModule = typeof import("@pithy-sh/testers/src/capability");
type TestersTablesModule = typeof import("@pithy-sh/testers/src/data/tables");
type TestersReadModule = typeof import("@pithy-sh/testers/src/roster/read");
type TestersWriteModule = typeof import("@pithy-sh/testers/src/roster/write");
type TestersDailyModule = typeof import("@pithy-sh/testers/src/workflows/daily");
type TestersViewModule = typeof import("@pithy-sh/testers/src/http/view");
type TestersConfigModule = typeof import("@pithy-sh/testers/src/config/config");

/** Everything `pithy testers` loads out of the optional package, in one guarded import. */
export type TestersModule = TestersCapabilityModule &
  TestersTablesModule &
  TestersReadModule &
  TestersWriteModule &
  TestersDailyModule &
  TestersViewModule &
  TestersConfigModule;

/**
 * Load `@pithy-sh/testers` from the project's own install.
 *
 * The one place the optional dependency is resolved, so a project that has not added testers gets one
 * clear instruction instead of a module error from whichever call site happened to run first.
 */
export async function loadTesters(): Promise<TestersModule> {
  try {
    const [capability, tables, read, write, daily, view, config] = await Promise.all([
      import("@pithy-sh/testers/src/capability"),
      import("@pithy-sh/testers/src/data/tables"),
      import("@pithy-sh/testers/src/roster/read"),
      import("@pithy-sh/testers/src/roster/write"),
      import("@pithy-sh/testers/src/workflows/daily"),
      import("@pithy-sh/testers/src/http/view"),
      import("@pithy-sh/testers/src/config/config"),
    ]);
    return { ...capability, ...tables, ...read, ...write, ...daily, ...view, ...config };
  } catch (error) {
    throw new ValidationError(
      {
        message: "The testers capability is not installed.",
        action: "Run `pithy add testers`, then re-run this command.",
        detail: "@pithy-sh/testers could not be resolved from the project's install.",
      },
      { cause: error },
    );
  }
}
